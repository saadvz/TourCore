import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resetLiveDesks, setCleanerCalendarFetch } from "../src/cleaner-core/liveDesk";
import { setCleanerTwilioClient } from "../src/cleaner-core/liveSms";
import { openPin, pinKeyFor, pinKeyFromHeader, sealPin } from "../src/cleaner-core/pinSeal";
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
  PIN_KEY_HEADER,
  startWiredApp,
  TEST_PIN_KEY,
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
const PIN_SENT = "I sent the door code to the cleaner. I'll tell you if it doesn't go through.";
const PIN_FAILED = "The door code didn't reach the cleaner. Tell me the guests have left again and I'll resend it.";
const PIN_REPEAT = "I already sent the door code to the cleaner.";
const PIN_KEY_MISSING = "I can't send the door code yet. Let's finish setting up Cleaner Core first.";
const PIN_REENTER = "Please enter the door code again in the private box. Don't text it here.";
const PIN_CHAT = "Please don't send the door code in chat. Use the private box instead.";
const DIRECT_REPLY = "Got it. To send the door code, tell your Grok Bot the guests have left. The cleaner is still waiting for the OK.";
const HOST_LEAK = /\b(webhook|key|request|queued)\b/i;
const FALSE_RETRY = /try again in a few minutes|we'll try again/i;

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
    const timeText = await wired.postTwilio("/webhooks/twilio/cleaner-core", { from: HOST, to: CLEANER_LINE, body: "10:30 AM", sid: "SM-direct-time", token: CLEANER_AUTH });
    http.push(timeText.raw);
    expect(timeText.status).toBe(200);
    expect(toCleaner(wired.cleanerSent)).toEqual([]);
    const afterTimeText = await wired.tool("/mcp/cleaner-core", CLEANER_TOKEN, "get_turns");
    remember(afterTimeText);
    expect(afterTimeText.text).not.toContain("10:30");

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
    const directBefore = wired.cleanerSent.length;
    const direct = await wired.postTwilio("/webhooks/twilio/cleaner-core", { from: HOST, to: CLEANER_LINE, body: "guests left", sid: "SM-direct-left", token: CLEANER_AUTH });
    http.push(direct.raw);
    expect(direct.status).toBe(200);
    const directSends = newer(wired.cleanerSent.slice(0, directBefore), wired.cleanerSent);
    expect(directSends.map((item) => item.body)).toEqual([]);
    const directState = await wired.tool("/mcp/cleaner-core", CLEANER_TOKEN, "get_state");
    remember(directState);
    expect(directState.text).toContain(DIRECT_REPLY);
    expect(directSends.some((item) => item.body.includes(DOOR_CODE))).toBe(false);
    const waiting = await wired.tool("/mcp/cleaner-core", CLEANER_TOKEN, "get_turns");
    remember(waiting);
    expect(waiting.text).toContain("\"status\":\"confirmed\"");
    expect(waiting.text).not.toContain("cleared");

    const left = await wired.tool("/mcp/cleaner-core", CLEANER_TOKEN, "mark_guests_left", { said: "The guests have left" });
    remember(left);
    expect(left.text).toContain(PIN_SENT);
    expect(left.text).not.toMatch(HOST_LEAK);
    expect(left.text).not.toMatch(FALSE_RETRY);
    const pinTexts = toCleaner(wired.cleanerSent).filter((item) => item.body.includes(DOOR_CODE));
    expect(pinTexts).toHaveLength(1);
    expect(pinTexts[0]?.to).toBe(CLEANER);
    expect(pinTexts[0]?.body).toBe(`Guests have left ${ADDRESS}. Door code: ${DOOR_CODE}. This code is only for you.`);
    expect(pinTexts[0]?.statusCallback).toBe("https://tour.example/webhooks/twilio/cleaner-core/status");
    expect(wired.cleanerSent.filter((item) => item.to !== CLEANER && item.body.includes(DOOR_CODE))).toEqual([]);
    expect(leftBefore.some((body) => body.includes(DOOR_CODE))).toBe(false);

    const again = await wired.tool("/mcp/cleaner-core", CLEANER_TOKEN, "mark_guests_left", { said: "The guests have left" });
    remember(again);
    expect(again.text).toContain(PIN_REPEAT);
    expect(toCleaner(wired.cleanerSent).filter((item) => item.body.includes(DOOR_CODE))).toHaveLength(1);

    const stopBefore = wired.cleanerSent.length;
    const stopped = await wired.postTwilio("/webhooks/twilio/cleaner-core", { from: CLEANER, to: CLEANER_LINE, body: "STOP", sid: "SM-stop", token: CLEANER_AUTH });
    http.push(stopped.raw);
    expect(stopped.raw).toBe("{}");
    const stopSends = newer(wired.cleanerSent.slice(0, stopBefore), wired.cleanerSent);
    expect(stopSends.find((item) => item.to === CLEANER)?.body).toBe(
      `You're opted out of cleaning texts for ${ADDRESS}. You won't get cleaning offers or the door code. Reply START to opt back in. Reply HELP for help.`,
    );
    const stopNote = `The cleaner opted out of cleaning texts for ${ADDRESS}, so the job is on hold.`;
    expect(stopSends.filter((item) => item.to === HOST).map((item) => item.body)).toEqual([stopNote]);
    const held = await wired.tool("/mcp/cleaner-core", CLEANER_TOKEN, "get_state");
    remember(held);
    expect(held.text).toContain(stopNote);

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
      expect(text).not.toMatch(FALSE_RETRY);
      expect(text).not.toMatch(HOST_LEAK);
    }
    expect(http.join("\n")).not.toContain(DOOR_CODE);
    expect(tools.join("\n")).not.toContain(DOOR_CODE);
    const captured = [...tools, ...http, ...bodies(wired.cleanerSent), ...wired.logs].join("\n");
    expect(wired.cleanerSent.filter((item) => item.to === HOST).some((item) => /send the new time/i.test(item.body))).toBe(false);
    expect(captured).not.toContain(TEST_PIN_KEY);
    const store = readFileSync(join(wired.root, "cleaner-live.json"), "utf8");
    expect(store).not.toContain(DOOR_CODE);
    expect(store).not.toContain(TEST_PIN_KEY);
    const sealed = JSON.parse(store) as { propertyId: string; pinSeal: { iv: string; tag: string; data: string } };
    expect(pinKeyFromHeader(undefined)).toBeUndefined();
    expect(() => openPin(sealed.pinSeal, pinKeyFor(sealed.propertyId))).toThrow();

    writeEvidence({
      tools,
      sends: wired.cleanerSent,
      stop: stopSends.find((item) => item.to === CLEANER)?.body ?? "",
      hostNote: stopNote,
      directReply: DIRECT_REPLY,
    });
  });

  it("tells the host once after an undelivered callback and resends only on the next tool call", async () => {
    const wired = await app();
    await throughSchedule(wired, "fail");
    const marked = await wired.tool("/mcp/cleaner-core", CLEANER_TOKEN, "mark_guests_left", { said: "The guests have left" });
    expect(marked.text).toContain(PIN_SENT);
    expect(marked.raw).not.toContain(DOOR_CODE);
    expect(marked.raw).not.toContain(TEST_PIN_KEY);
    const attempt = toCleaner(wired.cleanerSent).find((item) => item.body.includes(DOOR_CODE));
    expect(attempt).toMatchObject({ to: CLEANER, status: "queued" });
    expect(attempt?.statusCallback).toBe("https://tour.example/webhooks/twilio/cleaner-core/status");
    const pins = () => toCleaner(wired.cleanerSent).filter((item) => item.body.includes(DOOR_CODE));
    expect(pins()).toHaveLength(1);

    const queued = await wired.postStatus({ sid: attempt?.sid ?? "", status: "queued" });
    expect(queued.status).toBe(200);
    const repeat = await wired.tool("/mcp/cleaner-core", CLEANER_TOKEN, "mark_guests_left", { said: "The guests have left" });
    expect(repeat.text).toContain(PIN_REPEAT);
    expect(pins()).toHaveLength(1);

    const failed = await wired.postStatus({ sid: attempt?.sid ?? "", status: "undelivered" });
    expect(failed.status).toBe(200);
    expect(failed.raw).toBe("{}");
    expect(pins()).toHaveLength(1);
    expect(wired.cleanerSent.filter((item) => item.to === HOST && item.body === PIN_FAILED)).toHaveLength(1);

    const noted = await wired.tool("/mcp/cleaner-core", CLEANER_TOKEN, "get_state");
    expect(noted.text).toContain(PIN_FAILED);
    expect(noted.text).not.toMatch(FALSE_RETRY);
    expect(noted.text).not.toMatch(HOST_LEAK);
    expect(noted.raw).not.toContain(DOOR_CODE);
    expect(noted.raw).not.toContain(TEST_PIN_KEY);
    expect(pins()).toHaveLength(1);

    const replay = await wired.postStatus({ sid: attempt?.sid ?? "", status: "undelivered" });
    expect(replay.status).toBe(200);
    const again = await wired.tool("/mcp/cleaner-core", CLEANER_TOKEN, "get_state");
    expect(again.text).not.toContain(PIN_FAILED);
    expect(pins()).toHaveLength(1);

    const resent = await wired.tool("/mcp/cleaner-core", CLEANER_TOKEN, "mark_guests_left", { said: "The guests have left" });
    expect(resent.text).toContain(PIN_SENT);
    expect(pins()).toHaveLength(2);
    expect(wired.cleanerSent.filter((item) => item.to === HOST).map((item) => item.body).join("\n")).not.toMatch(FALSE_RETRY);

    mkdirSync(EVIDENCE_DIR, { recursive: true });
    const evidence = `${JSON.stringify(
      {
        tool: redactCode(marked.text),
        hostNote: PIN_FAILED,
        hostSms: wired.cleanerSent.filter((item) => item.to === HOST).map((item) => redactCode(item.body)),
        attempt: { to: attempt?.to, status: "queued", body: attempt ? redactCode(attempt.body) : "" },
        callback: "undelivered",
        replay: "no further send",
        resend: "mark_guests_left",
      },
      null,
      2,
    )}\n`;
    expect(evidence).not.toContain(DOOR_CODE);
    expect(evidence).not.toContain(TEST_PIN_KEY);
    writeFileSync(join(EVIDENCE_DIR, "failed-send.json"), evidence);
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
    expect(wired.cleanerSent).toEqual([]);
    const afterHelp = await wired.tool("/mcp/cleaner-core", CLEANER_TOKEN, "get_state");
    expect(afterHelp.text).not.toContain("on hold");

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
    expect(wired.cleanerSent.filter((item) => item.body.includes(DOOR_CODE))).toEqual([]);
    expect(wired.cleanerSent.filter((item) => item.body === DIRECT_REPLY)).toHaveLength(0);
    const directState = await wired.tool("/mcp/cleaner-core", CLEANER_TOKEN, "get_state");
    expect(directState.text).toContain(DIRECT_REPLY);
    resetLiveDesks();
    const sent = await wired.tool("/mcp/cleaner-core", CLEANER_TOKEN, "mark_guests_left", { said: "The guests have left" });
    expect(sent.text).toContain(PIN_SENT);
    const again = await wired.tool("/mcp/cleaner-core", CLEANER_TOKEN, "mark_guests_left", { said: "The guests have left" });
    expect(again.text).toContain(PIN_REPEAT);
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
    const stopState = await wired.tool("/mcp/cleaner-core", CLEANER_TOKEN, "get_state");
    expect(stopState.text).toContain(`The cleaner opted out of cleaning texts for ${ADDRESS}, so the job is on hold.`);

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

  it("refuses to seal or send when the header key is missing or wrong", async () => {
    const wired = await app();
    await wired.tool("/mcp/cleaner-core", CLEANER_TOKEN, "get_state", { said: "2" });
    await wired.tool("/mcp/cleaner-core", CLEANER_TOKEN, "save_property", { business: BUSINESS, address: ADDRESS, timeZone: "America/New_York" });
    await wired.tool("/mcp/cleaner-core", CLEANER_TOKEN, "save_people", { host: HOST, cleaner: CLEANER, observer: OBSERVER });
    await wired.tool("/mcp/cleaner-core", CLEANER_TOKEN, "save_calendar_link", { url: CALENDAR_URL });
    const missing = await wired.tool("/mcp/cleaner-core", CLEANER_TOKEN, "save_door_code", { code: DOOR_CODE }, { pinKey: null });
    expect(missing.isError).toBe(true);
    expect(missing.text).toBe(PIN_KEY_MISSING);
    expect(missing.raw).not.toContain(DOOR_CODE);
    const savedPath = join(wired.root, "cleaner-live.json");
    const beforeSeal = readFileSync(savedPath, "utf8");
    expect(beforeSeal).not.toContain("pinSeal");
    expect(beforeSeal).not.toContain(DOOR_CODE);

    await wired.tool("/mcp/cleaner-core", CLEANER_TOKEN, "save_door_code", { code: DOOR_CODE });
    await wired.tool("/mcp/cleaner-core", CLEANER_TOKEN, "set_up_texting");
    await wired.tool("/mcp/cleaner-core", CLEANER_TOKEN, "run_checks");
    await wired.tool("/mcp/cleaner-core", CLEANER_TOKEN, "confirm_times", { checkout: "10:30 AM", checkIn: "3:00 PM" });
    await wired.postTwilio("/webhooks/twilio/cleaner-core", { from: CLEANER, to: CLEANER_LINE, body: "YES", sid: "SM-key-yes-1", token: CLEANER_AUTH });
    await wired.postTwilio("/webhooks/twilio/cleaner-core", { from: CLEANER, to: CLEANER_LINE, body: "YES", sid: "SM-key-yes-2", token: CLEANER_AUTH });
    const wrongKey = Buffer.alloc(32, 9).toString("base64");
    const wrong = await wired.tool("/mcp/cleaner-core", CLEANER_TOKEN, "mark_guests_left", { said: "The guests have left" }, { pinKey: wrongKey });
    expect(wrong.isError).toBe(true);
    expect(wrong.text).toBe(PIN_REENTER);
    expect(wrong.raw).not.toContain(DOOR_CODE);
    expect(wrong.raw).not.toContain(wrongKey);
    expect(toCleaner(wired.cleanerSent).filter((item) => item.body.includes(DOOR_CODE))).toEqual([]);
    const stored = readFileSync(savedPath, "utf8");
    expect(stored).not.toContain(wrongKey);
    expect(stored).not.toContain(TEST_PIN_KEY);
    expect(stored).not.toContain(DOOR_CODE);
    const absent = await wired.tool("/mcp/cleaner-core", CLEANER_TOKEN, "mark_guests_left", { said: "The guests have left" }, { pinKey: null });
    expect(absent.text).toBe(PIN_KEY_MISSING);
    expect(toCleaner(wired.cleanerSent).filter((item) => item.body.includes(DOOR_CODE))).toEqual([]);

    const parsed = JSON.parse(stored) as { propertyId: string; pinSeal: { iv: string; tag: string; data: string } };
    parsed.pinSeal = sealPin(DOOR_CODE, pinKeyFor(parsed.propertyId));
    writeFileSync(savedPath, `${JSON.stringify(parsed)}\n`);
    resetLiveDesks();
    const stale = await wired.tool("/mcp/cleaner-core", CLEANER_TOKEN, "mark_guests_left", { said: "The guests have left" });
    expect(stale.text).toBe(PIN_REENTER);
    expect(toCleaner(wired.cleanerSent).filter((item) => item.body.includes(DOOR_CODE))).toEqual([]);
    expect(readFileSync(savedPath, "utf8")).not.toContain(TEST_PIN_KEY);
  });

  it("keeps the door-code key out of the tool schema and out of chat replies", async () => {
    const wired = await app();
    const listed = await wired.listTools("/mcp/cleaner-core", CLEANER_TOKEN);
    const tools = JSON.parse(listed.raw) as { result?: { tools?: Array<{ name: string; inputSchema?: { properties?: Record<string, unknown> } }> } };
    expect(listed.raw).not.toContain(TEST_PIN_KEY);
    expect(listed.raw).not.toContain(PIN_KEY_HEADER);
    for (const tool of tools.result?.tools ?? []) {
      expect(Object.keys(tool.inputSchema?.properties ?? {}).join(" ")).not.toMatch(/key/i);
    }
    await wired.tool("/mcp/cleaner-core", CLEANER_TOKEN, "get_state", { said: "2" });
    await wired.tool("/mcp/cleaner-core", CLEANER_TOKEN, "save_property", { business: BUSINESS, address: ADDRESS, timeZone: "America/New_York" });
    await wired.tool("/mcp/cleaner-core", CLEANER_TOKEN, "save_people", { host: HOST, cleaner: CLEANER, observer: OBSERVER });
    await wired.tool("/mcp/cleaner-core", CLEANER_TOKEN, "save_calendar_link", { url: CALENDAR_URL });
    const chat = await wired.tool("/mcp/cleaner-core", CLEANER_TOKEN, "get_state", { said: DOOR_CODE });
    expect(chat.isError).toBe(true);
    expect(chat.text).toBe(PIN_CHAT);
    expect(chat.raw).not.toContain(DOOR_CODE);
    await wired.tool("/mcp/cleaner-core", CLEANER_TOKEN, "save_door_code", { code: DOOR_CODE });
    const echoed = await wired.tool("/mcp/cleaner-core", CLEANER_TOKEN, "get_state", { said: `the door code is ${DOOR_CODE}` });
    expect(echoed.text).toBe(PIN_CHAT);
    expect(echoed.raw).not.toContain(DOOR_CODE);
    expect(echoed.raw).not.toContain(TEST_PIN_KEY);
    const unsigned = await wired.postStatus({ sid: "SM-unsigned", status: "undelivered", signed: false });
    expect(unsigned.status).toBe(403);
    expect(unsigned.raw).not.toContain(DOOR_CODE);
  });

  it("catches a saved door code outside the file that stored it", () => {
    const code = ["9", "0", "8", "1", "7", "3", "6", "4"].join("");
    const dir = mkdtempSync(join(tmpdir(), "cleaner-secret-"));
    const scanner = readFileSync("scripts/scan-cleaner-secrets.mjs", "utf8");
    const allow = scanner.match(/const allow = new Set\(\[([\s\S]*?)\]\)/)?.[1] ?? "";
    expect(allow).not.toContain("tenants.ts");
    try {
      const sealed = { propertyId: "probe-property", pinSeal: sealPin(code, Buffer.from("cleaner-core-scanner-test-key!!!")) };
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

      const hidden = ["6", "4", "2", "0", "8", "1", "3", "5"].join("");
      const propertySeal = { propertyId: "probe-property", pinSeal: sealPin(hidden, pinKeyFor("probe-property")) };
      writeFileSync(join(dir, "saved.json"), `${JSON.stringify(propertySeal)}\n`);
      writeFileSync(join(dir, "leak.txt"), `the code is ${hidden}\n`);
      const missed = spawnSync(process.execPath, ["scripts/scan-cleaner-secrets.mjs", dir], { encoding: "utf8" });
      expect(missed.status).toBe(0);
      expect(missed.stdout).not.toContain(hidden);
      expect(missed.stderr).not.toContain(hidden);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

async function throughSchedule(wired: WiredApp, tag: string): Promise<void> {
  await wired.tool("/mcp/cleaner-core", CLEANER_TOKEN, "get_state", { said: "2" });
  await wired.tool("/mcp/cleaner-core", CLEANER_TOKEN, "save_property", { business: BUSINESS, address: ADDRESS, timeZone: "America/New_York" });
  await wired.tool("/mcp/cleaner-core", CLEANER_TOKEN, "save_people", { host: HOST, cleaner: CLEANER, observer: OBSERVER });
  await wired.tool("/mcp/cleaner-core", CLEANER_TOKEN, "save_calendar_link", { url: CALENDAR_URL });
  await wired.tool("/mcp/cleaner-core", CLEANER_TOKEN, "save_door_code", { code: DOOR_CODE });
  await wired.tool("/mcp/cleaner-core", CLEANER_TOKEN, "set_up_texting");
  await wired.tool("/mcp/cleaner-core", CLEANER_TOKEN, "run_checks");
  await wired.tool("/mcp/cleaner-core", CLEANER_TOKEN, "confirm_times", { checkout: "10:30 AM", checkIn: "3:00 PM" });
  await wired.postTwilio("/webhooks/twilio/cleaner-core", { from: CLEANER, to: CLEANER_LINE, body: "YES", sid: `${tag}-yes-1`, token: CLEANER_AUTH });
  await wired.postTwilio("/webhooks/twilio/cleaner-core", { from: CLEANER, to: CLEANER_LINE, body: "YES", sid: `${tag}-yes-2`, token: CLEANER_AUTH });
}

function writeEvidence(input: { tools: string[]; sends: SentSms[]; stop: string; hostNote: string; directReply: string }): void {
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  const sends = input.sends.map((item) => ({ to: item.to, status: item.status, body: redactCode(item.body) }));
  const flow = {
    steps: [
      "setup-via-tool",
      "direct-time-text-ignored",
      "confirm-times-via-tool",
      "cleaner-yes-offer",
      "cleaner-yes-schedule",
      "direct-guests-left-sends-nothing",
      "mark-guests-left-via-tool",
      "mark-guests-left-again",
      "stop",
      "start",
    ],
    tools: input.tools.map((text) => redactCode(text)),
    sends,
    stop: input.stop,
    hostNote: input.hostNote,
    directReply: input.directReply,
    directTextSendsDoorCode: false,
  };
  writeFileSync(join(EVIDENCE_DIR, "flow.json"), `${JSON.stringify(flow, null, 2)}\n`);
  writeFileSync(
    join(EVIDENCE_DIR, "result.txt"),
    ["wiring", "flow: pass", "direct-text: no door code", "failed-send: see failed-send.json", "door code: absent", ""].join("\n"),
  );
  const saved = readFileSync(join(EVIDENCE_DIR, "flow.json"), "utf8");
  if (saved.includes(DOOR_CODE)) throw new Error("wiring evidence contains the door code");
  if (saved.includes(TEST_PIN_KEY)) throw new Error("wiring evidence contains the pin key");
}
