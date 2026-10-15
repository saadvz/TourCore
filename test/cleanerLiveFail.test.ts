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
  startWiredApp,
} from "./wiringProof";

const LANE = SCRATCH_TENANTS[0];
const HOST = "+15555550115";
const OBSERVER = "+15555550142";
const PIN_SENT = "I sent the door code to the cleaner. I'll tell you if it doesn't go through.";
const PIN_FAILED = "The door code didn't reach the cleaner. Tell your Grok Bot the guests have left and I'll resend it.";
const PIN_REPEAT = "I already sent the door code to the cleaner.";
const STOP_ACK = "You're opted out of cleaning texts for 12 Scratch Lane, Teaneck, NJ 07666. You won't get cleaning offers or the door code. Reply START to opt back in. Reply HELP for help.";
const HOST_STOP = "You're opted out of cleaning texts for 12 Scratch Lane, Teaneck, NJ 07666, and the cleaning there is on hold. Reply START to get texts again.";
const HOST_START = "You'll get cleaning texts for 12 Scratch Lane, Teaneck, NJ 07666 again. The cleaning is still on hold. Tell your Grok Bot to restart it.";
const INJURY_HOLD = "The cleaning at 12 Scratch Lane, Teaneck, NJ 07666 is on hold because the cleaner reported an injury. Once everyone's okay, tell your Grok Bot to restart it.";
const OWNER_HOLD = "The cleaning at 12 Scratch Lane, Teaneck, NJ 07666 is on hold because you opted out of texts. Tell your Grok Bot to restart it.";
const CLEANER_HOLD = "The cleaner opted out of cleaning texts for 12 Scratch Lane, Teaneck, NJ 07666, so the cleaning is on hold. Find another cleaner or reach them directly, then tell your Grok Bot to restart it.";

const open: WiredApp[] = [];

