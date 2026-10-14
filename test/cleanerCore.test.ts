import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MessagingLedger } from "../src/messaging/ledger";
import { handleProviderWebhook } from "../src/messaging/pipeline";
import { LocalMessagingProvider } from "../src/messaging/local/provider";
import { cleanerCoreEnabled, openCleanerCore, runDoctor, runSmoke, type CleanerText } from "../src/cleaner-core";

const ADDRESS = "12 Scratch Lane, Teaneck, NJ 07666";
const OWNER = "+15555550100";
const CLEANER = "+15555550101";
const CHECKOUT_Q = "Is checkout at 12 Scratch Lane, Teaneck, NJ 07666 on Sunday, Oct 18 still 11:00 AM? Reply YES or send the new time.";
const CHECKIN_Q = "Is check-in at 12 Scratch Lane, Teaneck, NJ 07666 on Sunday, Oct 18 still 4:00 PM? Reply YES or send the new time.";
const OFFER = "Turnover at 12 Scratch Lane, Teaneck, NJ 07666 on Sunday, Oct 18. Checkout 11:00 AM, next guest 4:00 PM. Reply YES to schedule it, or STOP to opt out.";
const OFFER_1PM = "Turnover at 12 Scratch Lane, Teaneck, NJ 07666 on Sunday, Oct 18. Checkout 1:00 PM, next guest 4:00 PM. Reply YES to schedule it, or STOP to opt out.";
const CONFIRM = "Cleaning is scheduled for Sunday, Oct 18 at 11:00 AM at 12 Scratch Lane, Teaneck, NJ 07666.";
const CONFIRM_1PM = "Cleaning is scheduled for Sunday, Oct 18 at 1:00 PM at 12 Scratch Lane, Teaneck, NJ 07666.";
const MONDAY_Q = "Is checkout at 12 Scratch Lane, Teaneck, NJ 07666 on Monday, Oct 19 still 11:00 AM? Reply YES or send the new time.";
const MONDAY_CHECKIN_Q = "Is check-in at 12 Scratch Lane, Teaneck, NJ 07666 on Monday, Oct 19 still 4:00 PM? Reply YES or send the new time.";
const CORRECTED = "Update: checkout at 12 Scratch Lane, Teaneck, NJ 07666 moved to Monday, Oct 19 at 11:00 AM. Reply YES to keep the cleaning, or STOP to opt out.";
const CANCEL = "Update: the cleaning at 12 Scratch Lane, Teaneck, NJ 07666 on Sunday, Oct 18 is canceled, so no need to come. Reply STOP to opt out.";
const REMINDER = "Reminder: checkout at 12 Scratch Lane, Teaneck, NJ 07666 is Sunday, Oct 18 at 11:00 AM. Reply STOP to opt out.";
const STOP_ACK = "Tour Core: You're opted out and won't receive more messages. Reply START to opt back in. Reply HELP for help.";
const HELP_ACK = "Cleaner Core: Reply here if you need help with this turnover. Reply STOP to opt out.";
const START_ACK = "You're opted back in. Reply YES if you still want this turnover. Reply STOP to opt out.";
const DECLINED = "Okay, that turnover is not scheduled.";
const EMERGENCY = "If someone is hurt, call 911 now. I couldn't reach the property team just now.";
const NOW = "2026-10-14T15:00:00.000Z";
const DUE = "2026-10-18T12:00:00.000Z";
const SMOKE_USAGE = "Usage: tsx src/cleaner-core/cli.ts smoke [--data <dir>] [--no-poll] [--feed <file>] [--then-feed <file>] [--now <iso>] [--remind] [--fail-sends <n>] [--reply <from>=<text> ...]";

const feed = (name: string) => readFileSync(join("src/cleaner-core/fixtures", name), "utf8");

afterEach(() => {
  delete process.env.CLEANER_CORE_ENABLED;
});

function said(from: string, text: string): string {
  return `${from}: ${text}`;
}

function sink() {
  const sent: CleanerText[] = [];
  return {
    sent,
    send(text: CleanerText) {
      sent.push(text);
    },
  };
}

