import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { groupTimeLine } from "../src/cleaner-core/cleanerTexts";
import { openCleanerCore, type CleanerCoreOptions, type CleanerText } from "../src/cleaner-core/core";
import { SCRATCH_TENANTS } from "../src/cleaner-core/tenants";

const ADDRESS = "12 Scratch Lane, Teaneck, NJ 07666";
const OWNER = "+15555550100";
const CLEANER = "+15555550101";
const NOW = "2026-10-14T15:00:00.000Z";
const lane = SCRATCH_TENANTS[0];
if (!lane) throw new Error("Scratch Lane is missing");
const PIN = lane.pin;
const FEED = readFileSync(join("src/cleaner-core/fixtures", "guesty-lite-scratch.ics"), "utf8");
const OFFER_COPY = "Turnover at 12 Scratch Lane, Teaneck, NJ 07666 on Sunday, Oct 18. Checkout 11:00 AM, next guest 4:00 PM. The cleaner will reply to confirm.";
const READY = "The cleaner marked the cleaning at 12 Scratch Lane, Teaneck, NJ 07666 done.";
const PRIVATE_PIN = `Guests have left ${ADDRESS}. Door code: ${PIN}. This code is only for you. Reply DONE when the cleaning is finished.`;
const TIME_LINE = groupTimeLine("Cory");
const SOLO_OPT = "Hi, this is Scratch's cleaning scheduler for 12 Scratch Lane, Teaneck, NJ 07666. Reply YES to get cleaning texts, or STOP to opt out.";
const CLEANER_OPT = "Maria, you're invited to the cleaning group for 12 Scratch Lane, Teaneck, NJ 07666 with Cory. Reply YES to join that group, or STOP to opt out.";
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function box() {
  const sent: CleanerText[] = [];
  return { sent, async send(text: CleanerText) { sent.push(text); } };
}

function options(sent: { send(text: CleanerText): void | Promise<void> }, dataDir?: string, group = true): CleanerCoreOptions {
  return {
    enabled: true,
    property: { id: "prop_12_scratch_lane", address: ADDRESS, timeZone: "America/New_York" },
    ownerPhone: OWNER,
    cleaner: { phone: CLEANER, approved: true },
    pin: PIN,
    hostName: "Scratch",
    consented: true,
    sink: sent,
    now: () => new Date(NOW),
    ...(dataDir ? { dataDir } : {}),
    ...(group ? { groupChat: { hostName: "Cory", cleanerName: "Maria" } } : {}),
  };
}

describe("host group seat", () => {
  it("sends the offer copy and the ready text to the host when he never texts YES", async () => {
    const sent = box();
    const job = openCleanerCore(options(sent));
    await job.pollFeed(FEED);
    await job.confirmHostTimes({ checkout: "11:00 AM", checkIn: "4:00 PM" });
    await job.receive({ id: "cleaner-yes", from: CLEANER, text: "YES" });
    await job.receive({ id: "schedule", from: CLEANER, text: "YES" });
    await job.receive({ id: "left", from: OWNER, text: "guests have left" });
    await job.receive({ id: "done", from: CLEANER, text: "DONE" });

    expect(job.transcript().filter((line) => line.startsWith(`${OWNER}:`) && /\bYES\b/.test(line))).toEqual([]);
    expect(sent.sent.filter((text) => text.kind === "opt-in")).toEqual([
      { to: CLEANER, body: CLEANER_OPT, kind: "opt-in" },
    ]);
    expect(sent.sent.filter((text) => text.body === OFFER_COPY)).toEqual([
      { to: CLEANER, body: OFFER_COPY, kind: "offer", channel: "group", audience: [OWNER, CLEANER] },
    ]);
    expect(sent.sent.filter((text) => text.body === READY)).toEqual([
      { to: OWNER, body: READY, kind: "done" },
    ]);
    expect(sent.sent.filter((text) => text.kind === "pin")).toEqual([
      { to: CLEANER, body: PRIVATE_PIN, kind: "pin" },
    ]);
    expect(sent.sent.filter((text) => text.channel === "group" && text.body.includes(PIN))).toEqual([]);
    expect(job.jobs().some((item) => item.status === "done")).toBe(true);
  });

  it("keeps the host and the opted-in cleaner seated when an existing install turns group mode on", async () => {
    const root = mkdtempSync(join(tmpdir(), "cleaner-host-seat-"));
    roots.push(root);
    const soloSent = box();
    const solo = openCleanerCore(options(soloSent, root, false));
    await solo.pollFeed(FEED);
    expect(soloSent.sent.filter((text) => text.kind === "opt-in")).toEqual([
      { to: CLEANER, body: SOLO_OPT, kind: "opt-in" },
    ]);
    await solo.receive({ id: "solo-yes", from: CLEANER, text: "YES" });

    const sent = box();
    const grouped = openCleanerCore(options(sent, root, true));
    const poll = await grouped.pollFeed(FEED);
    const time = await grouped.receive({ id: "group-time", from: CLEANER, text: "Can we do 2:00 PM?", channel: "group" });

    expect(poll.sent.filter((text) => text.kind === "opt-in" || /Reply YES/.test(text.body))).toEqual([]);
    expect(sent.sent.filter((text) => text.kind === "opt-in" || /Reply YES/.test(text.body))).toEqual([]);
    expect(time.sent).toEqual([
      { to: CLEANER, body: TIME_LINE, kind: "confirm", channel: "group", audience: [OWNER, CLEANER] },
    ]);
  });

  it("sends the host no group text after he replies STOP", async () => {
    const sent = box();
    const job = openCleanerCore(options(sent));
    await job.pollFeed(FEED);
    await job.confirmHostTimes({ checkout: "11:00 AM", checkIn: "4:00 PM" });
    await job.receive({ id: "cleaner-yes", from: CLEANER, text: "YES" });
    const before = await job.receive({ id: "before-stop", from: CLEANER, text: "Can we do 2:00 PM?", channel: "group" });
    const mark = sent.sent.length;
    const stopped = await job.receive({ id: "host-stop", from: OWNER, text: "STOP" });
    const after = await job.receive({ id: "after-stop", from: CLEANER, text: "Can we do 3:00 PM?", channel: "group" });

    expect(before.sent).toEqual([
      { to: CLEANER, body: TIME_LINE, kind: "confirm", channel: "group", audience: [OWNER, CLEANER] },
    ]);
    expect(stopped.sent.filter((text) => text.channel === "group")).toEqual([]);
    expect(after.sent).toEqual([
      { to: CLEANER, body: TIME_LINE, kind: "confirm", channel: "group", audience: [CLEANER] },
    ]);
    expect(sent.sent.slice(mark).filter((text) => text.channel === "group" && (text.to === OWNER || text.audience?.includes(OWNER)))).toEqual([]);
  });
});
