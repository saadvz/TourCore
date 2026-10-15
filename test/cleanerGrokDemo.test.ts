import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { zonedInstant } from "../src/cleaner-core/calendar";
import { privateCodeLine } from "../src/cleaner-core/cleanerTexts";
import type { CleanerCore } from "../src/cleaner-core/core";
import { liveDeskFor, resetLiveDesks, setCleanerCalendarFetch, type LiveDesk, type ToolReply } from "../src/cleaner-core/liveDesk";
import { setCleanerGroupFetch, setCleanerTwilioClient } from "../src/cleaner-core/liveSms";
import type { GoogleEventList } from "../src/cleaner-core/sources";
import { SCRATCH_TENANTS } from "../src/cleaner-core/tenants";
import { ADDRESS, BUSINESS, CALENDAR_URL, CLEANER, CLEANER_AUTH, CLEANER_LINE, CLEANER_TOKEN, DOOR_CODE, FROZEN, HOST, OBSERVER, startWiredApp, TEST_PIN_KEY, type SentSms, type WiredApp } from "./wiringProof";

const PATH = "/mcp/cleaner-core";
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

function googleList(stays: { id: string; start: string; end: string }[]): GoogleEventList {
  return {
    timeZone: "America/New_York",
    items: stays.map((stay) => ({ id: stay.id, status: "confirmed", summary: "Guest", start: { date: stay.start }, end: { date: stay.end } })),
  };
}

async function app(options?: Parameters<typeof startWiredApp>[0]): Promise<WiredApp> {
  const started = await startWiredApp(options);
  open.push(started);
  return started;
}

function call(wired: WiredApp, name: string, args: Record<string, unknown> = {}) {
  return wired.tool(PATH, CLEANER_TOKEN, name, args);
}

async function setUpTo(wired: WiredApp, observer = false) {
  await call(wired, "get_state", { said: "2" });
  expect((await call(wired, "save_property", { business: BUSINESS, address: ADDRESS, timeZone: "America/New_York" })).isError).toBe(false);
  expect((await call(wired, "save_people", { host: HOST, cleaner: CLEANER, ...(observer ? { observer: OBSERVER } : {}) })).isError).toBe(false);
}

async function setUpGoogle(wired: WiredApp, observer = false) {
  await setUpTo(wired, observer);
  expect((await call(wired, "save_calendar_link", { google: true })).isError).toBe(false);
  expect((await call(wired, "save_door_code", { code: DOOR_CODE })).isError).toBe(false);
  expect((await call(wired, "set_up_texting")).isError).toBe(false);
}

async function done(wired: WiredApp): Promise<string[]> {
  const state = await call(wired, "get_state");
  return (state.structured?.done as string[] | undefined) ?? [];
}

describe("Cleaner Core Grok demo: booking sources at setup", () => {
  it("saves Google without a Guesty link", async () => {
    const wired = await app();
    await setUpTo(wired);
    const saved = await call(wired, "save_calendar_link", { google: true });
    expect(saved.isError).toBe(false);
    const lines = await done(wired);
    expect(lines).toContain("Google Calendar saved.");
    expect(lines).not.toContain("Calendar link saved.");
  });

  it("refuses a calendar step with neither source", async () => {
    const wired = await app();
    await setUpTo(wired);
    const refused = await call(wired, "save_calendar_link", {});
    expect(refused.isError).toBe(true);
    expect(refused.text).toBe("Send the Guesty Lite link, or say you use Google Calendar.");
  });

  it("run_checks reads Google events", async () => {
    const wired = await app();
    await setUpGoogle(wired);
    const missing = await call(wired, "run_checks");
    expect(missing.isError).toBe(true);
    expect(missing.text).toBe("Read Google Calendar and pass its events.");
    const checks = await call(wired, "run_checks", { googleEvents: googleList([{ id: "g1", start: "2026-10-14", end: "2026-10-16" }]) });
    expect(checks.isError).toBe(false);
    const turns = checks.structured?.turns as { checkoutDate: string }[];
    expect(turns).toHaveLength(1);
    expect(turns[0]?.checkoutDate).toBe("2026-10-16");
    expect(wired.cleanerSent).toEqual([]);
  });

  it("run_checks with no stay yet", async () => {
    const wired = await app();
    await setUpGoogle(wired);
    const checks = await call(wired, "run_checks", { googleEvents: googleList([]) });
    expect(checks.isError).toBe(false);
    expect(checks.structured?.next).toBe("I read the calendar. There's no guest stay yet. I'll tell you when one shows up.");
    expect(await done(wired)).toContain("Checks finished.");
    expect(wired.cleanerSent).toEqual([]);
  });

  it("shows the group chat line only when group chat is on", async () => {
    const withObserver = await app({ groupChat: true });
    await setUpGoogle(withObserver, true);
    expect(await done(withObserver)).toContain("Group chat set up with you, the cleaner, and the observer.");

    const noObserver = await app({ groupChat: true });
    await setUpGoogle(noObserver);
    const lines = await done(noObserver);
    expect(lines).toContain("Group chat set up with you and the cleaner.");
    expect(lines.some((line) => line.includes("the observer"))).toBe(false);

    const off = await app({ groupChat: false });
    await setUpGoogle(off, true);
    expect((await done(off)).some((line) => line.startsWith("Group chat set up"))).toBe(false);
  });
});

