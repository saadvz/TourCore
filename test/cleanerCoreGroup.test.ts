import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { groupDoorCodeBody, groupOptInBody, groupTimeLine, holdNote, privateCodeLine, resumeNote } from "../src/cleaner-core/cleanerTexts";
import { openCleanerCore, type CleanerText } from "../src/cleaner-core/core";
import { GroupNotConfirmed } from "../src/cleaner-core/groupThread";
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
const PIN_SENT = "I sent the door code to the cleaner. I'll tell you if it doesn't go through.";
const PIN_FAILED = "The door code didn't reach the cleaner. Tell me the guests have left again and I'll resend it.";
const AFTER_CHECKS = "Tell me the checkout time and the next check-in time before I text the cleaner.";
const PRACTICE_INVITE = groupOptInBody("Cory", "Maria", PRACTICE);
const PRACTICE_HOLD = holdNote(PRACTICE);
const PRACTICE_SETUP = [PRACTICE_INVITE, PRACTICE_HOLD];
const PRACTICE_STOP = `The cleaner opted out of cleaning texts for ${PRACTICE}, so the job is on hold.`;
const PRACTICE_PIN_HELD = "The cleaner opted out, so the door code wasn't sent. Please reach them directly.";
const PIN_MISSING = "I can't send the door code yet. Let's finish setting up Cleaner Core first.";
const FAILED_ONCE = "A text failed to send. I saved it for your review and did not count it as delivered.";
const FEED = readFileSync(join("src/cleaner-core/fixtures", "guesty-lite-scratch.ics"), "utf8");

