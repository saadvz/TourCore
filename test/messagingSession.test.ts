import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/tourCoreConfig";
import { VISIT_RECORD_BASIS, VisitorDenialCopy } from "../src/core/TourCore";
import { zonedTimeToUtc } from "../src/core/timezone";
import { DemoMessagingAdapter } from "../src/messaging/Messenger";
import { withPrompt } from "../src/messaging/presentation";
import { handleVisitorText, keywordOf } from "../src/visitor/conversation";
import { VisitorDemoSession, visitorView } from "../src/visitor";
import { VerificationLinks } from "../src/visitor/verificationLinks";

const MONDAY_7AM = zonedTimeToUtc({ year: 2026, month: 9, day: 28, hour: 7, minute: 0 }, "America/New_York").getTime();
const PHONE = "+15550102000";

function phoneSession(links?: VerificationLinks) {
  const sent: string[] = [];
  const transport = new DemoMessagingAdapter((line) => sent.push(line), "MESSAGING");
  const session = new VisitorDemoSession("prop_100_alfred_way", loadConfig(), "t", { realNow: () => MONDAY_7AM, transport, kind: "messaging", verificationLinks: links });
  const say = (text: string) => handleVisitorText(session, PHONE, text, { provider: "test", providerMessageId: `m_${Math.random()}` });
  const lastReply = () => [...session.conversation].reverse().find((m) => m.from === "tourcore")!.text;
  return { session, say, lastReply };
}

describe("channel-aware wording", () => {
  it("states the same intent as buttons on the web and as typed replies on a phone", () => {
    expect(withPrompt("Is it OK?", { kind: "yes-no" }, "WEB")).toBe("Is it OK?");
    expect(withPrompt("Is it OK?", { kind: "yes-no" }, "MESSAGING")).toBe("Is it OK?\nReply YES or NO.");
    expect(withPrompt("Which unit?", { kind: "choose", options: ["Unit 101", "Unit 102"], what: "a unit" }, "MESSAGING")).toBe("Which unit?\nReply 1 for Unit 101 or 2 for Unit 102.");
    expect(withPrompt("Which unit?", { kind: "choose", options: ["Unit 101", "Unit 102"], what: "a unit" }, "WEB")).toBe("Which unit?\nPick a unit below.");
    expect(
      withPrompt("Tour times just changed. Here's what's open now:", {
        kind: "choose",
        options: ["Monday, Sep 28", "Tuesday, Sep 29", "Wednesday, Sep 30", "Thursday, Oct 1", "Friday, Oct 2"],
        what: "a day",
        after: "Which day works for you?",
      }, "MESSAGING"),
    ).toBe(
      "Tour times just changed. Here's what's open now:\n1) Monday, Sep 28\n2) Tuesday, Sep 29\n3) Wednesday, Sep 30\n4) Thursday, Oct 1\n5) Friday, Oct 2\nWhich day works for you?",
    );
    expect(
      withPrompt("Tour times just changed. Here's what's open now:", {
        kind: "choose",
        options: ["Monday, Sep 28", "Tuesday, Sep 29"],
        what: "a day",
        after: "Which day works for you?",
      }, "WEB"),
    ).toBe("Tour times just changed. Here's what's open now:\nWhich day works for you?\nPick a day below.");
    expect(withPrompt("Fill this in.", { kind: "form", link: "https://x/verify/abc" }, "MESSAGING")).toBe("Fill this in.\nhttps://x/verify/abc");
  });

  it("the browser phone gets button wording from the same engine step", async () => {
    const web = new VisitorDemoSession("prop_100_alfred_way", loadConfig(), "w", { realNow: () => MONDAY_7AM });
    await web.act("begin", { name: "Pat Smith", phone: PHONE });
    await web.act("chooseUnit", { unitId: "apt_101" });
    await web.act("chooseDate", (await visitorView(web)).choices[0]!.input);
    await web.act("chooseTime", (await visitorView(web)).choices[0]!.input);
    const webBooked = web.conversation.filter((m) => m.from === "tourcore").slice(-2).map((m) => m.text).join("\n");
    expect(webBooked).toContain("Great, you're booked for");
    expect(webBooked).toContain("please fill out this short form");
    expect(webBooked).not.toContain("Is it OK if I text you");
    expect(webBooked).not.toContain("Reply YES or NO");

    const { say, lastReply } = phoneSession();
    await say("TOUR");
    await say("YES");
    await say("1");
    await say("2:00 pm");
    expect(lastReply()).toContain("please fill out this short form");
    expect(lastReply()).not.toContain("Is it OK if I text you");
  });
});

