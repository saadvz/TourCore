import { approvedTool } from "./hostApproval";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { liveDeskFor, resetLiveDesks, setCleanerCalendarFetch } from "../src/cleaner-core/liveDesk";
import { setCleanerGroupFetch, setCleanerTwilioClient } from "../src/cleaner-core/liveSms";
import { SCRATCH_TENANTS } from "../src/cleaner-core/tenants";
import {
  CALENDAR_URL,
  CLEANER_TOKEN,
  type SentSms,
  type ToolResult,
  type WiredApp,
  fakeSms,
  startWiredApp,
} from "./wiringProof";

const LANE = SCRATCH_TENANTS[0];
const ADDRESS = "12 Scratch Lane, Teaneck, NJ 07666";
const HOST = "+15555550115";
const OBSERVER = "+15555550142";
const HOST_STOP_HELD = `You're opted out of cleaning texts for ${ADDRESS}, and the cleaning there is on hold. Reply START to get texts again.`;
const HOST_STOP_OPEN = `You're opted out of cleaning texts for ${ADDRESS}. Reply START to get texts again.`;
const HOST_START_HELD = `You'll get cleaning texts for ${ADDRESS} again. The cleaning is still on hold. Tell your Grok Bot to restart it.`;
const HOST_START_OPEN = `You'll get cleaning texts for ${ADDRESS} again.`;
const HOST_DONE = `The cleaner marked the cleaning at ${ADDRESS} done.`;
const CLEANER_STOP = `You're opted out of cleaning texts for ${ADDRESS}. You won't get cleaning offers or the door code. Reply START to opt back in. Reply HELP for help.`;
const CLEANER_START = "You're opted back in. Reply YES if you still want this turnover. Reply STOP to opt out.";
const CLEANER_START_EARLY = "You're opted back in to cleaning texts. Reply YES if you still want this turnover. Reply STOP to opt out.";
const CLEANER_DONE = "Thanks, cleaning marked done.";
const PIN_SENT = "I sent the door code to the cleaner. I'll tell you if it doesn't go through.";
const INJURY_ALERT = `The cleaner at ${ADDRESS} says someone is hurt. They've been told to call 911.`;

const open: WiredApp[] = [];
const roots: string[] = [];

