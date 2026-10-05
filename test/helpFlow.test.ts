import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/tourCoreConfig";
import { HELP_ALERT_WINDOW_MS, helpContext, VisitorDenialCopy } from "../src/core/TourCore";
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

function phone(now = at(13, 58)) {
  const transport = new DemoMessagingAdapter(() => {}, "MESSAGING");
  const session = new VisitorDemoSession("prop_100_alfred_way", loadConfig(), "t", { realNow: () => now, transport, kind: "messaging" });
  let n = 0;
  const say = (text: string) => handleVisitorText(session, PHONE, text, { provider: "test", providerMessageId: `m_${++n}` });
  return { session, say };
}

async function bookReady(p: ReturnType<typeof phone>) {
  await p.say("TOUR");
  await p.say("YES");
  await p.say("1");
  await p.say("1");
  await p.say("1");
  await p.say("yes");
  await p.session.act("submitIdentity", { firstName: "Pat", lastName: "Smith", email: "pat@example.com", phone: PHONE });
}

async function bookAndArrive(p: ReturnType<typeof phone>) {
  await bookReady(p);
  await p.say("I'm here");
}

async function prospectOutbound(session: VisitorDemoSession) {
  return (await session.store.list("messages")).filter((m) => m.audience === "PROSPECT" && m.direction === "OUTBOUND");
}