const ZONE = "America/New_York";
const HOST_CHECKOUT = `Is checkout at ${ADDRESS} on `;

function oneStay(): string {
  return [
    "BEGIN:VCALENDAR",
    "BEGIN:VEVENT",
    "UID:stay-a",
    "DTSTART;VALUE=DATE:20261014",
    "DTEND;VALUE=DATE:20261018",
    "SUMMARY:Guest",
    "END:VEVENT",
    "END:VCALENDAR",
    "",
  ].join("\n");
}

async function setUpBoth(wired: WiredApp) {
  await setUpTo(wired);
  expect((await call(wired, "save_calendar_link", { url: CALENDAR_URL, google: true })).isError).toBe(false);
  expect((await call(wired, "save_door_code", { code: DOOR_CODE })).isError).toBe(false);
  expect((await call(wired, "set_up_texting")).isError).toBe(false);
}

async function yes(wired: WiredApp, sid: string) {
  const res = await wired.postTwilio("/webhooks/twilio/cleaner-core", { from: CLEANER, to: CLEANER_LINE, body: "YES", sid, token: CLEANER_AUTH });
  expect(res.status).toBe(200);
}

/** The next guest. A job needs a next check-in before the host can confirm times. */
const NEXT_STAY = { id: "g2", start: "2026-10-20", end: "2026-10-24" };

function withNext(stay: { id: string; start: string; end: string }): GoogleEventList {
  return googleList([stay, NEXT_STAY]);
}

/** Google-only setup, two stays read, times confirmed, and the cleaner's two YES texts. */
async function confirmedJob(wired: WiredApp, stay: { id: string; start: string; end: string }) {
  await setUpGoogle(wired);
  expect((await call(wired, "run_checks", { googleEvents: withNext(stay) })).isError).toBe(false);
  expect((await call(wired, "confirm_times", { checkout: "10:30 AM", checkIn: "3:00 PM" })).isError).toBe(false);
  await yes(wired, "SM-demo-yes-1");
  await yes(wired, "SM-demo-yes-2");
}

function textKind(item: SentSms): string {
  if (/^Update: checkout at .* moved to /.test(item.body)) return "corrected";
  if (/^Update: the cleaning at .* is canceled/.test(item.body)) return "cancel-update";
  if (/^Reminder:/.test(item.body)) return "reminder";
  return "other";
}

function kindsSince(wired: WiredApp, from: number): string[] {
  return wired.cleanerSent.slice(from).map(textKind);
}

function reminders(wired: WiredApp): number {
  return wired.cleanerSent.filter((item) => textKind(item) === "reminder").length;
}

function alertsOf(reply: { structured: Record<string, unknown> | undefined }): string[] {
  return (reply.structured?.alerts as string[] | undefined) ?? [];
}

function turnsOf(reply: { structured: Record<string, unknown> | undefined }): { checkoutDate: string; status: string }[] {
  return (reply.structured?.turns as { checkoutDate: string; status: string }[] | undefined) ?? [];
}