function core(sent: ReturnType<typeof sink>, overrides: Partial<Parameters<typeof openCleanerCore>[0]> = {}) {
  return openCleanerCore({
    enabled: true,
    property: { id: "prop_12_scratch_lane", address: ADDRESS, timeZone: "America/New_York" },
    ownerPhone: OWNER,
    cleaner: { phone: CLEANER, approved: true },
    consented: true,
    sink: sent,
    now: () => new Date(NOW),
    ...overrides,
  });
}

describe("flag off leaves touring inbound unchanged", () => {
  it("accepts only 1 or true", () => {
    expect(cleanerCoreEnabled({})).toBe(false);
    expect(cleanerCoreEnabled({ CLEANER_CORE_ENABLED: "" })).toBe(false);
    expect(cleanerCoreEnabled({ CLEANER_CORE_ENABLED: "yes" })).toBe(false);
    expect(cleanerCoreEnabled({ CLEANER_CORE_ENABLED: "0" })).toBe(false);
    expect(cleanerCoreEnabled({ CLEANER_CORE_ENABLED: "1" })).toBe(true);
    expect(cleanerCoreEnabled({ CLEANER_CORE_ENABLED: "true" })).toBe(true);
    expect(cleanerCoreEnabled({ CLEANER_CORE_ENABLED: "TRUE" })).toBe(true);
  });

  it("delivers STOP, HELP, an injury, and YES through the shared pipeline with the flag off and on", async () => {
    for (const flag of [undefined, "1"] as const) {
      if (flag) process.env.CLEANER_CORE_ENABLED = flag;
      else delete process.env.CLEANER_CORE_ENABLED;
      for (const text of ["STOP", "HELP", "I fell and I'm hurt", "YES"]) {
        const ledger = new MessagingLedger();
        const received: string[] = [];
        const raw = Buffer.from(JSON.stringify({ id: `pipe-${text}`, from: "+15555550199", to: "+15555550123", text }));
        const result = await handleProviderWebhook(
          new LocalMessagingProvider(),
          { rawBody: raw, headers: {}, url: "http://127.0.0.1/webhooks/local" },
          { ledger, receive: async (message) => { received.push(message.text); } },
        );
        expect({ status: result.status, body: result.body, received }).toEqual({
          status: 200,
          body: { ok: true },
          received: [text],
        });
        const again = await handleProviderWebhook(
          new LocalMessagingProvider(),
          { rawBody: raw, headers: {}, url: "http://127.0.0.1/webhooks/local" },
          { ledger, receive: async (message) => { received.push(message.text); } },
        );
        expect({ status: again.status, body: again.body, received }).toEqual({
          status: 200,
          body: { duplicate: true },
          received: [text],
        });
      }
    }
  });

  it("sends nothing when the flag is off, and asks the host when it is on", async () => {
    const off = sink();
    const disabled = await core(off, { enabled: false }).pollFeed(feed("guesty-lite-scratch.ics"));
    expect(disabled).toEqual({ polled: false, reason: "disabled", sent: [], jobs: [], blocks: [] });
    expect(off.sent).toEqual([]);

    const on = sink();
    const asked = await core(on).pollFeed(feed("guesty-lite-scratch.ics"));
    expect(asked.sent).toEqual([{ to: OWNER, body: CHECKOUT_Q, kind: "host-checkout" }]);
    expect(on.sent).toEqual([{ to: OWNER, body: CHECKOUT_Q, kind: "host-checkout" }]);
  });
});

