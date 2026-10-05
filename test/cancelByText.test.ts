import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/tourCoreConfig";
import { zonedTimeToUtc } from "../src/core/timezone";
import {
  UNKNOWN_ANSWER,
  VISITOR_CANCEL_DONE,
  VISITOR_CANCEL_FAILED,
  VISITOR_CANCEL_KEPT,
  visitorCancelConfirm,
} from "../src/core/TourCore";
import { handleVisitorText } from "../src/visitor/conversation";
import { VisitorDemoSession } from "../src/visitor";
import { DemoMessagingAdapter } from "../src/messaging/Messenger";

const at = (hour: number, minute = 0) => zonedTimeToUtc({ year: 2026, month: 9, day: 28, hour, minute }, "America/New_York").getTime();
const PHONE = "+15550102000";
const CONFIRM = visitorCancelConfirm("Monday, Sep 28", "2:00 PM");

function phone() {
  const transport = new DemoMessagingAdapter(() => {}, "MESSAGING");
  const session = new VisitorDemoSession("prop_100_alfred_way", loadConfig(), "t", { realNow: () => at(7), transport, kind: "messaging" });
  let n = 0;
  const say = (text: string) => handleVisitorText(session, PHONE, text, { provider: "test", providerMessageId: `m_${++n}` });
  const lastReply = () => [...session.conversation].reverse().find((m) => m.from === "tourcore")!.text;
  const audit = async (type: string) => (await session.store.listAudit()).filter((e) => e.type === type);
  const grants = async () => (session.reservationId ? (await session.core.listGrants(session.reservationId)).filter((g) => g.status === "ACTIVE").map((g) => g.doorId) : []);
  return { session, say, lastReply, audit, grants };
}

async function bookedAndReady(p: ReturnType<typeof phone>) {
  await p.say("TOUR");
  await p.say("YES");
  await p.say("hi");
  await p.say("1");
  await p.say("1");
  await p.say("1");
  await p.say("yes");
  await p.session.act("submitIdentity", { firstName: "Pat", lastName: "Smith", email: "pat@example.com", phone: PHONE });
  expect(await p.session.stage()).toBe("ready");
}

describe("visitor cancel-by-text", () => {
  it("asks the exact confirm line, never the old info/flag line", async () => {
    const p = phone();
    await bookedAndReady(p);
    await p.say("Can we cancel the tour?");
    expect(p.lastReply()).toBe(CONFIRM);
    expect(p.lastReply()).not.toBe(UNKNOWN_ANSWER);
    expect(p.lastReply()).not.toContain("I don't have that information");
    expect(await p.audit("QUESTION_UNANSWERED")).toHaveLength(0);
    expect((await p.session.reservation())?.status).toBe("READY");
  });

  it.each([
    "Can we cancel the tour?",
    "I want to cancel the booked tour",
    "cancel",
    "please cancel my tour",
    "call off the tour",
    "I can't make it",
    "I need to cancel",
  ])("cancel phrasing %j triggers confirm, not the info/flag line", async (text) => {
    const p = phone();
    await bookedAndReady(p);
    await p.say(text);
    expect(p.lastReply(), text).toBe(CONFIRM);
    expect(p.lastReply(), text).not.toContain("I don't have that information");
    expect(p.lastReply(), text).not.toContain("Sorry, I didn't catch that");
    expect(await p.audit("QUESTION_UNANSWERED")).toHaveLength(0);
    expect((await p.session.reservation())?.status).toBe("READY");
  });

  it("YES cancels the tour: doors revoked, status cancelled, audit, short done line", async () => {
    const p = phone();
    await bookedAndReady(p);
    await p.say("I want to cancel the booked tour");
    expect(p.lastReply()).toBe(CONFIRM);
    await p.say("YES");
    expect(p.lastReply()).toBe(VISITOR_CANCEL_DONE);
    expect((await p.session.reservation())?.status).toBe("CANCELLED");
    expect((await p.audit("RESERVATION_CANCELLED")).map((e) => e.detail)).toEqual(["visitor cancelled by text"]);
    expect(await p.grants()).toEqual([]);
    expect(p.session.optedOut).toBe(false);
  });

  it("YES after 'Yes, cancel it' still cancels once they confirmed", async () => {
    const p = phone();
    await bookedAndReady(p);
    await p.say("Can we cancel the tour?");
    await p.say("Yes, cancel it");
    expect(p.lastReply()).toBe(VISITOR_CANCEL_DONE);
    expect((await p.session.reservation())?.status).toBe("CANCELLED");
  });

  it("NO keeps the booking and does not cancel", async () => {
    const p = phone();
    await bookedAndReady(p);
    await p.say("please cancel my tour");
    expect(p.lastReply()).toBe(CONFIRM);
    await p.say("NO");
    expect(p.lastReply()).toBe(VISITOR_CANCEL_KEPT);
    expect((await p.session.reservation())?.status).toBe("READY");
    expect(await p.audit("RESERVATION_CANCELLED")).toHaveLength(0);
    expect(p.lastReply()).not.toBe(VISITOR_CANCEL_DONE);
  });

  it("a real non-cancel question still flags", async () => {
    const p = phone();
    await bookedAndReady(p);
    await p.say("is there a gym?");
    expect(p.lastReply()).toBe(UNKNOWN_ANSWER);
    expect((await p.audit("QUESTION_UNANSWERED")).map((e) => e.detail)).toEqual(["is there a gym?"]);
    expect((await p.session.reservation())?.status).toBe("READY");
  });

  it("STOP still opts out and does not use the cancel confirm", async () => {
    const p = phone();
    await bookedAndReady(p);
    await p.say("STOP");
    expect(p.lastReply()).not.toBe(CONFIRM);
    expect(p.lastReply()).not.toContain("I don't have that information");
    expect(p.session.optedOut).toBe(true);
    expect((await p.session.reservation())?.status).toBe("CANCELLED");
    expect((await p.audit("RESERVATION_CANCELLED"))[0]?.detail).toBe("visitor opted out of messages");
  });

  it("revokes open doors when they cancel during the tour", async () => {
    const p = phone();
    await bookedAndReady(p);
    p.session.clock.jumpTo(new Date(at(13, 58)));
    await p.say("I'm here");
    expect(await p.grants()).toEqual(["entrance"]);
    await p.say("I need to cancel");
    expect(p.lastReply()).toBe(CONFIRM);
    await p.say("yes");
    expect(p.lastReply()).toBe(VISITOR_CANCEL_DONE);
    expect((await p.session.reservation())?.status).toBe("CANCELLED");
    expect(await p.grants()).toEqual([]);
    expect((await p.audit("ACCESS_REVOKED")).length).toBeGreaterThan(0);
  });

  it("if cancel cannot finish, uses Critiquito's interim line and flags the team", async () => {
    const p = phone();
    await bookedAndReady(p);
    p.session.core.cancelTourByVisitor = async () => {
      throw new Error("could not cancel");
    };
    await p.say("call off the tour");
    await p.say("YES");
    expect(p.lastReply()).toBe(VISITOR_CANCEL_FAILED);
    expect(p.lastReply()).not.toContain("I don't have that information");
    expect((await p.session.reservation())?.status).toBe("READY");
    expect((await p.audit("QUESTION_UNANSWERED")).map((e) => e.detail)).toEqual(["YES"]);
  });
});
