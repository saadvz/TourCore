import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { MessagingLedger } from "../src/messaging/ledger";
import { handleProviderWebhook } from "../src/messaging/pipeline";
import { LocalMessagingProvider } from "../src/messaging/local/provider";
import { cleanerCoreEnabled, openCleanerCore, runDoctor, runSmoke, type CleanerText } from "../src/cleaner-core";

const ADDRESS = "12 Scratch Lane, Teaneck, NJ 07666";
const OWNER = "+15555550100";
const CLEANER = "+15555550101";
const PIN = "4821";
const OFFER = "Turnover at 12 Scratch Lane, Teaneck, NJ 07666 on Sunday, Oct 18. Checkout 11:00 AM, next guest 4:00 PM. Reply YES to schedule it, or STOP to opt out.";
const CONFIRM = "Cleaning is scheduled for Sunday, Oct 18 at 11:00 AM at 12 Scratch Lane, Teaneck, NJ 07666.";
const PIN_TEXT = "Door code for 12 Scratch Lane, Teaneck, NJ 07666 on Sunday, Oct 18: 4821. This code is only for you.";
const STOP_ACK = "Tour Core: You're opted out and won't receive more messages. Reply START to opt back in. Reply HELP for help.";
const HELP_ACK = "Cleaner Core: Reply here if you need help with this turnover. Reply STOP to opt out.";
const START_ACK = "You're opted back in. Reply YES if you still want this turnover. Reply STOP to opt out.";
const DECLINED = "Okay, that turnover is not scheduled.";
const EMERGENCY = "If someone is hurt, call 911 now. I couldn't reach the property team just now.";
const NOW = new Date("2026-10-14T15:00:00.000Z");

/** Later stay is listed first. Checkout date is folded across a line, the way an iCal feed wraps. */
const SCRATCH_ICAL = [
  "BEGIN:VCALENDAR",
  "BEGIN:VEVENT",
  "UID:stay-b",
  "DTSTART;VALUE=DATE:20261018",
  "DTEND;VALUE=DATE:20261020",
  "SUMMARY:Reserved",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:stay-a",
  "DTSTART;VALUE=DATE:20261016",
  "DTEND;VALUE=DATE:202610",
  " 18",
  "SUMMARY:Reserved",
  "END:VEVENT",
  "END:VCALENDAR",
].join("\n");

const NEXT_JOB_ICAL = [
  "BEGIN:VCALENDAR",
  "BEGIN:VEVENT",
  "DTSTART;VALUE=DATE:20261019",
  "DTEND;VALUE=DATE:20261021",
  "SUMMARY:Reserved",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "DTSTART;VALUE=DATE:20261021",
  "DTEND;VALUE=DATE:20261023",
  "SUMMARY:Reserved",
  "END:VEVENT",
  "END:VCALENDAR",
].join("\n");

const NEXT_OFFER = "Turnover at 12 Scratch Lane, Teaneck, NJ 07666 on Wednesday, Oct 21. Checkout 11:00 AM, next guest 4:00 PM. Reply YES to schedule it, or STOP to opt out.";

const GAP_ICAL = [
  "BEGIN:VCALENDAR",
  "BEGIN:VEVENT",
  "DTSTART;VALUE=DATE:20261016",
  "DTEND;VALUE=DATE:20261018",
  "SUMMARY:Reserved",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "DTSTART;VALUE=DATE:20261025",
  "DTEND;VALUE=DATE:20261028",
  "SUMMARY:Reserved",
  "END:VEVENT",
  "END:VCALENDAR",
].join("\n");

afterEach(() => {
  delete process.env.CLEANER_CORE_ENABLED;
});

function sink() {
  const sent: CleanerText[] = [];
  return { sent, send(text: CleanerText) { sent.push(text); } };
}