describe("Guesty Lite feed", () => {
  it("reads a same-day turn and a free night, and does not treat a block as a departure", async () => {
    const box = sink();
    const job = core(box);
    const read = await job.pollFeed(feed("guesty-lite-scratch.ics"));
    expect(read.blocks).toEqual([
      { uid: "block-owner@guesty.com", summary: "Blocked" },
      { uid: "block-date@guesty.com", summary: "Not available" },
    ]);
    expect(read.jobs.map((item) => ({
      id: item.id,
      checkoutDate: item.checkoutDate,
      nextCheckInDate: item.nextCheckInDate,
      sameDay: item.sameDay,
      live: item.live,
      checkoutTime: item.checkoutTime,
    }))).toEqual([
      { id: "stay-anita@guesty.com", checkoutDate: "2026-10-18", nextCheckInDate: "2026-10-18", sameDay: true, live: true, checkoutTime: null },
      { id: "stay-same-day@guesty.com", checkoutDate: "2026-10-20", nextCheckInDate: "2026-10-22", sameDay: false, live: true, checkoutTime: null },
      { id: "stay-after-gap@guesty.com", checkoutDate: "2026-10-24", nextCheckInDate: null, sameDay: false, live: true, checkoutTime: null },
    ]);
    expect(read.jobs.some((item) => item.id.startsWith("block-"))).toBe(false);
    expect(box.sent).toEqual([{ to: OWNER, body: CHECKOUT_Q, kind: "host-checkout" }]);
    expect(CHECKOUT_Q).not.toContain("10:00");
  });

  it("creates no job and sends no offer for an owner block or a blocked date", async () => {
    const box = sink();
    const read = await core(box).pollFeed(feed("guesty-lite-blocks-only.ics"));
    expect(read.jobs).toEqual([]);
    expect(read.sent).toEqual([]);
    expect(box.sent).toEqual([]);
    expect(read.blocks.map((block) => block.uid)).toEqual(["block-owner@guesty.com", "block-date@guesty.com"]);
  });

  it("asks 11:00 AM when the feed says 10:00, then keeps the host's later time", async () => {
    const box = sink();
    const job = core(box);
    await job.pollFeed(feed("guesty-lite-clock-bait.ics"));
    expect(box.sent.map((text) => text.body)).toEqual([CHECKOUT_Q]);
    await job.receive({ id: "host-1", from: OWNER, text: "1:00 PM" });
    await job.pollFeed(feed("guesty-lite-clock-bait.ics"));
    await job.receive({ id: "host-2", from: OWNER, text: "YES" });
    expect(job.jobs()[0]).toMatchObject({
      checkoutTime: "1:00 PM",
      checkoutAt: "2026-10-18T17:00:00.000Z",
      nextCheckInTime: "4:00 PM",
      hostCheckoutVersion: 1,
      status: "offered",
    });
    expect(box.sent.map((text) => text.body)).toEqual([CHECKOUT_Q, CHECKIN_Q, OFFER_1PM]);
    expect(box.sent.map((text) => text.body).join("\n")).not.toContain("10:00");
  });
});

