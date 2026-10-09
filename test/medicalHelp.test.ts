import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/tourCoreConfig";
import { FAIR_HOUSING_CODE, isFairHousingQuestion } from "../src/core/fairHousing";
import { VisitorDenialCopy } from "../src/core/TourCore";
import { zonedTimeToUtc } from "../src/core/timezone";
import { isMedicalEmergency, interpretByRules } from "../src/intent/ruleBased";
import type { ConversationStep } from "../src/intent/model";
import type { OutgoingMessage } from "../src/messaging/Messenger";
import { DemoMessagingAdapter } from "../src/messaging/Messenger";
import { persistSession } from "../src/operator/services";
import { handleVisitorText } from "../src/visitor/conversation";
import { smsHelpBody } from "../src/visitor/smsConsent";
import { VisitorDemoSession } from "../src/visitor";
import { grokHarness } from "./grokHarness";

/**
 * A 911 line on a normal text is noise, but a missed injury is unsafe.
 * fell, hurt, injured, slipped, and tripped need a person or a help word.
 * Breathing, choking, collapse, heart, stroke, seizure, overdose, allergy,
 * chest pain, and a broken bone do not. The check runs in every conversation state.
 */

const at = (hour: number, minute = 0) => zonedTimeToUtc({ year: 2026, month: 9, day: 28, hour, minute }, "America/New_York").getTime();
const PHONE = "+15550102000";
const SENT = "If someone is hurt, call 911 now. I've also let the property team know, and they'll text you here as soon as they can.";
const MISSED = "If someone is hurt, call 911 now. I couldn't reach the property team just now.";
const MISSED_PHONE = "If someone is hurt, call 911 now. I couldn't reach the property team just now, so please call them at (555) 010-9999 too.";
const SNAG = "Sorry, I hit a snag with that. Could you text me again in a few minutes?";
const NOT_MEDICAL = [
  "I fell in love with the place",
  "Is it 911 Main St?",
  "Would it hurt to ask about the rent?",
  "No hurry, we'll call an ambulance-chaser lawyer later 😂",
  "the price fell?",
] as const;
const ACUTE = [
  "she's not breathing",
  "he stopped breathing",
  "I can't breathe",
  "my son is choking",
  "he's unconscious",
  "she's unresponsive",
  "he passed out",
  "my mom fainted",
  "my dad is having a heart attack",
  "I think she's having a stroke",
  "he's having a seizure",
  "she overdosed",
  "allergic reaction",
  "I have chest pain",
  "he broke his arm",
  "broke his back",
  "my son broke his back",
  "broken arm",
  "I slipped and can't get up",
  "fell and can't get up",
  "can't get up",
  "she can not breathe",
  "had a stroke",
] as const;
const STEPS: ConversationStep[] = ["intro", "choose-unit", "choose-date", "choose-time", "ready", "touring"];

const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).forEach((fn) => fn()));

function phone(now = at(7), visitorContact?: string) {
  const config = loadConfig();
  if (visitorContact) config.operator = { ...config.operator, visitorContact };
  const transport = new DemoMessagingAdapter(() => {}, "MESSAGING");
  const session = new VisitorDemoSession(config.property.id, config, "t", { realNow: () => now, transport, kind: "messaging" });
  let n = 0;
  const say = (text: string) => handleVisitorText(session, PHONE, text, { provider: "test", providerMessageId: `med_${++n}` });
  return { session, say };
}

function failOperatorSend(session: VisitorDemoSession) {
  const send = session.transport.send.bind(session.transport);
  session.transport.send = async (message) => {
    if (message.audience === "OPERATOR") {
      return {
        provider: session.transport.provider,
        channel: "DEMO" as const,
        status: "FAILED" as const,
        sentAt: new Date().toISOString(),
        error: { code: "SENDBLUE_DOWN", message: "Sendblue rejected the text" },
      };
    }
    return send(message);
  };
}

async function prospectOutbound(session: VisitorDemoSession) {
  return (await session.store.list("messages")).filter((m) => m.audience === "PROSPECT" && m.direction === "OUTBOUND");
}