describe("helpContext", () => {
  const reservation = (status: string, window?: { start: number; end: number }) =>
    ({
      status,
      windowStart: window ? new Date(window.start).toISOString() : undefined,
      windowEnd: window ? new Date(window.end).toISOString() : undefined,
    }) as Parameters<typeof helpContext>[0];

  it("splits booked tours into in-window vs upcoming, and treats dead or unbooked as none", () => {
    const start = at(13, 50);
    const end = at(14, 45);
    const nowIn = new Date(at(13, 58));
    const nowBefore = new Date(at(10));
    const nowAfter = new Date(at(16));
    expect(helpContext(reservation("READY", { start, end }), nowIn)).toBe("in-window");
    expect(helpContext(reservation("TOURING", { start, end }), nowIn)).toBe("in-window");
    expect(helpContext(reservation("READY", { start, end }), nowBefore)).toBe("upcoming");
    expect(helpContext(reservation("READY", { start, end }), nowAfter)).toBeNull();
    expect(helpContext(reservation("COMPLETED", { start, end }), nowIn)).toBeNull();
    expect(helpContext(reservation("CANCELLED", { start, end }), nowIn)).toBeNull();
    expect(helpContext(reservation("REVOKED", { start, end }), nowIn)).toBeNull();
    expect(helpContext(reservation("EXPIRED", { start, end }), nowIn)).toBeNull();
    expect(helpContext(reservation("INQUIRY"), nowIn)).toBeNull();
  });
});

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

  it("HELP on an upcoming booked tour (window not started) sends the remote ack, not stay-where-you-are", async () => {
    const p = phone(at(10));
    await bookReady(p);
    expect((await p.session.reservation())?.status).toBe("READY");
    const before = await prospectOutbound(p.session);
    await p.say("HELP");
    const added = (await prospectOutbound(p.session)).slice(before.length);
    expect(added.map((m) => m.body)).toEqual([VisitorDenialCopy.helpAckRemote(TEAM)]);
    expect(added[0]!.body).not.toContain("Stay where you are");
    expect(added.join("\n")).not.toContain("Tour Core:");
    expect((await p.session.store.listAudit()).some((e) => e.type === "HELP_REQUESTED")).toBe(true);
    expect((await p.session.store.list("messages")).filter((m) => m.audience === "OPERATOR" && m.body.includes("asked for help"))).toHaveLength(1);
  });

  it("HELP after choosing a unit but before a time is booked sends only the carrier keyword reply", async () => {
    const p = phone();
    await p.say("TOUR");
    await p.say("YES");
    await p.say("1");
    expect(p.session.reservationId).toBeTruthy();
    const before = await prospectOutbound(p.session);
    await p.say("HELP");
    const added = (await prospectOutbound(p.session)).slice(before.length);
    expect(added.map((m) => m.body)).toEqual([smsHelpBody()]);
    expect((await p.session.store.listAudit()).filter((e) => e.type === "HELP_REQUESTED")).toHaveLength(0);
    expect((await p.session.store.list("messages")).filter((m) => m.audience === "OPERATOR" && m.body.includes("asked for help"))).toHaveLength(0);
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
    h.setClock(h.now() + 60_000);
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
    const firstAcks = (await ctx.store.list("messages")).filter((m) => m.audience === "PROSPECT" && m.body === VisitorDenialCopy.helpAckRemote(TEAM));
    const repeatAcks = (await ctx.store.list("messages")).filter((m) => m.audience === "PROSPECT" && m.body === VisitorDenialCopy.helpRepeatAckRemote(TEAM));
    expect(alerts).toHaveLength(1);
    expect(firstAcks).toHaveLength(1);
    expect(repeatAcks).toHaveLength(1);
    expect((await ctx.store.listAudit()).filter((e) => e.type === "HELP_REQUESTED")).toHaveLength(2);
    expect((await ctx.store.listAudit()).filter((e) => e.type === "OPERATOR_NOTIFIED" && e.detail.includes("asked for help"))).toHaveLength(1);

    ctx.clock.set(minutesFrom(ctx.clock.now(), HELP_ALERT_WINDOW_MS / 60_000 - 1));
    await ctx.core.requestHelp(tour.reservation.id, "lobby", { text: "help" });
    expect((await ctx.store.list("messages")).filter((m) => m.audience === "OPERATOR" && m.body.includes("asked for help"))).toHaveLength(1);

    ctx.clock.set(minutesFrom(ctx.clock.now(), 1));
    await ctx.core.requestHelp(tour.reservation.id, "lobby", { text: "help" });
    expect((await ctx.store.list("messages")).filter((m) => m.audience === "OPERATOR" && m.body.includes("asked for help"))).toHaveLength(2);
    expect((await ctx.store.list("messages")).filter((m) => m.audience === "PROSPECT" && m.body === VisitorDenialCopy.helpAckRemote(TEAM))).toHaveLength(1);
    expect((await ctx.store.list("messages")).filter((m) => m.audience === "PROSPECT" && m.body === VisitorDenialCopy.helpRepeatAckRemote(TEAM))).toHaveLength(3);
  });

  it("HELP after a canceled reservation sends only the carrier keyword reply", async () => {
    const p = phone();
    await p.say("TOUR");
    await p.say("YES");
    await p.say("1");
    await p.say("1");
    await p.say("1");
    await p.say("NO");
    expect((await p.session.reservation())?.status).toBe("CANCELLED");
    const before = await prospectOutbound(p.session);
    await p.say("HELP");
    const added = (await prospectOutbound(p.session)).slice(before.length);
    expect(added.map((m) => m.body)).toEqual([smsHelpBody()]);
    expect((await p.session.store.listAudit()).filter((e) => e.type === "HELP_REQUESTED")).toHaveLength(0);
    expect((await p.session.store.list("messages")).filter((m) => m.audience === "OPERATOR" && m.body.includes("asked for help"))).toHaveLength(0);
  });

  it("HELP after a finished tour sends only the carrier keyword reply", async () => {
    const p = phone();
    await bookAndArrive(p);
    await p.say("I'm all done");
    expect((await p.session.reservation())?.status).toBe("COMPLETED");
    const before = await prospectOutbound(p.session);
    await p.say("HELP");
    const added = (await prospectOutbound(p.session)).slice(before.length);
    expect(added.map((m) => m.body)).toEqual([smsHelpBody()]);
    expect((await p.session.store.listAudit()).filter((e) => e.type === "HELP_REQUESTED")).toHaveLength(0);
    expect((await p.session.store.list("messages")).filter((m) => m.audience === "OPERATOR" && m.body.includes("asked for help"))).toHaveLength(0);
  });

  it("HELP after a revoked reservation sends only the carrier keyword reply", async () => {
    const p = phone();
    await bookAndArrive(p);
    await p.session.core.revokeReservation(p.session.reservationId!, "operator called it off");
    expect((await p.session.reservation())?.status).toBe("REVOKED");
    const before = await prospectOutbound(p.session);
    await p.say("HELP");
    const added = (await prospectOutbound(p.session)).slice(before.length);
    expect(added.map((m) => m.body)).toEqual([smsHelpBody()]);
    expect((await p.session.store.listAudit()).filter((e) => e.type === "HELP_REQUESTED")).toHaveLength(0);
    expect((await p.session.store.list("messages")).filter((m) => m.audience === "OPERATOR" && m.body.includes("asked for help"))).toHaveLength(0);
  });

  it("HELP after the tour window has ended sends only the carrier keyword reply", async () => {
    const p = phone();
    await bookAndArrive(p);
    p.session.clock.jumpTo(new Date(at(16)));
    const before = await prospectOutbound(p.session);
    await p.say("HELP");
    const added = (await prospectOutbound(p.session)).slice(before.length);
    expect(added.map((m) => m.body)).toEqual([smsHelpBody()]);
    expect((await p.session.store.listAudit()).filter((e) => e.type === "HELP_REQUESTED")).toHaveLength(0);
    expect((await p.session.store.list("messages")).filter((m) => m.audience === "OPERATOR" && m.body.includes("asked for help"))).toHaveLength(0);
  });

  it("a second in-window help says the team already knows, with the at-door next step", async () => {
    const p = phone();
    await bookAndArrive(p);
    const before = await prospectOutbound(p.session);
    await p.say("help");
    await p.say("I need help");
    const added = (await prospectOutbound(p.session)).slice(before.length);
    expect(added.map((m) => m.body)).toEqual([VisitorDenialCopy.helpAck(TEAM), VisitorDenialCopy.helpRepeatAck(TEAM)]);
    expect(added[1]!.body).toContain("Stay where you are");
    expect(added.join("\n")).not.toContain("Tour Core:");
    expect((await p.session.store.listAudit()).filter((e) => e.type === "HELP_REQUESTED")).toHaveLength(2);
    expect((await p.session.store.list("messages")).filter((m) => m.audience === "OPERATOR" && m.body.includes("asked for help"))).toHaveLength(1);
  });

  it("a second upcoming help says the team already knows, with the remote next step", async () => {
    const maple = "Maple Leasing team";
    const contact = "+15550109999";
    expect(VisitorDenialCopy.helpRepeatAck(maple, contact)).toBe(
      `The ${maple} already knows and is on it. ${VisitorDenialCopy.atDoor(maple, contact)}`,
    );
    expect(VisitorDenialCopy.helpRepeatAckRemote(maple, contact)).toBe(
      `The ${maple} already knows and is on it. ${VisitorDenialCopy.remote(maple, contact)}`,
    );
    expect(VisitorDenialCopy.helpRepeatAckRemote(maple, contact)).toContain("or call (555) 010-9999");
    expect(VisitorDenialCopy.helpRepeatAckRemote(maple, contact)).not.toContain("Stay where you are");
    expect(VisitorDenialCopy.helpAckRemote(TEAM)).toBe(`I've let the ${TEAM} know. ${VisitorDenialCopy.remote(TEAM)}`);
    expect(VisitorDenialCopy.helpRepeatAck(TEAM)).toBe(`The ${TEAM} already knows and is on it. ${VisitorDenialCopy.atDoor(TEAM)}`);

    const ctx = setup({ operatorName: maple, visitorContact: contact });
    const tour = await bookTour(ctx);
    await ctx.core.requestHelp(tour.reservation.id, "lobby", { text: "help" });
    await ctx.core.requestHelp(tour.reservation.id, "lobby", { text: "help again" });
    const toVisitor = (await ctx.store.list("messages")).filter((m) => m.audience === "PROSPECT").map((m) => m.body);
    expect(toVisitor.filter((b) => b === VisitorDenialCopy.helpAckRemote(maple, contact))).toEqual([VisitorDenialCopy.helpAckRemote(maple, contact)]);
    expect(toVisitor.filter((b) => b === VisitorDenialCopy.helpRepeatAckRemote(maple, contact))).toEqual([VisitorDenialCopy.helpRepeatAckRemote(maple, contact)]);
    expect(toVisitor.join("\n")).not.toContain("Stay where you are");
    expect((await ctx.store.list("messages")).filter((m) => m.audience === "OPERATOR" && m.body.includes("asked for help"))).toHaveLength(1);
    expect(toVisitor.join("\n")).toContain("Maple Leasing team");
    expect(toVisitor.join("\n")).not.toContain("maple leasing team");

    const inWindow = setup({ operatorName: maple, visitorContact: contact });
    const live = await bookTour(inWindow);
    inWindow.clock.set(live.slotStart);
    await inWindow.core.requestHelp(live.reservation.id, "lobby", { text: "help" });
    await inWindow.core.requestHelp(live.reservation.id, "lobby", { text: "help again" });
    const atDoor = (await inWindow.store.list("messages")).filter((m) => m.audience === "PROSPECT").map((m) => m.body);
    expect(atDoor.filter((b) => b === VisitorDenialCopy.helpAck(maple, contact))).toEqual([VisitorDenialCopy.helpAck(maple, contact)]);
    expect(atDoor.filter((b) => b === VisitorDenialCopy.helpRepeatAck(maple, contact))).toEqual([VisitorDenialCopy.helpRepeatAck(maple, contact)]);
    expect(atDoor.join("\n")).toContain("Stay where you are");
  });
});
