import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/tourCoreConfig";
import { HELP_ALERT_WINDOW_MS, VisitorDenialCopy } from "../src/core/TourCore";
import { zonedTimeToUtc } from "../src/core/timezone";
import { DemoMessagingAdapter } from "../src/messaging/Messenger";
import { handleVisitorText } from "../src/visitor/conversation";
import { smsHelpBody } from "../src/visitor/smsConsent";
import { VisitorDemoSession } from "../src/visitor";
import { grokHarness } from "./grokHarness";
import { bookTour, minutesFrom, setup } from "./helpers";

const at = (hour: number, minute = 0) => zonedTimeToUtc({ year: 2026, month: 9, day: 28, hour, minute }, "America/New_York").getTime();
const PHONE = "+15550102000";
const TEAM = "leasing team";

const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).forEach((c) => c()));

function phone() {
  const transport = new DemoMessagingAdapter(() => {}, "MESSAGING");
  const session = new VisitorDemoSession("prop_100_alfred_way", loadConfig(), "t", { realNow: () => at(13, 58), transport, kind: "messaging" });
  let n = 0;
  const say = (text: string) => handleVisitorText(session, PHONE, text, { provider: "test", providerMessageId: `m_${++n}` });
  return { session, say };
}

async function bookAndArrive(p: ReturnType<typeof phone>) {
  await p.say("TOUR");
  await p.say("YES");
  await p.say("1");
  await p.say("1");
  await p.say("1");
  await p.say("yes");
  await p.session.act("submitIdentity", { firstName: "Pat", lastName: "Smith", email: "pat@example.com", phone: PHONE });
  await p.say("I'm here");
}

async function prospectOutbound(session: VisitorDemoSession) {
  return (await session.store.list("messages")).filter((m) => m.audience === "PROSPECT" && m.direction === "OUTBOUND");
}

describe("help flow: one visitor reply, one open exception", () => {
  it("a HELP text during an active tour sends only the help ack", async () => {
    const p = phone();
    await bookAndArrive(p);
    const before = await prospectOutbound(p.session);
    await p.say("help");
    const added = (await prospectOutbound(p.session)).slice(before.length);
    expect(added.map((m) => m.body)).toEqual([VisitorDenialCopy.helpAck(TEAM)]);
    expect(added.join("\n")).not.toContain("Tour Core:");
    expect(added.join("\n")).not.toContain("Reply STOP to opt out.");
    expect(await p.session.store.listAudit()).toEqual(expect.arrayContaining([expect.objectContaining({ type: "HELP_REQUESTED" })]));
  });

  it("HELP after a unit is booked (reservation, not yet touring) still sends only the help ack", async () => {
    const p = phone();
    await p.say("TOUR");
    await p.say("YES");
    await p.say("1");
    expect(p.session.reservationId).toBeTruthy();
    const before = await prospectOutbound(p.session);
    await p.say("HELP");
    const added = (await prospectOutbound(p.session)).slice(before.length);
    expect(added.map((m) => m.body)).toEqual([VisitorDenialCopy.helpAck(TEAM)]);
    expect((await p.session.store.listAudit()).some((e) => e.type === "HELP_REQUESTED")).toBe(true);
  });

  it("HELP with no reservation still sends the carrier compliance reply", async () => {
    const p = phone();
    const before = await prospectOutbound(p.session);
    await p.say("HELP");
    const added = (await prospectOutbound(p.session)).slice(before.length);
    expect(added.map((m) => m.body)).toEqual([smsHelpBody()]);
    expect(added[0]!.body).toContain("Tour Core:");
    expect(added[0]!.body).toContain("Reply STOP to opt out.");
    expect((await p.session.store.listAudit()).filter((e) => e.type === "HELP_REQUESTED")).toHaveLength(0);
  });

  it("two help texts on one tour keep one open exception and append the later ask", async () => {
    const h = grokHarness();
    cleanups.push(h.cleanup);
    const id = await h.publish();
    const v = await h.touringVisitor(id);
    await v.act("help");
    const first = await h.ok("list_exceptions");
    expect(first.summary).toBe("1 thing needs attention.");
    const help = first.exceptions.filter((e: { what: string }) => e.what === "Visitor asked for help");
    expect(help).toHaveLength(1);
    expect(help[0].summary).toBe("Asked for help near Unit 101 Door.");

    await v.act("help");
    const second = await h.ok("list_exceptions");
    expect(second.summary).toBe("1 thing needs attention.");
    const again = second.exceptions.filter((e: { what: string }) => e.what === "Visitor asked for help");
    expect(again).toHaveLength(1);
    expect(again[0].exceptionId).toBe(help[0].exceptionId);
    expect(again[0].summary).toBe('Asked for help near Unit 101 Door. Asked again at Sep 28, 9:00 AM: "I need help".');

    await h.ok("resolve_exception", { exceptionId: again[0].exceptionId, resolutionNote: "Called Pat." });
    await v.act("help");
    const afterResolve = await h.ok("list_exceptions");
    const openHelp = afterResolve.exceptions.filter((e: { what: string }) => e.what === "Visitor asked for help");
    expect(openHelp).toHaveLength(1);
    expect(openHelp[0].exceptionId).not.toBe(again[0].exceptionId);
    expect(openHelp[0].summary).toBe("Asked for help near Unit 101 Door.");
  });

  it("re-alerts the team at most once per 5 minutes for the same open help exception", async () => {
    const ctx = setup();
    const tour = await bookTour(ctx);
    await ctx.core.requestHelp(tour.reservation.id, "lobby", { text: "help" });
    await ctx.core.requestHelp(tour.reservation.id, "lobby", { text: "help" });
    const alerts = (await ctx.store.list("messages")).filter((m) => m.audience === "OPERATOR" && m.body.includes("asked for help"));
    const acks = (await ctx.store.list("messages")).filter((m) => m.audience === "PROSPECT" && m.body === VisitorDenialCopy.helpAck(TEAM));
    expect(alerts).toHaveLength(1);
    expect(acks).toHaveLength(2);
    expect((await ctx.store.listAudit()).filter((e) => e.type === "HELP_REQUESTED")).toHaveLength(2);
    expect((await ctx.store.listAudit()).filter((e) => e.type === "OPERATOR_NOTIFIED" && e.detail.includes("asked for help"))).toHaveLength(1);

    ctx.clock.set(minutesFrom(ctx.clock.now(), HELP_ALERT_WINDOW_MS / 60_000 - 1));
    await ctx.core.requestHelp(tour.reservation.id, "lobby", { text: "help" });
    expect((await ctx.store.list("messages")).filter((m) => m.audience === "OPERATOR" && m.body.includes("asked for help"))).toHaveLength(1);

    ctx.clock.set(minutesFrom(ctx.clock.now(), 1));
    await ctx.core.requestHelp(tour.reservation.id, "lobby", { text: "help" });
    expect((await ctx.store.list("messages")).filter((m) => m.audience === "OPERATOR" && m.body.includes("asked for help"))).toHaveLength(2);
    expect((await ctx.store.list("messages")).filter((m) => m.audience === "PROSPECT" && m.body === VisitorDenialCopy.helpAck(TEAM))).toHaveLength(4);
  });
});