describe("a visitor still waiting on the old visit-record question", () => {
  async function rewindToAwaitingConsent(session: VisitorDemoSession) {
    const reservation = (await session.reservation())!;
    await session.store.put("reservations", { ...reservation, status: "AWAITING_CONSENT", consentId: undefined });
    return reservation.id;
  }

  it("the next text finishes the booking and sends the identity form", async () => {
    const { session, say } = phoneSession(new VerificationLinks({ baseUrl: () => "https://tour.example", now: () => MONDAY_7AM }));
    await say("TOUR");
    await say("YES");
    await say("1");
    await say("1");
    await say("1");
    const id = await rewindToAwaitingConsent(session);
    const before = session.conversation.length;
    await say("sounds good");
    const sent = session.conversation.slice(before).filter((item) => item.from === "tourcore").map((item) => item.text).join("\n");
    expect(sent).toContain("please fill out this short form");
    expect(sent).not.toContain("You're all set");
    expect(sent).not.toContain("Is it OK if I text you");
    expect(sent).not.toContain("keep a record");
    const reservation = (await session.store.get("reservations", id))!;
    expect(reservation.status).toBe("AWAITING_VERIFICATION");
    expect(reservation.consentId).toBeTruthy();
    expect((await session.store.get("consents", reservation.consentId!))!.text).toBe(VISIT_RECORD_BASIS);
    expect(await session.stage()).toBe("identity");
  });

  it("cancel still wins before that booking is finished", async () => {
    const { session, say, lastReply } = phoneSession();
    await say("TOUR");
    await say("YES");
    await say("1");
    await say("1");
    await say("1");
    const id = await rewindToAwaitingConsent(session);
    await say("Actually cancel that");
    expect(lastReply()).toContain("Cancel your tour");
    expect(lastReply()).not.toContain("please fill out this short form");
    expect(lastReply()).not.toContain("Is it OK if I text you");
    const waiting = (await session.store.get("reservations", id))!;
    expect(waiting.status).toBe("AWAITING_CONSENT");
    expect(waiting.consentId).toBeUndefined();
    await say("YES");
    expect((await session.store.get("reservations", id))!.status).toBe("CANCELLED");
  });

  it("a passed identity check means the next text is you're all set", async () => {
    const { session, say, lastReply } = phoneSession();
    await say("TOUR");
    await say("YES");
    await say("1");
    await say("1");
    await say("1");
    await session.act("submitIdentity", { firstName: "Pat", lastName: "Smith", email: "pat@example.com", phone: PHONE });
    const id = await rewindToAwaitingConsent(session);
    await say("ok");
    const reservation = (await session.store.get("reservations", id))!;
    expect(reservation.status).toBe("READY");
    expect(lastReply()).toContain("You're all set for your tour");
    expect(lastReply()).not.toContain("Is it OK if I text you");
  });

  it("declining the visit record still cancels only while that question was left open", async () => {
    const { session, say } = phoneSession();
    await say("TOUR");
    await say("YES");
    await say("1");
    await say("1");
    await say("1");
    const id = await rewindToAwaitingConsent(session);
    await session.core.recordConsent(id, false);
    await session.refreshThread();
    const reservation = (await session.store.get("reservations", id))!;
    expect(reservation.status).toBe("CANCELLED");
    expect(session.conversation.filter((item) => item.from === "tourcore").at(-1)!.text).toContain("No problem, I won't text you again about this tour");
  });
});

