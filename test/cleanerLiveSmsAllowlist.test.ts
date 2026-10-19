import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { liveDeskFor, resetLiveDesks, setCleanerCalendarFetch } from "../src/cleaner-core/liveDesk";
import { sendLiveSms, setCleanerTwilioClient } from "../src/cleaner-core/liveSms";
import {
  CALENDAR_ICS,
  CALENDAR_URL,
  CLEANER,
  CLEANER_LINE,
  FROZEN,
  HOST,
  OBSERVER,
  TEST_PIN_KEY,
  fakeSms,
} from "./wiringProof";

const ADDRESS = "12 Practice Lane, Teaneck, NJ 07666";
const BUSINESS = "Harbor";
const DOOR = "8088";
const BLANK_LISTS: Array<string | undefined> = [undefined, "", "   ", ",", " , , "];

afterEach(() => {
  setCleanerTwilioClient(undefined);
  setCleanerCalendarFetch(undefined);
  resetLiveDesks();
});

function envFor(allowlist: string | undefined): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    CLEANER_CORE_ENABLED: "1",
    CLEANER_CORE_GROUP_CHAT: "0",
    CLEANER_CORE_LIVE_SMS: "1",
    CLEANER_CORE_TWILIO_ACCOUNT_SID: "ACfake",
    CLEANER_CORE_TWILIO_AUTH_TOKEN: "token",
    CLEANER_CORE_TWILIO_PHONE_NUMBER: CLEANER_LINE,
  };
  if (allowlist !== undefined) env.CLEANER_CORE_SMS_ALLOWLIST = allowlist;
  return env;
}

function calendar() {
  setCleanerCalendarFetch(async (url) => ({
    status: url === CALENDAR_URL ? 200 : 404,
    url,
    async text() {
      return url === CALENDAR_URL ? CALENDAR_ICS : "";
    },
  }));
}

async function readyDesk(env: NodeJS.ProcessEnv) {
  const root = mkdtempSync(join(tmpdir(), "cleaner-allow-"));
  const desk = liveDeskFor(root, () => env, () => new Date(FROZEN));
  const pinKey = Buffer.from(TEST_PIN_KEY, "base64");
  expect((await desk.getState("cleaners")).ok).toBe(true);
  expect((await desk.saveProperty({ business: BUSINESS, address: ADDRESS, timeZone: "America/New_York" })).ok).toBe(true);
  expect((await desk.savePeople({ host: HOST, cleaner: CLEANER, observer: OBSERVER })).ok).toBe(true);
  expect((await desk.saveCalendarLink({ url: CALENDAR_URL })).ok).toBe(true);
  expect((await desk.saveDoorCode({ code: DOOR }, pinKey)).ok).toBe(true);
  expect((await desk.setUpTexting()).ok).toBe(true);
  return {
    desk,
    close() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

describe("live texts with a blank or incomplete allowlist", () => {
  it.each(BLANK_LISTS)("sends nothing and does not mark a job delivered when the allowlist is %j", async (allowlist) => {
    const client = fakeSms();
    setCleanerTwilioClient(client);
    calendar();
    const env = envFor(allowlist);
    expect(await sendLiveSms(env, { to: HOST, body: "checkout question" })).toBeUndefined();
    expect(await sendLiveSms(env, { to: CLEANER, body: "opt in" })).toBeUndefined();
    expect(client.sent).toEqual([]);

    const { desk, close } = await readyDesk(env);
    try {
      const checks = await desk.runChecks();
      expect(checks.ok).toBe(false);
      const times = await desk.confirmTimes({ checkout: "10:30", checkIn: "15:00" });
      expect(times.ok).toBe(false);
      const turns = await desk.getTurns();
      expect(turns).toEqual({ ok: true, result: { turns: [] } });
      await desk.inbound({ id: "blank-yes", from: CLEANER, text: "YES" });
      expect(await desk.getTurns()).toEqual({ ok: true, result: { turns: [] } });
      expect(client.sent).toEqual([]);
    } finally {
      close();
    }
  });

  it("sends nothing to a number that is off a non-empty allowlist", async () => {
    const client = fakeSms();
    setCleanerTwilioClient(client);
    calendar();
    const env = envFor(HOST);
    expect(await sendLiveSms(env, { to: CLEANER, body: "opt in" })).toBeUndefined();
    expect(await sendLiveSms(env, { to: OBSERVER, body: "copy" })).toBeUndefined();
    expect(client.sent).toEqual([]);
    const hostSid = await sendLiveSms(env, { to: HOST, body: "checkout question" });
    expect(hostSid).toBeTruthy();
    expect(client.sent.map((item) => item.to)).toEqual([HOST]);

    const { desk, close } = await readyDesk(env);
    try {
      const checks = await desk.runChecks();
      expect(checks.ok).toBe(false);
      const times = await desk.confirmTimes({ checkout: "10:30", checkIn: "15:00" });
      expect(times.ok).toBe(false);
      expect(await desk.getTurns()).toEqual({ ok: true, result: { turns: [] } });
      await desk.inbound({ id: "off-yes", from: CLEANER, text: "YES" });
      expect(client.sent.map((item) => ({ to: item.to, body: item.body }))).toEqual([
        { to: HOST, body: "checkout question" },
      ]);
    } finally {
      close();
    }
  });
});