describe("one Scratch turnover", () => {
  it("confirms the cleaning after the host agrees, and does not send a door code", async () => {
    const box = sink();
    const job = core(box);
    await job.pollFeed(feed("guesty-lite-scratch.ics"));
    await job.receive({ id: "yes-checkout", from: OWNER, text: "YES" });
    await job.receive({ id: "yes-checkin", from: OWNER, text: "YES" });
    const booked = await job.receive({ id: "yes-offer", from: OWNER, text: "YES" });
    expect(booked).toEqual({ handled: true, reason: "scheduled", sent: [{ to: OWNER, body: CONFIRM, kind: "confirm" }] });
    expect(box.sent.map((text) => text.body)).toEqual([CHECKOUT_Q, CHECKIN_Q, OFFER, CONFIRM]);
    expect(box.sent.map((text) => text.kind)).toEqual(["host-checkout", "host-checkin", "offer", "confirm"]);
    expect(job.transcript()).toEqual([
      CHECKOUT_Q, said(OWNER, "YES"), CHECKIN_Q, said(OWNER, "YES"), OFFER, said(OWNER, "YES"), CONFIRM,
    ]);
    const again = await job.receive({ id: "yes-offer", from: OWNER, text: "YES" });
    expect(again).toEqual({ handled: true, reason: "duplicate", sent: [] });
    expect(job.transcript()).toEqual([
      CHECKOUT_Q, said(OWNER, "YES"), CHECKIN_Q, said(OWNER, "YES"), OFFER, said(OWNER, "YES"), CONFIRM,
    ]);
  });

  it("asks the host again when the checkout date changes, and sends the update only after that answer", async () => {
    const box = sink();
    const job = core(box);
    await job.pollFeed(feed("guesty-lite-scratch.ics"));
    await job.receive({ id: "t1", from: OWNER, text: "1:00 PM" });
    await job.receive({ id: "t2", from: OWNER, text: "YES" });
    await job.receive({ id: "t3", from: OWNER, text: "YES" });
    await job.pollFeed(feed("guesty-lite-date-moved.ics"));
    expect(box.sent.map((text) => text.body)).toEqual([CHECKOUT_Q, CHECKIN_Q, OFFER_1PM, CONFIRM_1PM, MONDAY_Q]);
    expect(box.sent.map((text) => text.body).some((body) => body.startsWith("Update:"))).toBe(false);
    expect(job.jobs().find((item) => item.id === "stay-anita@guesty.com")).toMatchObject({
      live: true,
      status: "discovered",
      asking: "checkout",
      checkoutDate: "2026-10-19",
      checkoutTime: null,
      nextCheckInTime: null,
      hostCheckoutVersion: 0,
      hostCheckInVersion: 0,
    });
    await job.receive({ id: "t4", from: OWNER, text: "YES" });
    expect(box.sent.at(-1)?.body).toBe(MONDAY_CHECKIN_Q);
    expect(box.sent.map((text) => text.body).some((body) => body.startsWith("Update:"))).toBe(false);
    await job.receive({ id: "t5", from: OWNER, text: "YES" });
    const bodies = box.sent.map((text) => text.body);
    expect(bodies.at(-1)).toBe(CORRECTED);
    expect(bodies.indexOf(MONDAY_Q)).toBeLessThan(bodies.indexOf(CORRECTED));
    expect(bodies.filter((body) => body.startsWith("Turnover at"))).toEqual([OFFER_1PM]);
    const anita = job.jobs().filter((item) => item.id === "stay-anita@guesty.com");
    expect(anita).toEqual([expect.objectContaining({
      live: true,
      status: "offered",
      checkoutDate: "2026-10-19",
      checkoutTime: "11:00 AM",
      version: 2,
      hostCheckoutVersion: 1,
    })]);
    expect(job.jobs().filter((item) => item.live && item.id === "stay-anita@guesty.com")).toHaveLength(1);
    const due = sink();
    const reminded = core(due, { now: () => new Date(DUE) });
    await reminded.pollFeed(feed("guesty-lite-date-moved.ics"));
    expect(await reminded.runReminders()).toEqual({ sent: [], failed: [] });
    expect(due.sent.map((text) => text.body)).toEqual([
      "Is checkout at 12 Scratch Lane, Teaneck, NJ 07666 on Monday, Oct 19 still 11:00 AM? Reply YES or send the new time.",
    ]);
  });

  it("cancels the old job when the stay leaves the feed", async () => {
    const box = sink();
    const job = core(box);
    await job.pollFeed(feed("guesty-lite-scratch.ics"));
    await job.receive({ id: "c1", from: OWNER, text: "YES" });
    await job.receive({ id: "c2", from: OWNER, text: "YES" });
    await job.pollFeed(feed("guesty-lite-stay-removed.ics"));
    expect(box.sent.map((text) => text.body)).toEqual([CHECKOUT_Q, CHECKIN_Q, OFFER, CANCEL]);
    await job.pollFeed(feed("guesty-lite-stay-removed.ics"));
    await job.pollFeed(feed("guesty-lite-stay-removed.ics"));
    expect(box.sent.map((text) => text.body)).toEqual([
      CHECKOUT_Q,
      CHECKIN_Q,
      OFFER,
      CANCEL,
      "Is checkout at 12 Scratch Lane, Teaneck, NJ 07666 on Tuesday, Oct 20 still 11:00 AM? Reply YES or send the new time.",
    ]);
    expect(job.jobs().map((item) => ({ id: item.id, live: item.live, status: item.status }))).toEqual([
      { id: "stay-anita@guesty.com", live: false, status: "canceled" },
      { id: "stay-same-day@guesty.com", live: true, status: "discovered" },
      { id: "stay-after-gap@guesty.com", live: true, status: "discovered" },
    ]);
    expect(job.jobs().filter((item) => item.live && item.id === "stay-anita@guesty.com")).toEqual([]);
  });

  it("sends each reminder once across a second poll, a failed send, and a restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cleaner-core-"));
    try {
      let fail = true;
      const firstSink = sink();
      const first = core(firstSink, {
        dataDir: dir,
        now: () => new Date(DUE),
        sink: {
          send(text: CleanerText) {
            if (fail && text.kind === "reminder") {
              fail = false;
              throw new Error("send failed");
            }
            firstSink.sent.push(text);
          },
        },
      });
      await first.pollFeed(feed("guesty-lite-scratch.ics"));
      await first.pollFeed(feed("guesty-lite-scratch.ics"));
      expect(first.transcript()).toEqual([CHECKOUT_Q]);
      await first.receive({ id: "m1", from: OWNER, text: "YES" });
      await first.receive({ id: "m2", from: OWNER, text: "YES" });
      expect(await first.runReminders()).toEqual({
        sent: [],
        failed: ["reminder:stay-anita@guesty.com:morning-of:2026-10-18:1:660"],
      });
      expect(first.outbox().find((item) => item.kind === "reminder")).toMatchObject({ status: "failed", body: REMINDER });
      expect(first.transcript()).not.toContain(REMINDER);

      const secondSink = sink();
      const second = core(secondSink, { dataDir: dir, now: () => new Date(DUE) });
      expect(await second.runReminders()).toEqual({ sent: [{ to: OWNER, body: REMINDER, kind: "reminder" }], failed: [] });
      expect(second.transcript().filter((line) => line === REMINDER)).toEqual([REMINDER]);
      expect(second.outbox().find((item) => item.kind === "reminder")?.status).toBe("sent");

      const third = core(sink(), { dataDir: dir, now: () => new Date(DUE) });
      expect(await third.runReminders()).toEqual({ sent: [], failed: [] });
      expect(third.transcript().filter((line) => line === REMINDER)).toEqual([REMINDER]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sends nothing more to the owner after STOP, including a feed change and a reminder", async () => {
    const box = sink();
    const job = core(box, { now: () => new Date(DUE) });
    await job.pollFeed(feed("guesty-lite-scratch.ics"));
    await job.receive({ id: "stop-a", from: OWNER, text: "YES" });
    await job.receive({ id: "stop-b", from: OWNER, text: "YES" });
    expect(await job.receive({ id: "stop-1", from: OWNER, text: "STOP" })).toEqual({
      handled: true,
      reason: "stop",
      sent: [{ to: OWNER, body: STOP_ACK, kind: "stop" }],
    });
    const before = box.sent.length;
    await job.pollFeed(feed("guesty-lite-date-moved.ics"));
    expect(await job.runReminders()).toEqual({ sent: [], failed: [] });
    expect(box.sent.slice(before)).toEqual([]);
    expect(box.sent.filter((text) => text.body === CORRECTED || text.body === REMINDER || text.kind === "offer")).toEqual([
      { to: OWNER, body: OFFER, kind: "offer" },
    ]);
    expect(job.jobs().every((item) => item.textsBlocked)).toBe(true);
  });

  it("answers STOP, HELP, and an injury before step C in every new state", async () => {
    const phrases = [
      { text: "STOP", body: STOP_ACK, kind: "stop" as const, reason: "stop" as const },
      { text: "HELP", body: HELP_ACK, kind: "help" as const, reason: "help" as const },
      { text: "I fell and I'm hurt", body: EMERGENCY, kind: "emergency" as const, reason: "emergency" as const },
    ];
    for (const phrase of phrases) {
      const waiting = sink();
      const waitingJob = core(waiting);
      await waitingJob.pollFeed(feed("guesty-lite-scratch.ics"));
      const waitingStatus = waitingJob.jobs()[0]?.status;
      expect(await waitingJob.receive({ id: `w-${phrase.kind}`, from: OWNER, text: phrase.text })).toEqual({
        handled: true,
        reason: phrase.reason,
        sent: [{ to: OWNER, body: phrase.body, kind: phrase.kind }],
      });
      expect(waitingJob.jobs()[0]?.status).toBe(waitingStatus);
      expect(waiting.sent.map((text) => text.body)).toEqual([CHECKOUT_Q, phrase.body]);

      const offered = sink();
      const offeredJob = core(offered);
      await offeredJob.pollFeed(feed("guesty-lite-scratch.ics"));
      await offeredJob.receive({ id: `o1-${phrase.kind}`, from: OWNER, text: "YES" });
      await offeredJob.receive({ id: `o2-${phrase.kind}`, from: OWNER, text: "YES" });
      expect(offeredJob.jobs()[0]?.status).toBe("offered");
      expect(await offeredJob.receive({ id: `o3-${phrase.kind}`, from: OWNER, text: phrase.text })).toEqual({
        handled: true,
        reason: phrase.reason,
        sent: [{ to: OWNER, body: phrase.body, kind: phrase.kind }],
      });
      expect(offeredJob.jobs()[0]?.status).toBe(phrase.kind === "stop" ? "offered" : "offered");
      expect(offered.sent.at(-1)?.body).toBe(phrase.body);
      expect(offered.sent.map((text) => text.body)).not.toContain(CONFIRM);

      const corrected = sink();
      const correctedJob = core(corrected);
      await correctedJob.pollFeed(feed("guesty-lite-scratch.ics"));
      await correctedJob.receive({ id: `c1-${phrase.kind}`, from: OWNER, text: "YES" });
      await correctedJob.receive({ id: `c2-${phrase.kind}`, from: OWNER, text: "YES" });
      await correctedJob.receive({ id: `c3-${phrase.kind}`, from: OWNER, text: "YES" });
      await correctedJob.pollFeed(feed("guesty-lite-date-moved.ics"));
      const before = corrected.sent.length;
      expect(await correctedJob.receive({ id: `c4-${phrase.kind}`, from: OWNER, text: phrase.text })).toEqual({
        handled: true,
        reason: phrase.reason,
        sent: [{ to: OWNER, body: phrase.body, kind: phrase.kind }],
      });
      expect(corrected.sent.slice(before)).toEqual([{ to: OWNER, body: phrase.body, kind: phrase.kind }]);
      expect(correctedJob.jobs()[0]?.status).not.toBe("confirmed");
    }
  });

  it("sends the emergency reply once per sender per job", async () => {
    const box = sink();
    const job = core(box);
    await job.pollFeed(feed("guesty-lite-scratch.ics"));
    expect(await job.receive({ id: "hurt-owner-1", from: OWNER, text: "I fell and I'm hurt" })).toEqual({
      handled: true,
      reason: "emergency",
      sent: [{ to: OWNER, body: EMERGENCY, kind: "emergency" }],
    });
    expect(await job.receive({ id: "hurt-owner-2", from: OWNER, text: "I fell and I'm hurt" })).toEqual({
      handled: true,
      reason: "emergency",
      sent: [],
    });
    expect(await job.receive({ id: "hurt-cleaner-1", from: CLEANER, text: "I fell and I'm hurt" })).toEqual({
      handled: true,
      reason: "emergency",
      sent: [{ to: CLEANER, body: EMERGENCY, kind: "emergency" }],
    });
    await job.pollFeed(feed("guesty-lite-stay-removed.ics"));
    expect(await job.receive({ id: "hurt-owner-3", from: OWNER, text: "I fell and I'm hurt" })).toEqual({
      handled: true,
      reason: "emergency",
      sent: [{ to: OWNER, body: EMERGENCY, kind: "emergency" }],
    });
    expect(box.sent.filter((text) => text.kind === "emergency").map((text) => text.to)).toEqual([OWNER, CLEANER, OWNER]);
  });

  it("opts back in on START and still does not send a door code", async () => {
    const box = sink();
    const job = core(box);
    await job.pollFeed(feed("guesty-lite-scratch.ics"));
    await job.receive({ id: "stop-2", from: OWNER, text: "please stop texting me" });
    expect(await job.receive({ id: "start-1", from: OWNER, text: "START" })).toEqual({
      handled: true,
      reason: "start",
      sent: [{ to: OWNER, body: START_ACK, kind: "start" }],
    });
    const next = await job.receive({ id: "yes-3", from: OWNER, text: "Yes please" });
    expect(next.sent).toEqual([{ to: OWNER, body: CHECKIN_Q, kind: "host-checkin" }]);
    expect(box.sent.map((text) => text.kind)).toEqual(["host-checkout", "stop", "start", "host-checkin"]);
  });

  it("does not schedule a no, a stranger's yes, a non-scratch number, or a missing consent", async () => {
    const declined = sink();
    const noJob = core(declined);
    await noJob.pollFeed(feed("guesty-lite-scratch.ics"));
    await noJob.receive({ id: "no-a", from: OWNER, text: "YES" });
    await noJob.receive({ id: "no-b", from: OWNER, text: "YES" });
    expect(await noJob.receive({ id: "no-1", from: OWNER, text: "NO" })).toEqual({
      handled: true,
      reason: "declined",
      sent: [{ to: OWNER, body: DECLINED, kind: "declined" }],
    });
    expect((await noJob.pollFeed(feed("guesty-lite-scratch.ics"))).sent).toEqual([{
      to: OWNER,
      body: "Is checkout at 12 Scratch Lane, Teaneck, NJ 07666 on Tuesday, Oct 20 still 11:00 AM? Reply YES or send the new time.",
      kind: "host-checkout",
    }]);
    expect((await noJob.pollFeed(feed("guesty-lite-scratch.ics"))).sent).toEqual([]);
    expect(declined.sent.filter((text) => text.body === OFFER)).toEqual([{ to: OWNER, body: OFFER, kind: "offer" }]);
    expect(declined.sent.map((text) => text.body)).toContain(DECLINED);

    const stranger = sink();
    const strangerJob = core(stranger);
    await strangerJob.pollFeed(feed("guesty-lite-scratch.ics"));
    expect(await strangerJob.receive({ id: "stranger-1", from: CLEANER, text: "YES" })).toEqual({
      handled: true,
      reason: "ignored",
      sent: [],
    });
    expect(stranger.sent).toEqual([{ to: OWNER, body: CHECKOUT_Q, kind: "host-checkout" }]);

    const real = sink();
    const blocked = await core(real, { ownerPhone: "+10000000000" }).pollFeed(feed("guesty-lite-scratch.ics"));
    expect(blocked).toEqual({ polled: false, reason: "scratch-only", sent: [], jobs: [], blocks: [] });
    expect(real.sent).toEqual([]);

    const quiet = sink();
    const unconsented = await core(quiet, { consented: false }).pollFeed(feed("guesty-lite-scratch.ics"));
    expect(unconsented).toEqual({ polled: false, reason: "not-consented", sent: [], jobs: [], blocks: [] });
    expect(quiet.sent).toEqual([]);
  });

  it("runs the doctor and the Scratch smoke command without opening a socket", async () => {
    const calls: string[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request) => {
      calls.push(String(input));
      throw new Error("network");
    }) as typeof fetch;
    try {
      expect(runDoctor({})).toEqual({
        ok: true,
        enabled: false,
        sends: false,
        note: "Cleaner Core is off. Touring texts are unchanged.",
      });
      expect(runDoctor({ CLEANER_CORE_ENABLED: "1" })).toEqual({
        ok: true,
        enabled: true,
        sends: false,
        note: "Cleaner Core is on. doctor does not send texts.",
      });
      const smoke = await runSmoke({ CLEANER_CORE_ENABLED: "1" });
      expect(smoke.transcript).toEqual([
        CHECKOUT_Q, said(OWNER, "YES"), CHECKIN_Q, said(OWNER, "YES"), OFFER, said(OWNER, "YES"), CONFIRM,
      ]);
      expect(smoke.pinRecipients).toEqual([]);
      expect(smoke.checkout).toBe("2026-10-18T15:00:00.000Z");
      expect(smoke.nextArrival).toBe("2026-10-18T20:00:00.000Z");
      expect(calls).toEqual([]);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("the smoke command exits 2 when the flag is off and prints the host questions when it is on", () => {
    const env = { ...process.env };
    delete env.CLEANER_CORE_ENABLED;
    const stopped = cleanerCli(["smoke"], undefined);
    expect(stopped.status).toBe(2);
    expect(JSON.parse(stopped.stdout)).toEqual({ ok: false, reason: "disabled", sent: [], pinRecipients: [] });

    const on = cleanerCli(["smoke"], "1");
    expect(on.status).toBe(0);
    const report = JSON.parse(on.stdout) as { ok: boolean; pinRecipients: string[]; transcript: string[]; sent: CleanerText[] };
    expect(report.ok).toBe(true);
    expect(report.pinRecipients).toEqual([]);
    expect(report.transcript).toEqual([
      CHECKOUT_Q, said(OWNER, "YES"), CHECKIN_Q, said(OWNER, "YES"), OFFER, said(OWNER, "YES"), CONFIRM,
    ]);
    expect(report.sent.map((text) => text.kind)).toEqual(["host-checkout", "host-checkin", "offer", "confirm"]);

    const doctor = cleanerCli(["doctor"], undefined);
    expect(JSON.parse(doctor.stdout)).toEqual({
      ok: true,
      enabled: false,
      sends: false,
      note: "Cleaner Core is off. Touring texts are unchanged.",
    });
  });

  it("injects the given Scratch replies and does not add YES", () => {
    const stop = cleanerCli(["smoke", "--reply", `${OWNER}=STOP`, "--reply", `${OWNER}=YES`], "1");
    expect(stop.status).toBe(0);
    expect(JSON.parse(stop.stdout).transcript).toEqual([
      CHECKOUT_Q, said(OWNER, "STOP"), STOP_ACK, said(OWNER, "YES"),
    ]);

    const help = cleanerCli(["smoke", "--reply", `${OWNER}=HELP`], "1");
    expect(JSON.parse(help.stdout).transcript).toEqual([CHECKOUT_Q, said(OWNER, "HELP"), HELP_ACK]);

    const hurt = "I fell and I'm hurt";
    const injury = cleanerCli([
      "smoke",
      "--reply", `${OWNER}=${hurt}`,
      "--reply", `${OWNER}=${hurt}`,
      "--reply", `${CLEANER}=${hurt}`,
      "--reply", `${CLEANER}=${hurt}`,
    ], "1");
    expect(JSON.parse(injury.stdout).transcript).toEqual([
      CHECKOUT_Q,
      said(OWNER, hurt),
      EMERGENCY,
      said(OWNER, hurt),
      said(CLEANER, hurt),
      EMERGENCY,
      said(CLEANER, hurt),
    ]);
    expect(JSON.parse(injury.stdout).sent.map((text: CleanerText) => text.to)).toEqual([OWNER, OWNER, CLEANER]);

    const stranger = cleanerCli(["smoke", "--reply", "+15555550199=YES"], "1");
    expect(JSON.parse(stranger.stdout).transcript).toEqual([CHECKOUT_Q, said("+15555550199", "YES")]);
    expect(JSON.parse(stranger.stdout).pinRecipients).toEqual([]);
  });

  it("sends nothing when the flag is off, including when a Scratch reply is injected", () => {
    const quiet = cleanerCli(["smoke", "--reply", `${OWNER}=YES`], undefined);
    expect(quiet.status).toBe(2);
    expect(JSON.parse(quiet.stdout)).toEqual({
      ok: false,
      reason: "disabled",
      sent: [],
      pinRecipients: [],
    });
    expect(quiet.stderr).toBe("");
  });

  it("refuses an extra argument or a non-Scratch reply and prints no turnover", () => {
    const extra = cleanerCli(["smoke", "STOP"], "1");
    expect(extra.status).toBe(1);
    expect(extra.stdout).toBe("");
    expect(extra.stderr).toBe(`Unexpected argument STOP. ${SMOKE_USAGE}\n`);

    const real = cleanerCli(["smoke", "--reply", "+10000000000=YES"], "1");
    expect(real.status).toBe(1);
    expect(real.stdout).toBe("");
    expect(real.stderr).toBe("Cleaner Core only texts Scratch test numbers. Refusing +10000000000.\n");

    const realOff = cleanerCli(["smoke", "--reply", "+10000000000=YES"], undefined);
    expect(realOff.status).toBe(1);
    expect(realOff.stdout).toBe("");
    expect(realOff.stderr).toBe("Cleaner Core only texts Scratch test numbers. Refusing +10000000000.\n");

    const doctor = cleanerCli(["doctor", "--reply", `${OWNER}=YES`], undefined);
    expect(doctor.status).toBe(1);
    expect(doctor.stdout).toBe("");
    expect(doctor.stderr).toBe("Unexpected argument --reply. Usage: tsx src/cleaner-core/cli.ts doctor\n");
  });
});

function cleanerCli(args: string[], flag: "1" | undefined): { status: number | null; stdout: string; stderr: string } {
  const env = { ...process.env };
  if (flag) env.CLEANER_CORE_ENABLED = flag;
  else delete env.CLEANER_CORE_ENABLED;
  const result = spawnSync("node_modules/.bin/tsx", ["src/cleaner-core/cli.ts", ...args], {
    encoding: "utf8",
    env,
    cwd: process.cwd(),
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}