describe("Cleaner Core Grok demo: check_now", () => {
  it("new booking alerts the host", async () => {
    const wired = await app();
    await setUpGoogle(wired);
    expect((await call(wired, "run_checks", { googleEvents: googleList([]) })).isError).toBe(false);
    const list = googleList([{ id: "g1", start: "2026-10-14", end: "2026-10-15" }]);
    const first = await call(wired, "check_now", { googleEvents: list });
    expect(first.isError).toBe(false);
    const alerts = alertsOf(first);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.startsWith(HOST_CHECKOUT)).toBe(true);
    expect(turnsOf(first)).toHaveLength(1);
    expect(wired.cleanerSent).toEqual([]);
    const second = await call(wired, "check_now", { googleEvents: list });
    expect(second.isError).toBe(false);
    expect(alertsOf(second)).toEqual([]);
    expect(wired.cleanerSent).toEqual([]);
  });

  it("moved stay updates the job", async () => {
    const wired = await app();
    await confirmedJob(wired, { id: "g1", start: "2026-10-10", end: "2026-10-15" });
    const before = wired.cleanerSent.length;
    const moved = await call(wired, "check_now", { googleEvents: withNext({ id: "g1", start: "2026-10-10", end: "2026-10-16" }) });
    expect(moved.isError).toBe(false);
    expect(turnsOf(moved)[0]?.checkoutDate).toBe("2026-10-16");
    // The engine clears the host's checkout time when the date moves, so it asks the host again
    // and tells the cleaner nothing until the host confirms the new day.
    expect(alertsOf(moved).some((line) => line.startsWith(HOST_CHECKOUT) && line.includes("Oct 16"))).toBe(true);
    expect(kindsSince(wired, before)).toEqual([]);
    expect((await call(wired, "confirm_times", { checkout: "10:30 AM", checkIn: "3:00 PM" })).isError).toBe(false);
    const got = wired.cleanerSent.slice(before);
    expect(got.map(textKind)).toEqual(["corrected"]);
    expect(got[0]?.body).toContain("Friday, Oct 16 at 10:30 AM");
    expect(got[0]?.body).not.toContain("3:00 PM");
    expect(got.some((item) => item.body.includes(DOOR_CODE))).toBe(false);
  });

  it("removed stay calls the job off", async () => {
    const wired = await app();
    await confirmedJob(wired, { id: "g1", start: "2026-10-10", end: "2026-10-15" });
    const before = wired.cleanerSent.length;
    const removed = await call(wired, "check_now", { googleEvents: googleList([]) });
    expect(removed.isError).toBe(false);
    expect(kindsSince(wired, before)).toEqual(["cancel-update"]);
    expect(turnsOf(removed).every((turn) => turn.status === "canceled")).toBe(true);
  });

  it("omitted googleEvents changes nothing", async () => {
    const wired = await app();
    await confirmedJob(wired, { id: "g1", start: "2026-10-10", end: "2026-10-15" });
    const jobs = await call(wired, "get_turns");
    const before = wired.cleanerSent.length;
    const checked = await call(wired, "check_now", {});
    expect(checked.isError).toBe(false);
    expect(turnsOf(checked)).toEqual(jobs.structured?.turns);
    expect(wired.cleanerSent).toHaveLength(before);
  });

  it("one job from both calendars", async () => {
    const wired = await app({ calendar: oneStay });
    await setUpBoth(wired);
    const list = googleList([{ id: "g1", start: "2026-10-14", end: "2026-10-18" }]);
    expect((await call(wired, "run_checks", { googleEvents: list })).isError).toBe(false);
    const checked = await call(wired, "check_now", { googleEvents: list });
    expect(checked.isError).toBe(false);
    expect(turnsOf(checked)).toHaveLength(1);
    expect(turnsOf(checked)[0]?.checkoutDate).toBe("2026-10-18");
  });

  it("guesty failure still applies Google", async () => {
    const wired = await app({ calendar: oneStay });
    await setUpBoth(wired);
    const first = googleList([{ id: "g1", start: "2026-10-14", end: "2026-10-18" }]);
    expect((await call(wired, "run_checks", { googleEvents: first })).isError).toBe(false);
    setCleanerCalendarFetch(async (url) => ({
      status: 500,
      url,
      async text() {
        return "";
      },
    }));
    const next = googleList([
      { id: "g1", start: "2026-10-14", end: "2026-10-18" },
      { id: "g2", start: "2026-10-20", end: "2026-10-24" },
    ]);
    const checked = await call(wired, "check_now", { googleEvents: next });
    expect(checked.isError).toBe(false);
    expect(checked.structured?.guestyUnread).toBe(true);
    expect(turnsOf(checked).map((turn) => turn.checkoutDate)).toContain("2026-10-24");
  });

  it("malformed events are skipped", async () => {
    const wired = await app();
    await setUpGoogle(wired);
    expect((await call(wired, "run_checks", { googleEvents: googleList([]) })).isError).toBe(false);
    const good = googleList([{ id: "g1", start: "2026-10-14", end: "2026-10-16" }]).items[0];
    const checked = await call(wired, "check_now", {
      googleEvents: { timeZone: "America/New_York", items: [{ id: "bad" }, { id: "x", start: { date: "nope" }, end: {} }, good] },
    });
    expect(checked.isError).toBe(false);
    expect(turnsOf(checked)).toHaveLength(1);
  });

  it("refuses before setup", async () => {
    const wired = await app();
    const refused = await call(wired, "check_now", { googleEvents: googleList([]) });
    expect(refused.isError).toBe(true);
    expect(refused.text).toBe("Run the checks first.");
    expect(wired.cleanerSent).toEqual([]);
    expect(wired.tourSent).toEqual([]);
  });

  it("reminder fires once and a restart does not resend it", async () => {
    let now = new Date(FROZEN);
    const wired = await app({ now: () => now });
    const stay = { id: "g1", start: "2026-10-10", end: "2026-10-14" };
    const list = withNext(stay);
    await confirmedJob(wired, stay);
    expect(reminders(wired)).toBe(0);

    now = new Date(zonedInstant("2026-10-14", "07:59", ZONE));
    expect((await call(wired, "check_now", { googleEvents: list })).isError).toBe(false);
    expect(reminders(wired)).toBe(0);

    now = new Date(zonedInstant("2026-10-14", "08:00", ZONE));
    expect((await call(wired, "check_now", { googleEvents: list })).isError).toBe(false);
    expect(reminders(wired)).toBe(1);
    expect((await call(wired, "check_now", { googleEvents: list })).isError).toBe(false);
    expect(reminders(wired)).toBe(1);

    resetLiveDesks();
    expect((await call(wired, "check_now", { googleEvents: list })).isError).toBe(false);
    expect(reminders(wired)).toBe(1);
  });

  it("is off when Cleaner Core is off", async () => {
    const wired = await app({ enabled: false });
    const off = await call(wired, "check_now", { googleEvents: googleList([]) });
    expect(off.status).toBe(503);
    expect(wired.cleanerSent).toEqual([]);
    expect(wired.tourSent).toEqual([]);
  });
});

