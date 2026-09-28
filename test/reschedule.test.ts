import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/tourCoreConfig";
import { SimulatedClock } from "../src/core/clock";
import { zonedTimeToUtc } from "../src/core/timezone";
import { TourCoreError } from "../src/core/TourCore";
import { createTourCore } from "../src/createTourCore";
import { DemoMessagingAdapter } from "../src/messaging/Messenger";
import { PropertyWorkspace } from "../src/setup";
import { VisitorDemoSession, visitorView } from "../src/visitor";
import { handleVisitorText } from "../src/visitor/conversation";
import { MessagingConversations } from "../src/visitor/messagingRouter";
import { VisitorDemoRegistry } from "../src/visitor/session";
import { VerificationLinks } from "../src/visitor/verificationLinks";

/** Demo property tours: Monday 28 Sep 2026 at 2:00 PM and 3:30 PM (doors open 10 minutes early, tours last 45). */
const at = (hour: number, minute = 0) => zonedTimeToUtc({ year: 2026, month: 9, day: 28, hour, minute }, "America/New_York");
const TWO_PM = at(14).toISOString();
const THREE_THIRTY = at(15, 30).toISOString();
const PHONE = "+15550102000";

/** A text-message visitor (like Sendblue) booked and verified for 2:00 PM. */
async function bookedByText(kind: "messaging" | "web" = "messaging") {
  let realNow = at(7).getTime();
  const session =
    kind === "messaging"
      ? new VisitorDemoSession("prop_100_alfred_way", loadConfig(), "t", { realNow: () => realNow, kind: "messaging", transport: new DemoMessagingAdapter(() => {}, "MESSAGING") })
      : new VisitorDemoSession("prop_100_alfred_way", loadConfig(), "w", { realNow: () => realNow });
  if (kind === "messaging") {
    for (const text of ["Hi", "1", "1", "YES"]) await handleVisitorText(session, PHONE, text);
  } else {
    await session.act("begin", { name: "Pat Smith", phone: PHONE });
    await session.act("chooseUnit", { unitId: "apt_101" });
    await session.act("chooseTime", (await visitorView(session)).choices[0]!.input);
    await session.act("consent", { agree: true });
  }
  await session.act("submitIdentity", { firstName: "Pat", lastName: "Smith", email: "pat@example.com", phone: PHONE });
  const text = (t: string) => handleVisitorText(session, PHONE, t);
  const lastReply = () => [...session.conversation].reverse().find((m) => m.from === "tourcore")!.text;
  const setTime = (d: Date) => session.clock.jumpTo(d);
  return { session, text, lastReply, setTime, setRealNow: (t: number) => (realNow = t) };
}

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((r) => rmSync(r, { recursive: true, force: true })));

describe("rescheduleReservation", () => {
  it("moves the same reservation to the new time and keeps prospect, consent and verification", async () => {
    const { session } = await bookedByText();
    const before = (await session.reservation())!;
    expect(before).toMatchObject({ status: "READY", slotStart: TWO_PM });

    expect(await session.reschedule(THREE_THIRTY)).toEqual({ changed: true });
    const after = (await session.reservation())!;
    expect(after).toMatchObject({
      id: before.id,
      prospectId: before.prospectId,
      consentId: before.consentId,
      verificationId: before.verificationId,
      status: "READY",
      slotStart: THREE_THIRTY,
      windowStart: at(15, 20).toISOString(),
      windowEnd: at(16, 15).toISOString(),
    });
    expect(await session.store.list("reservations")).toHaveLength(1);
    const audit = (await session.store.listAudit()).filter((e) => e.type === "RESERVATION_RESCHEDULED");
    expect(audit).toHaveLength(1);
    expect(audit[0]!.detail).toContain("from Monday, Sep 28 2:00 PM to Monday, Sep 28 3:30 PM");
  });

  it("tells the visitor the new time through their own channel", async () => {
    const phone = await bookedByText("messaging");
    await phone.session.reschedule(THREE_THIRTY);
    expect(phone.lastReply()).toBe(
      'Your tour has moved to Monday, Sep 28 at 3:30 PM.\nDoors will work for you from 3:20 PM to 4:15 PM.\nText "I\'m here" when you arrive and I\'ll open the entrance.',
    );

    const web = await bookedByText("web");
    await web.session.reschedule(THREE_THIRTY);
    expect(web.lastReply()).toBe("Your tour has moved to Monday, Sep 28 at 3:30 PM.\nDoors will work for you from 3:20 PM to 4:15 PM.");
  });

  it("the old time no longer opens doors, and the new time does", async () => {
    const { session, text, lastReply, setTime } = await bookedByText();
    await session.reschedule(THREE_THIRTY);

    setTime(at(13, 58));
    await text("I'm here");
    expect(session.lastAccess).toMatchObject({ allowed: false, code: "DENY_TOO_EARLY", durinCalled: false });
    expect(lastReply()).toBe("You're a little early! I can open the doors from 3:20 PM.");

    setTime(at(15, 28));
    await text("I'm here");
    expect(session.lastAccess).toMatchObject({ allowed: true, code: "ALLOW", durinCalled: true });
    expect(lastReply()).toContain("Entrance is open for you now.");
  });

  it("switches off doors already opened for the old time", async () => {
    const { session, text, setTime } = await bookedByText();
    setTime(at(13, 58));
    await text("I'm here");
    expect((await session.reservation())!.status).toBe("TOURING");

    await session.reschedule(THREE_THIRTY);
    const grants = await session.core.listGrants(session.reservationId!);
    expect(grants.map((g) => g.status)).toEqual(["REVOKED"]);
    expect(session.durin.revokeCount).toBe(1);
    expect((await session.reservation())!.status).toBe("READY");

    // Back to waiting for the new time: arriving during the old window is refused.
    setTime(at(14, 5));
    await text("I'm here");
    expect(session.lastAccess).toMatchObject({ doorId: "entrance", allowed: false, code: "DENY_TOO_EARLY", durinCalled: false });
  });

  it("rejects times outside tour hours, past times and times another visitor holds", async () => {
    const { session, setTime } = await bookedByText();
    await expect(session.reschedule(at(20).toISOString())).rejects.toMatchObject({ code: "SLOT_NOT_OFFERED" });
    await expect(session.reschedule("tomorrow-ish")).rejects.toMatchObject({ code: "INVALID_SLOT" });
    setTime(at(16, 30));
    await expect(session.reschedule(THREE_THIRTY)).rejects.toMatchObject({ code: "SLOT_PAST" });
    expect((await session.reservation())!.slotStart).toBe(TWO_PM);

    // Two visitors in one store: a taken time can't be moved into.
    const clock = new SimulatedClock(at(7));
    const core = createTourCore(loadConfig(), { clock, messenger: new DemoMessagingAdapter(() => {}) });
    const a = await core.startInquiry({ name: "A", phone: "5550100001", unitId: "apt_101" });
    await core.reserveSlot(a.reservation.id, TWO_PM);
    const b = await core.startInquiry({ name: "B", phone: "5550100002", unitId: "apt_102" });
    await core.reserveSlot(b.reservation.id, THREE_THIRTY);
    await expect(core.rescheduleReservation({ reservationId: a.reservation.id, newStartsAt: THREE_THIRTY })).rejects.toBeInstanceOf(TourCoreError);
    await expect(core.rescheduleReservation({ reservationId: a.reservation.id, newStartsAt: THREE_THIRTY })).rejects.toMatchObject({ code: "SLOT_UNAVAILABLE" });
  });

  it("treats a repeated reschedule to the same time as a no-op", async () => {
    const { session } = await bookedByText();
    const messagesBefore = (await session.store.list("messages")).length;
    expect(await session.reschedule(THREE_THIRTY)).toEqual({ changed: true });
    expect(await session.reschedule(THREE_THIRTY)).toEqual({ changed: false });
    expect((await session.store.listAudit()).filter((e) => e.type === "RESERVATION_RESCHEDULED")).toHaveLength(1);
    expect((await session.store.list("messages")).length).toBe(messagesBefore + 1);
  });

  it("offers only open, configured tour times", async () => {
    const { session } = await bookedByText();
    const options = (await session.rescheduleOptions()).map((s) => s.start.toISOString());
    expect(options[0]).toBe(THREE_THIRTY);
    expect(options).not.toContain(TWO_PM);
  });
});