async function helpAlerts(session: VisitorDemoSession) {
  return (await session.store.list("messages")).filter((m) => m.audience === "OPERATOR" && m.body.includes("asked for help"));
}

async function fairFlags(session: VisitorDemoSession) {
  return (await session.store.listAudit()).filter((e) => e.type === "QUESTION_UNANSWERED" && e.code === FAIR_HOUSING_CODE);
}

async function addedReply(session: VisitorDemoSession, say: (text: string) => Promise<unknown>, text: string) {
  const before = await prospectOutbound(session);
  const alerts = await helpAlerts(session);
  await say(text);
  const replies = (await prospectOutbound(session)).slice(before.length).map((m) => m.body);
  const newAlerts = (await helpAlerts(session)).slice(alerts.length);
  return { replies, newAlerts };
}

async function optIn(p: ReturnType<typeof phone>) {
  await p.say("TOUR");
  await p.say("YES");
}

async function dayMenu(p: ReturnType<typeof phone>) {
  await optIn(p);
  await p.say("1");
}

async function timeMenu(p: ReturnType<typeof phone>) {
  await dayMenu(p);
  await p.say("1");
}

async function bookReady(p: ReturnType<typeof phone>) {
  await timeMenu(p);
  await p.say("1");
  await p.say("yes");
  await p.session.act("submitIdentity", { firstName: "Pat", lastName: "Smith", email: "pat@example.com", phone: PHONE });
}

async function onTour(p: ReturnType<typeof phone>) {
  await bookReady(p);
  await p.say("I'm here");
}

function inboxText(item: { what?: unknown; summary?: unknown; nextSteps?: unknown }): string {
  const steps = Array.isArray(item.nextSteps) ? item.nextSteps.map(String) : [];
  return [String(item.what), String(item.summary), ...steps].join("\n");
}

/** A touring visitor's help text, then the one help row from get_inbox. No live send. */
async function inboxAfterHelp(text: string, failTeam = false) {
  const h = grokHarness();
  cleanups.push(h.cleanup);
  const id = await h.publish();
  const v = await h.touringVisitor(id);
  if (failTeam) {
    const send = v.session.transport.send.bind(v.session.transport);
    v.session.transport.send = async (message: OutgoingMessage) => {
      if (message.audience === "OPERATOR") {
        return {
          provider: v.session.transport.provider,
          channel: "WEB" as const,
          status: "FAILED" as const,
          sentAt: new Date().toISOString(),
          error: { code: "NOT_DELIVERED", message: "The message couldn't be delivered." },
        };
      }
      return send(message);
    };
  }
  await v.session.act("help", {}, { text });
  await persistSession(h.services, v.session);
  const inbox = await h.ok("get_inbox");
  const help = (inbox.items as Array<{ kind?: string; what?: string }>).filter((row) => row.kind === "help");
  expect(help).toHaveLength(1);
  const visitor = (await v.session.store.list("messages")).filter((m) => m.audience === "PROSPECT" && m.direction === "OUTBOUND").at(-1)?.body;
  return { text: inboxText(help[0]!), visitor };
}

const ctx = {
  message: "",
  units: [{ name: "Unit 101" }],
  timeChoices: ["Monday, Sep 28"],
  remainingStops: [],
  doors: [],
  today: { year: 2026, month: 9, day: 28 },
  timezone: "America/New_York",
};