interface GroupPost {
  to: string[];
  body: string;
}

/** A fake Twilio Conversations API. It records each group message and never leaves the machine. */
function groupStub(): { impl: typeof fetch; posts: GroupPost[] } {
  const conversations = new Map<string, { sid: string; address: string }[]>();
  const posts: GroupPost[] = [];
  let sequence = 0;
  const impl: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const reply = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => body }) as Response;
    const root = "https://conversations.twilio.com/v1/Conversations";
    if (url === root && method === "POST") {
      const sid = `CH${++sequence}`;
      conversations.set(sid, []);
      return reply(201, { sid });
    }
    if (!url.startsWith(`${root}/`)) return reply(404, {});
    const [rawSid, ...rest] = url.slice(root.length + 1).split("/");
    const people = conversations.get(decodeURIComponent(rawSid ?? ""));
    if (!people) return reply(404, {});
    const tail = rest.join("/").split("?")[0] ?? "";
    if (tail === "Messages" && method === "POST") {
      const params = new URLSearchParams(String(init?.body ?? ""));
      posts.push({ to: people.map((person) => person.address).sort(), body: params.get("Body") ?? "" });
      return reply(201, { sid: `IM${posts.length}` });
    }
    if (tail === "Participants" && method === "GET") {
      return reply(200, { participants: people.map((person) => ({ sid: person.sid, messaging_binding: { address: person.address } })), meta: { next_page_url: null } });
    }
    if (tail === "Participants" && method === "POST") {
      const address = new URLSearchParams(String(init?.body ?? "")).get("MessagingBinding.Address") ?? "";
      const person = { sid: `MB${++sequence}`, address };
      people.push(person);
      return reply(201, { sid: person.sid });
    }
    if (method === "DELETE") {
      const index = people.findIndex((person) => person.sid === decodeURIComponent(tail.slice("Participants/".length)));
      if (index >= 0) people.splice(index, 1);
      return reply(204, {});
    }
    return reply(404, {});
  };
  return { impl, posts };
}

