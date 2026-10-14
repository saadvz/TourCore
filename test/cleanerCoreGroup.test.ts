import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { groupDoorCodeBody, groupOptInBody, groupTimeLine, holdNote, privateCodeLine, resumeNote } from "../src/cleaner-core/cleanerTexts";
import { openCleanerCore, type CleanerText } from "../src/cleaner-core/core";
import { liveDeskFor, resetLiveDesks, setCleanerCalendarFetch } from "../src/cleaner-core/liveDesk";
import { sendLiveGroup, sendLiveSms, setCleanerGroupFetch, setCleanerTwilioClient } from "../src/cleaner-core/liveSms";
import { SCRATCH_TENANTS } from "../src/cleaner-core/tenants";
import { ADDRESS as PRACTICE, CALENDAR_ICS, CALENDAR_URL, CLEANER as LIVE_CLEANER, CLEANER_LINE, DOOR_CODE, fakeSms, FROZEN, HOST as LIVE_HOST, OBSERVER, TEST_PIN_KEY } from "./wiringProof";

const ADDRESS = "12 Scratch Lane, Teaneck, NJ 07666";
const OWNER = "+15555550100";
const CLEANER = "+15555550101";
const EXTRA = "+15555550122";
const NOW = "2026-10-14T15:00:00.000Z";
const lane = SCRATCH_TENANTS[0];
if (!lane) throw new Error("Scratch Lane is missing");
const PIN = lane.pin;
const OPT_CLEANER = groupOptInBody("Maria", "Cory", ADDRESS);
const OPT_HOST = groupOptInBody("Cory", "Maria", ADDRESS);
const OPT_EXTRA = groupOptInBody("Alex", "Cory and Maria", ADDRESS);
const GROUP_PIN = groupDoorCodeBody("Maria", ADDRESS, PIN);
const PRIVATE_PIN = `Guests have left ${ADDRESS}. Door code: ${PIN}. This code is only for you.`;
const PRIVATE_LINE = privateCodeLine("Maria");
const TIME_LINE = groupTimeLine("Cory");
const HOLD = holdNote(ADDRESS);
const RESUME = resumeNote(ADDRESS);
const OFFER = "Turnover at 12 Scratch Lane, Teaneck, NJ 07666 on Sunday, Oct 18. Checkout 11:00 AM, next guest 4:00 PM. Reply YES to schedule it, or STOP to opt out.";
const CONFIRM = "Cleaning is scheduled for Sunday, Oct 18 at 11:00 AM at 12 Scratch Lane, Teaneck, NJ 07666.";
const HURT = "If someone is hurt, call 911 now. I've let the host know.";
const HOST_HURT = "The cleaner at 12 Scratch Lane, Teaneck, NJ 07666 says someone is hurt. They've been told to call 911.";
const HOST_HURT_SELF = "If someone is hurt, call 911 now.";
const STOP_ACK = "You're opted out and won't receive more messages. Reply START to opt back in. Reply HELP for help.";
const STOP_HOLD = `The cleaner opted out of cleaning texts for ${ADDRESS}, so the job is on hold.`;
const ALREADY = "I already sent the door code to the cleaner.";
const PIN_MISSING = "I can't send the door code yet. Let's finish setting up Cleaner Core first.";
const FAILED_ONCE = "A text failed to send. I saved it for your review and did not count it as delivered.";
const FEED = readFileSync(join("src/cleaner-core/fixtures", "guesty-lite-scratch.ics"), "utf8");

function box() {
  const sent: CleanerText[] = [];
  return { sent, async send(text: CleanerText) { sent.push(text); } };
}

function failingBox() {
  const sent: CleanerText[] = [];
  return {
    sent,
    async send(text: CleanerText) {
      if (text.kind === "pin") throw new Error("send failed");
      sent.push(text);
    },
  };
}

function open(sent: { send(text: CleanerText): void | Promise<void> }, extra = false) {
  return openCleanerCore({
    enabled: true,
    property: { id: "prop_12_scratch_lane", address: ADDRESS, timeZone: "America/New_York" },
    ownerPhone: OWNER,
    cleaner: { phone: CLEANER, approved: true },
    pin: PIN,
    hostName: "Scratch",
    consented: true,
    sink: sent,
    now: () => new Date(NOW),
    groupChat: {
      hostName: "Cory",
      cleanerName: "Maria",
      ...(extra ? { extra: [{ phone: EXTRA, name: "Alex" }] } : {}),
    },
  });
}

async function joined(sent: ReturnType<typeof box>, extra = false) {
  const job = open(sent, extra);
  await job.pollFeed(FEED);
  await job.receive({ id: "host-yes", from: OWNER, text: "YES" });
  await job.receive({ id: "cleaner-yes", from: CLEANER, text: "YES" });
  if (extra) await job.receive({ id: "extra-yes", from: EXTRA, text: "YES" });
  await job.confirmHostTimes({ checkout: "11:00 AM", checkIn: "4:00 PM" });
  await job.receive({ id: "schedule", from: CLEANER, text: "YES" });
  return job;
}

function groupTexts(sent: CleanerText[]): CleanerText[] {
  return sent.filter((text) => text.channel === "group");
}

