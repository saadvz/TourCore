import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/tourCoreConfig";
import { FAIR_HOUSING_CODE } from "../src/core/fairHousing";
import { VisitorDenialCopy } from "../src/core/TourCore";
import { zonedTimeToUtc } from "../src/core/timezone";
import { isMedicalEmergency, interpretByRules } from "../src/intent/ruleBased";
import type { ConversationStep } from "../src/intent/model";
import { DemoMessagingAdapter } from "../src/messaging/Messenger";
import { handleVisitorText } from "../src/visitor/conversation";
import { VisitorDemoSession } from "../src/visitor";

/**
 * A 911 line on a normal text is noise, but a missed injury is unsafe.
 * fell, hurt, and injured need a person or a help word. The check runs in
 * every conversation state.
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
