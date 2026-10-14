import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resetLiveDesks, setCleanerCalendarFetch } from "../src/cleaner-core/liveDesk";
import { setCleanerTwilioClient } from "../src/cleaner-core/liveSms";
import { pinKeyFor, sealPin } from "../src/cleaner-core/pinSeal";
import {
  ADDRESS,
  BUSINESS,
  bodies,
  CALENDAR_URL,
  CLEANER,
  CLEANER_AUTH,
  CLEANER_LINE,
  CLEANER_TOKEN,
  DOOR_CODE,
  EVIDENCE_DIR,
  FIRST_QUESTION,
  HOST,
  OBSERVER,
  OFF_LIST,
  redactCode,
  startWiredApp,
  toCleaner,
  TOUR_AUTH,
  TOUR_LINE,
  TOUR_TOKEN,
  type SentSms,
  type WiredApp,
} from "./wiringProof";

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

async function app(options?: { live?: boolean; enabled?: boolean }): Promise<WiredApp> {
  const started = await startWiredApp(options);
  open.push(started);
  return started;
}

function newer(before: SentSms[], after: SentSms[]): SentSms[] {
  return after.slice(before.length);
}

const BANNED = /\b(flag|webhook|token|connector|scratch)\b/i;
const PRODUCT = /\b(Tour Core|Cleaner Core)\b/;