function plainFour(forbidden: readonly string[]): string {
  for (let n = 1000; n <= 9999; n += 1) {
    const value = String(n);
    if (forbidden.some((secret) => secret.includes(value))) continue;
    return value;
  }
  throw new Error("no 4-digit marker was free of the scratch codes");
}

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
    expect(left.sent.filter((text) => text.body === PRIVATE_LINE || text.channel === "group")).toEqual([]);
    expect(job.hostNotes()).toEqual([]);
    job.notePrivateCodeDelivered();
    expect(job.hostNotes()).toEqual([PRIVATE_LINE]);
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
    expect(left.sent.filter((text) => text.body === PRIVATE_LINE || text.channel === "group")).toEqual([]);
    expect(job.hostNotes()).toEqual([]);
    job.notePrivateCodeDelivered();
    expect(job.hostNotes()).toEqual([PRIVATE_LINE]);
  });

  it("files the private line for Cory only after a delivery report, and the group never gets it", async () => {
    const sent = box();
    const job = await joined(sent, true);
    const left = await job.receive({ id: "left-private-note", from: OWNER, text: "guests have left" });
    expect(left.sent.filter((text) => text.kind === "pin")).toEqual([{ to: CLEANER, body: PRIVATE_PIN, kind: "pin" }]);
    expect(sent.sent.filter((text) => text.body === PRIVATE_LINE)).toEqual([]);
    expect(sent.sent.filter((text) => text.channel === "group" && text.kind === "pin-notice")).toEqual([]);
    expect(job.hostNotes()).toEqual([]);
    job.notePrivateCodeDelivered();
    expect(job.hostNotes()).toEqual([PRIVATE_LINE]);
    job.notePrivateCodeDelivered();
    expect(job.hostNotes()).toEqual([PRIVATE_LINE]);
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

  it("names a dropped group text from the fixed list when that text contains a 4-digit number", async () => {
    const marker = plainFour(SCRATCH_TENANTS.map((tenant) => tenant.pin));
    const sent: CleanerText[] = [];
    const job = openCleanerCore({
      enabled: true,
      property: { id: "prop_12_scratch_lane", address: ADDRESS, timeZone: "America/New_York" },
      ownerPhone: OWNER,
      cleaner: { phone: CLEANER, approved: true },
      pin: PIN,
      hostName: "Scratch",
      consented: true,
      sink: {
        async send(text) {
          if (text.channel === "group") throw new GroupNotConfirmed();
          sent.push(text);
        },
      },
      now: () => new Date(NOW),
      groupChat: { hostName: `Gate ${marker}`, cleanerName: "Maria" },
    });
    await job.pollFeed(FEED);
    await job.receive({ id: "host-yes-marker", from: OWNER, text: "YES" });
    await job.receive({ id: "cleaner-yes-marker", from: CLEANER, text: "YES" });
    await job.confirmHostTimes({ checkout: "11:00 AM", checkIn: "4:00 PM" });
    await job.receive({ id: "schedule-marker", from: CLEANER, text: "YES" });
    await job.receive({ id: "time-marker", from: CLEANER, text: "Can we do 2:00 PM?", channel: "group" });
    await job.receive({ id: "time-marker-again", from: CLEANER, text: "Can we do 3:00 PM?", channel: "group" });
    expect(job.hostNotes().filter((line) => line.startsWith("I couldn't send"))).toEqual(["I couldn't send the time to the group."]);
    expect(job.hostNotes().join("\n").includes(marker)).toBe(false);
    expect(job.hostNotes().join("\n").includes("Gate")).toBe(false);
    expect(sent.filter((text) => text.channel === "group")).toEqual([]);
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

  it("drops the checkout question in group mode and sets times only through confirm_times", async () => {
    const sent = box();
    const job = open(sent);
    const checkout = `Is checkout at ${ADDRESS} on Sunday, Oct 18 still 11:00 AM? Reply YES or send the new time.`;
    const checkin = `Is check-in at ${ADDRESS} on Sunday, Oct 18 still 4:00 PM? Reply YES or send the new time.`;
    const poll = await job.pollFeed(FEED);
    expect(poll.sent.filter((text) => text.body === checkout || text.body === checkin)).toEqual([]);
    expect(sent.sent.filter((text) => text.body === checkout || text.body === checkin)).toEqual([]);
    expect(groupTexts(sent.sent).filter((text) => text.body === checkout || text.body === checkin)).toEqual([]);
    await job.receive({ id: "yes-not-the-clock", from: OWNER, text: "YES" });
    expect(job.jobs().filter((item) => item.checkoutTime === "11:00 AM")).toEqual([]);
    await job.confirmHostTimes({ checkout: "11:00 AM", checkIn: "4:00 PM" });
    expect(job.jobs().filter((item) => item.checkoutTime === "11:00 AM").map((item) => item.nextCheckInTime)).toEqual(["4:00 PM"]);
    expect(sent.sent.filter((text) => text.body === checkout || text.body === checkin)).toEqual([]);
    expect(groupTexts(sent.sent).filter((text) => text.body === checkout || text.body === checkin)).toEqual([]);
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

  it("drops the checkout question on the desk and sets times only through confirm_times", async () => {
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
      CLEANER_CORE_GROUP_CHAT: "1",
      CLEANER_CORE_SMS_ALLOWLIST: `${LIVE_HOST},${LIVE_CLEANER}`,
      CLEANER_CORE_TWILIO_ACCOUNT_SID: "ACfake",
      CLEANER_CORE_TWILIO_AUTH_TOKEN: "token",
      CLEANER_CORE_TWILIO_PHONE_NUMBER: CLEANER_LINE,
    };
    const checkout = `Is checkout at ${PRACTICE} on Sunday, Oct 18 still 11:00 AM? Reply YES or send the new time.`;
    const checkin = `Is check-in at ${PRACTICE} on Monday, Oct 19 still 4:00 PM? Reply YES or send the new time.`;
    const clockBodies = () => sms.sent.filter((text) => text.body === checkout || text.body === checkin);
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
    expect(clockBodies()).toEqual([]);
    expect(fetchBox.posts.filter((text) => text.body === checkout || text.body === checkin)).toEqual([]);
    await desk.inbound({ id: "yes-not-the-clock", from: LIVE_HOST, text: "YES" });
    const early = desk.getTurns();
    expect(early.ok).toBe(true);
    if (early.ok) {
      const turns = early.result.turns as { checkoutTime: string | null }[];
      expect(turns.filter((turn) => turn.checkoutTime === "11:00 AM")).toEqual([]);
    }
    env.CLEANER_CORE_LIVE_SMS = "1";
    expect((await desk.runChecks()).ok).toBe(true);
    expect(clockBodies()).toEqual([]);
    await desk.confirmTimes({ checkout: "11:00 AM", checkIn: "4:00 PM" });
    const saved = desk.getTurns();
    expect(saved.ok).toBe(true);
    if (saved.ok) {
      const turns = saved.result.turns as { checkoutTime: string | null; nextCheckInTime: string | null }[];
      expect(turns.filter((turn) => turn.checkoutTime === "11:00 AM").map((turn) => turn.nextCheckInTime)).toEqual(["4:00 PM"]);
    }
    expect(clockBodies()).toEqual([]);
    feed = CALENDAR_ICS.replace("DTSTART;VALUE=DATE:20261018", "DTSTART;VALUE=DATE:20261019");
    expect((await desk.runChecks()).ok).toBe(true);
    expect(clockBodies()).toEqual([]);
    expect(fetchBox.posts.filter((text) => text.body === checkout || text.body === checkin)).toEqual([]);
    const read = desk.getState();
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(read.result.notes).toEqual(PRACTICE_SETUP);
      expect(JSON.stringify(read.result.notes).includes(checkout)).toBe(false);
      expect(JSON.stringify(read.result.notes).includes(checkin)).toBe(false);
    }
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
    setCleanerCalendarFetch(undefined);
    resetLiveDesks();
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

  it("tells Cory once in get_state when a group text is dropped, including a retry and a restart", async () => {
    const root = mkdtempSync(join(tmpdir(), "cleaner-group-alert-"));
    roots.push(root);
    const fetchBox = groupFetch();
    const sms = fakeSms();
    const env: NodeJS.ProcessEnv = {
      CLEANER_CORE_ENABLED: "1",
      CLEANER_CORE_LIVE_SMS: "1",
      CLEANER_CORE_GROUP_CHAT: "1",
      CLEANER_CORE_SMS_ALLOWLIST: `${LIVE_HOST},${LIVE_CLEANER}`,
      CLEANER_CORE_TWILIO_ACCOUNT_SID: "ACfake",
      CLEANER_CORE_TWILIO_AUTH_TOKEN: "token",
      CLEANER_CORE_TWILIO_PHONE_NUMBER: CLEANER_LINE,
    };
    const line = "I couldn't send the time to the group.";
    const checkout = `Is checkout at ${PRACTICE} on Sunday, Oct 18 still 11:00 AM? Reply YES or send the new time.`;
    const privateLine = "I've sent the door code to Maria privately.";
    setCleanerTwilioClient(sms);
    setCleanerGroupFetch(fetchBox.impl);
    setCleanerCalendarFetch(async (url) => ({
      status: url === CALENDAR_URL ? 200 : 404,
      url,
      async text() {
        return url === CALENDAR_URL ? CALENDAR_ICS : "";
      },
    }));
    const pinKey = Buffer.from(TEST_PIN_KEY, "base64");
    const boot = () => {
      const desk = liveDeskFor(root, () => env, () => new Date(FROZEN));
      return desk;
    };
    const desk = boot();
    expect(desk.getState("2").ok).toBe(true);
    expect(desk.saveProperty({ business: "Harbor", address: PRACTICE, timeZone: "America/New_York" }).ok).toBe(true);
    expect(desk.savePeople({ host: LIVE_HOST, cleaner: LIVE_CLEANER, observer: OBSERVER }).ok).toBe(true);
    expect(desk.saveCalendarLink({ url: CALENDAR_URL }).ok).toBe(true);
    expect(desk.saveDoorCode({ code: DOOR_CODE }, pinKey).ok).toBe(true);
    expect(desk.setUpTexting().ok).toBe(true);
    expect((await desk.runChecks()).ok).toBe(true);
    await desk.confirmTimes({ checkout: "11:00 AM", checkIn: "4:00 PM" });
    await desk.inbound({ id: "yes-host", from: LIVE_HOST, text: "YES" });
    await desk.inbound({ id: "yes-cleaner", from: LIVE_CLEANER, text: "YES" });
    await desk.inbound({ id: "yes-schedule", from: LIVE_CLEANER, text: "YES" });
    const quiet = desk.getState();
    expect(quiet.ok).toBe(true);
    if (quiet.ok) expect(quiet.result.notes).toEqual(PRACTICE_SETUP);
    fetchBox.blockMembership();
    await desk.inbound({ id: "time-dropped", from: LIVE_CLEANER, text: "Can we do 2:00 PM?", channel: "group" });
    await desk.inbound({ id: "time-dropped-2", from: LIVE_CLEANER, text: "Can we do 3:00 PM?", channel: "group" });
    const read = desk.getState();
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.result.notes).toEqual([...PRACTICE_SETUP, line]);
    expect(line).not.toMatch(/twilio|grok|door code|cleaner_core|\d/);
    expect(sms.sent.filter((text) => text.body === line || text.body === privateLine || text.body === checkout)).toEqual([]);
    expect(fetchBox.posts.map((text) => text.body)).toEqual([]);
    const reread = desk.getState();
    expect(reread.ok).toBe(true);
    if (reread.ok) expect(reread.result.notes).toEqual([...PRACTICE_SETUP, line]);

    resetLiveDesks();
    const restarted = boot();
    expect(restarted.saveDoorCode({ code: DOOR_CODE }, pinKey).ok).toBe(true);
    const afterRestart = restarted.getState();
    expect(afterRestart.ok).toBe(true);
    if (afterRestart.ok) expect(afterRestart.result.notes).toEqual([...PRACTICE_SETUP, line]);
    await restarted.inbound({ id: "time-dropped-3", from: LIVE_CLEANER, text: "Can we do 4:00 PM?", channel: "group" });
    const still = restarted.getState();
    expect(still.ok).toBe(true);
    if (still.ok) expect(still.result.notes).toEqual([...PRACTICE_SETUP, line]);
    expect(fetchBox.posts.map((text) => text.body)).toEqual([]);
    expect(sms.sent.filter((text) => text.body === line)).toEqual([]);
  });

  it("shows the private line in get_state after a failed member check and posts nothing to the group", async () => {
    const root = mkdtempSync(join(tmpdir(), "cleaner-group-private-note-"));
    roots.push(root);
    const fetchBox = groupFetch();
    const sms = fakeSms();
    const env: NodeJS.ProcessEnv = {
      CLEANER_CORE_ENABLED: "1",
      CLEANER_CORE_LIVE_SMS: "1",
      CLEANER_CORE_GROUP_CHAT: "1",
      CLEANER_CORE_SMS_ALLOWLIST: `${LIVE_HOST},${LIVE_CLEANER}`,
      CLEANER_CORE_TWILIO_ACCOUNT_SID: "ACfake",
      CLEANER_CORE_TWILIO_AUTH_TOKEN: "token",
      CLEANER_CORE_TWILIO_PHONE_NUMBER: CLEANER_LINE,
    };
    const line = "I've sent the door code to Maria privately.";
    const alert = "I couldn't send the time to the group.";
    const checkout = `Is checkout at ${PRACTICE} on Sunday, Oct 18 still 11:00 AM? Reply YES or send the new time.`;
    const groupPin = `Maria, guests have left ${PRACTICE}. Door code: ${DOOR_CODE}.`;
    const privatePin = `Guests have left ${PRACTICE}. Door code: ${DOOR_CODE}. This code is only for you.`;
    setCleanerTwilioClient(sms);
    setCleanerGroupFetch(fetchBox.impl);
    setCleanerCalendarFetch(async (url) => ({
      status: url === CALENDAR_URL ? 200 : 404,
      url,
      async text() {
        return url === CALENDAR_URL ? CALENDAR_ICS : "";
      },
    }));
    const pinKey = Buffer.from(TEST_PIN_KEY, "base64");
    const boot = () => liveDeskFor(root, () => env, () => new Date(FROZEN));
    const desk = boot();
    expect(desk.getState("2").ok).toBe(true);
    expect(desk.saveProperty({ business: "Harbor", address: PRACTICE, timeZone: "America/New_York" }).ok).toBe(true);
    expect(desk.savePeople({ host: LIVE_HOST, cleaner: LIVE_CLEANER, observer: OBSERVER }).ok).toBe(true);
    expect(desk.saveCalendarLink({ url: CALENDAR_URL }).ok).toBe(true);
    expect(desk.saveDoorCode({ code: DOOR_CODE }, pinKey).ok).toBe(true);
    expect(desk.setUpTexting().ok).toBe(true);
    expect((await desk.runChecks()).ok).toBe(true);
    await desk.confirmTimes({ checkout: "11:00 AM", checkIn: "4:00 PM" });
    await desk.inbound({ id: "yes-host", from: LIVE_HOST, text: "YES" });
    await desk.inbound({ id: "yes-cleaner", from: LIVE_CLEANER, text: "YES" });
    await desk.inbound({ id: "yes-schedule", from: LIVE_CLEANER, text: "YES" });
    fetchBox.blockMembership();
    const left = await desk.markGuestsLeft({ said: "The guests have left" }, pinKey);
    const again = await desk.markGuestsLeft({ said: "The guests have left" }, pinKey);
    expect(left).toEqual({ ok: true, result: { next: PIN_SENT } });
    expect(again).toEqual({ ok: true, result: { next: ALREADY } });
    expect(fetchBox.posts.filter((text) => text.body === line || text.body === alert || text.body === checkout || text.body === groupPin || text.body === TIME_LINE)).toEqual([]);
    expect(sms.sent.filter((text) => text.body === privatePin).map((text) => text.to)).toEqual([LIVE_CLEANER]);
    expect(sms.sent.filter((text) => text.body === line || text.body === alert || text.body === checkout || text.body === groupPin)).toEqual([]);
    const waiting = desk.getState();
    expect(waiting.ok).toBe(true);
    if (waiting.ok) {
      expect(waiting.result.next).toBe(AFTER_CHECKS);
      expect(waiting.result.notes).toEqual(PRACTICE_SETUP);
    }
    const pinText = sms.sent.find((text) => text.body === privatePin);
    desk.notePinDelivery({ sid: pinText?.sid ?? "", status: "sent" });
    const pendingNote = desk.getState();
    expect(pendingNote.ok).toBe(true);
    if (pendingNote.ok) expect(pendingNote.result.notes).toEqual(PRACTICE_SETUP);
    desk.notePinDelivery({ sid: pinText?.sid ?? "", status: "delivered" });
    const read = desk.getState();
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(read.result.notes).toEqual([...PRACTICE_SETUP, line]);
      expect(read.result.next).toBe(AFTER_CHECKS);
      expect(JSON.stringify(read.result.notes).includes(DOOR_CODE)).toBe(false);
      expect(JSON.stringify(read.result.notes).includes(groupPin)).toBe(false);
    }
    resetLiveDesks();
    const restarted = boot();
    expect(restarted.saveDoorCode({ code: DOOR_CODE }, pinKey).ok).toBe(true);
    const afterRestart = restarted.getState();
    expect(afterRestart.ok).toBe(true);
    if (afterRestart.ok) expect(afterRestart.result.notes).toEqual([...PRACTICE_SETUP, line]);
    expect(fetchBox.posts.filter((text) => text.body === line || text.body === alert || text.body === groupPin || text.body === TIME_LINE)).toEqual([]);

    const heldRoot = mkdtempSync(join(tmpdir(), "cleaner-group-private-held-"));
    roots.push(heldRoot);
    const heldFetch = groupFetch();
    const heldSms = fakeSms();
    setCleanerTwilioClient(heldSms);
    setCleanerGroupFetch(heldFetch.impl);
    const held = liveDeskFor(heldRoot, () => env, () => new Date(FROZEN));
    expect(held.getState("2").ok).toBe(true);
    expect(held.saveProperty({ business: "Harbor", address: PRACTICE, timeZone: "America/New_York" }).ok).toBe(true);
    expect(held.savePeople({ host: LIVE_HOST, cleaner: LIVE_CLEANER, observer: OBSERVER }).ok).toBe(true);
    expect(held.saveCalendarLink({ url: CALENDAR_URL }).ok).toBe(true);
    expect(held.saveDoorCode({ code: DOOR_CODE }, pinKey).ok).toBe(true);
    expect(held.setUpTexting().ok).toBe(true);
    expect((await held.runChecks()).ok).toBe(true);
    await held.confirmTimes({ checkout: "11:00 AM", checkIn: "4:00 PM" });
    await held.inbound({ id: "yes-host-held", from: LIVE_HOST, text: "YES" });
    await held.inbound({ id: "yes-cleaner-held", from: LIVE_CLEANER, text: "YES" });
    await held.inbound({ id: "yes-schedule-held", from: LIVE_CLEANER, text: "YES" });
    heldFetch.blockMembership();
    await held.inbound({ id: "stop-before-sync", from: LIVE_CLEANER, text: "STOP" });
    const stayed = await held.markGuestsLeft({ said: "The guests have left" }, pinKey);
    expect(stayed.ok).toBe(true);
    expect(heldFetch.posts.filter((text) => text.body === line || text.body === groupPin || text.body === alert || text.body === TIME_LINE)).toEqual([]);
    expect(heldSms.sent.filter((text) => text.body === privatePin || text.body === line || text.body === groupPin)).toEqual([]);
    const heldRead = held.getState();
    expect(heldRead.ok).toBe(true);
    if (heldRead.ok) expect(heldRead.result.notes).toEqual([...PRACTICE_SETUP, PRACTICE_STOP, PRACTICE_PIN_HELD]);
    expect(heldSms.sent.filter((text) => text.to === LIVE_HOST).map((text) => text.body)).toEqual([]);
  });

  it("shows the failed-send alert when the private door-code text fails and never the private note", async () => {
    const root = mkdtempSync(join(tmpdir(), "cleaner-group-private-fail-"));
    roots.push(root);
    const fetchBox = groupFetch();
    const sms = fakeSms((body) => (body.includes("Door code:") ? "failed" : "queued"));
    const env: NodeJS.ProcessEnv = {
      CLEANER_CORE_ENABLED: "1",
      CLEANER_CORE_LIVE_SMS: "1",
      CLEANER_CORE_GROUP_CHAT: "1",
      CLEANER_CORE_SMS_ALLOWLIST: `${LIVE_HOST},${LIVE_CLEANER}`,
      CLEANER_CORE_TWILIO_ACCOUNT_SID: "ACfake",
      CLEANER_CORE_TWILIO_AUTH_TOKEN: "token",
      CLEANER_CORE_TWILIO_PHONE_NUMBER: CLEANER_LINE,
    };
    const line = "I've sent the door code to Maria privately.";
    const failedAlert = "The door code didn't reach the cleaner. Tell me the guests have left again and I'll resend it.";
    const groupPin = `Maria, guests have left ${PRACTICE}. Door code: ${DOOR_CODE}.`;
    setCleanerTwilioClient(sms);
    setCleanerGroupFetch(fetchBox.impl);
    setCleanerCalendarFetch(async (url) => ({
      status: url === CALENDAR_URL ? 200 : 404,
      url,
      async text() {
        return url === CALENDAR_URL ? CALENDAR_ICS : "";
      },
    }));
    const pinKey = Buffer.from(TEST_PIN_KEY, "base64");
    const desk = liveDeskFor(root, () => env, () => new Date(FROZEN));
    expect(desk.getState("2").ok).toBe(true);
    expect(desk.saveProperty({ business: "Harbor", address: PRACTICE, timeZone: "America/New_York" }).ok).toBe(true);
    expect(desk.savePeople({ host: LIVE_HOST, cleaner: LIVE_CLEANER, observer: OBSERVER }).ok).toBe(true);
    expect(desk.saveCalendarLink({ url: CALENDAR_URL }).ok).toBe(true);
    expect(desk.saveDoorCode({ code: DOOR_CODE }, pinKey).ok).toBe(true);
    expect(desk.setUpTexting().ok).toBe(true);
    expect((await desk.runChecks()).ok).toBe(true);
    await desk.confirmTimes({ checkout: "11:00 AM", checkIn: "4:00 PM" });
    await desk.inbound({ id: "yes-host-fail", from: LIVE_HOST, text: "YES" });
    await desk.inbound({ id: "yes-cleaner-fail", from: LIVE_CLEANER, text: "YES" });
    await desk.inbound({ id: "yes-schedule-fail", from: LIVE_CLEANER, text: "YES" });
    fetchBox.blockMembership();
    const left = await desk.markGuestsLeft({ said: "The guests have left" }, pinKey);
    expect(left).toEqual({ ok: true, result: { next: failedAlert } });
    desk.notePinDelivery({ sid: "SM-none", status: "sent" });
    const read = desk.getState();
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(read.result.next).toBe(failedAlert);
      expect(JSON.stringify(read.result.notes ?? [])).not.toContain(line);
      expect(JSON.stringify(read.result).includes(DOOR_CODE)).toBe(false);
    }
    expect(fetchBox.posts.filter((text) => text.body === line || text.body === groupPin)).toEqual([]);
    expect(sms.sent.filter((text) => text.to === LIVE_HOST && text.body === line)).toEqual([]);
  });

  it("keeps the job on hold when STOP comes before a dropped group text and sends no code", async () => {
    const root = mkdtempSync(join(tmpdir(), "cleaner-group-stop-drop-"));
    roots.push(root);
    const fetchBox = groupFetch();
    const sms = fakeSms();
    const env: NodeJS.ProcessEnv = {
      CLEANER_CORE_ENABLED: "1",
      CLEANER_CORE_LIVE_SMS: "1",
      CLEANER_CORE_GROUP_CHAT: "1",
      CLEANER_CORE_SMS_ALLOWLIST: `${LIVE_HOST},${LIVE_CLEANER}`,
      CLEANER_CORE_TWILIO_ACCOUNT_SID: "ACfake",
      CLEANER_CORE_TWILIO_AUTH_TOKEN: "token",
      CLEANER_CORE_TWILIO_PHONE_NUMBER: CLEANER_LINE,
    };
    const hold = "The cleaner opted out of cleaning texts, so the job is on hold.";
    const line = "I've sent the door code to Maria privately.";
    setCleanerTwilioClient(sms);
    setCleanerGroupFetch(fetchBox.impl);
    setCleanerCalendarFetch(async (url) => ({
      status: url === CALENDAR_URL ? 200 : 404,
      url,
      async text() {
        return url === CALENDAR_URL ? CALENDAR_ICS : "";
      },
    }));
    const pinKey = Buffer.from(TEST_PIN_KEY, "base64");
    const desk = liveDeskFor(root, () => env, () => new Date(FROZEN));
    expect(desk.getState("2").ok).toBe(true);
    expect(desk.saveProperty({ business: "Harbor", address: PRACTICE, timeZone: "America/New_York" }).ok).toBe(true);
    expect(desk.savePeople({ host: LIVE_HOST, cleaner: LIVE_CLEANER, observer: OBSERVER }).ok).toBe(true);
    expect(desk.saveCalendarLink({ url: CALENDAR_URL }).ok).toBe(true);
    expect(desk.saveDoorCode({ code: DOOR_CODE }, pinKey).ok).toBe(true);
    expect(desk.setUpTexting().ok).toBe(true);
    expect((await desk.runChecks()).ok).toBe(true);
    await desk.confirmTimes({ checkout: "11:00 AM", checkIn: "4:00 PM" });
    await desk.inbound({ id: "yes-host-stop", from: LIVE_HOST, text: "YES" });
    await desk.inbound({ id: "yes-cleaner-stop", from: LIVE_CLEANER, text: "YES" });
    await desk.inbound({ id: "yes-schedule-stop", from: LIVE_CLEANER, text: "YES" });
    await desk.inbound({ id: "stop-first", from: LIVE_CLEANER, text: "STOP" });
    fetchBox.blockMembership();
    await desk.inbound({ id: "time-after-stop", from: LIVE_CLEANER, text: "Can we do 2:00 PM?", channel: "group" });
    const read = desk.getState();
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.result.next).toBe(hold);
    const turns = desk.getTurns();
    expect(turns.ok).toBe(true);
    if (turns.ok) expect(turns.result.held).toBe(true);
    const left = await desk.markGuestsLeft({ said: "The guests have left" }, pinKey);
    expect(left.ok).toBe(true);
    expect(sms.sent.filter((text) => text.body.includes("Door code:"))).toEqual([]);
    expect(fetchBox.posts.filter((text) => text.body.includes("Door code:") || text.body === line)).toEqual([]);
    expect(sms.sent.filter((text) => text.body === "You're opted back in to cleaning texts. Reply YES if you still want this turnover. Reply STOP to opt out.")).toEqual([]);
    const after = desk.getState();
    expect(after.ok).toBe(true);
    if (after.ok) expect(after.result.next).toBe(hold);
  });

  async function privateSendWithoutHost() {
    const root = mkdtempSync(join(tmpdir(), "cleaner-private-accept-"));
    roots.push(root);
    const fetchBox = groupFetch();
    const sms = fakeSms();
    const env: NodeJS.ProcessEnv = {
      CLEANER_CORE_ENABLED: "1",
      CLEANER_CORE_LIVE_SMS: "1",
      CLEANER_CORE_GROUP_CHAT: "1",
      CLEANER_CORE_SMS_ALLOWLIST: `${LIVE_HOST},${LIVE_CLEANER}`,
      CLEANER_CORE_TWILIO_ACCOUNT_SID: "ACfake",
      CLEANER_CORE_TWILIO_AUTH_TOKEN: "token",
      CLEANER_CORE_TWILIO_PHONE_NUMBER: CLEANER_LINE,
    };
    setCleanerTwilioClient(sms);
    setCleanerGroupFetch(fetchBox.impl);
    setCleanerCalendarFetch(async (url) => ({
      status: url === CALENDAR_URL ? 200 : 404,
      url,
      async text() {
        return url === CALENDAR_URL ? CALENDAR_ICS : "";
      },
    }));
    const pinKey = Buffer.from(TEST_PIN_KEY, "base64");
    const desk = liveDeskFor(root, () => env, () => new Date(FROZEN));
    expect(desk.getState("2").ok).toBe(true);
    expect(desk.saveProperty({ business: "Harbor", address: PRACTICE, timeZone: "America/New_York" }).ok).toBe(true);
    expect(desk.savePeople({ host: LIVE_HOST, cleaner: LIVE_CLEANER, observer: OBSERVER }).ok).toBe(true);
    expect(desk.saveCalendarLink({ url: CALENDAR_URL }).ok).toBe(true);
    expect(desk.saveDoorCode({ code: DOOR_CODE }, pinKey).ok).toBe(true);
    expect(desk.setUpTexting().ok).toBe(true);
    expect((await desk.runChecks()).ok).toBe(true);
    await desk.confirmTimes({ checkout: "11:00 AM", checkIn: "4:00 PM" });
    await desk.inbound({ id: "yes-cleaner-only", from: LIVE_CLEANER, text: "YES" });
    await desk.inbound({ id: "yes-schedule-only", from: LIVE_CLEANER, text: "YES" });
    const privatePin = `Guests have left ${PRACTICE}. Door code: ${DOOR_CODE}. This code is only for you.`;
    return { desk, sms, posts: fetchBox.posts, pinKey, privatePin };
  }

  it("returns the sent sentence when Twilio accepts a private door code", async () => {
    const { desk, sms, posts, pinKey, privatePin } = await privateSendWithoutHost();
    const left = await desk.markGuestsLeft({ said: "The guests have left" }, pinKey);
    expect(left).toEqual({ ok: true, result: { next: PIN_SENT } });
    expect(sms.sent.filter((text) => text.body === privatePin).map((text) => text.to)).toEqual([LIVE_CLEANER]);
    expect(sms.sent.filter((text) => text.to === LIVE_HOST && text.body === privatePin).map((text) => text.to)).toEqual([]);
    expect(posts.filter((text) => text.body === privatePin).map((text) => text.body)).toEqual([]);
    const state = desk.getState();
    expect(state.ok).toBe(true);
    if (state.ok) {
      expect(state.result.next).toBe(AFTER_CHECKS);
      expect(state.result.notes).toEqual(PRACTICE_SETUP);
    }
  });

  it("returns the already-sent sentence while a private delivery report is pending", async () => {
    const { desk, sms, posts, pinKey, privatePin } = await privateSendWithoutHost();
    const left = await desk.markGuestsLeft({ said: "The guests have left" }, pinKey);
    expect(left).toEqual({ ok: true, result: { next: PIN_SENT } });
    const again = await desk.markGuestsLeft({ said: "The guests have left" }, pinKey);
    expect(again).toEqual({ ok: true, result: { next: ALREADY } });
    expect(sms.sent.filter((text) => text.body === privatePin).map((text) => text.to)).toEqual([LIVE_CLEANER]);
    expect(posts.filter((text) => text.body === privatePin).map((text) => text.body)).toEqual([]);
    expect(sms.sent.filter((text) => text.to === LIVE_HOST && text.body === privatePin).map((text) => text.to)).toEqual([]);
    const state = desk.getState();
    expect(state.ok).toBe(true);
    if (state.ok) {
      expect(state.result.next).toBe(AFTER_CHECKS);
      expect(state.result.notes).toEqual(PRACTICE_SETUP);
    }
  });

  it("returns the failed-send sentence after a failed private delivery report", async () => {
    const { desk, sms, posts, pinKey, privatePin } = await privateSendWithoutHost();
    const line = "I've sent the door code to Maria privately.";
    const left = await desk.markGuestsLeft({ said: "The guests have left" }, pinKey);
    expect(left).toEqual({ ok: true, result: { next: PIN_SENT } });
    const pending = desk.getState();
    expect(pending.ok).toBe(true);
    if (pending.ok) {
      expect(pending.result.next).toBe(AFTER_CHECKS);
      expect(pending.result.notes).toEqual(PRACTICE_SETUP);
    }
    const pinText = sms.sent.find((text) => text.body === privatePin);
    desk.notePinDelivery({ sid: pinText?.sid ?? "", status: "failed" });
    const after = desk.getState();
    expect(after.ok).toBe(true);
    if (after.ok) {
      expect(after.result.next).toBe(PIN_FAILED);
      expect(after.result.notes).toEqual(PRACTICE_SETUP);
    }
    expect(sms.sent.filter((text) => text.body === privatePin).map((text) => text.to)).toEqual([LIVE_CLEANER]);
    expect(posts.filter((text) => text.body === privatePin).map((text) => text.body)).toEqual([]);
    expect(sms.sent.filter((text) => text.to === LIVE_HOST && (text.body === privatePin || text.body === PIN_FAILED || text.body === line)).map((text) => text.body)).toEqual([]);
  });

  it("hides the private note after an undelivered report and returns the failed-send sentence", async () => {
    const { desk, sms, posts, pinKey, privatePin } = await privateSendWithoutHost();
    const line = "I've sent the door code to Maria privately.";
    const left = await desk.markGuestsLeft({ said: "The guests have left" }, pinKey);
    expect(left).toEqual({ ok: true, result: { next: PIN_SENT } });
    const pinText = sms.sent.find((text) => text.body === privatePin);
    desk.notePinDelivery({ sid: pinText?.sid ?? "", status: "sent" });
    const pendingNote = desk.getState();
    expect(pendingNote.ok).toBe(true);
    if (pendingNote.ok) expect(pendingNote.result.notes).toEqual(PRACTICE_SETUP);
    desk.notePinDelivery({ sid: pinText?.sid ?? "", status: "delivered" });
    const shown = desk.getState();
    expect(shown.ok).toBe(true);
    if (shown.ok) {
      expect(shown.result.notes).toEqual([...PRACTICE_SETUP, line]);
      expect(shown.result.next).toBe(AFTER_CHECKS);
    }
    desk.notePinDelivery({ sid: pinText?.sid ?? "", status: "undelivered" });
    const hidden = desk.getState();
    expect(hidden.ok).toBe(true);
    if (hidden.ok) {
      expect(hidden.result.notes).toEqual(PRACTICE_SETUP);
      expect(hidden.result.next).toBe(PIN_FAILED);
    }
    expect(sms.sent.filter((text) => text.body === privatePin).map((text) => text.to)).toEqual([LIVE_CLEANER]);
    expect(posts.filter((text) => text.body === privatePin).map((text) => text.body)).toEqual([]);
    expect(sms.sent.filter((text) => text.to === LIVE_HOST && (text.body === privatePin || text.body === line || text.body === PIN_FAILED)).map((text) => text.body)).toEqual([]);
  });

  function notesOf(reply: { ok: boolean; result?: Record<string, unknown> }): string[] {
    if (!reply.ok || !reply.result) return [];
    const notes = reply.result.notes;
    return Array.isArray(notes) ? notes.filter((line): line is string => typeof line === "string") : [];
  }

  function hostBodies(sent: { to: string; body: string }[]): string[] {
    return sent.filter((text) => text.to === LIVE_HOST).map((text) => text.body);
  }

  async function readyPractice(group: boolean, decide?: (body: string) => string) {
    const root = mkdtempSync(join(tmpdir(), "cleaner-host-notes-"));
    roots.push(root);
    const sms = fakeSms(decide);
    const fetchBox = groupFetch();
    const env: NodeJS.ProcessEnv = {
      CLEANER_CORE_ENABLED: "1",
      CLEANER_CORE_LIVE_SMS: "1",
      ...(group ? { CLEANER_CORE_GROUP_CHAT: "1" } : {}),
      CLEANER_CORE_SMS_ALLOWLIST: `${LIVE_HOST},${LIVE_CLEANER}`,
      CLEANER_CORE_TWILIO_ACCOUNT_SID: "ACfake",
      CLEANER_CORE_TWILIO_AUTH_TOKEN: "token",
      CLEANER_CORE_TWILIO_PHONE_NUMBER: CLEANER_LINE,
    };
    setCleanerTwilioClient(sms);
    setCleanerGroupFetch(fetchBox.impl);
    setCleanerCalendarFetch(async (url) => ({
      status: url === CALENDAR_URL ? 200 : 404,
      url,
      async text() {
        return url === CALENDAR_URL ? CALENDAR_ICS : "";
      },
    }));
    const pinKey = Buffer.from(TEST_PIN_KEY, "base64");
    const desk = liveDeskFor(root, () => env, () => new Date(FROZEN));
    expect(desk.getState("2").ok).toBe(true);
    expect(desk.saveProperty({ business: "Harbor", address: PRACTICE, timeZone: "America/New_York" }).ok).toBe(true);
    expect(desk.savePeople({ host: LIVE_HOST, cleaner: LIVE_CLEANER, observer: OBSERVER }).ok).toBe(true);
    expect(desk.saveCalendarLink({ url: CALENDAR_URL }).ok).toBe(true);
    expect(desk.saveDoorCode({ code: DOOR_CODE }, pinKey).ok).toBe(true);
    expect(desk.setUpTexting().ok).toBe(true);
    expect((await desk.runChecks()).ok).toBe(true);
    await desk.confirmTimes({ checkout: "11:00 AM", checkIn: "4:00 PM" });
    return { desk, sms, posts: fetchBox.posts, pinKey, root };
  }

  it("keeps every host message off SMS, one-on-one and in the group", async () => {
    const pinHeld = "The cleaner opted out, so the door code wasn't sent. Please reach them directly.";
    const stopHold = `The cleaner opted out of cleaning texts for ${PRACTICE}, so the job is on hold.`;
    const hostHurt = `The cleaner at ${PRACTICE} says someone is hurt. They've been told to call 911.`;
    const cleanerHurt = "If someone is hurt, call 911 now. I've let the host know.";
    const direct = "Got it. To send the door code, tell your Grok Bot the guests have left. The cleaner is still waiting for the OK.";
    const resume = resumeNote(PRACTICE);
    const hold = holdNote(PRACTICE);
    const invite = groupOptInBody("Cory", "Maria", PRACTICE);

    const solo = await readyPractice(false);
    await solo.desk.inbound({ id: "solo-yes-offer", from: LIVE_CLEANER, text: "YES" });
    await solo.desk.inbound({ id: "solo-yes-schedule", from: LIVE_CLEANER, text: "YES" });
    const hurt = await solo.desk.inbound({ id: "solo-hurt", from: LIVE_CLEANER, text: "I fell at 2:00 PM and I'm hurt" });
    expect(hurt.sent.filter((text) => text.to === LIVE_CLEANER).map((text) => text.body)).toEqual([cleanerHurt]);
    expect(notesOf(solo.desk.getState())).toContain(hostHurt);
    await solo.desk.inbound({ id: "solo-stop", from: LIVE_CLEANER, text: "STOP" });
    expect(notesOf(solo.desk.getState())).toContain(stopHold);
    const held = await solo.desk.markGuestsLeft({ said: "The guests have left" }, solo.pinKey);
    expect(held).toEqual({ ok: true, result: { next: pinHeld } });
    expect(notesOf(solo.desk.getState())).toContain(pinHeld);
    expect(solo.sms.sent.filter((text) => text.body.includes("Door code:"))).toEqual([]);
    const started = await solo.desk.inbound({ id: "solo-start", from: LIVE_CLEANER, text: "START" });
    expect(started.sent.map((text) => text.body)).toEqual([
      "You're opted back in. Reply YES if you still want this turnover. Reply STOP to opt out.",
    ]);
    expect(solo.sms.sent.filter((text) => text.body.includes("Door code:"))).toEqual([]);
    await solo.desk.inbound({ id: "solo-direct", from: LIVE_HOST, text: "guests left" });
    expect(notesOf(solo.desk.getState())).toContain(direct);
    expect(hostBodies(solo.sms.sent)).toEqual([]);
    expect(solo.posts.map((text) => text.body)).toEqual([]);

    const waiting = await readyPractice(false);
    expect(notesOf(waiting.desk.getState())).toContain(hold);
    expect(hostBodies(waiting.sms.sent)).toEqual([]);

    const failed = await readyPractice(false, (body) => (body.includes("Door code:") ? "failed" : "queued"));
    await failed.desk.inbound({ id: "fail-yes-offer", from: LIVE_CLEANER, text: "YES" });
    await failed.desk.inbound({ id: "fail-yes-schedule", from: LIVE_CLEANER, text: "YES" });
    const missed = await failed.desk.markGuestsLeft({ said: "The guests have left" }, failed.pinKey);
    expect(missed).toEqual({ ok: true, result: { next: PIN_FAILED } });
    expect(notesOf(failed.desk.getState()).join("\n").includes("Door code")).toBe(false);
    expect(hostBodies(failed.sms.sent)).toEqual([]);
    expect(failed.sms.sent.filter((text) => text.to === LIVE_HOST && text.body.includes("Door code:"))).toEqual([]);

    const grouped = await readyPractice(true);
    await grouped.desk.inbound({ id: "group-yes-offer", from: LIVE_CLEANER, text: "YES" });
    await grouped.desk.inbound({ id: "group-yes-schedule", from: LIVE_CLEANER, text: "YES" });
    expect(notesOf(grouped.desk.getState())).toContain(invite);
    await grouped.desk.inbound({ id: "group-problem", from: LIVE_CLEANER, text: "The lock is broken", channel: "group" });
    expect(notesOf(grouped.desk.getState())).toContain(hold);
    expect(grouped.posts.filter((text) => text.body === hold || text.body === resume || text.body === stopHold || text.body === pinHeld)).toEqual([]);
    const resumed = await grouped.desk.resumeCleaning();
    expect(resumed).toEqual({ ok: true, result: { next: resume } });
    expect(notesOf(grouped.desk.getState())).toContain(resume);
    const groupHurt = await grouped.desk.inbound({ id: "group-hurt", from: LIVE_CLEANER, text: "I fell at 2:00 PM and I'm hurt", channel: "group" });
    expect(groupHurt.sent.filter((text) => text.kind === "emergency" && text.to === LIVE_CLEANER).map((text) => text.body)).toEqual([cleanerHurt]);
    expect(grouped.posts.filter((text) => text.body === hostHurt || /2:00 PM/.test(text.body))).toEqual([]);
    expect(notesOf(grouped.desk.getState())).toContain(hostHurt);
    await grouped.desk.inbound({ id: "group-stop", from: LIVE_CLEANER, text: "STOP" });
    expect(notesOf(grouped.desk.getState())).toContain(stopHold);
    const groupHeld = await grouped.desk.markGuestsLeft({ said: "The guests have left" }, grouped.pinKey);
    expect(groupHeld).toEqual({ ok: true, result: { next: pinHeld } });
    expect(notesOf(grouped.desk.getState())).toContain(pinHeld);
    expect(hostBodies(grouped.sms.sent)).toEqual([]);
    expect(grouped.posts.filter((text) => text.body.includes("Door code:") || text.body === PRIVATE_LINE)).toEqual([]);
    expect(grouped.sms.sent.filter((text) => text.body.includes("Door code:") || text.to === LIVE_HOST)).toEqual([]);
  });

  it("shows the private line only after a delivered report and never posts it to the group", async () => {
    const { desk, sms, posts, pinKey, privatePin } = await privateSendWithoutHost();
    const line = "I've sent the door code to Maria privately.";
    const before = notesOf(desk.getState());
    expect(before.filter((item) => item === line)).toEqual([]);
    const left = await desk.markGuestsLeft({ said: "The guests have left" }, pinKey);
    expect(left).toEqual({ ok: true, result: { next: PIN_SENT } });
    const pinText = sms.sent.find((text) => text.body === privatePin);
    expect(sms.sent.filter((text) => text.body === privatePin).map((text) => text.to)).toEqual([LIVE_CLEANER]);
    expect(posts.map((text) => text.body).filter((body) => body === line)).toEqual([]);
    expect(hostBodies(sms.sent)).toEqual([]);
    desk.notePinDelivery({ sid: pinText?.sid ?? "", status: "sent" });
    expect(notesOf(desk.getState())).toEqual(before);
    const again = await desk.markGuestsLeft({ said: "The guests have left" }, pinKey);
    expect(again).toEqual({ ok: true, result: { next: ALREADY } });
    expect(sms.sent.filter((text) => text.body === privatePin)).toHaveLength(1);
    desk.notePinDelivery({ sid: pinText?.sid ?? "", status: "delivered" });
    expect(notesOf(desk.getState())).toEqual([...before, line]);
    expect(posts.map((text) => text.body).filter((body) => body === line || body.includes("Door code:"))).toEqual([]);
    desk.notePinDelivery({ sid: pinText?.sid ?? "", status: "undelivered" });
    const hidden = desk.getState();
    expect(hidden.ok).toBe(true);
    if (hidden.ok) {
      expect(hidden.result.next).toBe(PIN_FAILED);
      expect(notesOf(hidden)).toEqual(before);
    }
    expect(sms.sent.filter((text) => text.body === privatePin)).toHaveLength(1);
  });

  it("names a dropped group text with a fixed topic and does not quote it", async () => {
    const { desk, posts } = await readyPractice(true);
    await desk.inbound({ id: "topic-yes-offer", from: LIVE_CLEANER, text: "YES" });
    await desk.inbound({ id: "topic-yes-schedule", from: LIVE_CLEANER, text: "YES" });
    const fetchBoxPosts = posts;
    const blocked = groupFetch();
    blocked.blockMembership();
    setCleanerGroupFetch(blocked.impl);
    const marker = plainFour([DOOR_CODE, ...SCRATCH_TENANTS.map((tenant) => tenant.pin)]);
    await desk.inbound({ id: "topic-time", from: LIVE_CLEANER, text: `Can we do 2:00 PM, unit ${marker}?`, channel: "group" });
    await desk.inbound({ id: "topic-time-2", from: LIVE_CLEANER, text: `Can we do 3:00 PM, unit ${marker}?`, channel: "group" });
    expect(notesOf(desk.getState()).filter((line) => line.startsWith("I couldn't send"))).toEqual(["I couldn't send the time to the group."]);
    const alert = notesOf(desk.getState()).find((line) => line.startsWith("I couldn't send")) ?? "";
    expect(alert).toBe("I couldn't send the time to the group.");
    expect(alert.includes(marker)).toBe(false);
    expect(alert.includes("2:00")).toBe(false);
    expect(alert.includes("unit")).toBe(false);
    expect(alert.includes("Can we do")).toBe(false);
    expect(alert.includes("Door code")).toBe(false);
    expect(notesOf(desk.getState()).join("\n").includes(marker)).toBe(false);
    expect(blocked.posts.map((text) => text.body)).toEqual([]);
    expect(fetchBoxPosts.map((text) => text.body).filter((body) => body.includes("2:00"))).toEqual([]);
  });

  function clocks(desk: { getTurns(): { ok: boolean; result?: Record<string, unknown> } }): string[] {
    const reply = desk.getTurns();
    if (!reply.ok || !Array.isArray(reply.result?.turns)) return [];
    return reply.result.turns.flatMap((turn) => {
      if (!turn || typeof turn !== "object" || !("checkoutTime" in turn)) return [];
      const time = (turn as { checkoutTime?: unknown }).checkoutTime;
      return typeof time === "string" ? [time] : [];
    });
  }

  it("gives Cory every host-only kind through get_state and texts him nothing", async () => {
    const pinHeld = "The cleaner opted out, so the door code wasn't sent. Please reach them directly.";
    const hostHurt = `The cleaner at ${PRACTICE} says someone is hurt. They've been told to call 911.`;
    const cleanerHurt = "If someone is hurt, call 911 now. I've let the host know.";
    const direct = "Got it. To send the door code, tell your Grok Bot the guests have left. The cleaner is still waiting for the OK.";
    const resume = resumeNote(PRACTICE);
    const hold = holdNote(PRACTICE);
    const invite = groupOptInBody("Cory", "Maria", PRACTICE);
    const review = `I saved a manual Airbnb booking exception for ${PRACTICE}. I did not change the cleaning until you confirm it.`;
    const hostStop = `You're opted out of cleaning texts for ${PRACTICE}. You won't get cleaning offers or the door code. Reply START to opt back in. Reply HELP for help.`;
    const checkin = `Is check-in at ${PRACTICE} on Sunday, Oct 18 still 4:00 PM? Reply YES or send the new time.`;

    const solo = await readyPractice(false);
    expect(notesOf(solo.desk.getState())).toEqual([checkin, hold]);
    await solo.desk.inbound({ id: "kinds-solo-yes-offer", from: LIVE_CLEANER, text: "YES" });
    await solo.desk.inbound({ id: "kinds-solo-yes-schedule", from: LIVE_CLEANER, text: "YES" });
    const hurt = await solo.desk.inbound({ id: "kinds-solo-hurt", from: LIVE_CLEANER, text: "I fell at 2:00 PM and I'm hurt" });
    expect(hurt.sent.filter((text) => text.to === LIVE_CLEANER).map((text) => text.body)).toEqual([cleanerHurt]);
    expect(notesOf(solo.desk.getState())).toContain(hostHurt);
    await solo.desk.inbound({ id: "kinds-solo-stop", from: LIVE_CLEANER, text: "STOP" });
    expect(notesOf(solo.desk.getState())).toContain(PRACTICE_STOP);
    expect(solo.desk.getTurns()).toEqual({ ok: true, result: expect.objectContaining({ held: true }) });
    const held = await solo.desk.markGuestsLeft({ said: "The guests have left" }, solo.pinKey);
    expect(held).toEqual({ ok: true, result: { next: pinHeld } });
    expect(notesOf(solo.desk.getState())).toContain(pinHeld);
    const started = await solo.desk.inbound({ id: "kinds-solo-start", from: LIVE_CLEANER, text: "START" });
    expect(started.sent.map((text) => text.body)).toEqual([
      "You're opted back in. Reply YES if you still want this turnover. Reply STOP to opt out.",
    ]);
    expect(solo.sms.sent.filter((text) => text.body.includes("Door code:"))).toEqual([]);
    await solo.desk.inbound({ id: "kinds-solo-direct", from: LIVE_HOST, text: "guests left" });
    expect(notesOf(solo.desk.getState())).toContain(direct);
    expect(hostBodies(solo.sms.sent)).toEqual([]);

    const failed = await readyPractice(false, (body) => (body.includes("Door code:") ? "failed" : "queued"));
    await failed.desk.inbound({ id: "kinds-fail-yes-offer", from: LIVE_CLEANER, text: "YES" });
    await failed.desk.inbound({ id: "kinds-fail-yes-schedule", from: LIVE_CLEANER, text: "YES" });
    const missed = await failed.desk.markGuestsLeft({ said: "The guests have left" }, failed.pinKey);
    expect(missed).toEqual({ ok: true, result: { next: PIN_FAILED } });
    expect(notesOf(failed.desk.getState()).join("\n").includes("Door code")).toBe(false);
    expect(hostBodies(failed.sms.sent)).toEqual([]);

    const sentPin = await readyPractice(false);
    await sentPin.desk.inbound({ id: "kinds-pin-yes-offer", from: LIVE_CLEANER, text: "YES" });
    await sentPin.desk.inbound({ id: "kinds-pin-yes-schedule", from: LIVE_CLEANER, text: "YES" });
    const left = await sentPin.desk.markGuestsLeft({ said: "The guests have left" }, sentPin.pinKey);
    expect(left).toEqual({ ok: true, result: { next: PIN_SENT } });
    const again = await sentPin.desk.markGuestsLeft({ said: "The guests have left" }, sentPin.pinKey);
    expect(again).toEqual({ ok: true, result: { next: ALREADY } });
    expect(sentPin.sms.sent.filter((text) => text.body.includes("Door code:")).map((text) => text.to)).toEqual([LIVE_CLEANER]);
    expect(notesOf(sentPin.desk.getState()).join("\n").includes("Door code")).toBe(false);
    expect(hostBodies(sentPin.sms.sent)).toEqual([]);

    const grouped = await readyPractice(true);
    expect(notesOf(grouped.desk.getState())).toEqual(expect.arrayContaining([invite, hold]));
    await grouped.desk.inbound({ id: "kinds-group-yes-offer", from: LIVE_CLEANER, text: "YES" });
    await grouped.desk.inbound({ id: "kinds-group-yes-schedule", from: LIVE_CLEANER, text: "YES" });
    expect(clocks(grouped.desk)).toEqual(["11:00 AM"]);
    await grouped.desk.inbound({ id: "kinds-group-time", from: LIVE_CLEANER, text: "Let's say 2:00 PM", channel: "group" });
    expect(clocks(grouped.desk)).toEqual(["11:00 AM"]);
    await grouped.desk.inbound({ id: "kinds-group-problem", from: LIVE_CLEANER, text: "The lock is broken", channel: "group" });
    expect(notesOf(grouped.desk.getState())).toContain(hold);
    const ignored = await grouped.desk.inbound({ id: "kinds-group-start", from: LIVE_CLEANER, text: "START" });
    expect(ignored.sent.map((text) => text.body)).toEqual([]);
    expect(notesOf(grouped.desk.getState()).includes(resume)).toBe(false);
    const groupHurt = await grouped.desk.inbound({ id: "kinds-group-hurt", from: LIVE_CLEANER, text: "I fell at 2:00 PM and I'm hurt", channel: "group" });
    expect(groupHurt.sent.filter((text) => text.to === LIVE_CLEANER).map((text) => text.body)).toEqual([cleanerHurt]);
    expect(notesOf(grouped.desk.getState())).toContain(hostHurt);
    await grouped.desk.inbound({ id: "kinds-group-review", from: LIVE_HOST, text: "booked on airbnb" });
    expect(notesOf(grouped.desk.getState())).toContain(review);
    await grouped.desk.inbound({ id: "kinds-group-stop", from: LIVE_CLEANER, text: "STOP" });
    expect(notesOf(grouped.desk.getState())).toContain(PRACTICE_STOP);
    expect(grouped.desk.getTurns()).toEqual({ ok: true, result: expect.objectContaining({ held: true }) });
    const stillHeld = await grouped.desk.inbound({ id: "kinds-group-start-again", from: LIVE_CLEANER, text: "START" });
    expect(stillHeld.sent.map((text) => text.body)).toEqual([]);
    expect(grouped.desk.getTurns()).toEqual({ ok: true, result: expect.objectContaining({ held: true }) });
    const groupHeld = await grouped.desk.markGuestsLeft({ said: "The guests have left" }, grouped.pinKey);
    expect(groupHeld).toEqual({ ok: true, result: { next: pinHeld } });
    expect(notesOf(grouped.desk.getState())).toContain(pinHeld);
    const resumed = await grouped.desk.resumeCleaning();
    expect(resumed).toEqual({ ok: true, result: { next: resume } });
    expect(notesOf(grouped.desk.getState())).toContain(resume);
    await grouped.desk.inbound({ id: "kinds-host-stop", from: LIVE_HOST, text: "STOP" });
    expect(notesOf(grouped.desk.getState())).toContain(hostStop);
    expect(hostBodies(grouped.sms.sent)).toEqual([]);
    expect(grouped.posts.filter((text) => text.body === hostHurt || text.body === hold || text.body === resume || text.body === pinHeld || text.body === review || text.body === hostStop || text.body === PRIVATE_LINE || text.body.includes("Door code:"))).toEqual([]);
    expect(grouped.sms.sent.filter((text) => text.to === LIVE_HOST || text.body.includes("Door code:"))).toEqual([]);
  });

  it("keeps the private line out of the group on the private route, a failed member check, and an opted-out hold", async () => {
    const line = "I've sent the door code to Maria privately.";
    const privatePin = `Guests have left ${PRACTICE}. Door code: ${DOOR_CODE}. This code is only for you.`;

    const pending = await readyPractice(true);
    await pending.desk.inbound({ id: "route-pending-offer", from: LIVE_CLEANER, text: "YES" });
    await pending.desk.inbound({ id: "route-pending-schedule", from: LIVE_CLEANER, text: "YES" });
    const pendingLeft = await pending.desk.markGuestsLeft({ said: "The guests have left" }, pending.pinKey);
    expect(pendingLeft).toEqual({ ok: true, result: { next: PIN_SENT } });
    const pendingAgain = await pending.desk.markGuestsLeft({ said: "The guests have left" }, pending.pinKey);
    expect(pendingAgain).toEqual({ ok: true, result: { next: ALREADY } });
    expect(pending.sms.sent.filter((text) => text.body === privatePin).map((text) => text.to)).toEqual([LIVE_CLEANER]);
    expect(pending.posts.filter((text) => text.body === line || text.body.includes("Door code:"))).toEqual([]);
    expect(hostBodies(pending.sms.sent)).toEqual([]);
    const pendingSid = pending.sms.sent.find((text) => text.body === privatePin)?.sid ?? "";
    const before = notesOf(pending.desk.getState());
    pending.desk.notePinDelivery({ sid: pendingSid, status: "sent" });
    expect(notesOf(pending.desk.getState())).toEqual(before);
    pending.desk.notePinDelivery({ sid: pendingSid, status: "delivered" });
    expect(notesOf(pending.desk.getState())).toEqual([...before, line]);
    pending.desk.notePinDelivery({ sid: pendingSid, status: "failed" });
    const failedNote = pending.desk.getState();
    expect(failedNote).toEqual({ ok: true, result: expect.objectContaining({ next: PIN_FAILED }) });
    expect(notesOf(failedNote)).toEqual(before);
    expect(pending.posts.filter((text) => text.body === line || text.body.includes("Door code:"))).toEqual([]);

    const blocked = await readyPractice(true);
    await blocked.desk.inbound({ id: "route-block-offer", from: LIVE_CLEANER, text: "YES" });
    await blocked.desk.inbound({ id: "route-block-host", from: LIVE_HOST, text: "YES" });
    await blocked.desk.inbound({ id: "route-block-schedule", from: LIVE_CLEANER, text: "YES" });
    const blockedFetch = groupFetch();
    blockedFetch.blockMembership();
    setCleanerGroupFetch(blockedFetch.impl);
    const blockedLeft = await blocked.desk.markGuestsLeft({ said: "The guests have left" }, blocked.pinKey);
    expect(blockedLeft).toEqual({ ok: true, result: { next: PIN_SENT } });
    expect(blocked.sms.sent.filter((text) => text.body === privatePin).map((text) => text.to)).toEqual([LIVE_CLEANER]);
    expect(blockedFetch.posts.filter((text) => text.body === line || text.body.includes("Door code:"))).toEqual([]);
    expect(blocked.posts.filter((text) => text.body === line || text.body.includes("Door code:"))).toEqual([]);
    const blockedSid = blocked.sms.sent.find((text) => text.body === privatePin)?.sid ?? "";
    blocked.desk.notePinDelivery({ sid: blockedSid, status: "sent" });
    expect(notesOf(blocked.desk.getState()).includes(line)).toBe(false);
    blocked.desk.notePinDelivery({ sid: blockedSid, status: "undelivered" });
    const undelivered = blocked.desk.getState();
    expect(undelivered).toEqual({ ok: true, result: expect.objectContaining({ next: PIN_FAILED }) });
    expect(notesOf(undelivered).includes(line)).toBe(false);
    expect(hostBodies(blocked.sms.sent)).toEqual([]);

    const hostOut = await readyPractice(true);
    await hostOut.desk.inbound({ id: "route-out-offer", from: LIVE_CLEANER, text: "YES" });
    await hostOut.desk.inbound({ id: "route-out-host", from: LIVE_HOST, text: "YES" });
    await hostOut.desk.inbound({ id: "route-out-schedule", from: LIVE_CLEANER, text: "YES" });
    await hostOut.desk.inbound({ id: "route-out-stop", from: LIVE_HOST, text: "STOP" });
    const hostLeft = await hostOut.desk.markGuestsLeft({ said: "The guests have left" }, hostOut.pinKey);
    expect(hostLeft).toEqual({ ok: true, result: { next: PIN_SENT } });
    expect(hostOut.sms.sent.filter((text) => text.body === privatePin).map((text) => text.to)).toEqual([LIVE_CLEANER]);
    expect(hostOut.posts.filter((text) => text.body === line || text.body.includes("Door code:"))).toEqual([]);
    const hostSid = hostOut.sms.sent.find((text) => text.body === privatePin)?.sid ?? "";
    hostOut.desk.notePinDelivery({ sid: hostSid, status: "sent" });
    expect(notesOf(hostOut.desk.getState()).includes(line)).toBe(false);
    hostOut.desk.notePinDelivery({ sid: hostSid, status: "delivered" });
    expect(notesOf(hostOut.desk.getState())).toContain(line);
    expect(hostBodies(hostOut.sms.sent)).toEqual([]);
    expect(hostOut.posts.filter((text) => text.body === line)).toEqual([]);
  });
});