afterEach(async () => {
  setCleanerTwilioClient(undefined);
  setCleanerGroupFetch(undefined);
  setCleanerCalendarFetch(undefined);
  resetLiveDesks();
  while (open.length > 0) {
    const app = open.pop();
    if (app) await app.close();
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

function notesOf(result: ToolResult): string[] {
  const notes = result.structured?.notes;
  if (notes === undefined) return [];
  if (!Array.isArray(notes) || notes.some((line) => typeof line !== "string")) throw new Error(result.text);
  return notes as string[];
}

function linesOf(result: ToolResult): string[] {
  const lines = result.structured?.lines;
  if (!Array.isArray(lines) || lines.some((line) => typeof line !== "string")) throw new Error(result.text);
  return lines as string[];
}

async function scratchApp(): Promise<WiredApp> {
  if (!LANE) throw new Error("missing lane");
  const started = await startWiredApp({
    scratchTools: true,
    allowlist: `${HOST},${LANE.cleanerPhone},${OBSERVER}`,
  });
  open.push(started);
  return started;
}

async function call(wired: WiredApp, name: string, args?: Record<string, unknown>): Promise<ToolResult> {
  return wired.tool("/mcp/cleaner-core", CLEANER_TOKEN, name, args);
}

async function saveLane(wired: WiredApp): Promise<void> {
  if (!LANE) throw new Error("missing lane");
  expect((await call(wired, "get_state", { said: "2" })).isError).toBe(false);
  expect((await call(wired, "save_property", { business: "Scratch", address: LANE.property.address, timeZone: "America/New_York" })).isError).toBe(false);
  expect((await call(wired, "save_people", { host: HOST, cleaner: LANE.cleanerPhone, observer: OBSERVER })).isError).toBe(false);
  expect((await call(wired, "save_calendar_link", { url: CALENDAR_URL })).isError).toBe(false);
  expect((await call(wired, "save_door_code", { code: LANE.pin })).isError).toBe(false);
  expect((await call(wired, "set_up_texting")).isError).toBe(false);
  expect((await call(wired, "run_checks")).isError).toBe(false);
}

async function confirmJob(wired: WiredApp): Promise<void> {
  if (!LANE) throw new Error("missing lane");
  expect((await call(wired, "confirm_times", { checkout: "10:30 AM", checkIn: "3:00 PM" })).isError).toBe(false);
  expect(nextOf(await call(wired, "send_test_text", { from: LANE.cleanerPhone, text: "YES" }))).toBe("The test text went through.");
  expect(nextOf(await call(wired, "send_test_text", { from: LANE.cleanerPhone, text: "YES" }))).toBe("The test text went through.");
}

function codeTexts(sent: SentSms[], pin: string): { to: string; body: string }[] {
  return redact(sent, pin).filter((item) => item.body.includes("Door code:"));
}

describe("live Scratch failures from 19087415", () => {
  it("a failed or undelivered report tells Cory once and the next guests left sends the code once", async () => {
    if (!LANE) throw new Error("missing lane");
    const wired = await scratchApp();
    await saveLane(wired);
    await confirmJob(wired);
    const left = await call(wired, "mark_guests_left", { said: "The guests have left" });
    expect(nextOf(left)).toBe(PIN_SENT);
    expect(codeTexts(wired.cleanerSent, LANE.pin)).toEqual([
      { to: LANE.cleanerPhone, body: "Guests have left 12 Scratch Lane, Teaneck, NJ 07666. Door code: [redacted]. This code is only for you." },
    ]);

    expect(nextOf(await call(wired, "report_delivery", { which: "Door code text to the cleaner", status: "failed" }))).toBe("Door code text to the cleaner: failed.");
    const failed = await call(wired, "get_state");
    expect(nextOf(failed)).toBe(PIN_FAILED);
    expect(failed.text).not.toContain(PIN_SENT);
    expect(codeTexts(wired.cleanerSent, LANE.pin)).toHaveLength(1);
    expect(redact(wired.cleanerSent, LANE.pin).filter((item) => item.to === HOST && item.body === PIN_FAILED)).toEqual([{ to: HOST, body: PIN_FAILED }]);
    const turns = await call(wired, "get_turns");
    expect(turns.text).not.toContain("\"status\":\"cleared\"");

    const late = await call(wired, "report_delivery", { which: "Door code text to the cleaner", status: "delivered" });
    expect(nextOf(late)).toBe("Door code text to the cleaner: failed.");
    expect(nextOf(await call(wired, "get_state"))).not.toBe(PIN_SENT);
    expect(codeTexts(wired.cleanerSent, LANE.pin)).toHaveLength(1);
    expect(redact(wired.cleanerSent, LANE.pin).filter((item) => item.body === PIN_FAILED)).toHaveLength(1);

    const resent = await call(wired, "mark_guests_left", { said: "guests left" });
    expect(nextOf(resent)).toBe(PIN_SENT);
    expect(codeTexts(wired.cleanerSent, LANE.pin)).toHaveLength(2);

    expect(nextOf(await call(wired, "report_delivery", { which: "Door code text to the cleaner", status: "undelivered" }))).toBe("Door code text to the cleaner: undelivered.");
    expect(nextOf(await call(wired, "get_state"))).toBe(PIN_FAILED);
    expect(redact(wired.cleanerSent, LANE.pin).filter((item) => item.body === PIN_FAILED)).toHaveLength(2);
    expect(nextOf(await call(wired, "report_delivery", { which: "Door code text to the cleaner", status: "undelivered" }))).toBe("Door code text to the cleaner: undelivered.");
    expect(redact(wired.cleanerSent, LANE.pin).filter((item) => item.body === PIN_FAILED)).toHaveLength(2);
    expect(nextOf(await call(wired, "report_delivery", { which: "Door code text to the cleaner", status: "delivered" }))).toBe("Door code text to the cleaner: undelivered.");
    const again = await call(wired, "mark_guests_left", { said: "they left" });
    expect(nextOf(again)).toBe(PIN_SENT);
    expect(codeTexts(wired.cleanerSent, LANE.pin)).toHaveLength(3);
    expect(nextOf(await call(wired, "report_delivery", { which: "Door code text to the cleaner", status: "delivered" }))).toBe("Door code text to the cleaner: delivered.");
    expect(nextOf(await call(wired, "mark_guests_left", { said: "The guests have left" }))).toBe(PIN_REPEAT);
    expect(codeTexts(wired.cleanerSent, LANE.pin)).toHaveLength(3);
    expect(JSON.stringify(redact(wired.cleanerSent, LANE.pin))).not.toContain(LANE.pin);
  }, 40_000);

  it("holds the job after an injury and sends no code until Cory resumes", async () => {
    if (!LANE) throw new Error("missing lane");
    const wired = await scratchApp();
    await saveLane(wired);
    await confirmJob(wired);
    const before = wired.cleanerSent.length;
    expect(nextOf(await call(wired, "send_test_text", { from: LANE.cleanerPhone, text: "I fell and I'm hurt" }))).toBe("The test text went through.");
    const state = await call(wired, "get_state");
    expect(nextOf(state)).toBe(INJURY_HOLD);
    expect(state.text).toContain("\"held\":true");
    const blocked = await call(wired, "mark_guests_left", { said: "The guests have left" });
    expect(nextOf(blocked)).toBe(INJURY_HOLD);
    expect(blocked.text).not.toContain("I sent the door code");
    expect(codeTexts(wired.cleanerSent, LANE.pin)).toEqual([]);
    expect(nextOf(await call(wired, "send_test_text", { from: LANE.cleanerPhone, text: "START" }))).toBe("The test text went through.");
    expect((await call(wired, "get_state")).text).toContain(INJURY_HOLD);
    expect(nextOf(await call(wired, "mark_guests_left", { said: "guests left" }))).toBe(INJURY_HOLD);
    expect(codeTexts(wired.cleanerSent, LANE.pin)).toEqual([]);
    const resumed = await call(wired, "resume_job");
    expect(resumed.text).toContain("The cleaning at 12 Scratch Lane, Teaneck, NJ 07666 is back on.");
    expect(nextOf(await call(wired, "get_state"))).not.toBe(INJURY_HOLD);
    expect((await call(wired, "get_turns")).text).not.toContain("\"held\":true");
    expect(nextOf(await call(wired, "mark_guests_left", { said: "The guests have left" }))).toBe(PIN_SENT);
    expect(codeTexts(wired.cleanerSent, LANE.pin)).toHaveLength(1);
    const added = redact(wired.cleanerSent.slice(before), LANE.pin);
    expect(added.filter((item) => item.body === PIN_FAILED || item.body === PIN_REPEAT)).toEqual([]);
    expect(added.some((item) => item.to === HOST && item.body.includes("someone is hurt"))).toBe(true);
  }, 40_000);

  it("handles host STOP and START before the departure return, and a repeat sends nothing", async () => {
    if (!LANE) throw new Error("missing lane");
    const wired = await scratchApp();
    await saveLane(wired);
    await confirmJob(wired);
    const before = wired.cleanerSent.length;
    expect(nextOf(await call(wired, "send_test_text", { from: HOST, text: "don't stop by early" }))).toBe("The test text went through.");
    expect(redact(wired.cleanerSent.slice(before), LANE.pin)).toEqual([]);
    expect((await call(wired, "get_turns")).text).not.toContain("\"held\":true");

    const spellings = ["STOP", "Stop.", "stop", "UNSUBSCRIBE"];
    for (const text of spellings) {
      const sentBefore = wired.cleanerSent.length;
      expect(nextOf(await call(wired, "send_test_text", { from: HOST, text }))).toBe("The test text went through.");
      expect(redact(wired.cleanerSent.slice(sentBefore), LANE.pin)).toEqual([{ to: HOST, body: HOST_STOP }]);
      const state = await call(wired, "get_state");
      expect(state.text).toContain(OWNER_HOLD);
      expect(state.text).toContain("\"held\":true");
      expect(nextOf(await call(wired, "mark_guests_left", { said: "The guests have left" }))).toBe(OWNER_HOLD);
      expect(codeTexts(wired.cleanerSent, LANE.pin)).toEqual([]);
      const repeatBefore = wired.cleanerSent.length;
      const notesBefore = ((await call(wired, "get_state")).structured?.notes as string[] | undefined)?.length ?? 0;
      expect(nextOf(await call(wired, "send_test_text", { from: HOST, text }))).toBe("The test text went through.");
      expect(wired.cleanerSent.length).toBe(repeatBefore);
      const notesAfter = ((await call(wired, "get_state")).structured?.notes as string[] | undefined)?.length ?? 0;
      expect(notesAfter).toBe(notesBefore);
      if (text !== "UNSUBSCRIBE") {
        expect(nextOf(await call(wired, "send_test_text", { from: HOST, text: "START" }))).toBe("The test text went through.");
        expect((await call(wired, "get_state")).text).toContain(OWNER_HOLD);
      }
    }
    expect(linesOf(await call(wired, "read_inbox"))).toContain("Text from the host: STOP.");

    const startBefore = wired.cleanerSent.length;
    expect(nextOf(await call(wired, "send_test_text", { from: HOST, text: "START" }))).toBe("The test text went through.");
    expect(redact(wired.cleanerSent.slice(startBefore), LANE.pin)).toEqual([{ to: HOST, body: HOST_START }]);
    const afterStart = await call(wired, "get_state");
    expect(afterStart.text).toContain(OWNER_HOLD);
    expect(afterStart.text).toContain(HOST_START);
    expect(afterStart.text).toContain(HOST_STOP);
    expect(nextOf(await call(wired, "mark_guests_left", { said: "The guests have left" }))).toBe(OWNER_HOLD);
    expect(codeTexts(wired.cleanerSent, LANE.pin)).toEqual([]);
    expect((await call(wired, "resume_job")).text).toContain("is back on");
    expect(nextOf(await call(wired, "mark_guests_left", { said: "The guests have left" }))).toBe(PIN_SENT);
    expect(codeTexts(wired.cleanerSent, LANE.pin)).toHaveLength(1);
  }, 40_000);

  it("a second STOP from the cleaner sends nothing and adds no note", async () => {
    if (!LANE) throw new Error("missing lane");
    const wired = await scratchApp();
    await saveLane(wired);
    await confirmJob(wired);
    expect(nextOf(await call(wired, "send_test_text", { from: LANE.cleanerPhone, text: "STOP" }))).toBe("The test text went through.");
    const once = redact(wired.cleanerSent, LANE.pin).filter((item) => item.body === STOP_ACK || item.body === CLEANER_HOLD);
    expect(once.filter((item) => item.to === LANE.cleanerPhone && item.body === STOP_ACK)).toHaveLength(1);
    const notesOnce = linesOf(await call(wired, "read_outbox")).filter((line) => line.startsWith("Hold note") || line.startsWith("Opt-out"));
    const sentOnce = wired.cleanerSent.length;
    expect(nextOf(await call(wired, "send_test_text", { from: LANE.cleanerPhone, text: "STOP" }))).toBe("The test text went through.");
    expect(wired.cleanerSent.length).toBe(sentOnce);
    expect(linesOf(await call(wired, "read_outbox")).filter((line) => line.startsWith("Hold note") || line.startsWith("Opt-out"))).toEqual(notesOnce);
    const state = await call(wired, "get_state");
    expect(state.text).toContain(CLEANER_HOLD);
    expect(nextOf(await call(wired, "send_test_text", { from: LANE.cleanerPhone, text: "START" }))).toBe("The test text went through.");
    expect((await call(wired, "get_state")).text).toContain("on hold");
    expect(nextOf(await call(wired, "mark_guests_left", { said: "The guests have left" }))).toBe(CLEANER_HOLD);
    expect(codeTexts(wired.cleanerSent, LANE.pin)).toEqual([]);
    expect((await call(wired, "resume_job")).isError).toBe(false);
    expect(nextOf(await call(wired, "mark_guests_left", { said: "The guests have left" }))).toBe(PIN_SENT);
    expect(codeTexts(wired.cleanerSent, LANE.pin)).toHaveLength(1);
  }, 40_000);

  it("runs offer, confirm, guests left, the private code, START, and DONE with no extra texts", async () => {
    if (!LANE) throw new Error("missing lane");
    const wired = await scratchApp();
    await saveLane(wired);
    await confirmJob(wired);
    expect(nextOf(await call(wired, "mark_guests_left", { said: "The guests have left" }))).toBe(PIN_SENT);
    expect(nextOf(await call(wired, "send_test_text", { from: LANE.cleanerPhone, text: "START" }))).toBe("The test text went through.");
    expect((await call(wired, "get_turns")).text).toContain("\"status\":\"in_progress\"");
    expect(nextOf(await call(wired, "send_test_text", { from: LANE.cleanerPhone, text: "DONE" }))).toBe("The test text went through.");
    expect((await call(wired, "get_turns")).text).toContain("\"status\":\"done\"");
    const bodies = redact(wired.cleanerSent, LANE.pin).map((item) => item.body);
    expect(bodies.filter((body) => body.includes("Reply YES to schedule it"))).toHaveLength(1);
    expect(bodies.filter((body) => body.startsWith("Cleaning is scheduled for "))).toHaveLength(1);
    expect(bodies.filter((body) => body.includes("Door code:"))).toHaveLength(1);
    expect(bodies.filter((body) => body === "Got it, cleaning started.")).toHaveLength(1);
    expect(bodies.filter((body) => body === "Thanks, cleaning marked done.")).toHaveLength(1);
    expect(bodies.filter((body) => body === PIN_FAILED || body === INJURY_HOLD || body === OWNER_HOLD || body === CLEANER_HOLD)).toEqual([]);
    expect(wired.cleanerSent.filter((item) => item.to !== LANE.cleanerPhone && item.to !== HOST)).toEqual([]);
  }, 40_000);

  it("sends Cory nothing after STOP when the door code fails, and get_state still shows the failed line", async () => {
    if (!LANE) throw new Error("missing lane");
    const wired = await scratchApp();
    await saveLane(wired);
    await confirmJob(wired);
    expect(nextOf(await call(wired, "mark_guests_left", { said: "The guests have left" }))).toBe(PIN_SENT);
    expect(codeTexts(wired.cleanerSent, LANE.pin)).toEqual([
      { to: LANE.cleanerPhone, body: "Guests have left 12 Scratch Lane, Teaneck, NJ 07666. Door code: [redacted]. This code is only for you." },
    ]);
    const beforeStop = wired.cleanerSent.length;
    expect(nextOf(await call(wired, "send_test_text", { from: HOST, text: "STOP" }))).toBe("The test text went through.");
    expect(redact(wired.cleanerSent.slice(beforeStop), LANE.pin)).toEqual([{ to: HOST, body: HOST_STOP }]);
    const afterStop = wired.cleanerSent.length;
    expect(nextOf(await call(wired, "report_delivery", { which: "Door code text to the cleaner", status: "failed" }))).toBe("Door code text to the cleaner: failed.");
    expect(redact(wired.cleanerSent.slice(afterStop), LANE.pin)).toEqual([]);
    expect(nextOf(await call(wired, "get_state"))).toBe(PIN_FAILED);
    expect(codeTexts(wired.cleanerSent, LANE.pin)).toHaveLength(1);
    expect(JSON.stringify(redact(wired.cleanerSent, LANE.pin))).not.toContain(LANE.pin);
  }, 40_000);

  it("keeps the other host lines in get_state and off Twilio after Cory opts out", async () => {
    if (!LANE) throw new Error("missing lane");
    const wired = await scratchApp();
    await saveLane(wired);
    await confirmJob(wired);
    expect(nextOf(await call(wired, "send_test_text", { from: LANE.cleanerPhone, text: "STOP" }))).toBe("The test text went through.");
    const beforeStop = wired.cleanerSent.length;
    expect(nextOf(await call(wired, "send_test_text", { from: HOST, text: "STOP" }))).toBe("The test text went through.");
    expect(redact(wired.cleanerSent.slice(beforeStop), LANE.pin)).toEqual([{ to: HOST, body: HOST_STOP }]);
    const afterStop = wired.cleanerSent.length;
    const resumed = await call(wired, "resume_job");
    const backOn = "The cleaning at 12 Scratch Lane, Teaneck, NJ 07666 is back on.";
    const held = "The cleaner opted out, so the door code wasn't sent. Please reach them directly.";
    expect(resumed.text).toContain(backOn);
    expect(redact(wired.cleanerSent.slice(afterStop), LANE.pin)).toEqual([]);
    expect(notesOf(await call(wired, "get_state"))).toContain(backOn);
    expect(nextOf(await call(wired, "mark_guests_left", { said: "The guests have left" }))).toBe(held);
    expect(redact(wired.cleanerSent.slice(afterStop), LANE.pin)).toEqual([]);
    expect(codeTexts(wired.cleanerSent, LANE.pin)).toEqual([]);
    const notes = notesOf(await call(wired, "get_state"));
    expect(notes).toContain(backOn);
    expect(notes).toContain(held);
    expect(JSON.stringify(redact(wired.cleanerSent, LANE.pin))).not.toContain(LANE.pin);
  }, 40_000);

  it("after STOP, a reminder and DONE text Cory nothing and the job is done", async () => {
    if (!LANE) throw new Error("missing lane");
    const wired = await scratchApp();
    await saveLane(wired);
    await confirmJob(wired);
    expect(nextOf(await call(wired, "mark_guests_left", { said: "The guests have left" }))).toBe(PIN_SENT);
    expect(nextOf(await call(wired, "send_test_text", { from: LANE.cleanerPhone, text: "START" }))).toBe("The test text went through.");
    expect((await call(wired, "get_turns")).text).toContain("\"status\":\"in_progress\"");
    const beforeStop = wired.cleanerSent.length;
    expect(nextOf(await call(wired, "send_test_text", { from: HOST, text: "STOP" }))).toBe("The test text went through.");
    expect(redact(wired.cleanerSent.slice(beforeStop), LANE.pin)).toEqual([{ to: HOST, body: HOST_STOP }]);
    const afterStop = wired.cleanerSent.length;
    await liveDeskFor(wired.root, () => process.env, () => new Date()).runReminders();
    expect(nextOf(await call(wired, "send_test_text", { from: LANE.cleanerPhone, text: "DONE" }))).toBe("The test text went through.");
    const after = redact(wired.cleanerSent.slice(afterStop), LANE.pin);
    expect(after.filter((item) => item.to === HOST)).toEqual([]);
    expect(after).toEqual([{ to: LANE.cleanerPhone, body: "Thanks, cleaning marked done." }]);
    expect((await call(wired, "get_turns")).text).toContain("\"status\":\"done\"");
    expect(nextOf(await call(wired, "get_state"))).toBe(OWNER_HOLD);
    expect(JSON.stringify(redact(wired.cleanerSent, LANE.pin))).not.toContain(LANE.pin);
    const repeat = wired.cleanerSent.length;
    expect(nextOf(await call(wired, "send_test_text", { from: HOST, text: "STOP" }))).toBe("The test text went through.");
    expect(wired.cleanerSent.length).toBe(repeat);
  }, 40_000);
});