describe("group thread", () => {
  it("opts both people in one-on-one before any group text", async () => {
    const sent = box();
    const job = open(sent);
    await job.pollFeed(FEED);
    expect(groupTexts(sent.sent)).toEqual([]);
    expect(sent.sent.filter((text) => text.kind === "opt-in")).toEqual([
      { to: CLEANER, body: OPT_CLEANER, kind: "opt-in" },
      { to: OWNER, body: OPT_HOST, kind: "opt-in" },
    ]);
    await job.receive({ id: "host-yes", from: OWNER, text: "YES" });
    expect(groupTexts(sent.sent)).toEqual([]);
    expect(sent.sent.filter((text) => text.to === CLEANER && text.channel === "group")).toEqual([]);
  });

  it("sends the door code to the group only when Cory and the approved cleaner have both opted in", async () => {
    const sent = box();
    const job = await joined(sent);
    const before = sent.sent.length;
    const left = await job.receive({ id: "left-1", from: OWNER, text: "guests have left" });
    expect(left.sent.filter((text) => text.kind === "pin")).toEqual([
      { to: CLEANER, body: GROUP_PIN, kind: "pin", channel: "group", audience: [OWNER, CLEANER] },
    ]);
    expect(sent.sent.slice(before).filter((text) => text.kind === "pin")).toEqual(left.sent.filter((text) => text.kind === "pin"));
    expect(job.transcript().join("\n").includes(PIN)).toBe(false);
    expect(job.outbox().map((item) => item.body).join("\n").includes(PIN)).toBe(false);
    expect(JSON.stringify(job.jobs()).includes(PIN)).toBe(false);
    expect(JSON.stringify(job.reviews()).includes(PIN)).toBe(false);
    expect(sent.sent.filter((text) => text.to === OWNER && text.channel !== "group").some((text) => text.body.includes(PIN))).toBe(false);
    const again = await job.receive({ id: "left-2", from: OWNER, text: "guests have left" });
    expect(again.sent.filter((text) => text.kind === "pin")).toEqual([]);
    expect(sent.sent.filter((text) => text.kind === "pin")).toHaveLength(1);
  });

  it("sends the code one-on-one when someone else is in the group, and tells the group it went privately", async () => {
    const sent = box();
    const job = await joined(sent, true);
    expect(sent.sent.filter((text) => text.kind === "opt-in" && text.to === EXTRA)).toEqual([
      { to: EXTRA, body: OPT_EXTRA, kind: "opt-in" },
    ]);
    const left = await job.receive({ id: "left-extra", from: OWNER, text: "guests have left" });
    expect(left.sent.filter((text) => text.kind === "pin")).toEqual([
      { to: CLEANER, body: PRIVATE_PIN, kind: "pin" },
    ]);
    expect(left.sent.filter((text) => text.channel === "group")).toEqual([
      { to: CLEANER, body: PRIVATE_LINE, kind: "pin-notice", channel: "group", audience: [OWNER, CLEANER, EXTRA] },
    ]);
    expect(left.sent.filter((text) => text.channel === "group").some((text) => text.body.includes(PIN))).toBe(false);
    expect(sent.sent.filter((text) => text.to === EXTRA).every((text) => !text.body.includes(PIN))).toBe(true);
  });

  it("holds the code when the cleaner has not opted in or has opted out", async () => {
    const waiting = box();
    const held = open(waiting);
    await held.pollFeed(FEED);
    await held.confirmHostTimes({ checkout: "11:00 AM", checkIn: "4:00 PM" });
    const early = await held.receive({ id: "left-early", from: OWNER, text: "guests have left" });
    expect(early.sent.filter((text) => text.kind === "pin" || text.body.includes(PIN))).toEqual([]);
    expect(held.jobOnHold()).toBe(false);

    const sent = box();
    const job = await joined(sent);
    const stopped = await job.receive({ id: "stop-cleaner", from: CLEANER, text: "STOP", channel: "group" });
    expect(stopped.sent).toEqual([
      { to: CLEANER, body: STOP_ACK, kind: "stop" },
      { to: OWNER, body: STOP_HOLD, kind: "stop" },
    ]);
    expect(job.jobOnHold()).toBe(true);
    const left = await job.receive({ id: "left-out", from: OWNER, text: "guests have left" });
    expect(left.sent.filter((text) => text.kind === "pin" || text.body.includes(PIN) || text.channel === "group")).toEqual([]);
    expect(sent.sent.filter((text) => text.to === CLEANER).every((text) => text.kind === "opt-in" || text.kind === "offer" || text.kind === "confirm" || text.kind === "stop" || text.body === OFFER || text.body === CONFIRM || text.body === STOP_ACK)).toBe(true);
    expect(sent.sent.filter((text) => text.body.includes(PIN))).toEqual([]);
  });

  it("sends the door code privately after Cory opts out", async () => {
    const sent = box();
    const job = await joined(sent);
    await job.receive({ id: "stop-cory", from: OWNER, text: "STOP", channel: "group" });
    const left = await job.receive({ id: "left-cory-out", from: OWNER, text: "guests have left" });
    expect(left.sent.filter((text) => text.kind === "pin")).toEqual([{ to: CLEANER, body: PRIVATE_PIN, kind: "pin" }]);
    expect(left.sent.filter((text) => text.channel === "group")).toEqual([
      { to: CLEANER, body: PRIVATE_LINE, kind: "pin-notice", channel: "group", audience: [CLEANER] },
    ]);
  });

  it("removes only the person who sent STOP, and only Cory can resume", async () => {
    const sent = box();
    const job = await joined(sent);
    await job.receive({ id: "stop-host", from: OWNER, text: "STOP", channel: "group" });
    const afterHost = await job.receive({ id: "time-after-host", from: CLEANER, text: "Can we do 2:00 PM?", channel: "group" });
    expect(afterHost.sent).toEqual([
      { to: CLEANER, body: TIME_LINE, kind: "confirm", channel: "group", audience: [CLEANER] },
    ]);
    expect(sent.sent.filter((text) => text.to === OWNER && text.body === TIME_LINE)).toEqual([]);

    const fresh = box();
    const held = await joined(fresh);
    await held.receive({ id: "stop-cleaner", from: CLEANER, text: "STOP" });
    expect(held.jobOnHold()).toBe(true);
    const ignored = await held.receive({ id: "start-again", from: CLEANER, text: "START" });
    expect(ignored.sent).toEqual([]);
    expect(held.jobOnHold()).toBe(true);
    const resumed = await held.resumeJob();
    expect(resumed).toEqual({ to: OWNER, body: RESUME, kind: "resume" });
    expect(held.jobOnHold()).toBe(false);
    const second = await held.resumeJob();
    expect(second).toBeNull();
    expect(fresh.sent.filter((text) => text.body === RESUME)).toEqual([resumed]);
    expect(fresh.sent.filter((text) => text.to === CLEANER && text.body === RESUME)).toEqual([]);
    const after = await held.receive({ id: "after-stop", from: OWNER, text: "Are you on the way?", channel: "group" });
    expect(after.sent.filter((text) => text.audience?.includes(CLEANER))).toEqual([]);
  });

  it("does not move a time texted in the group, and does not retry a failed group send", async () => {
    const sent = box();
    const job = await joined(sent);
    const clock = job.jobs().find((item) => item.checkoutTime === "11:00 AM");
    expect(clock?.checkoutTime).toBe("11:00 AM");
    const timed = await job.receive({ id: "group-time", from: CLEANER, text: "Let's say 2:00 PM", channel: "group" });
    expect(timed.sent).toEqual([
      { to: CLEANER, body: TIME_LINE, kind: "confirm", channel: "group", audience: [OWNER, CLEANER] },
    ]);
    expect(job.jobs().find((item) => item.id === clock?.id)?.checkoutTime).toBe("11:00 AM");
    const quiet = await job.receive({ id: "cory-quiet", from: OWNER, text: "Sounds good", channel: "group" });
    expect(quiet.sent).toEqual([]);

    const failed = failingBox();
    const broken = await joined(failed);
    const first = await broken.receive({ id: "left-fail", from: OWNER, text: "guests have left" });
    expect(first.sent.filter((text) => text.kind === "pin")).toEqual([]);
    expect(broken.groupPinSettled()).toBe(true);
    const reminded = await broken.runReminders();
    expect(reminded.sent.filter((text) => text.kind === "pin")).toEqual([]);
    const second = await broken.receive({ id: "left-fail-2", from: OWNER, text: "guests have left" });
    expect(second.sent.filter((text) => text.kind === "pin")).toEqual([]);
    expect(failed.sent.filter((text) => text.kind === "pin")).toEqual([]);
  });

  it("answers a group injury with the one-on-one 911 text before any group reply", async () => {
    const sent = box();
    const job = await joined(sent);
    const before = sent.sent.length;
    const hurt = await job.receive({ id: "fell", from: CLEANER, text: "I fell at 2:00 PM and I'm hurt", channel: "group" });
    expect(hurt.sent).toEqual([
      { to: OWNER, body: HOST_HURT, kind: "emergency" },
      { to: CLEANER, body: HURT, kind: "emergency" },
    ]);
    expect(sent.sent.slice(before).some((text) => text.channel === "group" || text.body === TIME_LINE || text.body === HOLD)).toBe(false);
    const host = await job.receive({ id: "host-fell", from: OWNER, text: "someone is hurt", channel: "group" });
    expect(host.sent).toEqual([{ to: OWNER, body: HOST_HURT_SELF, kind: "emergency" }]);
  });

  it("holds a problem for Cory and keeps the group from seeing the hold", async () => {
    const sent = box();
    const job = await joined(sent);
    const problem = await job.receive({ id: "problem", from: CLEANER, text: "The lock is broken", channel: "group" });
    expect(problem.sent).toEqual([
      { to: OWNER, body: HOLD, kind: "review" },
      { to: CLEANER, body: HOLD, kind: "held" },
    ]);
    expect(problem.sent.some((text) => text.channel === "group")).toBe(false);
    expect(job.jobOnHold()).toBe(true);
    const left = await job.receive({ id: "left-held", from: OWNER, text: "guests have left" });
    expect(left.sent.filter((text) => text.kind === "pin")).toEqual([]);
    const resumed = await job.resumeJob();
    expect(resumed?.body).toBe(RESUME);
    expect(job.jobOnHold()).toBe(false);
  });

  it("reaches done from the cleaner's replies after the code is out", async () => {
    const sent = box();
    const job = await joined(sent);
    await job.receive({ id: "left-done", from: OWNER, text: "guests have left" });
    const started = await job.receive({ id: "start-work", from: CLEANER, text: "START", channel: "group" });
    expect(started.sent).toEqual([{ to: CLEANER, body: "Got it, cleaning started.", kind: "started" }]);
    const done = await job.receive({ id: "done-work", from: CLEANER, text: "DONE", channel: "group" });
    expect(done.sent).toEqual([{ to: CLEANER, body: "Thanks, cleaning marked done.", kind: "done" }]);
    expect(job.jobs().some((item) => item.status === "done")).toBe(true);
    expect(done.sent.some((text) => text.to === OWNER)).toBe(false);
  });

  it("keeps group wording aimed at the group", async () => {
    const sent = box();
    const job = await joined(sent);
    await job.receive({ id: "group-time-2", from: OWNER, text: "2:00 PM", channel: "group" });
    await job.receive({ id: "left-words", from: OWNER, text: "guests have left" });
    const groups = groupTexts(sent.sent);
    expect(groups.length).toBeGreaterThan(0);
    for (const text of groups) {
      expect(text.body).not.toMatch(/\byou\b/i);
      expect(text.body).not.toMatch(/grok bot|twilio|engine|cleaner_core/i);
    }
    expect(groups.some((text) => text.body === TIME_LINE)).toBe(true);
    expect(groups.some((text) => text.body === GROUP_PIN)).toBe(true);
    expect(sent.sent.some((text) => text.body === OFFER && !text.channel)).toBe(true);
    expect(sent.sent.some((text) => text.body === CONFIRM && !text.channel)).toBe(true);
  });
});