describe("Cleaner Core live wiring", () => {
  it("sets up from an empty install and runs the five cleaning steps through the webhook", async () => {
    const wired = await app();
    const tools: string[] = [];
    const http: string[] = [];
    const remember = (result: { text: string; raw: string }) => {
      tools.push(result.text);
      http.push(result.raw);
    };

    const first = await wired.tool("/mcp/cleaner-core", CLEANER_TOKEN, "get_state");
    remember(first);
    expect(first.text).toContain(FIRST_QUESTION);
    expect(first.text).not.toMatch(PRODUCT);

    const picked = await wired.tool("/mcp/cleaner-core", CLEANER_TOKEN, "get_state", { said: "2" });
    remember(picked);
    expect(picked.text).toContain("That's Cleaner Core. It schedules cleaners between guest stays.");
    const later = await wired.tool("/mcp/cleaner-core", CLEANER_TOKEN, "get_state");
    remember(later);
    expect(later.text).not.toMatch(PRODUCT);

    remember(await wired.tool("/mcp/cleaner-core", CLEANER_TOKEN, "save_property", { business: BUSINESS, address: ADDRESS, timeZone: "America/New_York" }));
    remember(await wired.tool("/mcp/cleaner-core", CLEANER_TOKEN, "save_people", { host: HOST, cleaner: CLEANER, observer: OBSERVER }));
    remember(await wired.tool("/mcp/cleaner-core", CLEANER_TOKEN, "save_calendar_link", { url: CALENDAR_URL }));
    const savedCode = await wired.tool("/mcp/cleaner-core", CLEANER_TOKEN, "save_door_code", { code: DOOR_CODE });
    remember(savedCode);
    expect(savedCode.text).toMatch(/won't repeat it|private text/i);
    remember(await wired.tool("/mcp/cleaner-core", CLEANER_TOKEN, "set_up_texting"));
    const checks = await wired.tool("/mcp/cleaner-core", CLEANER_TOKEN, "run_checks");
    remember(checks);
    expect(checks.isError).toBe(false);
    expect(checks.text).toContain("2026-10-18");
    expect(toCleaner(wired.cleanerSent)).toEqual([]);
    expect(wired.cleanerSent).toEqual([]);

    const rejected = await wired.tool("/mcp/cleaner-core", CLEANER_TOKEN, "confirm_times", { checkout: "YES", checkIn: "YES" });
    remember(rejected);
    expect(rejected.isError).toBe(true);
    const beforeTimes = await wired.tool("/mcp/cleaner-core", CLEANER_TOKEN, "get_turns");
    remember(beforeTimes);
    expect(beforeTimes.text).not.toContain("11:00");
    expect(beforeTimes.text).not.toContain("4:00");
    expect(beforeTimes.text).not.toContain("10:30");

    const confirmed = await wired.tool("/mcp/cleaner-core", CLEANER_TOKEN, "confirm_times", { checkout: "10:30 AM", checkIn: "3:00 PM" });
    remember(confirmed);
    expect(confirmed.isError).toBe(false);
    expect(confirmed.text).toMatch(/The cleaner got one text asking them to reply YES/);
    expect(confirmed.text).toContain("10:30 AM");
    expect(confirmed.text).toContain("3:00 PM");
    expect(confirmed.text).not.toContain("11:00");
    expect(confirmed.text).not.toContain("4:00");
    const optIn = toCleaner(wired.cleanerSent);
    expect(optIn).toHaveLength(1);
    expect(optIn[0]?.body).toBe(
      `Hi, this is ${BUSINESS} at ${ADDRESS}. You're getting this because you clean between guest stays. Reply YES to get cleaning texts, or STOP to opt out.`,
    );
    expect(bodies(wired.cleanerSent).some((body) => /schedule it/i.test(body))).toBe(false);

    const offerBefore = wired.cleanerSent.length;
    const yesOffer = await wired.postTwilio("/webhooks/twilio/cleaner-core", { from: CLEANER, to: CLEANER_LINE, body: "YES", sid: "SM-yes-offer", token: CLEANER_AUTH });
    http.push(yesOffer.raw);
    expect(yesOffer.status).toBe(200);
    expect(yesOffer.raw).toBe("{}");
    const offer = newer(wired.cleanerSent.slice(0, offerBefore), wired.cleanerSent);
    expect(toCleaner(offer).map((item) => item.body).join("\n")).toMatch(/Reply YES to schedule it/);
    expect(toCleaner(offer)).toHaveLength(1);

    const scheduleBefore = wired.cleanerSent.length;
    const yesSchedule = await wired.postTwilio("/webhooks/twilio/cleaner-core", { from: CLEANER, to: CLEANER_LINE, body: "YES", sid: "SM-yes-schedule", token: CLEANER_AUTH });
    http.push(yesSchedule.raw);
    expect(yesSchedule.raw).toBe("{}");
    const scheduled = toCleaner(newer(wired.cleanerSent.slice(0, scheduleBefore), wired.cleanerSent));
    expect(scheduled.map((item) => item.body).join("\n")).toMatch(/Cleaning is scheduled/);

    const ignored = await wired.tool("/mcp/cleaner-core", CLEANER_TOKEN, "mark_guests_left", { said: "11:00 AM" });
    remember(ignored);
    expect(ignored.isError).toBe(true);
    expect(ignored.text).toMatch(/won't guess from the calendar/i);
    expect(bodies(toCleaner(wired.cleanerSent)).some((body) => body.includes(DOOR_CODE))).toBe(false);

    const leftBefore = wired.cleanerSent.map((item) => item.body);
    const left = await wired.tool("/mcp/cleaner-core", CLEANER_TOKEN, "mark_guests_left", { said: "The guests have left" });
    remember(left);
    expect(left.text).toContain("Door code sent to the cleaner.");
    const pinTexts = toCleaner(wired.cleanerSent).filter((item) => item.body.includes(DOOR_CODE));
    expect(pinTexts).toHaveLength(1);
    expect(pinTexts[0]?.to).toBe(CLEANER);
    expect(pinTexts[0]?.body).toBe(`Guests have left ${ADDRESS}. Door code: ${DOOR_CODE}. This code is only for you.`);
    expect(wired.cleanerSent.filter((item) => item.to !== CLEANER && item.body.includes(DOOR_CODE))).toEqual([]);
    expect(leftBefore.some((body) => body.includes(DOOR_CODE))).toBe(false);

    const again = await wired.tool("/mcp/cleaner-core", CLEANER_TOKEN, "mark_guests_left", { said: "The guests have left" });
    remember(again);
    expect(again.text).toContain("The cleaner already has the door code.");
    expect(toCleaner(wired.cleanerSent).filter((item) => item.body.includes(DOOR_CODE))).toHaveLength(1);

    const stopBefore = wired.cleanerSent.length;
    const stopped = await wired.postTwilio("/webhooks/twilio/cleaner-core", { from: CLEANER, to: CLEANER_LINE, body: "STOP", sid: "SM-stop", token: CLEANER_AUTH });
    http.push(stopped.raw);
    expect(stopped.raw).toBe("{}");
    const stopSends = newer(wired.cleanerSent.slice(0, stopBefore), wired.cleanerSent);
    expect(stopSends.find((item) => item.to === CLEANER)?.body).toBe(
      `You're opted out of cleaning texts for ${ADDRESS}. You won't get cleaning offers or the door code. Reply START to opt back in. Reply HELP for help.`,
    );
    expect(stopSends.find((item) => item.to === HOST)?.body).toBe(`The cleaner opted out of cleaning texts for ${ADDRESS}, so the job is on hold.`);
    const held = await wired.tool("/mcp/cleaner-core", CLEANER_TOKEN, "get_state");
    remember(held);
    expect(held.text).toMatch(/on hold/i);

    const startBefore = wired.cleanerSent.length;
    const pinCount = () => toCleaner(wired.cleanerSent).filter((item) => item.body.includes(DOOR_CODE)).length;
    const offerCount = () => toCleaner(wired.cleanerSent).filter((item) => /Reply YES to schedule it/.test(item.body)).length;
    const pins = pinCount();
    const offers = offerCount();
    const started = await wired.postTwilio("/webhooks/twilio/cleaner-core", { from: CLEANER, to: CLEANER_LINE, body: "START", sid: "SM-start", token: CLEANER_AUTH });
    http.push(started.raw);
    const startSends = newer(wired.cleanerSent.slice(0, startBefore), wired.cleanerSent);
    expect(startSends.map((item) => item.body).join("\n")).toMatch(/opted back in/i);
    expect(startSends.some((item) => item.body.includes(DOOR_CODE) || /Reply YES to schedule it/.test(item.body))).toBe(false);
    expect(pinCount()).toBe(pins);
    expect(offerCount()).toBe(offers);

    const offBefore = wired.cleanerSent.length;
    const silent = await wired.postTwilio("/webhooks/twilio/cleaner-core", { from: OFF_LIST, to: CLEANER_LINE, body: "YES", sid: "SM-off", token: CLEANER_AUTH });
    http.push(silent.raw);
    expect(silent.raw).toBe("{}");
    expect(wired.cleanerSent.length).toBe(offBefore);
    const observer = await wired.postTwilio("/webhooks/twilio/cleaner-core", { from: OBSERVER, to: CLEANER_LINE, body: "YES", sid: "SM-observer", token: CLEANER_AUTH });
    http.push(observer.raw);
    expect(wired.cleanerSent.length).toBe(offBefore);

    const unsigned = await fetch(`http://127.0.0.1:${wired.port}/webhooks/twilio/cleaner-core`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ MessageSid: "SM-bad", From: CLEANER, To: CLEANER_LINE, Body: "HELP", SmsStatus: "received" }).toString(),
    });
    expect(unsigned.status).toBe(403);
    http.push(await unsigned.text());

    for (const text of [...tools, ...http, ...bodies(wired.cleanerSent.filter((item) => !item.body.includes(DOOR_CODE)))]) {
      expect(text).not.toMatch(BANNED);
      expect(text).not.toMatch(/\b(911|injury|blood)\b/i);
    }
    expect(http.join("\n")).not.toContain(DOOR_CODE);
    expect(tools.join("\n")).not.toContain(DOOR_CODE);

    writeEvidence({
      tools,
      sends: wired.cleanerSent,
      stop: stopSends.find((item) => item.to === CLEANER)?.body ?? "",
      hostNote: stopSends.find((item) => item.to === HOST)?.body ?? "",
    });
  });

  it("does not say a door code was sent when Twilio reports the send failed", async () => {
    const wired = await app();
    wired.cleanerSent.splice(0, wired.cleanerSent.length);
    const failing = {
      sent: wired.cleanerSent,
      async getAccount() {
        return { sid: "ACfake", status: "active" };
      },
      async findNumber() {
        return undefined;
      },
      async setSmsUrl() {},
      async sendSms(input: { to: string; body: string }) {
        const status = input.body.startsWith("Guests have left") ? "failed" : "queued";
        wired.cleanerSent.push({ to: input.to, body: input.body, status });
        return { sid: `SM${wired.cleanerSent.length}`, status };
      },
    };
    setCleanerTwilioClient(failing);
    await wired.tool("/mcp/cleaner-core", CLEANER_TOKEN, "get_state", { said: "2" });
    await wired.tool("/mcp/cleaner-core", CLEANER_TOKEN, "save_property", { business: BUSINESS, address: ADDRESS, timeZone: "America/New_York" });
    await wired.tool("/mcp/cleaner-core", CLEANER_TOKEN, "save_people", { host: HOST, cleaner: CLEANER, observer: OBSERVER });
    await wired.tool("/mcp/cleaner-core", CLEANER_TOKEN, "save_calendar_link", { url: CALENDAR_URL });
    await wired.tool("/mcp/cleaner-core", CLEANER_TOKEN, "save_door_code", { code: DOOR_CODE });
    await wired.tool("/mcp/cleaner-core", CLEANER_TOKEN, "set_up_texting");
    await wired.tool("/mcp/cleaner-core", CLEANER_TOKEN, "run_checks");
    await wired.tool("/mcp/cleaner-core", CLEANER_TOKEN, "confirm_times", { checkout: "10:30 AM", checkIn: "3:00 PM" });
    await wired.postTwilio("/webhooks/twilio/cleaner-core", { from: CLEANER, to: CLEANER_LINE, body: "YES", sid: "SM-fail-yes-1", token: CLEANER_AUTH });
    await wired.postTwilio("/webhooks/twilio/cleaner-core", { from: CLEANER, to: CLEANER_LINE, body: "YES", sid: "SM-fail-yes-2", token: CLEANER_AUTH });
    const marked = await wired.tool("/mcp/cleaner-core", CLEANER_TOKEN, "mark_guests_left", { said: "The guests have left" });
    expect(marked.text).toContain("The door code didn't reach the cleaner.");
    expect(marked.raw).not.toContain(DOOR_CODE);
    const attempt = wired.cleanerSent.find((item) => item.body.startsWith("Guests have left"));
    expect(attempt).toMatchObject({ to: CLEANER, status: "failed" });
    expect(attempt?.body).toContain(DOOR_CODE);
    const note = wired.cleanerSent.find((item) => item.to === HOST && /didn't reach the cleaner/.test(item.body));
    expect(note?.body).toBe("The door code didn't reach the cleaner. We'll try again in a few minutes.");
    expect(note?.body).not.toContain(DOOR_CODE);
    expect(wired.cleanerSent.some((item) => item.body === "Door code sent to the cleaner.")).toBe(false);
    const dir = join(EVIDENCE_DIR);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "failed-send.json"),
      `${JSON.stringify(
        {
          tool: redactCode(marked.text),
          hostNote: note?.body ?? "",
          attempt: { to: attempt?.to, status: attempt?.status, body: attempt ? redactCode(attempt.body) : "" },
        },
        null,
        2,
      )}\n`,
    );
  });

  it("sends nothing when live texts are off", async () => {
    const wired = await app({ live: false });
    await wired.tool("/mcp/cleaner-core", CLEANER_TOKEN, "get_state", { said: "2" });
    await wired.tool("/mcp/cleaner-core", CLEANER_TOKEN, "save_property", { business: BUSINESS, address: ADDRESS, timeZone: "America/New_York" });
    await wired.tool("/mcp/cleaner-core", CLEANER_TOKEN, "save_people", { host: HOST, cleaner: CLEANER, observer: OBSERVER });
    await wired.tool("/mcp/cleaner-core", CLEANER_TOKEN, "save_calendar_link", { url: CALENDAR_URL });
    await wired.tool("/mcp/cleaner-core", CLEANER_TOKEN, "save_door_code", { code: DOOR_CODE });
    await wired.tool("/mcp/cleaner-core", CLEANER_TOKEN, "set_up_texting");
    const checks = await wired.tool("/mcp/cleaner-core", CLEANER_TOKEN, "run_checks");
    expect(checks.isError).toBe(false);
    const times = await wired.tool("/mcp/cleaner-core", CLEANER_TOKEN, "confirm_times", { checkout: "10:30 AM", checkIn: "3:00 PM" });
    expect(times.text).toMatch(/Nothing was sent/);
    expect(times.text).not.toMatch(/got one text/i);
    const inbound = await wired.postTwilio("/webhooks/twilio/cleaner-core", { from: CLEANER, to: CLEANER_LINE, body: "STOP", sid: "SM-live-off", token: CLEANER_AUTH });
    expect(inbound.raw).toBe("{}");
    expect(wired.cleanerSent).toEqual([]);
    expect(wired.tourSent).toEqual([]);
  });

  it("keeps a STOP on the number that was texted, even when it arrives on the other route", async () => {
    const wired = await app();
    await wired.tool("/mcp/cleaner-core", CLEANER_TOKEN, "get_state", { said: "2" });
    await wired.tool("/mcp/cleaner-core", CLEANER_TOKEN, "save_property", { business: BUSINESS, address: ADDRESS, timeZone: "America/New_York" });
    await wired.tool("/mcp/cleaner-core", CLEANER_TOKEN, "save_people", { host: HOST, cleaner: CLEANER, observer: OBSERVER });

    const tourHi = await wired.postTwilio("/webhooks/twilio", { from: CLEANER, to: TOUR_LINE, body: "Hi", sid: "SM-tour-hi", token: TOUR_AUTH });
    expect(tourHi.status).toBe(200);
    expect(tourHi.raw).toContain("ok");
    const tourReply = newer([], wired.tourSent).map((item) => item.body).join("\n");
    expect(tourReply).toMatch(/Tours by text|TOUR|YES/);
    expect(tourReply).not.toMatch(/cleaning texts/);
    expect(wired.cleanerSent).toEqual([]);

    const hostHi = await wired.postTwilio("/webhooks/twilio", { from: HOST, to: TOUR_LINE, body: "Hi", sid: "SM-host-hi", token: TOUR_AUTH });
    expect(hostHi.raw).not.toBe("{}");
    const hostStop = await wired.postTwilio("/webhooks/twilio/cleaner-core", { from: HOST, to: TOUR_LINE, body: "STOP", sid: "SM-host-stop", token: TOUR_AUTH });
    expect(hostStop.status).toBe(200);
    const hostStopSends = wired.tourSent.filter((item) => item.to === HOST && /opted out/i.test(item.body));
    expect(hostStopSends).toHaveLength(1);
    expect(hostStopSends[0]?.body).not.toMatch(/cleaning texts/);
    expect(wired.cleanerSent).toEqual([]);
    const booked = await wired.postTwilio("/webhooks/twilio", { from: HOST, to: TOUR_LINE, body: "book a tour", sid: "SM-host-book", token: TOUR_AUTH });
    expect(booked.status).toBe(200);
    const bookedSends = wired.tourSent.filter((item) => item.to === HOST).slice(hostStopSends.length + 1);
    expect(bookedSends).toEqual([]);

    const helpBeforeTour = wired.tourSent.length;
    const help = await wired.postTwilio("/webhooks/twilio", { from: CLEANER, to: CLEANER_LINE, body: "HELP", sid: "SM-clean-help", token: CLEANER_AUTH });
    expect(help.raw).toBe("{}");
    expect(wired.tourSent.length).toBe(helpBeforeTour);
    expect(wired.cleanerSent.map((item) => item.body).join("\n")).toMatch(/cleaning/i);

    const stopBeforeTour = wired.tourSent.length;
    const stop = await wired.postTwilio("/webhooks/twilio", { from: CLEANER, to: CLEANER_LINE, body: "STOP", sid: "SM-clean-stop", token: CLEANER_AUTH });
    expect(stop.raw).toBe("{}");
    expect(wired.tourSent.length).toBe(stopBeforeTour);
    expect(wired.cleanerSent.find((item) => item.to === CLEANER && /opted out/i.test(item.body))?.body).toMatch(/cleaning texts/);

    const stillTouring = await wired.postTwilio("/webhooks/twilio", { from: CLEANER, to: TOUR_LINE, body: "Hi again", sid: "SM-tour-again", token: TOUR_AUTH });
    expect(stillTouring.raw).toContain("ok");
    expect(wired.tourSent.filter((item) => item.to === CLEANER).length).toBeGreaterThan(1);
  });

  it("does not divert a text sent to the touring number, and stays quiet when cleaning is off", async () => {
    const on = await app();
    const tourText = await on.postTwilio("/webhooks/twilio", { from: HOST, to: TOUR_LINE, body: "Hi", sid: "SM-shared-tour", token: TOUR_AUTH });
    expect(tourText.raw).toContain("ok");
    expect(on.tourSent.some((item) => item.to === HOST)).toBe(true);
    expect(on.cleanerSent).toEqual([]);

    const off = await app({ enabled: false });
    const missing = await fetch(`http://127.0.0.1:${off.port}/webhooks/twilio/cleaner-core`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "Body=STOP",
    });
    expect(missing.status).toBe(404);
    const shared = await off.postTwilio("/webhooks/twilio", { from: HOST, to: TOUR_LINE, body: "Hi", sid: "SM-flag-off", token: TOUR_AUTH });
    expect(shared.raw).toContain("ok");
    expect(off.tourSent.some((item) => item.to === HOST)).toBe(true);
    expect(off.cleanerSent).toEqual([]);
  });

  it("rejects the other product's credential and lists only its own tools", async () => {
    const wired = await app();
    const cleanerWithTour = await wired.tool("/mcp/cleaner-core", TOUR_TOKEN, "save_door_code", { code: DOOR_CODE });
    expect(cleanerWithTour.status).toBe(401);
    expect(cleanerWithTour.raw).not.toContain(DOOR_CODE);
    const tourWithCleaner = await wired.tool("/mcp", CLEANER_TOKEN, "schedule_tour", {});
    expect(tourWithCleaner.status).toBe(401);

    const cleanerTools = await wired.listTools("/mcp/cleaner-core", CLEANER_TOKEN);
    expect(cleanerTools.names).toContain("save_door_code");
    expect(cleanerTools.names).not.toContain("schedule_tour");
    const tourTools = await wired.listTools("/mcp", TOUR_TOKEN);
    expect(tourTools.names).toContain("schedule_tour");
    expect(tourTools.names).not.toContain("save_door_code");

    const wrongTool = await wired.tool("/mcp/cleaner-core", CLEANER_TOKEN, "schedule_tour", {});
    expect(wrongTool.text).toMatch(/can't do that/i);
    const missing = await wired.tool("/mcp", TOUR_TOKEN, "save_door_code", { code: DOOR_CODE });
    expect(missing.raw).not.toContain(DOOR_CODE);
    expect(missing.text).toMatch(/no Tour Core tool/i);
  });

  it("asks by the job, and names Tour Core only in the reply that confirms that pick", async () => {
    const wired = await app();
    const first = await wired.tool("/mcp/cleaner-core", CLEANER_TOKEN, "get_state");
    expect(first.text).toContain(FIRST_QUESTION);
    expect(first.text).not.toMatch(PRODUCT);
    const picked = await wired.tool("/mcp/cleaner-core", CLEANER_TOKEN, "get_state", { said: "1" });
    expect(picked.text).toContain("That's Tour Core. It lets renters tour a unit on their own.");
    const later = await wired.tool("/mcp/cleaner-core", CLEANER_TOKEN, "get_state");
    expect(later.text).not.toMatch(PRODUCT);
    expect(later.text).toMatch(/property you want renters to tour/);
  });

  it("sends one STOP acknowledgement when the same text is delivered again, including after a restart", async () => {
    const wired = await app();
    await wired.tool("/mcp/cleaner-core", CLEANER_TOKEN, "get_state", { said: "2" });
    await wired.tool("/mcp/cleaner-core", CLEANER_TOKEN, "save_property", { business: BUSINESS, address: ADDRESS, timeZone: "America/New_York" });
    await wired.tool("/mcp/cleaner-core", CLEANER_TOKEN, "save_people", { host: HOST, cleaner: CLEANER, observer: OBSERVER });
    const sid = "SM-early-stop";
    const stop = { from: CLEANER, to: CLEANER_LINE, body: "STOP", sid, token: CLEANER_AUTH };
    const first = await wired.postTwilio("/webhooks/twilio/cleaner-core", stop);
    const second = await wired.postTwilio("/webhooks/twilio", stop);
    resetLiveDesks();
    const third = await wired.postTwilio("/webhooks/twilio/cleaner-core", stop);
    expect([first.raw, second.raw, third.raw]).toEqual(["{}", "{}", "{}"]);
    expect(wired.cleanerSent.map((item) => ({ to: item.to, body: item.body }))).toEqual([
      {
        to: CLEANER,
        body: `You're opted out of cleaning texts for ${ADDRESS}. You won't get cleaning offers or the door code. Reply START to opt back in. Reply HELP for help.`,
      },
    ]);
    const held = await wired.tool("/mcp/cleaner-core", CLEANER_TOKEN, "get_state");
    expect(held.text).toContain("The cleaner opted out of cleaning texts, so the job is on hold.");
  });

  it("sends the door code once when the departure text, START, and STOP are retried", async () => {
    const wired = await app();
    await wired.tool("/mcp/cleaner-core", CLEANER_TOKEN, "get_state", { said: "2" });
    await wired.tool("/mcp/cleaner-core", CLEANER_TOKEN, "save_property", { business: BUSINESS, address: ADDRESS, timeZone: "America/New_York" });
    await wired.tool("/mcp/cleaner-core", CLEANER_TOKEN, "save_people", { host: HOST, cleaner: CLEANER, observer: OBSERVER });
    await wired.tool("/mcp/cleaner-core", CLEANER_TOKEN, "save_calendar_link", { url: CALENDAR_URL });
    await wired.tool("/mcp/cleaner-core", CLEANER_TOKEN, "save_door_code", { code: DOOR_CODE });
    await wired.tool("/mcp/cleaner-core", CLEANER_TOKEN, "set_up_texting");
    await wired.tool("/mcp/cleaner-core", CLEANER_TOKEN, "run_checks");
    await wired.tool("/mcp/cleaner-core", CLEANER_TOKEN, "confirm_times", { checkout: "10:30 AM", checkIn: "3:00 PM" });
    await wired.postTwilio("/webhooks/twilio/cleaner-core", { from: CLEANER, to: CLEANER_LINE, body: "YES", sid: "SM-once-yes-1", token: CLEANER_AUTH });
    await wired.postTwilio("/webhooks/twilio/cleaner-core", { from: CLEANER, to: CLEANER_LINE, body: "YES", sid: "SM-once-yes-1", token: CLEANER_AUTH });
    await wired.postTwilio("/webhooks/twilio/cleaner-core", { from: CLEANER, to: CLEANER_LINE, body: "YES", sid: "SM-once-yes-2", token: CLEANER_AUTH });

    const left = { from: HOST, to: CLEANER_LINE, body: "The guests have left", sid: "SM-once-left", token: CLEANER_AUTH };
    await wired.postTwilio("/webhooks/twilio/cleaner-core", left);
    await wired.postTwilio("/webhooks/twilio", left);
    resetLiveDesks();
    const again = await wired.tool("/mcp/cleaner-core", CLEANER_TOKEN, "mark_guests_left", { said: "The guests have left" });
    expect(again.text).toContain("The cleaner already has the door code.");
    expect(wired.cleanerSent.filter((item) => item.body.includes(DOOR_CODE)).map((item) => ({ to: item.to, body: item.body }))).toEqual([
      { to: CLEANER, body: `Guests have left ${ADDRESS}. Door code: ${DOOR_CODE}. This code is only for you.` },
    ]);

    const stop = { from: CLEANER, to: CLEANER_LINE, body: "STOP", sid: "SM-once-stop", token: CLEANER_AUTH };
    await wired.postTwilio("/webhooks/twilio", stop);
    await wired.postTwilio("/webhooks/twilio/cleaner-core", stop);
    resetLiveDesks();
    await wired.postTwilio("/webhooks/twilio", stop);
    expect(wired.cleanerSent.filter((item) => item.to === CLEANER && item.body.startsWith("You're opted out of cleaning texts")).map((item) => item.body)).toEqual([
      `You're opted out of cleaning texts for ${ADDRESS}. You won't get cleaning offers or the door code. Reply START to opt back in. Reply HELP for help.`,
    ]);
    expect(wired.cleanerSent.filter((item) => item.to === HOST && item.body === `The cleaner opted out of cleaning texts for ${ADDRESS}, so the job is on hold.`)).toHaveLength(1);

    const start = { from: CLEANER, to: CLEANER_LINE, body: "START", sid: "SM-once-start", token: CLEANER_AUTH };
    const beforeStart = wired.cleanerSent.length;
    await wired.postTwilio("/webhooks/twilio/cleaner-core", start);
    await wired.postTwilio("/webhooks/twilio", start);
    resetLiveDesks();
    await wired.postTwilio("/webhooks/twilio/cleaner-core", start);
    expect(wired.cleanerSent.slice(beforeStart).map((item) => item.body)).toEqual([
      "You're opted back in. Reply YES if you still want this turnover. Reply STOP to opt out.",
    ]);
    expect(wired.cleanerSent.filter((item) => item.body.includes(DOOR_CODE))).toHaveLength(1);
  });

  it("catches a saved door code outside the file that stored it", () => {
    const code = ["9", "0", "8", "1", "7", "3", "6", "4"].join("");
    const dir = mkdtempSync(join(tmpdir(), "cleaner-secret-"));
    try {
      const sealed = { propertyId: "probe-property", pinSeal: sealPin(code, pinKeyFor("probe-property")) };
      writeFileSync(join(dir, "saved.json"), `${JSON.stringify(sealed)}\n`);
      writeFileSync(join(dir, "leak.txt"), `the code is ${code}\n`);
      const leaked = spawnSync(process.execPath, ["scripts/scan-cleaner-secrets.mjs", dir], { encoding: "utf8" });
      expect(leaked.status).not.toBe(0);
      expect(leaked.stderr).toMatch(/secret scan found a saved door code/);
      expect(leaked.stderr).not.toContain(code);
      expect(leaked.stdout).not.toContain(code);
      rmSync(join(dir, "leak.txt"));
      const clean = spawnSync(process.execPath, ["scripts/scan-cleaner-secrets.mjs", dir], { encoding: "utf8" });
      expect(clean.status).toBe(0);
      expect(clean.stdout).not.toContain(code);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function writeEvidence(input: { tools: string[]; sends: SentSms[]; stop: string; hostNote: string }): void {
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  const sends = input.sends.map((item) => ({ to: item.to, status: item.status, body: redactCode(item.body) }));
  const flow = {
    steps: [
      "setup",
      "confirm-times",
      "cleaner-yes-offer",
      "cleaner-yes-schedule",
      "guests-left",
      "guests-left-again",
      "stop",
      "start",
    ],
    tools: input.tools.map((text) => redactCode(text)),
    sends,
    stop: input.stop,
    hostNote: input.hostNote,
  };
  writeFileSync(join(EVIDENCE_DIR, "flow.json"), `${JSON.stringify(flow, null, 2)}\n`);
  writeFileSync(
    join(EVIDENCE_DIR, "result.txt"),
    ["wiring", "flow: pass", "failed-send: see failed-send.json", "door code: absent", ""].join("\n"),
  );
  const saved = readFileSync(join(EVIDENCE_DIR, "flow.json"), "utf8");
  if (saved.includes(DOOR_CODE)) throw new Error("wiring evidence contains the door code");
}