/** A Guesty calendar that answers slowly and counts how many reads are open at once. */
function slowCalendar(): { peak: () => number } {
  let inFlight = 0;
  let peak = 0;
  setCleanerCalendarFetch(async (url) => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 25));
    inFlight -= 1;
    return {
      status: 200,
      url,
      async text() {
        return oneStay();
      },
    };
  });
  return { peak: () => peak };
}

function deskEnv(): NodeJS.ProcessEnv {
  return { CLEANER_CORE_ENABLED: "1", CLEANER_CORE_GROUP_CHAT: "0", CLEANER_CORE_SMS_ALLOWLIST: `${HOST},${CLEANER}` };
}

function resultOf(reply: ToolReply): Record<string, unknown> {
  if (!reply.ok) throw new Error(reply.error);
  return reply.result;
}

/** A desk with its own state folder and no live texting. */
async function openDesk(root: string, env: NodeJS.ProcessEnv): Promise<LiveDesk> {
  const desk = liveDeskFor(root, () => env, () => new Date(FROZEN));
  const pinKey = Buffer.from(TEST_PIN_KEY, "base64");
  expect(desk.getState("2").ok).toBe(true);
  expect(desk.saveProperty({ business: BUSINESS, address: ADDRESS, timeZone: ZONE }).ok).toBe(true);
  expect(desk.savePeople({ host: HOST, cleaner: CLEANER }).ok).toBe(true);
  expect(desk.saveCalendarLink({ google: true }).ok).toBe(true);
  expect(desk.saveDoorCode({ code: DOOR_CODE }, pinKey).ok).toBe(true);
  expect(desk.setUpTexting().ok).toBe(true);
  expect((await desk.runChecks({ googleEvents: googleList([]) })).ok).toBe(true);
  return desk;
}

