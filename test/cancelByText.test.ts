import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/tourCoreConfig";
import { zonedTimeToUtc } from "../src/core/timezone";
import { cannotCancelRunningTour } from "../src/core/availabilityCopy";
import {
  NOTHING_BOOKED_CANCEL,
  UNKNOWN_ANSWER,
  VISITOR_CANCEL_DONE,
  VISITOR_CANCEL_FAILED,
  visitorCancelConfirm,
  visitorCancelKept,
} from "../src/core/TourCore";
import { handleVisitorText } from "../src/visitor/conversation";
import { VisitorDemoSession } from "../src/visitor";
import { DemoMessagingAdapter } from "../src/messaging/Messenger";

const at = (hour: number, minute = 0) => zonedTimeToUtc({ year: 2026, month: 9, day: 28, hour, minute }, "America/New_York").getTime();
const PHONE = "+15550102000";
const CONFIRM = visitorCancelConfirm("Monday, Sep 28", "2:00 PM");
const KEPT = visitorCancelKept("Monday, Sep 28", "2:00 PM");
const CHECK_BACK = "I'll check with the property team and get back to you.";

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

async function toDayMenu(p: ReturnType<typeof phone>) {
  await p.say("TOUR");
  await p.say("YES");
  await p.say("1");
  expect(p.lastReply()).toContain("Which day works for you?");
  expect((await p.session.reservation())?.status).toBe("INQUIRY");
}

async function toTimeMenu(p: ReturnType<typeof phone>) {
  await toDayMenu(p);
  await p.say("1");
  expect(p.lastReply()).toContain("times available");
  expect(p.session.selectedDate).toBeTruthy();
  expect((await p.session.reservation())?.status).toBe("INQUIRY");
}

describe("cancel before anything is booked", () => {
  it("cancel at the day menu stops and does not repeat the menu", async () => {
    const p = phone();
    await toDayMenu(p);
    await p.say("cancel that");
    expect(p.lastReply()).toBe(NOTHING_BOOKED_CANCEL);
    expect(p.lastReply()).not.toContain("didn't catch that");
    expect(p.lastReply()).not.toContain("Which day works for you?");
    expect((await p.session.reservation())?.status).toBe("INQUIRY");
    expect(await p.audit("RESERVATION_CANCELLED")).toHaveLength(0);
    expect(await p.audit("QUESTION_UNANSWERED")).toHaveLength(0);
    expect(p.session.optedOut).toBe(false);
    await p.say("hi");
    expect(p.lastReply()).toContain("Which day works for you?");
    expect(p.lastReply()).not.toContain("Text TOUR");
    expect(p.lastReply()).not.toBe(NOTHING_BOOKED_CANCEL);
  });

  it("Actually cancel that at the time menu stops, then hi or Thursday starts scheduling again", async () => {
    const hi = phone();
    await toTimeMenu(hi);
    await hi.say("Actually cancel that");
    expect(hi.lastReply()).toBe(NOTHING_BOOKED_CANCEL);
    expect(hi.lastReply()).not.toContain("didn't catch that");
    expect(hi.lastReply()).not.toContain("Which time works for you?");
    expect(hi.session.selectedDate).toBeUndefined();
    expect(hi.session.optedOut).toBe(false);
    expect((await hi.session.reservation())?.status).toBe("INQUIRY");
    expect(await hi.audit("RESERVATION_CANCELLED")).toHaveLength(0);
    await hi.say("hi");
    expect(hi.lastReply()).toContain("Which day works for you?");
    expect(hi.lastReply()).not.toContain("didn't catch that");
    expect(hi.lastReply()).not.toContain("Text TOUR");
    expect(hi.session.smsConsent).toBe("opted_in");

    const thursday = phone();
    await toTimeMenu(thursday);
    await thursday.say("Actually cancel that");
    expect(thursday.lastReply()).toBe(NOTHING_BOOKED_CANCEL);
    await thursday.say("Thursday");
    expect(thursday.lastReply()).toContain("times available");
    expect(thursday.lastReply()).toContain("Thursday");
    expect(thursday.lastReply()).not.toContain("didn't catch that");
    expect(thursday.lastReply()).not.toBe(NOTHING_BOOKED_CANCEL);
    expect(thursday.session.optedOut).toBe(false);
  });

  it("any later text, not only hi, starts scheduling again", async () => {
    const p = phone();
    await toTimeMenu(p);
    await p.say("nevermind");
    expect(p.lastReply()).toBe(NOTHING_BOOKED_CANCEL);
    await p.say("ok");
    expect(p.lastReply()).toContain("Which day works for you?");
    expect(p.lastReply()).not.toContain("didn't catch that");
    expect(p.lastReply()).not.toContain("Text TOUR");
  });

  it("bare cancel at the time menu still opts out", async () => {
    const p = phone();
    await toTimeMenu(p);
    await p.say("cancel");
    expect(p.session.optedOut).toBe(true);
    expect(p.lastReply()).not.toBe(NOTHING_BOOKED_CANCEL);
  });
});