describe("developer: move tour to now", () => {
  it("starts the tour this minute, even outside tour hours, without touching the clock", async () => {
    const { session, text, lastReply, setRealNow } = await bookedByText();
    const sundayNight = zonedTimeToUtc({ year: 2026, month: 9, day: 27, hour: 19, minute: 45 }, "America/New_York");
    setRealNow(sundayNight.getTime() + 20_000);
    expect(await session.moveTourToNow()).toEqual({ changed: true });
    expect((await session.reservation())!.slotStart).toBe(sundayNight.toISOString());
    expect(session.clock.now().getTime()).toBe(sundayNight.getTime() + 20_000);
    await text("I'm here");
    expect(session.lastAccess).toMatchObject({ allowed: true, code: "ALLOW" });
    expect(lastReply()).toContain("Entrance is open for you now.");
  });

  it("only skips tour hours when asked to", async () => {
    const { session, setRealNow } = await bookedByText();
    const sundayNight = zonedTimeToUtc({ year: 2026, month: 9, day: 27, hour: 19, minute: 45 }, "America/New_York");
    setRealNow(sundayNight.getTime() - 3_600_000);
    await expect(session.reschedule(sundayNight.toISOString())).rejects.toMatchObject({ code: "SLOT_NOT_OFFERED" });
    expect(await session.reschedule(sundayNight.toISOString(), { outsideTourHours: true })).toEqual({ changed: true });
    const r = (await session.reservation())!;
    expect(r.windowEnd).toBe(new Date(sundayNight.getTime() + 45 * 60_000).toISOString());
  });
});

describe("conversations survive a restart", () => {
  it("restores an in-progress text tour from its records and keeps going", async () => {
    const root = mkdtempSync(join(tmpdir(), "tourcore-restore-"));
    roots.push(root);
    const ws = new PropertyWorkspace(root);
    const config = { ...loadConfig(), messagingMode: "sendblue" as const };
    ws.save(config);
    const sent: string[] = [];
    const transport = new DemoMessagingAdapter((l) => sent.push(l), "MESSAGING");
    const links = new VerificationLinks({ baseUrl: () => undefined });

    const { session } = await bookedByText();
    const { record, bundle } = await session.record();
    ws.recordVisitorDemo(config.property.id, { ...record, tourId: "2026-09-27T22-00-00-000Z_text" }, bundle);

    const registry = new VisitorDemoRegistry();
    const router = new MessagingConversations({ workspace: ws, registry, links, transport: () => transport, realNow: () => at(7).getTime() });
    expect(await router.restoreSaved()).toBe(1);
    const restored = registry.latestForPhone(config.property.id, PHONE, "messaging")!;
    expect(restored.reservationId).toBe(session.reservationId);
    expect(await restored.stage()).toBe("ready");

    await restored.reschedule(THREE_THIRTY);
    const seqs = (await restored.store.listAudit()).map((e) => e.seq);
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(sent.join("\n")).toContain("Your tour has moved to Monday, Sep 28 at 3:30 PM.");
  });
});