afterEach(async () => {
  setCleanerTwilioClient(undefined);
  setCleanerGroupFetch(undefined);
  setCleanerCalendarFetch(undefined);
  resetLiveDesks();
  while (open.length > 0) {
    const app = open.pop();
    if (app) await app.close();
  }
  while (roots.length > 0) {
    const root = roots.pop();
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

function redact(sent: SentSms[], pin: string): { to: string; body: string }[] {
  return sent.map((item) => ({ to: item.to, body: item.body.split(pin).join("[redacted]") }));
}

function nextOf(result: ToolResult): string {
  const next = result.structured?.next;
  if (typeof next !== "string") throw new Error(result.text);
  return next;
}

function linesOf(result: ToolResult): string[] {
  const lines = result.structured?.lines;
  if (!Array.isArray(lines) || lines.some((line) => typeof line !== "string")) throw new Error(result.text);
  return lines as string[];
}

async function scratchApp(): Promise<WiredApp> {
  const started = await startWiredApp({
    scratchTools: true,
    allowlist: `${HOST},${LANE?.cleanerPhone},${OBSERVER}`,
  });
  open.push(started);
  return started;
}

async function call(wired: WiredApp, name: string, args?: Record<string, unknown>): Promise<ToolResult> {
  return wired.tool("/mcp/cleaner-core", CLEANER_TOKEN, name, args);
}

async function savePeople(wired: WiredApp): Promise<void> {
  if (!LANE) throw new Error("missing lane");
  expect((await call(wired, "get_state", { choice: "cleaners" })).isError).toBe(false);
  expect((await call(wired, "save_property", { business: "Scratch", address: ADDRESS, timeZone: "America/New_York" })).isError).toBe(false);
  expect((await call(wired, "save_people", { host: HOST, cleaner: LANE.cleanerPhone, observer: OBSERVER })).isError).toBe(false);
}

async function saveLane(wired: WiredApp): Promise<void> {
  if (!LANE) throw new Error("missing lane");
  await savePeople(wired);
  expect((await call(wired, "save_calendar_link", { url: CALENDAR_URL })).isError).toBe(false);
  expect((await call(wired, "save_door_code", { code: LANE.pin })).isError).toBe(false);
  expect((await call(wired, "set_up_texting")).isError).toBe(false);
  expect((await call(wired, "run_checks")).isError).toBe(false);
}

async function confirmJob(wired: WiredApp): Promise<void> {
  if (!LANE) throw new Error("missing lane");
  expect((await call(wired, "confirm_times", { checkout: "10:30", checkIn: "15:00" })).isError).toBe(false);
  expect(nextOf(await call(wired, "send_test_text", { from: LANE.cleanerPhone, text: "YES" }))).toBe("The test text went through.");
  expect(nextOf(await call(wired, "send_test_text", { from: LANE.cleanerPhone, text: "YES" }))).toBe("The test text went through.");
}

function hostBodies(sent: SentSms[], pin: string): string[] {
  return redact(sent, pin).filter((item) => item.to === HOST).map((item) => item.body);
}

function assertHostWording(body: string): void {
  expect(body.toLowerCase().includes("cleaning offers")).toBe(false);
  expect(body.toLowerCase().includes("door code")).toBe(false);
  expect(body.toLowerCase().includes("reply yes")).toBe(false);
}

describe("host texts after 46105bc", () => {
  it("uses the host STOP and START wording, and START leaves the hold in place", async () => {
    if (!LANE) throw new Error("missing lane");
    const root = mkdtempSync(join(tmpdir(), "host-copy-"));
    roots.push(root);
    const sms = fakeSms();
    const env: NodeJS.ProcessEnv = {
      CLEANER_CORE_ENABLED: "1",
      CLEANER_CORE_GROUP_CHAT: "0",
      CLEANER_CORE_LIVE_SMS: "1",
      CLEANER_CORE_SMS_ALLOWLIST: `${HOST},${LANE.cleanerPhone},${OBSERVER}`,
      CLEANER_CORE_TWILIO_ACCOUNT_SID: "ACfake",
      CLEANER_CORE_TWILIO_AUTH_TOKEN: "token",
      CLEANER_CORE_TWILIO_PHONE_NUMBER: "+15555550124",
    };
    setCleanerTwilioClient(sms);
    const desk = liveDeskFor(root, () => env, () => new Date("2026-10-14T15:00:00.000Z"));
    expect((await desk.getState("cleaners")).ok).toBe(true);
    expect((await desk.saveProperty({ business: "Scratch", address: ADDRESS, timeZone: "America/New_York" })).ok).toBe(true);
    expect((await desk.savePeople({ host: HOST, cleaner: LANE.cleanerPhone, observer: OBSERVER })).ok).toBe(true);
    await desk.inbound({ id: "early-stop", from: HOST, text: "STOP" });
    await desk.inbound({ id: "early-start", from: HOST, text: "START" });
    const earlyState = await desk.getState();
    if (!earlyState.ok) throw new Error("missing state");
    expect(JSON.stringify(earlyState.result).includes("on hold")).toBe(false);
    await desk.inbound({ id: "early-cleaner-stop", from: LANE.cleanerPhone, text: "STOP" });
    await desk.inbound({ id: "early-cleaner-start", from: LANE.cleanerPhone, text: "START" });
    expect(sms.sent.map((item) => ({ to: item.to, body: item.body }))).toEqual([
      { to: HOST, body: HOST_STOP_OPEN },
      { to: HOST, body: HOST_START_OPEN },
      { to: LANE.cleanerPhone, body: CLEANER_STOP },
      { to: LANE.cleanerPhone, body: CLEANER_START_EARLY },
    ]);

    const wired = await scratchApp();
    await saveLane(wired);
    await confirmJob(wired);
    const stopAt = wired.cleanerSent.length;
    expect(nextOf(await call(wired, "send_test_text", { from: HOST, text: "STOP" }))).toBe("The test text went through.");
    expect(hostBodies(wired.cleanerSent.slice(stopAt), LANE.pin)).toEqual([HOST_STOP_HELD]);
    expect((await call(wired, "get_turns")).text).toContain("\"held\":true");
    const startAt = wired.cleanerSent.length;
    expect(nextOf(await call(wired, "send_test_text", { from: HOST, text: "START" }))).toBe("The test text went through.");
    expect(hostBodies(wired.cleanerSent.slice(startAt), LANE.pin)).toEqual([HOST_START_HELD]);
    expect((await call(wired, "get_turns")).text).toContain("\"held\":true");
    expect(nextOf(await call(wired, "mark_guests_left", { confirmed: true }))).not.toBe(PIN_SENT);
    expect((await approvedTool((args) => call(wired, "resume_job", args))).isError).toBe(false);
    expect((await call(wired, "get_turns")).text).not.toContain("\"held\":true");
    const cleanerHeld = wired.cleanerSent.length;
    expect(nextOf(await call(wired, "send_test_text", { from: LANE.cleanerPhone, text: "STOP" }))).toBe("The test text went through.");
    expect(redact(wired.cleanerSent.slice(cleanerHeld), LANE.pin).filter((item) => item.to === LANE.cleanerPhone)).toEqual([
      { to: LANE.cleanerPhone, body: CLEANER_STOP },
    ]);
    const cleanerBack = wired.cleanerSent.length;
    expect(nextOf(await call(wired, "send_test_text", { from: LANE.cleanerPhone, text: "START" }))).toBe("The test text went through.");
    expect(redact(wired.cleanerSent.slice(cleanerBack), LANE.pin).filter((item) => item.to === LANE.cleanerPhone)).toEqual([
      { to: LANE.cleanerPhone, body: CLEANER_START },
    ]);
    expect((await call(wired, "get_turns")).text).toContain("\"held\":true");
    for (const body of [HOST_STOP_HELD, HOST_STOP_OPEN, HOST_START_HELD, HOST_START_OPEN]) assertHostWording(body);
    expect(JSON.stringify(redact(wired.cleanerSent, LANE.pin)).includes(LANE.pin)).toBe(false);
  }, 60_000);

  it("logs the resume note unsent while Cory is opted out, sends one ready text, and the cleaner still gets the door code", async () => {
    if (!LANE) throw new Error("missing lane");
    const wired = await scratchApp();
    await saveLane(wired);
    await confirmJob(wired);
    expect(nextOf(await call(wired, "send_test_text", { from: HOST, text: "STOP" }))).toBe("The test text went through.");
    const afterStop = wired.cleanerSent.length;
    expect((await approvedTool((args) => call(wired, "resume_job", args))).isError).toBe(false);
    expect(nextOf(await call(wired, "mark_guests_left", { confirmed: true }))).toBe(PIN_SENT);
    expect(nextOf(await call(wired, "send_test_text", { from: LANE.cleanerPhone, text: "START" }))).toBe("The test text went through.");
    expect((await call(wired, "get_turns")).text).toContain("\"status\":\"in_progress\"");
    expect(nextOf(await call(wired, "send_test_text", { from: LANE.cleanerPhone, text: "DONE" }))).toBe("The test text went through.");
    expect(nextOf(await call(wired, "send_test_text", { from: LANE.cleanerPhone, text: "DONE" }))).toBe("The test text went through.");
    expect(nextOf(await call(wired, "mark_guests_left", { confirmed: true }))).not.toBe(PIN_SENT);
    const after = redact(wired.cleanerSent.slice(afterStop), LANE.pin);
    expect(after.filter((item) => item.to === HOST)).toEqual([{ to: HOST, body: HOST_DONE }]);
    expect(after.filter((item) => item.body.includes("Door code:"))).toEqual([
      { to: LANE.cleanerPhone, body: `Guests have left ${ADDRESS}. Door code: [redacted]. This code is only for you. Reply DONE when the cleaning is finished.` },
    ]);
    const lines = linesOf(await call(wired, "read_outbox"));
    expect(lines).toContain("Resume note to the host: unsent.");
    expect(lines.filter((line) => line === "Done note to the host: sent.")).toEqual(["Done note to the host: sent."]);
    expect(lines.filter((line) => line === "Done note to the host: unsent.")).toEqual([]);
    expect(lines.filter((line) => line === "Resume note to the host: sent.")).toEqual([]);
    expect((await call(wired, "get_turns")).text).toContain("\"status\":\"done\"");
    expect((await call(wired, "get_turns")).text).not.toContain("\"held\":true");
    const beforeHurt = wired.cleanerSent.length;
    expect(nextOf(await call(wired, "send_test_text", { from: LANE.cleanerPhone, text: "I fell and I'm hurt" }))).toBe("The test text went through.");
    expect(hostBodies(wired.cleanerSent.slice(beforeHurt), LANE.pin)).toContain(INJURY_ALERT);
    expect(JSON.stringify(redact(wired.cleanerSent, LANE.pin)).includes(LANE.pin)).toBe(false);
  }, 60_000);

  it("sends Cory one ready text when the cleaner texts DONE, and a retry sends no duplicate", async () => {
    if (!LANE) throw new Error("missing lane");
    const wired = await scratchApp();
    await saveLane(wired);
    await confirmJob(wired);
    expect(nextOf(await call(wired, "mark_guests_left", { confirmed: true }))).toBe(PIN_SENT);
    expect(nextOf(await call(wired, "send_test_text", { from: LANE.cleanerPhone, text: "START" }))).toBe("The test text went through.");
    const beforeDone = wired.cleanerSent.length;
    expect(nextOf(await call(wired, "send_test_text", { from: LANE.cleanerPhone, text: "DONE" }))).toBe("The test text went through.");
    expect(redact(wired.cleanerSent.slice(beforeDone), LANE.pin)).toEqual([
      { to: LANE.cleanerPhone, body: CLEANER_DONE },
      { to: HOST, body: HOST_DONE },
    ]);
    expect(linesOf(await call(wired, "read_outbox")).filter((line) => line === "Done note to the host: sent.")).toEqual([
      "Done note to the host: sent.",
    ]);
    const retry = wired.cleanerSent.length;
    expect(nextOf(await call(wired, "send_test_text", { from: LANE.cleanerPhone, text: "DONE" }))).toBe("The test text went through.");
    expect(redact(wired.cleanerSent.slice(retry), LANE.pin)).toEqual([
      { to: LANE.cleanerPhone, body: "This cleaning is already marked done." },
    ]);
    expect((await call(wired, "get_turns")).text).toContain("\"status\":\"done\"");
    expect(hostBodies(wired.cleanerSent, LANE.pin).filter((body) => body === HOST_DONE)).toEqual([HOST_DONE]);
    expect(JSON.stringify(redact(wired.cleanerSent, LANE.pin)).includes(LANE.pin)).toBe(false);
  }, 60_000);
});