describe("Cleaner Core Grok demo: check_now follow-ups", () => {
  it("returns a held-back alert once it becomes visible", async () => {
    const root = mkdtempSync(join(tmpdir(), "cleaner-held-"));
    try {
      const env = deskEnv();
      const desk = await openDesk(root, env);
      const internals = desk as unknown as { engine: CleanerCore; file: { pinSend?: unknown } };
      // The private-code line is hidden until the door-code text is confirmed delivered.
      const line = privateCodeLine("Maria");
      internals.engine.keepHostNote("pin-private:held", line);
      const held = resultOf(await desk.checkNow({ googleEvents: googleList([]) }));
      expect(held.alerts).toEqual([]);
      internals.file.pinSend = { sid: "SM-held", outcome: "settled", notePending: false, delivered: true };
      const shown = resultOf(await desk.checkNow({ googleEvents: googleList([]) }));
      expect(shown.alerts).toEqual([line]);
      expect(resultOf(await desk.checkNow({ googleEvents: googleList([]) })).alerts).toEqual([]);
    } finally {
      resetLiveDesks();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports Google as unread when the engine does not take the read", async () => {
    const root = mkdtempSync(join(tmpdir(), "cleaner-unread-"));
    try {
      const env = deskEnv();
      await openDesk(root, env);
      // The host's number is no longer approved, so the reopened engine refuses to read any source.
      env.CLEANER_CORE_SMS_ALLOWLIST = "+15555550199";
      resetLiveDesks();
      const desk = liveDeskFor(root, () => env, () => new Date(FROZEN));
      const reply = resultOf(await desk.checkNow({ googleEvents: googleList([{ id: "g1", start: "2026-10-14", end: "2026-10-16" }]) }));
      expect(reply.googleUnread).toBe(true);
      expect(reply.turns).toEqual([]);
      expect(reply.guestyUnread).toBeUndefined();
    } finally {
      resetLiveDesks();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("marks the alerts the host already saw at run_checks as shown", async () => {
    const wired = await app();
    const stay = { id: "g1", start: "2026-10-10", end: "2026-10-15" };
    await confirmedJob(wired, stay);
    const state = await call(wired, "get_state");
    const seen = (state.structured?.notes as string[] | undefined) ?? [];
    expect(seen.length).toBeGreaterThan(0);
    expect((await call(wired, "run_checks", { googleEvents: withNext(stay) })).isError).toBe(false);
    const checked = await call(wired, "check_now", { googleEvents: withNext(stay) });
    expect(checked.isError).toBe(false);
    expect(alertsOf(checked).filter((line) => seen.includes(line))).toEqual([]);
  });

  it("returns a new-booking alert again after reset_scratch", async () => {
    const lane = SCRATCH_TENANTS[0];
    if (!lane) throw new Error("missing tenant");
    const wired = await app({ scratchTools: true, allowlist: `${lane.ownerPhone},${lane.cleanerPhone}` });
    await call(wired, "get_state", { said: "2" });
    await call(wired, "save_property", { business: "Scratch", address: lane.property.address, timeZone: ZONE });
    await call(wired, "save_people", { host: lane.ownerPhone, cleaner: lane.cleanerPhone });
    await call(wired, "save_calendar_link", { google: true });
    await call(wired, "save_door_code", { code: DOOR_CODE });
    await call(wired, "set_up_texting");
    expect((await call(wired, "run_checks", { googleEvents: googleList([]) })).isError).toBe(false);
    const list = googleList([{ id: "g1", start: "2026-10-14", end: "2026-10-15" }]);
    const first = await call(wired, "check_now", { googleEvents: list });
    expect(alertsOf(first)).toHaveLength(1);
    expect(alertsOf(await call(wired, "check_now", { googleEvents: list }))).toEqual([]);
    expect((await call(wired, "reset_scratch")).isError).toBe(false);
    const again = await call(wired, "check_now", { googleEvents: list });
    expect(again.isError).toBe(false);
    expect(alertsOf(again)).toEqual(alertsOf(first));
  });

  it("never runs two checks at once", async () => {
    const wired = await app({ calendar: oneStay });
    await setUpBoth(wired);
    const list = googleList([{ id: "g1", start: "2026-10-14", end: "2026-10-18" }]);
    expect((await call(wired, "run_checks", { googleEvents: list })).isError).toBe(false);
    const slow = slowCalendar();
    const pair = await Promise.all([call(wired, "check_now", { googleEvents: list }), call(wired, "check_now", { googleEvents: list })]);
    expect(pair.map((reply) => reply.isError)).toEqual([false, false]);
    expect(slow.peak()).toBe(1);
    const mixed = await Promise.all([call(wired, "run_checks", { googleEvents: list }), call(wired, "check_now", { googleEvents: list })]);
    expect(mixed.map((reply) => reply.isError)).toEqual([false, false]);
    expect(slow.peak()).toBe(1);
  });

  it("with group chat on, a moved stay waits for the host and then sends one corrected text", async () => {
    const stub = groupStub();
    setCleanerGroupFetch(stub.impl);
    const wired = await app({ groupChat: true });
    await confirmedJob(wired, { id: "g1", start: "2026-10-10", end: "2026-10-15" });
    const sms = wired.cleanerSent.length;
    const posts = stub.posts.length;
    const moved = await call(wired, "check_now", { googleEvents: withNext({ id: "g1", start: "2026-10-10", end: "2026-10-16" }) });
    expect(moved.isError).toBe(false);
    expect(turnsOf(moved)[0]?.checkoutDate).toBe("2026-10-16");
    expect((moved.structured?.turns as { checkoutTime: string | null }[])[0]?.checkoutTime).toBeNull();
    expect(wired.cleanerSent).toHaveLength(sms);
    expect(stub.posts).toHaveLength(posts);
    expect((await call(wired, "confirm_times", { checkout: "10:30 AM", checkIn: "3:00 PM" })).isError).toBe(false);
    const got = wired.cleanerSent.slice(sms);
    expect(got.map(textKind)).toEqual(["corrected"]);
    expect(got[0]?.body).toContain("Friday, Oct 16 at 10:30 AM");
    expect(got[0]?.body).not.toContain("3:00 PM");
    expect(stub.posts).toHaveLength(posts);
  });

  it("with group chat on, a removed stay sends the cleaner one cancellation", async () => {
    const stub = groupStub();
    setCleanerGroupFetch(stub.impl);
    const wired = await app({ groupChat: true });
    await confirmedJob(wired, { id: "g1", start: "2026-10-10", end: "2026-10-15" });
    const sms = wired.cleanerSent.length;
    const posts = stub.posts.length;
    const removed = await call(wired, "check_now", { googleEvents: googleList([]) });
    expect(removed.isError).toBe(false);
    expect(wired.cleanerSent.slice(sms).map(textKind)).toEqual(["cancel-update"]);
    expect(stub.posts).toHaveLength(posts);
    expect(turnsOf(removed).every((turn) => turn.status === "canceled")).toBe(true);
  });
});
