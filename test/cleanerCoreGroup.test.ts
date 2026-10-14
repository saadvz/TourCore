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
    if (read.ok) expect(read.result.notes ?? []).toEqual([]);
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
    const line = "I couldn't send that to the group.";
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
    if (quiet.ok) expect(quiet.result.notes ?? []).toEqual([]);
    fetchBox.blockMembership();
    await desk.inbound({ id: "time-dropped", from: LIVE_CLEANER, text: "Can we do 2:00 PM?", channel: "group" });
    await desk.inbound({ id: "time-dropped-2", from: LIVE_CLEANER, text: "Can we do 3:00 PM?", channel: "group" });
    const read = desk.getState();
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.result.notes).toEqual([line]);
    expect(line).not.toMatch(/twilio|grok|door code|cleaner_core|\d/);
    expect(sms.sent.filter((text) => text.body === line || text.body === privateLine || text.body === checkout)).toEqual([]);
    expect(fetchBox.posts.map((text) => text.body)).toEqual([]);
    const reread = desk.getState();
    expect(reread.ok).toBe(true);
    if (reread.ok) expect(reread.result.notes).toEqual([line]);

    resetLiveDesks();
    const restarted = boot();
    expect(restarted.saveDoorCode({ code: DOOR_CODE }, pinKey).ok).toBe(true);
    const afterRestart = restarted.getState();
    expect(afterRestart.ok).toBe(true);
    if (afterRestart.ok) expect(afterRestart.result.notes).toEqual([line]);
    await restarted.inbound({ id: "time-dropped-3", from: LIVE_CLEANER, text: "Can we do 4:00 PM?", channel: "group" });
    const still = restarted.getState();
    expect(still.ok).toBe(true);
    if (still.ok) expect(still.result.notes).toEqual([line]);
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
    const alert = "I couldn't send that to the group.";
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
    const failedAlert = "The door code didn't reach the cleaner. Tell me the guests have left again and I'll resend it.";
    const left = await desk.markGuestsLeft({ said: "The guests have left" }, pinKey);
    const again = await desk.markGuestsLeft({ said: "The guests have left" }, pinKey);
    expect(left).toEqual({ ok: true, result: { next: failedAlert } });
    expect(again).toEqual({ ok: true, result: { next: failedAlert } });
    expect(fetchBox.posts.filter((text) => text.body === line || text.body === alert || text.body === checkout || text.body === groupPin || text.body === TIME_LINE)).toEqual([]);
    expect(sms.sent.filter((text) => text.body === privatePin).map((text) => text.to)).toEqual([LIVE_CLEANER]);
    expect(sms.sent.filter((text) => text.body === line || text.body === alert || text.body === checkout || text.body === groupPin)).toEqual([]);
    const waiting = desk.getState();
    expect(waiting.ok).toBe(true);
    if (waiting.ok) {
      expect(waiting.result.next).toBe(failedAlert);
      expect(waiting.result.notes ?? []).toEqual([]);
    }
    const pinText = sms.sent.find((text) => text.body === privatePin);
    desk.notePinDelivery({ sid: pinText?.sid ?? "", status: "sent" });
    const read = desk.getState();
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(read.result.notes).toEqual([line]);
      expect(read.result.next).toBe("Tell me the checkout time and the next check-in time before I text the cleaner.");
      expect(JSON.stringify(read.result.notes).includes(DOOR_CODE)).toBe(false);
      expect(JSON.stringify(read.result.notes).includes(groupPin)).toBe(false);
    }
    resetLiveDesks();
    const restarted = boot();
    expect(restarted.saveDoorCode({ code: DOOR_CODE }, pinKey).ok).toBe(true);
    const afterRestart = restarted.getState();
    expect(afterRestart.ok).toBe(true);
    if (afterRestart.ok) expect(afterRestart.result.notes).toEqual([line]);
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
    if (heldRead.ok) expect(heldRead.result.notes ?? []).toEqual([]);
    expect(heldSms.sent.filter((text) => text.body === `The cleaner opted out of cleaning texts for ${PRACTICE}, so the job is on hold.`).map((text) => text.to)).toEqual([LIVE_HOST]);
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
});