describe("identity form links", () => {
  it("are random, carry no personal data, and a new link retires the old one", () => {
    const links = new VerificationLinks({ baseUrl: () => "https://tour.example", now: () => MONDAY_7AM });
    const first = links.issue({ sessionId: "s1", reservationId: "r1", phone: PHONE })!;
    const second = links.issue({ sessionId: "s1", reservationId: "r1", phone: PHONE })!;
    expect(first).toMatch(/^https:\/\/tour\.example\/verify\/[A-Za-z0-9_-]{24}$/);
    expect(first).not.toContain("5550102000");
    expect(links.check(first.split("/").pop()!)).toEqual({ ok: false, reason: "unknown" });
    expect(links.check(second.split("/").pop()!)).toMatchObject({ ok: true, entry: { reservationId: "r1", phone: PHONE } });
  });

  it("expire, work once, and can't be issued without a public address", () => {
    let now = MONDAY_7AM;
    const links = new VerificationLinks({ baseUrl: () => "https://tour.example", ttlMinutes: 30, now: () => now });
    const token = links.issue({ sessionId: "s1", reservationId: "r1", phone: PHONE })!.split("/").pop()!;
    now += 31 * 60_000;
    expect(links.check(token)).toEqual({ ok: false, reason: "expired" });

    const fresh = links.issue({ sessionId: "s1", reservationId: "r1", phone: PHONE })!.split("/").pop()!;
    links.markUsed(fresh);
    expect(links.check(fresh)).toEqual({ ok: false, reason: "used" });
    expect(new VerificationLinks({ baseUrl: () => undefined }).issue({ sessionId: "s", reservationId: "r", phone: PHONE })).toBeUndefined();
  });

  it("the phone conversation sends the personal link and continues after the form", async () => {
    const links = new VerificationLinks({ baseUrl: () => "https://tour.example", now: () => MONDAY_7AM });
    const { session, say, lastReply } = phoneSession(links);
    await say("TOUR");
    await say("YES");
    await say("1");
    await say("1");
    await say("1");
    await say("yes");
    const token = lastReply().match(/\/verify\/([A-Za-z0-9_-]+)$/)![1]!;
    expect(links.check(token)).toMatchObject({ ok: true, entry: { sessionId: session.id } });

    await say("where's the form?");
    expect(lastReply()).toContain("Here's your identity form link again.");
    expect(links.check(token)).toEqual({ ok: false, reason: "unknown" });

    await session.act("submitIdentity", { firstName: "Pat", lastName: "Smith", email: "pat@example.com", phone: PHONE }, { text: "Submitted the identity form." });
    expect(await session.stage()).toBe("ready");
    expect(lastReply()).toContain('Text "I\'m here" when you arrive');
    expect(await session.visitorName()).toBe("Pat Smith");
  });
});

describe("typed replies", () => {
  it("recognizes messaging keywords only as whole messages", () => {
    expect(["STOP", "unsubscribe", "Cancel", "quit."].map(keywordOf)).toEqual(["stop", "stop", "stop", "stop"]);
    expect(keywordOf("START")).toBe("start");
    expect(keywordOf("HELP")).toBe("help");
    expect(keywordOf("please don't stop")).toBeUndefined();
  });

  it("HELP says who this is and how to reach the team; during a tour it also alerts them", async () => {
    const { session, say, lastReply } = phoneSession();
    await say("HELP");
    expect(lastReply()).toContain("Tour Core:");
    expect(lastReply()).toContain("Reply STOP to opt out.");
    expect(lastReply()).not.toContain("Khanex");

    await say("TOUR");
    await say("YES");
    await say("1");
    await say("1");
    await say("1");
    await say("yes");
    await session.act("submitIdentity", { firstName: "Pat", lastName: "Smith", email: "pat@example.com", phone: PHONE });
    const outboundBefore = (await session.store.list("messages")).filter((m) => m.audience === "PROSPECT" && m.direction === "OUTBOUND").length;
    await say("help");
    expect((await session.store.listAudit()).some((e) => e.type === "HELP_REQUESTED")).toBe(true);
    expect(lastReply()).toBe(VisitorDenialCopy.helpAckRemote("property team"));
    expect(lastReply()).not.toContain("Stay where you are");
    const outbound = (await session.store.list("messages")).filter((m) => m.audience === "PROSPECT" && m.direction === "OUTBOUND");
    expect(outbound.length - outboundBefore).toBe(1);
    expect(outbound.at(-1)?.body).not.toContain("Tour Core:");
  });

  it("asks again, with the options, when it doesn't understand", async () => {
    const { say, lastReply } = phoneSession();
    await say("TOUR");
    await say("YES");
    await say("the blue one");
    expect(lastReply()).toBe("Sorry, I didn't catch that. Which unit would you like to see?\nReply 1 for Unit 101 or 2 for Unit 102.");
  });

  it("a texted wrong door is refused by policy without contacting Durin", async () => {
    const { session, say, lastReply } = phoneSession();
    await say("TOUR");
    await say("YES");
    await say("1");
    await say("1");
    await say("1");
    await say("yes");
    await session.act("submitIdentity", { firstName: "Pat", lastName: "Smith", email: "pat@example.com", phone: PHONE });
    session.clock.jumpTo(new Date(zonedTimeToUtc({ year: 2026, month: 9, day: 28, hour: 13, minute: 58 }, "America/New_York")));
    await say("I'm here");
    const before = session.durin.requestCount;
    await say("I'm at unit 102");
    expect(session.lastAccess).toMatchObject({ doorId: "unit_102", allowed: false, code: "DENY_WRONG_ROUTE", durinCalled: false });
    expect(session.durin.requestCount).toBe(before);
    expect(lastReply()).toContain("That door isn't part of your tour");
  });
});