describe("visitor cancel-by-text", () => {
  it("asks the exact confirm line, never the old info/flag line", async () => {
    const p = phone();
    await bookedAndReady(p);
    await p.say("Can we cancel the tour?");
    expect(p.lastReply()).toBe("Cancel your tour on Monday, Sep 28 at 2:00 PM? Reply YES or NO.");
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
    expect(p.lastReply()).toBe("You're cancelled. Text me anytime if you want to book again.");
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
    expect(p.lastReply()).toBe("Okay, your tour stays on Monday, Sep 28 at 2:00 PM.");
    expect(p.lastReply()).toBe(KEPT);
    expect((await p.session.reservation())?.status).toBe("READY");
    expect(await p.audit("RESERVATION_CANCELLED")).toHaveLength(0);
    expect(p.lastReply()).not.toBe(VISITOR_CANCEL_DONE);
  });

  it("unclear reply on the confirm flags the team with the check-back line and leaves the tour booked", async () => {
    const p = phone();
    await bookedAndReady(p);
    await p.say("Can we cancel the tour?");
    expect(p.lastReply()).toBe(CONFIRM);
    await p.say("huh?");
    expect(p.lastReply()).toBe(CHECK_BACK);
    expect(p.lastReply()).not.toBe(UNKNOWN_ANSWER);
    expect((await p.session.reservation())?.status).toBe("READY");
    expect((await p.audit("QUESTION_UNANSWERED")).map((e) => e.detail)).toEqual(["huh?"]);
    await p.say("YES");
    expect(p.lastReply()).toBe(VISITOR_CANCEL_DONE);
    expect((await p.session.reservation())?.status).toBe("CANCELLED");
  });

  it("a real non-cancel question still flags", async () => {
    const p = phone();
    await bookedAndReady(p);
    await p.say("is there a gym?");
    expect(p.lastReply()).toBe(UNKNOWN_ANSWER);
    expect((await p.audit("QUESTION_UNANSWERED")).map((e) => e.detail)).toEqual(["is there a gym?"]);
    expect((await p.session.reservation())?.status).toBe("READY");
  });

  it("a question on the cancel confirm uses the check-back line, not the missing-fact line", async () => {
    const p = phone();
    await bookedAndReady(p);
    await p.say("please cancel my tour");
    await p.say("is there a gym?");
    expect(p.lastReply()).toBe(CHECK_BACK);
    expect(p.lastReply()).not.toBe(UNKNOWN_ANSWER);
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

  it("refuses a bare cancel while touring with no later booking and leaves doors working", async () => {
    const p = phone();
    await bookedAndReady(p);
    p.session.clock.jumpTo(new Date(at(13, 58)));
    await p.say("I'm here");
    expect(await p.grants()).toEqual(["entrance"]);
    await p.say("cancel");
    expect(p.lastReply()).toBe(cannotCancelRunningTour());
    expect(p.lastReply()).not.toContain("is still working on the problem");
    expect((await p.session.reservation())?.status).toBe("TOURING");
    expect(await p.grants()).toEqual(["entrance"]);
  });

  it("refuses cancel my tour while touring with no later booking", async () => {
    const p = phone();
    await bookedAndReady(p);
    p.session.clock.jumpTo(new Date(at(13, 58)));
    await p.say("I'm here");
    await p.say("cancel my tour");
    expect(p.lastReply()).toBe(cannotCancelRunningTour());
    expect(p.lastReply()).not.toContain("is still working on the problem");
    expect((await p.session.reservation())?.status).toBe("TOURING");
    expect(await p.grants()).toEqual(["entrance"]);
  });

  it("still opens a door after a refused cancel while touring with no later booking", async () => {
    const p = phone();
    await bookedAndReady(p);
    p.session.clock.jumpTo(new Date(at(13, 58)));
    await p.say("I'm here");
    await p.say("cancel");
    expect(p.lastReply()).toBe(cannotCancelRunningTour());
    expect(p.lastReply()).not.toContain("is still working on the problem");
    const before = p.session.durin.requestCount;
    await p.say("I'm at 101");
    expect((await p.session.reservation())?.status).toBe("TOURING");
    expect(p.session.lastAccess).toMatchObject({ doorId: "unit_101", allowed: true });
    expect(p.session.durin.requestCount).toBeGreaterThan(before);
    expect((await p.grants()).length).toBeGreaterThan(0);
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

  const HOLD_REFUSE =
    "You can't cancel the tour you're on, but you're free to wrap up whenever you like. The property team is still working on the problem and will text you here. Text me anytime if you want to book another tour.";

  async function arrive(p: ReturnType<typeof phone>) {
    await bookedAndReady(p);
    p.session.clock.jumpTo(new Date(at(13, 58)));
    await p.say("I'm here");
  }

  it("refuses a bare cancel on operator hold with no later booking", async () => {
    const p = phone();
    await arrive(p);
    await p.session.operatorChange((core, id) => core.placeOperatorHold(id, "checking something"));
    expect((await p.session.reservation())?.status).toBe("OPERATOR_HOLD");
    await p.say("cancel");
    expect(p.lastReply()).toBe(HOLD_REFUSE);
    expect(p.lastReply()).toBe(cannotCancelRunningTour("property team"));
    expect((await p.session.reservation())?.status).toBe("OPERATOR_HOLD");
    expect(p.session.optedOut).toBe(false);
    await p.say("hi");
    expect(p.lastReply().length).toBeGreaterThan(0);
    expect(p.session.optedOut).toBe(false);
  });

  it("refuses a bare cancel on door failure with no later booking", async () => {
    const p = phone();
    await arrive(p);
    p.session.durin.failNextRequest("door controller timeout");
    await p.say("I'm at 101");
    expect((await p.session.reservation())?.status).toBe("PROVIDER_FAILURE");
    await p.say("cancel");
    expect(p.lastReply()).toBe(HOLD_REFUSE);
    expect(p.lastReply()).toBe(cannotCancelRunningTour("property team"));
    expect((await p.session.reservation())?.status).toBe("PROVIDER_FAILURE");
    expect(p.session.optedOut).toBe(false);
    await p.say("hi");
    expect(p.lastReply().length).toBeGreaterThan(0);
    expect(p.session.optedOut).toBe(false);
  });
});
