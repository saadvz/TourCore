import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { zonedInstant } from "../src/cleaner-core/calendar";
import { resetLiveDesks, setCleanerCalendarFetch } from "../src/cleaner-core/liveDesk";
import { setCleanerTwilioClient } from "../src/cleaner-core/liveSms";
import type { GoogleEventList } from "../src/cleaner-core/sources";
import { ADDRESS, BUSINESS, CALENDAR_URL, CLEANER, CLEANER_AUTH, CLEANER_LINE, CLEANER_TOKEN, DOOR_CODE, FROZEN, HOST, OBSERVER, startWiredApp, type SentSms, type WiredApp } from "./wiringProof";

const PATH = "/mcp/cleaner-core";
const open: WiredApp[] = [];

afterEach(async () => {
  setCleanerTwilioClient(undefined);
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
    // confirm_times sends both times as host texts, so a second corrected text can follow the first.
    const kinds = kindsSince(wired, before);
    expect(kinds.length).toBeGreaterThan(0);
    expect(kinds.every((kind) => kind === "corrected")).toBe(true);
    expect(wired.cleanerSent[before]?.body).toContain("Friday, Oct 16 at 10:30 AM");
    expect(wired.cleanerSent.slice(before).some((item) => item.body.includes(DOOR_CODE))).toBe(false);
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

  it("two check_now calls at once alert the host once", async () => {
    const wired = await app({ calendar: oneStay });
    await setUpBoth(wired);
    expect((await call(wired, "run_checks", { googleEvents: googleList([]) })).isError).toBe(false);
    // A slow calendar read lets two unqueued calls interleave.
    setCleanerCalendarFetch(async (url) => {
      await new Promise((resolve) => setTimeout(resolve, 25));
      return { status: 200, url, async text() { return oneStay(); } };
    });
    const list = googleList([{ id: "g1", start: "2026-10-14", end: "2026-10-15" }]);
    const [a, b] = await Promise.all([call(wired, "check_now", { googleEvents: list }), call(wired, "check_now", { googleEvents: list })]);
    expect(a.isError).toBe(false);
    expect(b.isError).toBe(false);
    const asks = [...alertsOf(a), ...alertsOf(b)].filter((line) => line.startsWith(HOST_CHECKOUT));
    expect(asks).toHaveLength(1);
    const stored = JSON.parse(readFileSync(join(wired.root, "cleaner-job", "cleaner-core.json"), "utf8")) as { outbox: { kind: string }[] };
    expect(stored.outbox.filter((item) => item.kind === "host-checkout")).toHaveLength(1);
  });

  it("is off when Cleaner Core is off", async () => {
    const wired = await app({ enabled: false });
    const off = await call(wired, "check_now", { googleEvents: googleList([]) });
    expect(off.status).toBe(503);
    expect(wired.cleanerSent).toEqual([]);
    expect(wired.tourSent).toEqual([]);
  });
});