describe("group thread on the desk", () => {
  afterEach(() => {
    setCleanerTwilioClient(undefined);
    setCleanerGroupFetch(undefined);
    setCleanerCalendarFetch(undefined);
    resetLiveDesks();
  });

  it("keeps the missing key note and does not retry a failed group send", async () => {
    const calls: string[] = [];
    const fetchBox = groupFetch({ failMessages: true });
    setCleanerGroupFetch(async (url, init) => {
      calls.push(String(url));
      return fetchBox.impl(url, init);
    });
    setCleanerTwilioClient(fakeSms());
    setCleanerCalendarFetch(async (url) => ({
      status: url === CALENDAR_URL ? 200 : 404,
      url,
      async text() {
        return url === CALENDAR_URL ? CALENDAR_ICS : "";
      },
    }));
    const root = mkdtempSync(join(tmpdir(), "cleaner-group-"));
    const env: NodeJS.ProcessEnv = {
      CLEANER_CORE_ENABLED: "1",
      CLEANER_CORE_LIVE_SMS: "1",
      CLEANER_CORE_GROUP_CHAT: "1",
      CLEANER_CORE_SMS_ALLOWLIST: `${LIVE_HOST},${LIVE_CLEANER}`,
      CLEANER_CORE_TWILIO_ACCOUNT_SID: "ACfake",
      CLEANER_CORE_TWILIO_AUTH_TOKEN: "token",
      CLEANER_CORE_TWILIO_PHONE_NUMBER: CLEANER_LINE,
    };
    const desk = liveDeskFor(root, () => env, () => new Date(FROZEN));
    const pinKey = Buffer.from(TEST_PIN_KEY, "base64");
    expect(desk.getState("2").ok).toBe(true);
    expect(desk.saveProperty({ business: "Harbor", address: "12 Practice Lane, Teaneck, NJ 07666", timeZone: "America/New_York" }).ok).toBe(true);
    expect(desk.savePeople({ host: LIVE_HOST, cleaner: LIVE_CLEANER, observer: OBSERVER }).ok).toBe(true);
    expect(desk.saveCalendarLink({ url: CALENDAR_URL }).ok).toBe(true);
    expect(desk.saveDoorCode({ code: DOOR_CODE }, pinKey).ok).toBe(true);
    expect(desk.setUpTexting().ok).toBe(true);
    expect((await desk.runChecks()).ok).toBe(true);
    const missing = await desk.markGuestsLeft({ said: "The guests have left" }, undefined);
    expect(missing).toEqual({ ok: false, error: PIN_MISSING });
    expect(calls).toEqual([]);

    await desk.confirmTimes({ checkout: "11:00 AM", checkIn: "4:00 PM" });
    await desk.inbound({ id: "yes-host", from: LIVE_HOST, text: "YES" });
    await desk.inbound({ id: "yes-cleaner", from: LIVE_CLEANER, text: "YES" });
    await desk.inbound({ id: "yes-schedule", from: LIVE_CLEANER, text: "YES" });
    const failed = await desk.markGuestsLeft({ said: "The guests have left" }, pinKey);
    expect(failed).toEqual({ ok: true, result: { next: FAILED_ONCE } });
    const again = await desk.markGuestsLeft({ said: "The guests have left" }, pinKey);
    expect(again).toEqual({ ok: true, result: { next: ALREADY } });
    expect(JSON.stringify(again).includes(DOOR_CODE)).toBe(false);
    expect(JSON.stringify(failed).includes(DOOR_CODE)).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });

  it("asks Cory the checkout question once and keeps every host clock question off the group", async () => {
    const sms = fakeSms();
    const fetchBox = groupFetch();
    setCleanerTwilioClient(sms);
    setCleanerGroupFetch(fetchBox.impl);
    let feed = CALENDAR_ICS;
    setCleanerCalendarFetch(async (url) => ({
      status: url === CALENDAR_URL ? 200 : 404,
      url,
      async text() {
        return url === CALENDAR_URL ? feed : "";
      },
    }));
    const root = mkdtempSync(join(tmpdir(), "cleaner-host-clock-"));
    const env: NodeJS.ProcessEnv = {
      CLEANER_CORE_ENABLED: "1",
      CLEANER_CORE_LIVE_SMS: "1",
      CLEANER_CORE_GROUP_CHAT: "1",
      CLEANER_CORE_SMS_ALLOWLIST: `${LIVE_HOST},${LIVE_CLEANER}`,
      CLEANER_CORE_TWILIO_ACCOUNT_SID: "ACfake",
      CLEANER_CORE_TWILIO_AUTH_TOKEN: "token",
      CLEANER_CORE_TWILIO_PHONE_NUMBER: CLEANER_LINE,
    };
    const checkout = `Is checkout at ${PRACTICE} on Sunday, Oct 18 still 11:00 AM? Reply YES or send the new time.`;
    const checkin = `Is check-in at ${PRACTICE} on Monday, Oct 19 still 4:00 PM? Reply YES or send the new time.`;
    const open = () => liveDeskFor(root, () => env, () => new Date(FROZEN));
    const desk = open();
    const pinKey = Buffer.from(TEST_PIN_KEY, "base64");
    expect(desk.getState("2").ok).toBe(true);
    expect(desk.saveProperty({ business: "Harbor", address: PRACTICE, timeZone: "America/New_York" }).ok).toBe(true);
    expect(desk.savePeople({ host: LIVE_HOST, cleaner: LIVE_CLEANER, observer: OBSERVER }).ok).toBe(true);
    expect(desk.saveCalendarLink({ url: CALENDAR_URL }).ok).toBe(true);
    expect(desk.saveDoorCode({ code: DOOR_CODE }, pinKey).ok).toBe(true);
    expect(desk.setUpTexting().ok).toBe(true);
    expect((await desk.runChecks()).ok).toBe(true);
    const clockTexts = () => sms.sent.filter((text) => text.body === checkout || text.body === checkin);
    expect(clockTexts().map((text) => ({ to: text.to, body: text.body }))).toEqual([{ to: LIVE_HOST, body: checkout }]);
    expect(sms.sent.filter((text) => text.to === LIVE_CLEANER && (text.body === checkout || text.body === checkin))).toEqual([]);
    expect(fetchBox.posts.filter((text) => text.body === checkout || text.body === checkin)).toEqual([]);
    await desk.confirmTimes({ checkout: "11:00 AM", checkIn: "4:00 PM" });
    expect(clockTexts().map((text) => text.body)).toEqual([checkout]);
    feed = CALENDAR_ICS.replace("DTSTART;VALUE=DATE:20261018", "DTSTART;VALUE=DATE:20261019");
    expect((await desk.runChecks()).ok).toBe(true);
    expect(clockTexts().map((text) => ({ to: text.to, body: text.body }))).toEqual([
      { to: LIVE_HOST, body: checkout },
      { to: LIVE_HOST, body: checkin },
    ]);
    expect(fetchBox.posts.filter((text) => text.body === checkout || text.body === checkin)).toEqual([]);
    resetLiveDesks();
    const restarted = open();
    expect(restarted.saveDoorCode({ code: DOOR_CODE }, pinKey).ok).toBe(true);
    expect((await restarted.runChecks()).ok).toBe(true);
    expect(clockTexts()).toHaveLength(2);
    rmSync(root, { recursive: true, force: true });
  });

  it("waits to ask Cory the checkout question until live texts are on", async () => {
    const sms = fakeSms();
    setCleanerTwilioClient(sms);
    setCleanerGroupFetch(groupFetch().impl);
    setCleanerCalendarFetch(async (url) => ({
      status: url === CALENDAR_URL ? 200 : 404,
      url,
      async text() {
        return url === CALENDAR_URL ? CALENDAR_ICS : "";
      },
    }));
    const root = mkdtempSync(join(tmpdir(), "cleaner-host-clock-off-"));
    const env: NodeJS.ProcessEnv = {
      CLEANER_CORE_ENABLED: "1",
      CLEANER_CORE_GROUP_CHAT: "1",
      CLEANER_CORE_SMS_ALLOWLIST: `${LIVE_HOST},${LIVE_CLEANER}`,
      CLEANER_CORE_TWILIO_ACCOUNT_SID: "ACfake",
      CLEANER_CORE_TWILIO_AUTH_TOKEN: "token",
      CLEANER_CORE_TWILIO_PHONE_NUMBER: CLEANER_LINE,
    };
    const checkout = `Is checkout at ${PRACTICE} on Sunday, Oct 18 still 11:00 AM? Reply YES or send the new time.`;
    const desk = liveDeskFor(root, () => env, () => new Date(FROZEN));
    const pinKey = Buffer.from(TEST_PIN_KEY, "base64");
    expect(desk.getState("2").ok).toBe(true);
    expect(desk.saveProperty({ business: "Harbor", address: PRACTICE, timeZone: "America/New_York" }).ok).toBe(true);
    expect(desk.savePeople({ host: LIVE_HOST, cleaner: LIVE_CLEANER, observer: OBSERVER }).ok).toBe(true);
    expect(desk.saveCalendarLink({ url: CALENDAR_URL }).ok).toBe(true);
    expect(desk.saveDoorCode({ code: DOOR_CODE }, pinKey).ok).toBe(true);
    expect(desk.setUpTexting().ok).toBe(true);
    expect((await desk.runChecks()).ok).toBe(true);
    expect(sms.sent.filter((text) => text.body === checkout)).toEqual([]);
    env.CLEANER_CORE_LIVE_SMS = "1";
    expect((await desk.runChecks()).ok).toBe(true);
    expect(sms.sent.filter((text) => text.body === checkout).map((text) => text.to)).toEqual([LIVE_HOST]);
    rmSync(root, { recursive: true, force: true });
  });
});