describe("medical help", () => {
  it("sends one 911 line and one help alert for acute phrases at the day menu and on a running tour", async () => {
    for (const phrase of ACUTE) {
      const day = phone();
      await dayMenu(day);
      const atMenu = await addedReply(day.session, day.say, phrase);
      expect(atMenu.replies, `day ${phrase}`).toEqual([SENT]);
      expect(atMenu.newAlerts, `day ${phrase}`).toHaveLength(1);

      const touring = phone(at(13, 58));
      await onTour(touring);
      const on = await addedReply(touring.session, touring.say, phrase);
      expect(on.replies, `tour ${phrase}`).toEqual([SENT]);
      expect(on.newAlerts, `tour ${phrase}`).toHaveLength(1);
    }

    expect(isMedicalEmergency("the date slipped")).toBe(false);
    expect(isMedicalEmergency("he tripped")).toBe(true);
    expect(isMedicalEmergency("tripped on the stairs")).toBe(false);
    const day = phone();
    await dayMenu(day);
    const slippedDay = await addedReply(day.session, day.say, "the date slipped");
    expect(slippedDay.replies.join("\n")).not.toContain("call 911 now");
    expect(slippedDay.newAlerts).toEqual([]);

    const touring = phone(at(13, 58));
    await onTour(touring);
    const slippedTour = await addedReply(touring.session, touring.say, "the date slipped");
    expect(slippedTour.replies.join("\n")).not.toContain("call 911 now");
    expect(slippedTour.newAlerts).toEqual([]);
  });

  it("requires a person or a help word, and ignores addresses and hyphenated compounds", () => {
    for (const phrase of NOT_MEDICAL) expect(isMedicalEmergency(phrase), phrase).toBe(false);
    expect(isMedicalEmergency("my son is bleeding")).toBe(true);
    expect(isMedicalEmergency("call 911")).toBe(true);
    expect(isMedicalEmergency("911")).toBe(true);
    expect(isMedicalEmergency("dial 911")).toBe(true);
    expect(isMedicalEmergency("my elderly mom fell, help")).toBe(true);
    expect(isMedicalEmergency("help! my child fell")).toBe(true);
    expect(isMedicalEmergency("my mom fell, help")).toBe(true);
    expect(isMedicalEmergency("help")).toBe(false);
    for (const step of STEPS) {
      for (const phrase of ["my son is bleeding", "call 911"]) {
        expect(interpretByRules({ ...ctx, step, message: phrase }).intent.type, `${step} ${phrase}`).toBe("REQUEST_HELP");
      }
      for (const phrase of NOT_MEDICAL) {
        expect(interpretByRules({ ...ctx, step, message: phrase }).intent.type, `${step} ${phrase}`).not.toBe("REQUEST_HELP");
      }
    }
  });

  it("sends the 911 line and a help alert from idle, the day menu, the time menu, a booked tour, and a running tour", async () => {
    const ordinary = phone();
    await dayMenu(ordinary);
    for (const phrase of NOT_MEDICAL) {
      const { replies, newAlerts } = await addedReply(ordinary.session, ordinary.say, phrase);
      expect(replies.join("\n"), phrase).not.toContain("If someone is hurt");
      expect(replies.join("\n"), phrase).not.toContain("call 911 now");
      expect(newAlerts, phrase).toEqual([]);
    }

    const idle = phone();
    await optIn(idle);
    const idleHit = await addedReply(idle.session, idle.say, "call 911");
    expect(idleHit.replies).toEqual([SENT]);
    expect(idleHit.newAlerts).toHaveLength(1);

    const dayBleed = phone();
    await dayMenu(dayBleed);
    const bleed = await addedReply(dayBleed.session, dayBleed.say, "my son is bleeding");
    expect(bleed.replies).toEqual([SENT]);
    expect(bleed.newAlerts).toHaveLength(1);

    const dayCall = phone();
    await dayMenu(dayCall);
    const call = await addedReply(dayCall.session, dayCall.say, "call 911");
    expect(call.replies).toEqual([SENT]);
    expect(call.newAlerts).toHaveLength(1);

    const times = phone();
    await timeMenu(times);
    expect((await addedReply(times.session, times.say, "call 911")).replies).toEqual([SENT]);

    const booked = phone(at(13, 58));
    await bookReady(booked);
    expect((await addedReply(booked.session, booked.say, "call 911")).replies).toEqual([SENT]);

    const touringBleed = phone(at(13, 58));
    await onTour(touringBleed);
    const onBleed = await addedReply(touringBleed.session, touringBleed.say, "my son is bleeding");
    expect(onBleed.replies).toEqual([SENT]);
    expect(onBleed.newAlerts).toHaveLength(1);

    const touringCall = phone(at(13, 58));
    await onTour(touringCall);
    const onCall = await addedReply(touringCall.session, touringCall.say, "call 911");
    expect(onCall.replies).toEqual([SENT]);
    expect(onCall.newAlerts).toHaveLength(1);
  });

  it("files a fair-housing flag only when the injury text also names a group", async () => {
    const elderly = phone(at(13, 58));
    await onTour(elderly);
    const mom = await addedReply(elderly.session, elderly.say, "my elderly mom fell, help");
    expect(mom.replies).toEqual([SENT]);
    expect(mom.newAlerts).toHaveLength(1);
    expect((await fairFlags(elderly.session)).map((e) => e.detail)).toContain("my elderly mom fell, help");

    const child = phone(at(13, 58));
    await onTour(child);
    const fell = await addedReply(child.session, child.say, "help! my child fell");
    expect(fell.replies).toEqual([SENT]);
    expect(fell.newAlerts).toHaveLength(1);
    expect((await fairFlags(child.session)).map((e) => e.detail)).toContain("help! my child fell");

    const plain = phone(at(13, 58));
    await onTour(plain);
    const noGroup = await addedReply(plain.session, plain.say, "my mom fell, help");
    expect(noGroup.replies).toEqual([SENT]);
    expect(noGroup.newAlerts).toHaveLength(1);
    expect(await fairFlags(plain.session)).toEqual([]);

    const help = phone(at(13, 58));
    await onTour(help);
    const ordinary = await addedReply(help.session, help.say, "help");
    expect(ordinary.replies).toEqual([VisitorDenialCopy.helpAck("property team")]);
    expect(ordinary.replies.join("\n")).not.toContain("call 911 now");
  });

  it("uses the help number on a failed team alert, and omits it when none is saved", async () => {
    const none = phone(at(13, 58));
    failOperatorSend(none.session);
    await onTour(none);
    const missed = await addedReply(none.session, none.say, "my mom fell, help");
    expect(missed.replies).toEqual([MISSED]);
    expect(missed.replies.join("\n")).not.toContain(SNAG);
    expect(missed.newAlerts).toHaveLength(1);
    expect(missed.newAlerts[0]!.deliveryStatus).toBe("FAILED");

    const withNumber = phone(at(13, 58), "+15550109999");
    failOperatorSend(withNumber.session);
    await onTour(withNumber);
    const called = await addedReply(withNumber.session, withNumber.say, "my mom fell, help");
    expect(called.replies).toEqual([MISSED_PHONE]);
    expect(called.replies.join("\n")).not.toContain(SNAG);
    expect(called.newAlerts[0]!.deliveryStatus).toBe("FAILED");
  });

  it("titles a sent medical alert Possible injury in get_inbox", async () => {
    const shown = await inboxAfterHelp("she's not breathing");
    expect(shown.visitor).toBe(SENT);
    expect(shown.text).toBe(
      [
        "Possible injury",
        'They texted: "she\'s not breathing". They were told to call 911 if someone is hurt, and that you\'d text them here.',
        "Text or call them now, then mark it handled.",
      ].join("\n"),
    );
  });

  it("tells the landlord they could not be reached when the medical alert fails", async () => {
    const shown = await inboxAfterHelp("she's not breathing", true);
    expect(shown.visitor).toBe(MISSED);
    expect(shown.visitor).not.toContain(SNAG);
    expect(shown.text).toBe(
      [
        "Possible injury",
        'They texted: "she\'s not breathing". They were told you couldn\'t be reached.',
        "Text or call them now, then mark it handled.",
      ].join("\n"),
    );
  });

  it("keeps the existing get_inbox item for plain HELP", async () => {
    const shown = await inboxAfterHelp("HELP");
    expect(shown.visitor).not.toContain("call 911 now");
    expect(shown.text).toBe(
      [
        "Visitor asked for help",
        "Asked for help near Unit 101 Door.",
        "Reach out to the visitor.",
        "Mark it handled once they're sorted.",
      ].join("\n"),
    );
  });

  it("does not let never-count phrases swallow a real emergency", async () => {
    const must = [
      "he passed out",
      "my kid is choking",
      "she's having a heart attack",
      "broke his back",
      "had a stroke",
      "cant get up",
      "cannot get up",
      "can not get up",
      "can not breathe",
      "cannot breathe",
      "collapsed",
      "trouble breathing",
      "has a stroke",
    ];
    const mustNot = [
      "they passed out flyers",
      "choking hazard for toddlers?",
      "broke a back window",
      "my tour slipped to 3?",
      "I broke a lease before",
      "is there a seizure of deposit",
      "my heart attack of a commute lol",
      "price is a heart attack",
      "I tripped the breaker",
      "we tripped the alarm",
      "my roommate broke her lease",
      "we broke a window",
      "sorry we broke a glass",
      "broke a nail lol",
    ];
    for (const phrase of must) expect(isMedicalEmergency(phrase), phrase).toBe(true);
    for (const phrase of mustNot) expect(isMedicalEmergency(phrase), phrase).toBe(false);
    expect(isFairHousingQuestion("choking hazard for toddlers?")).toBe(true);

    const day = phone();
    await dayMenu(day);
    for (const phrase of mustNot) {
      const hit = await addedReply(day.session, day.say, phrase);
      expect(hit.replies.join("\n"), phrase).not.toContain("call 911 now");
      expect(hit.newAlerts, phrase).toEqual([]);
    }
    expect((await fairFlags(day.session)).map((e) => e.detail)).toContain("choking hazard for toddlers?");
  });

  it("keeps the plain help item and one Possible injury after two injury texts", async () => {
    const h = grokHarness();
    cleanups.push(h.cleanup);
    const id = await h.publish();
    const v = await h.touringVisitor(id);
    await v.session.act("help", {});
    const start = h.now();
    h.setClock(start + 60_000);
    await v.session.act("help", {}, { text: "my dad passed out" });
    h.setClock(start + 6 * 60_000);
    await v.session.act("help", {}, { text: "my dad passed out" });
    await persistSession(h.services, v.session);
    const inbox = await h.ok("get_inbox");
    const items = inbox.items as Array<{ kind?: string; what?: string; summary?: string; nextSteps?: string[] }>;
    expect(items).toHaveLength(2);
    const plain = items.find((item) => item.what === "Visitor asked for help");
    const injury = items.find((item) => item.what === "Possible injury");
    expect(inboxText(plain!)).toBe(
      ["Visitor asked for help", "Asked for help near Unit 101 Door.", "Reach out to the visitor.", "Mark it handled once they're sorted."].join("\n"),
    );
    expect(injury?.summary).toBe('They texted: "my dad passed out". They were told to call 911 if someone is hurt, and that you\'d text them here.');
    expect(injury?.nextSteps).toEqual(["Text or call them now, then mark it handled."]);
  });

  it("ends with the 911 sentence after a failed alert is retried and sent", async () => {
    const h = grokHarness();
    cleanups.push(h.cleanup);
    const id = await h.publish();
    const v = await h.touringVisitor(id);
    const send = v.session.transport.send.bind(v.session.transport);
    let fail = true;
    v.session.transport.send = async (message: OutgoingMessage) => {
      if (fail && message.audience === "OPERATOR") {
        return {
          provider: v.session.transport.provider,
          channel: "WEB" as const,
          status: "FAILED" as const,
          sentAt: new Date().toISOString(),
          error: { code: "NOT_DELIVERED", message: "The message couldn't be delivered." },
        };
      }
      return send(message);
    };
    await v.session.act("help", {}, { text: "she's not breathing" });
    h.setClock(h.now() + 6 * 60_000);
    fail = false;
    await v.session.act("help", {}, { text: "she's not breathing" });
    await persistSession(h.services, v.session);
    const inbox = await h.ok("get_inbox");
    const items = inbox.items as Array<{ kind?: string; what?: string; summary?: string }>;
    const help = items.filter((item) => item.kind === "help");
    expect(help).toHaveLength(1);
    expect(help[0]?.summary).toBe('They texted: "she\'s not breathing". They were told to call 911 if someone is hurt, and that you\'d text them here.');
    expect(help[0]?.summary?.endsWith("They were told to call 911 if someone is hurt, and that you'd text them here.")).toBe(true);
    expect(items.some((item) => item.what === "A text to you didn't go out")).toBe(false);
    expect((await v.session.store.listAudit()).some((e) => e.type === "MESSAGE_FAILED" && e.detail.includes("couldn't text you"))).toBe(true);
  });

  it("renders a visitor quote inside a quote with single quotes", async () => {
    const h = grokHarness();
    cleanups.push(h.cleanup);
    const id = await h.publish();
    const v = await h.touringVisitor(id);
    await v.session.act("help", {}, { text: 'he said "I can\'t breathe"' });
    await persistSession(h.services, v.session);
    const inbox = await h.ok("get_inbox");
    const injury = (inbox.items as Array<{ what?: string; summary?: string }>).find((item) => item.what === "Possible injury");
    expect(injury?.summary).toBe('They texted: "he said \'I can\'t breathe\'". They were told to call 911 if someone is hurt, and that you\'d text them here.');
  });

  it("uses the injury ending on a fair-housing text that also got the 911 line", async () => {
    const h = grokHarness();
    cleanups.push(h.cleanup);
    const id = await h.publish();
    const v = await h.touringVisitor(id);
    await v.session.act("help", {}, { text: "my kid is choking" });
    await persistSession(h.services, v.session);
    const inbox = await h.ok("get_inbox");
    const items = inbox.items as Array<{ what?: string; summary?: string; nextSteps?: string[]; proposeDraft?: boolean }>;
    const fair = items.find((item) => item.what === "Possible fair-housing question");
    expect(fair?.proposeDraft).toBe(false);
    expect(fair?.summary).toBe(
      'They asked: "my kid is choking". This may touch on fair housing, so there\'s no draft. Only you can answer this one. They were told to call 911 if someone is hurt, and that you\'d text them here.',
    );
    expect(fair?.summary).not.toContain("They were told you'd text them back here.");
    expect(fair?.nextSteps).toEqual(["Mark it handled once you've replied."]);
    expect(items.filter((item) => item.what === "Possible injury")).toHaveLength(1);
  });

  it("lists one Possible injury when the alert fails, with or without a help number", async () => {
    const none = grokHarness();
    cleanups.push(none.cleanup);
    const noneId = await none.publish();
    const noneVisitor = await none.touringVisitor(noneId);
    failOperatorSend(noneVisitor.session);
    await noneVisitor.session.act("help", {}, { text: "she's not breathing" });
    await persistSession(none.services, noneVisitor.session);
    const noneInbox = await none.ok("get_inbox");
    const noneItems = noneInbox.items as Array<{ what?: string; summary?: string }>;
    expect(noneItems.filter((item) => item.what === "Possible injury")).toHaveLength(1);
    expect(noneItems.some((item) => item.what === "A text to you didn't go out")).toBe(false);
    expect(noneItems.find((item) => item.what === "Possible injury")?.summary).toContain("They were told you couldn't be reached.");
    const noneVisitorLine = (await noneVisitor.session.store.list("messages")).filter((m) => m.audience === "PROSPECT" && m.direction === "OUTBOUND").at(-1)?.body;
    expect(noneVisitorLine).toBe(MISSED);

    const withNumber = grokHarness();
    cleanups.push(withNumber.cleanup);
    const withId = await withNumber.publish();
    const saved = withNumber.workspace.load(withId);
    withNumber.workspace.save({
      ...saved.config,
      operator: { ...saved.config.operator, visitorContact: "+15550109999", visitorHelpDecided: true },
    });
    const numbered = await withNumber.touringVisitor(withId);
    failOperatorSend(numbered.session);
    await numbered.session.act("help", {}, { text: "she's not breathing" });
    await persistSession(withNumber.services, numbered.session);
    const numberedInbox = await withNumber.ok("get_inbox");
    const numberedItems = numberedInbox.items as Array<{ what?: string }>;
    expect(numberedItems.filter((item) => item.what === "Possible injury")).toHaveLength(1);
    expect(numberedItems.some((item) => item.what === "A text to you didn't go out")).toBe(false);
    const numberedLine = (await numbered.session.store.list("messages")).filter((m) => m.audience === "PROSPECT" && m.direction === "OUTBOUND").at(-1)?.body;
    expect(numberedLine).toBe(MISSED_PHONE);
  });

  it("after STOP, sends the 911 line once per opt-out and still alerts each injury", async () => {
    const h = grokHarness();
    cleanups.push(h.cleanup);
    const id = await h.publish();
    const v = await h.touringVisitor(id);
    const say = (text: string) => handleVisitorText(v.session, PHONE, text);
    const injuryLines = async () => (await prospectOutbound(v.session)).map((m) => m.body).filter((body) => body.includes("call 911 now"));
    await say("STOP");
    await say("my dad passed out");
    expect(await helpAlerts(v.session)).toHaveLength(1);
    expect(await injuryLines()).toEqual([SENT]);
    expect((await h.ok("get_inbox")).items.filter((item: { what?: string }) => item.what === "Possible injury")).toHaveLength(1);

    await say("he passed out");
    expect(await helpAlerts(v.session)).toHaveLength(2);
    expect(await injuryLines()).toEqual([SENT]);
    expect((await h.ok("get_inbox")).items.filter((item: { what?: string }) => item.what === "Possible injury")).toHaveLength(2);

    await say("START");
    await say("STOP");
    await say("call 911");
    expect(await injuryLines()).toHaveLength(2);
    expect(await helpAlerts(v.session)).toHaveLength(3);
    expect((await h.ok("get_inbox")).items.filter((item: { what?: string }) => item.what === "Possible injury")).toHaveLength(3);

    const beforeHelp = (await prospectOutbound(v.session)).length;
    await say("HELP");
    const afterHelp = await prospectOutbound(v.session);
    expect(afterHelp.slice(beforeHelp).map((m) => m.body)).toEqual([smsHelpBody()]);
    expect(await helpAlerts(v.session)).toHaveLength(3);

    const beforeQuiet = afterHelp.length;
    await say("Hi");
    await say("2pm");
    expect(await prospectOutbound(v.session)).toHaveLength(beforeQuiet);
    expect(v.session.optedOut).toBe(true);
    expect((await h.ok("get_inbox")).items.some((item: { what?: string }) => item.what === "A text to you didn't go out")).toBe(false);
  });

  it("logs one blocked 911 line after STOP, does not retry, and does not list a missed text", async () => {
    const h = grokHarness();
    cleanups.push(h.cleanup);
    const id = await h.publish();
    const v = await h.touringVisitor(id);
    const say = (text: string) => handleVisitorText(v.session, PHONE, text);
    await say("STOP");
    const send = v.session.transport.send.bind(v.session.transport);
    let blocked = 0;
    v.session.transport.send = async (message: OutgoingMessage) => {
      if (message.audience === "PROSPECT" && message.body.includes("call 911 now")) {
        blocked += 1;
        return {
          provider: v.session.transport.provider,
          channel: "WEB" as const,
          status: "FAILED" as const,
          sentAt: new Date().toISOString(),
          error: { code: "NOT_DELIVERED", message: "The message couldn't be delivered." },
        };
      }
      return send(message);
    };
    const errors: string[] = [];
    const orig = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    };
    try {
      await say("my dad passed out");
      await say("he passed out");
    } finally {
      console.error = orig;
    }
    expect(blocked).toBe(1);
    expect(errors.filter((line) => line.startsWith("911 line was not sent"))).toHaveLength(1);
    const items = (await h.ok("get_inbox")).items as Array<{ what?: string }>;
    expect(items.filter((item) => item.what === "Possible injury")).toHaveLength(2);
    expect(items.some((item) => item.what === "A text to you didn't go out")).toBe(false);
    expect(items.some((item) => item.what === "Message couldn't be delivered")).toBe(false);
    expect(await helpAlerts(v.session)).toHaveLength(2);
  });

  it("repeats the sent 911 line inside the help window and does not alert again", async () => {
    const p = phone(at(13, 58));
    await onTour(p);
    const first = await addedReply(p.session, p.say, "call 911");
    const second = await addedReply(p.session, p.say, "my son is bleeding");
    expect(first.replies).toEqual([SENT]);
    expect(first.newAlerts).toHaveLength(1);
    expect(second.replies).toEqual([SENT]);
    expect(second.newAlerts).toEqual([]);
  });
});