function core(sent: ReturnType<typeof sink>, overrides: Partial<Parameters<typeof openCleanerCore>[0]> = {}) {
  return openCleanerCore({
    enabled: true,
    property: { id: "prop_12_scratch_lane", address: ADDRESS, timeZone: "America/New_York" },
    ownerPhone: OWNER,
    cleaner: { phone: CLEANER, approved: true },
    pin: PIN,
    consented: true,
    sink: sent,
    now: () => NOW,
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

  it("sends nothing when the flag is off, and the same calendar texts the owner when it is on", async () => {
    const off = sink();
    const disabled = await core(off, { enabled: false }).scheduleFromIcal(SCRATCH_ICAL);
    expect(disabled).toEqual({ scheduled: false, reason: "disabled", sent: [] });
    expect(off.sent).toEqual([]);

    const on = sink();
    const offered = await core(on).scheduleFromIcal(SCRATCH_ICAL);
    expect(offered).toEqual({
      scheduled: true,
      reason: "offered",
      sent: [{ to: OWNER, body: OFFER, kind: "offer" }],
      turnover: { checkout: "2026-10-18T15:00:00.000Z", nextArrival: "2026-10-18T20:00:00.000Z" },
    });
    expect(on.sent).toEqual([{ to: OWNER, body: OFFER, kind: "offer" }]);
  });
});

describe("one Scratch turnover", () => {
  it("confirms to the owner and sends the door code only to the approved cleaner", async () => {
    const box = sink();
    const job = core(box);
    await job.scheduleFromIcal(SCRATCH_ICAL);
    const booked = await job.receive({ id: "yes-1", from: OWNER, text: "YES" });
    expect(booked).toEqual({
      handled: true,
      reason: "scheduled",
      sent: [
        { to: OWNER, body: CONFIRM, kind: "confirm" },
        { to: CLEANER, body: PIN_TEXT, kind: "pin" },
      ],
    });
    expect(box.sent).toEqual([
      { to: OWNER, body: OFFER, kind: "offer" },
      { to: OWNER, body: CONFIRM, kind: "confirm" },
      { to: CLEANER, body: PIN_TEXT, kind: "pin" },
    ]);
    const again = await job.receive({ id: "yes-1", from: OWNER, text: "YES" });
    expect(again).toEqual({ handled: true, reason: "duplicate", sent: [] });
    expect(box.sent.map((text) => text.body)).toEqual([OFFER, CONFIRM, PIN_TEXT]);
  });

  it("does not text the door code when the cleaner is not approved", async () => {
    const box = sink();
    const job = core(box, { cleaner: { phone: CLEANER, approved: false } });
    await job.scheduleFromIcal(SCRATCH_ICAL);
    const booked = await job.receive({ id: "yes-2", from: OWNER, text: "YES" });
    expect(booked.sent).toEqual([{ to: OWNER, body: CONFIRM, kind: "confirm" }]);
    expect(box.sent.map((text) => text.kind)).toEqual(["offer", "confirm"]);
  });

  it("keeps the door code off the line after STOP, HELP, and an injury", async () => {
    const stopped = sink();
    const stopJob = core(stopped);
    await stopJob.scheduleFromIcal(SCRATCH_ICAL);
    expect(await stopJob.receive({ id: "stop-1", from: OWNER, text: "STOP" })).toEqual({
      handled: true,
      reason: "stop",
      sent: [{ to: OWNER, body: STOP_ACK, kind: "stop" }],
    });
    expect(await stopJob.receive({ id: "yes-after-stop", from: OWNER, text: "YES" })).toEqual({
      handled: true,
      reason: "ignored",
      sent: [],
    });
    expect(stopped.sent).toEqual([
      { to: OWNER, body: OFFER, kind: "offer" },
      { to: OWNER, body: STOP_ACK, kind: "stop" },
    ]);

    const helped = sink();
    const helpJob = core(helped);
    await helpJob.scheduleFromIcal(SCRATCH_ICAL);
    expect(await helpJob.receive({ id: "help-1", from: OWNER, text: "HELP" })).toEqual({
      handled: true,
      reason: "help",
      sent: [{ to: OWNER, body: HELP_ACK, kind: "help" }],
    });
    expect(helped.sent).toEqual([
      { to: OWNER, body: OFFER, kind: "offer" },
      { to: OWNER, body: HELP_ACK, kind: "help" },
    ]);

    const hurt = sink();
    const hurtJob = core(hurt);
    await hurtJob.scheduleFromIcal(SCRATCH_ICAL);
    expect(await hurtJob.receive({ id: "hurt-1", from: OWNER, text: "I fell and I'm hurt" })).toEqual({
      handled: true,
      reason: "emergency",
      sent: [{ to: OWNER, body: EMERGENCY, kind: "emergency" }],
    });
    expect(await hurtJob.receive({ id: "hurt-2", from: OWNER, text: "I fell and I'm hurt" })).toEqual({
      handled: true,
      reason: "emergency",
      sent: [],
    });
    expect(hurt.sent).toEqual([
      { to: OWNER, body: OFFER, kind: "offer" },
      { to: OWNER, body: EMERGENCY, kind: "emergency" },
    ]);
  });

  it("sends the emergency reply once per sender per job", async () => {
    const box = sink();
    const job = core(box);
    await job.scheduleFromIcal(SCRATCH_ICAL);

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
    expect(await job.receive({ id: "hurt-cleaner-2", from: CLEANER, text: "I fell and I'm hurt" })).toEqual({
      handled: true,
      reason: "emergency",
      sent: [],
    });

    await job.scheduleFromIcal(NEXT_JOB_ICAL);
    expect(await job.receive({ id: "hurt-owner-3", from: OWNER, text: "I fell and I'm hurt" })).toEqual({
      handled: true,
      reason: "emergency",
      sent: [{ to: OWNER, body: EMERGENCY, kind: "emergency" }],
    });
    expect(await job.receive({ id: "hurt-owner-4", from: OWNER, text: "I fell and I'm hurt" })).toEqual({
      handled: true,
      reason: "emergency",
      sent: [],
    });

    expect(box.sent).toEqual([
      { to: OWNER, body: OFFER, kind: "offer" },
      { to: OWNER, body: EMERGENCY, kind: "emergency" },
      { to: CLEANER, body: EMERGENCY, kind: "emergency" },
      { to: OWNER, body: NEXT_OFFER, kind: "offer" },
      { to: OWNER, body: EMERGENCY, kind: "emergency" },
    ]);
  });

  it("opts back in on START and still withholds the door code until YES", async () => {
    const box = sink();
    const job = core(box);
    await job.scheduleFromIcal(SCRATCH_ICAL);
    await job.receive({ id: "stop-2", from: OWNER, text: "please stop texting me" });
    expect(await job.receive({ id: "start-1", from: OWNER, text: "START" })).toEqual({
      handled: true,
      reason: "start",
      sent: [{ to: OWNER, body: START_ACK, kind: "start" }],
    });
    expect(box.sent.map((text) => text.kind)).toEqual(["offer", "stop", "start"]);
    const booked = await job.receive({ id: "yes-3", from: OWNER, text: "Yes please" });
    expect(booked.sent).toEqual([
      { to: OWNER, body: CONFIRM, kind: "confirm" },
      { to: CLEANER, body: PIN_TEXT, kind: "pin" },
    ]);
  });

  it("does not schedule a no, a stranger's yes, a non-scratch number, a missing consent, or a multi-day gap", async () => {
    const declined = sink();
    const noJob = core(declined);
    await noJob.scheduleFromIcal(SCRATCH_ICAL);
    expect(await noJob.receive({ id: "no-1", from: OWNER, text: "NO" })).toEqual({
      handled: true,
      reason: "declined",
      sent: [{ to: OWNER, body: DECLINED, kind: "declined" }],
    });
    expect(await noJob.scheduleFromIcal(SCRATCH_ICAL)).toEqual({ scheduled: false, reason: "declined", sent: [] });
    expect(declined.sent).toEqual([
      { to: OWNER, body: OFFER, kind: "offer" },
      { to: OWNER, body: DECLINED, kind: "declined" },
    ]);

    const stranger = sink();
    const strangerJob = core(stranger);
    await strangerJob.scheduleFromIcal(SCRATCH_ICAL);
    expect(await strangerJob.receive({ id: "stranger-1", from: CLEANER, text: "YES" })).toEqual({
      handled: true,
      reason: "ignored",
      sent: [],
    });
    expect(stranger.sent).toEqual([{ to: OWNER, body: OFFER, kind: "offer" }]);

    const real = sink();
    const blocked = await core(real, { ownerPhone: "+10000000000", cleaner: { phone: CLEANER, approved: true } }).scheduleFromIcal(SCRATCH_ICAL);
    expect(blocked).toEqual({ scheduled: false, reason: "scratch-only", sent: [] });
    expect(real.sent).toEqual([]);

    const quiet = sink();
    const unconsented = await core(quiet, { consented: false }).scheduleFromIcal(SCRATCH_ICAL);
    expect(unconsented).toEqual({ scheduled: false, reason: "not-consented", sent: [] });
    expect(quiet.sent).toEqual([]);

    const gap = sink();
    const none = await core(gap).scheduleFromIcal(GAP_ICAL);
    expect(none).toEqual({ scheduled: false, reason: "no-turnover", sent: [] });
    expect(gap.sent).toEqual([]);

    const badPin = sink();
    const invalid = await core(badPin, { pin: "hello" }).scheduleFromIcal(SCRATCH_ICAL);
    expect(invalid).toEqual({ scheduled: false, reason: "pin-invalid", sent: [] });
    expect(badPin.sent).toEqual([]);
  });

  it("does not offer the same turnover twice", async () => {
    const box = sink();
    const job = core(box);
    await job.scheduleFromIcal(SCRATCH_ICAL);
    expect(await job.scheduleFromIcal(SCRATCH_ICAL)).toEqual({ scheduled: false, reason: "already-offered", sent: [] });
    expect(box.sent).toEqual([{ to: OWNER, body: OFFER, kind: "offer" }]);
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
      expect(smoke).toEqual({
        ok: true,
        flag: true,
        property: ADDRESS,
        checkout: "2026-10-18T15:00:00.000Z",
        nextArrival: "2026-10-18T20:00:00.000Z",
        sent: [
          { to: OWNER, body: OFFER, kind: "offer" },
          { to: OWNER, body: CONFIRM, kind: "confirm" },
          { to: CLEANER, body: PIN_TEXT, kind: "pin" },
        ],
        pinRecipients: [CLEANER],
      });
      expect(calls).toEqual([]);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("the smoke command exits 2 when the flag is off and prints the turnover when it is on", () => {
    const tsx = "node_modules/.bin/tsx";
    const env = { ...process.env };
    delete env.CLEANER_CORE_ENABLED;
    let failure: unknown;
    try {
      execFileSync(tsx, ["src/cleaner-core/cli.ts", "smoke"], { encoding: "utf8", env, cwd: process.cwd() });
    } catch (err) {
      failure = err;
    }
    const stopped = failure as { status?: number; stdout?: string };
    expect(stopped.status).toBe(2);
    expect(JSON.parse(stopped.stdout ?? "")).toEqual({
      ok: false,
      reason: "disabled",
      sent: [],
      pinRecipients: [],
    });

    const out = execFileSync(tsx, ["src/cleaner-core/cli.ts", "smoke"], {
      encoding: "utf8",
      env: { ...env, CLEANER_CORE_ENABLED: "1" },
      cwd: process.cwd(),
    });
    const report = JSON.parse(out) as { ok: boolean; pinRecipients: string[]; sent: CleanerText[] };
    expect(report.ok).toBe(true);
    expect(report.pinRecipients).toEqual([CLEANER]);
    expect(report.sent.map((text) => text.body)).toEqual([OFFER, CONFIRM, PIN_TEXT]);

    const doctor = execFileSync(tsx, ["src/cleaner-core/cli.ts", "doctor"], { encoding: "utf8", env, cwd: process.cwd() });
    expect(JSON.parse(doctor)).toEqual({
      ok: true,
      enabled: false,
      sends: false,
      note: "Cleaner Core is off. Touring texts are unchanged.",
    });
  });
});