describe("live group send", () => {
  afterEach(() => {
    setCleanerGroupFetch(undefined);
  });

  it("texts nobody when the allowlist is empty", async () => {
    const calls: string[] = [];
    setCleanerGroupFetch(async (url) => {
      calls.push(String(url));
      return { ok: true, status: 200, json: async () => ({ sid: "CH1" }) } as Response;
    });
    const env = {
      CLEANER_CORE_LIVE_SMS: "1",
      CLEANER_CORE_SMS_ALLOWLIST: "",
      CLEANER_CORE_TWILIO_ACCOUNT_SID: "ACfake",
      CLEANER_CORE_TWILIO_AUTH_TOKEN: "token",
      CLEANER_CORE_TWILIO_PHONE_NUMBER: CLEANER_LINE,
    };
    expect(await sendLiveGroup(env, { audience: [OWNER, CLEANER], body: "Hello the group" })).toBeUndefined();
    expect(calls).toEqual([]);
  });
});

interface GroupPost {
  conversationSid: string;
  to: string[];
  body: string;
}

function groupFetch(options?: { failMessages?: boolean }) {
  const conversations = new Map<string, { sid: string; address: string }[]>();
  const posts: GroupPost[] = [];
  let sequence = 0;
  let blockMembership = false;
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
    const path = url.slice(root.length + 1);
    const [rawSid, ...rest] = path.split("/");
    const sid = decodeURIComponent(rawSid ?? "");
    const tail = rest.join("/").split("?")[0] ?? "";
    const people = conversations.get(sid);
    if (!people) return reply(404, {});
    if (tail === "Messages" && method === "POST") {
      if (options?.failMessages) return reply(500, {});
      const params = new URLSearchParams(String(init?.body ?? ""));
      posts.push({ conversationSid: sid, to: people.map((person) => person.address).sort(), body: params.get("Body") ?? "" });
      return reply(201, { sid: `IM${posts.length}` });
    }
    if (tail === "Participants" || tail.startsWith("Participants/")) {
      if (blockMembership) return reply(500, {});
      if (tail === "Participants" && method === "GET") {
        return reply(200, {
          participants: people.map((person) => ({ sid: person.sid, messaging_binding: { address: person.address } })),
          meta: { next_page_url: null },
        });
      }
      if (tail === "Participants" && method === "POST") {
        const params = new URLSearchParams(String(init?.body ?? ""));
        const address = params.get("MessagingBinding.Address") ?? "";
        if (people.some((person) => person.address === address)) return reply(409, {});
        const person = { sid: `MB${++sequence}`, address };
        people.push(person);
        return reply(201, { sid: person.sid });
      }
      if (method === "DELETE") {
        const party = decodeURIComponent(tail.slice("Participants/".length));
        const index = people.findIndex((person) => person.sid === party);
        if (index < 0) return reply(404, {});
        people.splice(index, 1);
        return reply(204, {});
      }
    }
    return reply(404, {});
  };
  return { impl, posts, blockMembership() { blockMembership = true; } };
}

