import { afterEach, describe, expect, it } from "vitest";
import { resetLiveDesks, setCleanerCalendarFetch } from "../src/cleaner-core/liveDesk";
import { setCleanerTwilioClient } from "../src/cleaner-core/liveSms";
import type { GoogleEventList } from "../src/cleaner-core/sources";
import { ADDRESS, BUSINESS, CLEANER, CLEANER_TOKEN, DOOR_CODE, HOST, OBSERVER, startWiredApp, type WiredApp } from "./wiringProof";

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