describe("live group membership", () => {
  const roots: string[] = [];

  afterEach(() => {
    setCleanerTwilioClient(undefined);
    setCleanerGroupFetch(undefined);
    for (const root of roots) rmSync(root, { recursive: true, force: true });
    roots.length = 0;
  });

  function liveGroup(extra: boolean) {
    const root = mkdtempSync(join(tmpdir(), "cleaner-group-live-"));
    roots.push(root);
    const store = join(root, "conversation.json");
    const readSid = () => {
      if (!existsSync(store)) return undefined;
      const parsed = JSON.parse(readFileSync(store, "utf8")) as { conversationSid?: string };
      return parsed.conversationSid;
    };
    const sms = fakeSms();
    const fetchBox = groupFetch();
    setCleanerTwilioClient(sms);
    setCleanerGroupFetch(fetchBox.impl);
    const allow = extra ? [OWNER, CLEANER, EXTRA] : [OWNER, CLEANER];
    const env: NodeJS.ProcessEnv = {
      CLEANER_CORE_LIVE_SMS: "1",
      CLEANER_CORE_SMS_ALLOWLIST: allow.join(","),
      CLEANER_CORE_TWILIO_ACCOUNT_SID: "ACfake",
      CLEANER_CORE_TWILIO_AUTH_TOKEN: "token",
      CLEANER_CORE_TWILIO_PHONE_NUMBER: CLEANER_LINE,
    };
    const job = openCleanerCore({
      enabled: true,
      property: { id: "prop_12_scratch_lane", address: ADDRESS, timeZone: "America/New_York" },
      ownerPhone: OWNER,
      cleaner: { phone: CLEANER, approved: true },
      pin: PIN,
      hostName: "Scratch",
      consented: true,
      allowlist: allow,
      sink: {
        async send(text: CleanerText) {
          if (text.channel === "group" && text.audience && text.audience.length > 0) {
            const sent = await sendLiveGroup(env, { audience: [...text.audience], body: text.body, conversationSid: readSid() });
            if (sent?.conversationSid) writeFileSync(store, `${JSON.stringify({ conversationSid: sent.conversationSid })}\n`);
            return;
          }
          await sendLiveSms(env, { to: text.to, body: text.body });
        },
      },
      now: () => new Date(NOW),
      groupChat: {
        hostName: "Cory",
        cleanerName: "Maria",
        ...(extra ? { extra: [{ phone: EXTRA, name: "Alex" }] } : {}),
      },
    });
    return { job, sms, posts: fetchBox.posts, blockMembership: fetchBox.blockMembership, readSid };
  }

  async function ready(extra: boolean) {
    const live = liveGroup(extra);
    await live.job.pollFeed(FEED);
    await live.job.receive({ id: "host-yes", from: OWNER, text: "YES" });
    await live.job.receive({ id: "cleaner-yes", from: CLEANER, text: "YES" });
    if (extra) await live.job.receive({ id: "extra-yes", from: EXTRA, text: "YES" });
    await live.job.confirmHostTimes({ checkout: "11:00 AM", checkIn: "4:00 PM" });
    await live.job.receive({ id: "schedule", from: CLEANER, text: "YES" });
    await live.job.receive({ id: "time-1", from: CLEANER, text: "Can we do 2:00 PM?", channel: "group" });
    return live;
  }

  it("keeps Alex out of a saved conversation after STOP, including the next group text and the door code", async () => {
    const live = await ready(true);
    const sid = live.readSid();
    expect(live.posts).toEqual([{ conversationSid: sid, to: [OWNER, CLEANER, EXTRA], body: TIME_LINE }]);
    await live.job.receive({ id: "stop-alex", from: EXTRA, text: "STOP", channel: "group" });
    await live.job.receive({ id: "time-2", from: CLEANER, text: "Can we do 3:00 PM?", channel: "group" });
    const left = await live.job.receive({ id: "left-alex", from: OWNER, text: "guests have left" });
    expect(live.posts).toEqual([
      { conversationSid: sid, to: [OWNER, CLEANER, EXTRA], body: TIME_LINE },
      { conversationSid: sid, to: [OWNER, CLEANER], body: TIME_LINE },
      { conversationSid: sid, to: [OWNER, CLEANER], body: GROUP_PIN },
    ]);
    expect(left.sent.filter((text) => text.kind === "pin")).toEqual([
      { to: CLEANER, body: GROUP_PIN, kind: "pin", channel: "group", audience: [OWNER, CLEANER] },
    ]);
  });

  it("sends nothing to the group when the saved conversation's members cannot be confirmed", async () => {
    const live = await ready(false);
    const sid = live.readSid();
    expect(live.posts).toEqual([{ conversationSid: sid, to: [OWNER, CLEANER], body: TIME_LINE }]);
    live.blockMembership();
    const left = await live.job.receive({ id: "left-unsynced", from: OWNER, text: "guests have left" });
    expect(live.posts).toEqual([{ conversationSid: sid, to: [OWNER, CLEANER], body: TIME_LINE }]);
    expect(live.sms.sent.filter((text) => text.body === PRIVATE_PIN).map((text) => ({ to: text.to, body: text.body }))).toEqual([
      { to: CLEANER, body: PRIVATE_PIN },
    ]);
    expect(left.sent.filter((text) => text.channel === "group")).toEqual([]);
    expect(left.sent.filter((text) => text.kind === "pin")).toEqual([{ to: CLEANER, body: PRIVATE_PIN, kind: "pin" }]);
  });

  it("tells Cory once when a group text is dropped, including a retry and a restart", async () => {
    const root = mkdtempSync(join(tmpdir(), "cleaner-group-alert-"));
    roots.push(root);
    const fetchBox = groupFetch();
    const env: NodeJS.ProcessEnv = {
      CLEANER_CORE_LIVE_SMS: "1",
      CLEANER_CORE_SMS_ALLOWLIST: [OWNER, CLEANER].join(","),
      CLEANER_CORE_TWILIO_ACCOUNT_SID: "ACfake",
      CLEANER_CORE_TWILIO_AUTH_TOKEN: "token",
      CLEANER_CORE_TWILIO_PHONE_NUMBER: CLEANER_LINE,
    };
    const line = "I couldn't send that to the group.";
    const open = (sms: ReturnType<typeof fakeSms>) => {
      setCleanerTwilioClient(sms);
      setCleanerGroupFetch(fetchBox.impl);
      return openCleanerCore({
        enabled: true,
        property: { id: "prop_12_scratch_lane", address: ADDRESS, timeZone: "America/New_York" },
        ownerPhone: OWNER,
        cleaner: { phone: CLEANER, approved: true },
        pin: PIN,
        hostName: "Scratch",
        consented: true,
        allowlist: [OWNER, CLEANER],
        dataDir: root,
        sink: {
          async send(text: CleanerText) {
            if (text.channel === "group" && text.audience && text.audience.length > 0) {
              await sendLiveGroup(env, { audience: [...text.audience], body: text.body });
              return;
            }
            await sendLiveSms(env, { to: text.to, body: text.body });
          },
        },
        now: () => new Date(NOW),
        groupChat: { hostName: "Cory", cleanerName: "Maria" },
      });
    };
    const firstSms = fakeSms();
    const job = open(firstSms);
    await job.pollFeed(FEED);
    await job.receive({ id: "host-yes", from: OWNER, text: "YES" });
    await job.receive({ id: "cleaner-yes", from: CLEANER, text: "YES" });
    await job.confirmHostTimes({ checkout: "11:00 AM", checkIn: "4:00 PM" });
    await job.receive({ id: "schedule", from: CLEANER, text: "YES" });
    fetchBox.blockMembership();
    await job.receive({ id: "time-dropped", from: CLEANER, text: "Can we do 2:00 PM?", channel: "group" });
    await job.receive({ id: "time-dropped-2", from: CLEANER, text: "Can we do 3:00 PM?", channel: "group" });
    const alerts = firstSms.sent.filter((text) => text.body === line);
    expect(alerts.map((text) => text.to)).toEqual([OWNER]);
    expect(alerts[0]?.body).toBe("I couldn't send that to the group.");
    expect(alerts[0]?.body).not.toMatch(/twilio|grok|door code|cleaner_core|\d/);
    expect(fetchBox.posts.map((text) => text.body)).toEqual([]);

    const secondSms = fakeSms();
    const restarted = open(secondSms);
    await restarted.receive({ id: "time-dropped-3", from: CLEANER, text: "Can we do 4:00 PM?", channel: "group" });
    expect(secondSms.sent.filter((text) => text.body === line)).toEqual([]);
    expect(fetchBox.posts.map((text) => text.body)).toEqual([]);
  });

  it("shows Cory the private line after a failed member check and posts nothing to the group", async () => {
    const live = await ready(false);
    const sid = live.readSid();
    expect(live.posts).toEqual([{ conversationSid: sid, to: [OWNER, CLEANER], body: TIME_LINE }]);
    live.blockMembership();
    const left = await live.job.receive({ id: "left-unsynced-host", from: OWNER, text: "guests have left" });
    const again = await live.job.receive({ id: "left-unsynced-host-2", from: OWNER, text: "guests have left" });
    expect(live.posts).toEqual([{ conversationSid: sid, to: [OWNER, CLEANER], body: TIME_LINE }]);
    expect(live.sms.sent.filter((text) => text.body === PRIVATE_PIN).map((text) => text.to)).toEqual([CLEANER]);
    expect(live.sms.sent.filter((text) => text.body === PRIVATE_LINE).map((text) => text.to)).toEqual([OWNER]);
    expect(left.sent.filter((text) => text.channel === "group")).toEqual([]);
    expect(again.sent.filter((text) => text.body === PRIVATE_LINE || text.channel === "group")).toEqual([]);
    expect(live.posts.some((text) => text.body === PRIVATE_LINE)).toBe(false);

    const optedOut = await ready(false);
    const optedSid = optedOut.readSid();
    optedOut.blockMembership();
    await optedOut.job.receive({ id: "stop-before-sync", from: CLEANER, text: "STOP" });
    const held = await optedOut.job.receive({ id: "left-opted-out-sync", from: OWNER, text: "guests have left" });
    expect(optedOut.posts).toEqual([{ conversationSid: optedSid, to: [OWNER, CLEANER], body: TIME_LINE }]);
    expect(optedOut.sms.sent.filter((text) => text.body === PRIVATE_PIN || text.body === PRIVATE_LINE)).toEqual([]);
    expect(held.sent.filter((text) => text.kind === "pin" || text.channel === "group")).toEqual([]);
    expect(optedOut.sms.sent.filter((text) => text.body === STOP_HOLD).map((text) => text.to)).toEqual([OWNER]);
  });
});
