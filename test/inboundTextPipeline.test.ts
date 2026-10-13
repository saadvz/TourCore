import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/tourCoreConfig";
import { NOTHING_BOOKED_CANCEL, VisitorDenialCopy } from "../src/core/TourCore";
import { renderSms } from "../src/sms/templates";
import { smsHelpBody, smsStopAck } from "../src/visitor/smsConsent";
import { at, liveApp, PHONE, type LiveApp } from "./liveApp";

/**
 * Full-app inbound SMS: POST /webhooks/sendblue → handleProviderWebhook →
 * the visitor handler → the reply in the outbox. One text that matches more
 * than one intent uses this order: HELP, emergency/911, on-tour door,
 * STOP/consent, cancel, menus, fair housing last.
 *
 * Tests that still take the wrong path are it.fails (Vitest 5). The name
 * starts with "fixed in pipeline PR 2". A passing test is a regression guard
 * for an edge that already matches this order on 84b745a.
 */

const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).forEach((fn) => fn()));

const MEDICAL = VisitorDenialCopy.medicalAlert("property team", undefined, true);
const HELP_ACK = VisitorDenialCopy.helpAck("property team");
const HELP_KEYWORD = smsHelpBody();
const STOP = smsStopAck();
const HELD = renderSms("fair-housing-held", { team: "property team" }).body;
const MONDAY_TIMES = "I have these times available Monday, Sep 28:\nReply 1 for 2:00 PM or 2 for 3:30 PM.";
const DOOR = "Unit 101 Door is open for you now.";

function unit101() {
  const config = loadConfig();
  return { ...config, messagingMode: "live" as const };
}

function consent(app: LiveApp, phone: string): { status?: string; keyword?: string } {
  const id = unit101().property.id;
  const file = join(app.root, "properties", id, "sms-campaign-consent.json");
  try {
    const senders = JSON.parse(readFileSync(file, "utf8")).senders as Record<string, { status?: string; keyword?: string }>;
    return senders[phone] ?? {};
  } catch {
    return {};
  }
}

async function appAt(hour = 7, minute = 0) {
  const clock = { t: at(hour, minute) };
  const app = await liveApp({ cleanups, clock, config: unit101() });
  return { app, clock };
}

/** Book Unit 101 at 2:00 PM and open the entrance, the same path a visitor texts. */
async function arrive(app: LiveApp, clock: { t: number }) {
  await app.optInSms();
  await app.text("1");
  await app.text("1");
  await app.text("1");
  await app.fillForm(await app.text("YES"));
  clock.t = at(13, 58);
  const here = await app.text("I'm here");
  expect(here.join("\n")).toContain("Entrance is open for you now.");
}

describe("inbound text order", () => {
  it.fails("fixed in pipeline PR 2: HELP beats emergency and fair housing on one text", async () => {
    const { app, clock } = await appAt();
    await arrive(app, clock);
    const replies = await app.text("my elderly mom fell, help");
    expect(replies, "wrong precedence: emergency beat HELP").toEqual([HELP_ACK]);
    expect(replies.join("\n"), "wrong precedence: emergency beat HELP").not.toContain("call 911");
    expect(replies.join("\n"), "wrong precedence: fair housing beat HELP").not.toContain(HELD);
  });

  it.fails("fixed in pipeline PR 2: emergency beats STOP before opt-in", async () => {
    const { app } = await appAt();
    const phone = "+15550103011";
    const replies = await app.textFrom(phone, "stop texting my dad, he passed out");
    expect(replies, "wrong precedence: STOP beat emergency").toEqual([MEDICAL]);
    expect(consent(app, phone).status, "wrong precedence: STOP beat emergency").not.toBe("opted_out");
  });

  it.fails("fixed in pipeline PR 2: emergency beats STOP after opt-in", async () => {
    const { app } = await appAt();
    const phone = "+15550103012";
    await app.textFrom(phone, "TOUR");
    await app.textFrom(phone, "YES");
    const replies = await app.textFrom(phone, "stop texting my dad, he passed out");
    expect(replies, "wrong precedence: STOP beat emergency").toEqual([MEDICAL]);
    expect(consent(app, phone).status, "wrong precedence: STOP beat emergency").toBe("opted_in");
  });

  it.fails("fixed in pipeline PR 2: an on-tour door beats STOP", async () => {
    const { app, clock } = await appAt();
    await arrive(app, clock);
    const replies = await app.text("stop texting my family, I am at unit 101");
    expect(replies.join("\n"), "wrong precedence: STOP beat the on-tour door").toContain(DOOR);
    expect(replies.join("\n"), "wrong precedence: STOP beat the on-tour door").not.toContain("opted out");
    expect(consent(app, PHONE).status, "wrong precedence: STOP beat the on-tour door").toBe("opted_in");
  });

  it.fails("fixed in pipeline PR 2: an on-tour door beats cancel", async () => {
    const { app, clock } = await appAt();
    await arrive(app, clock);
    const replies = await app.text("I am at unit 101, please cancel the tour");
    expect(replies.join("\n"), "wrong precedence: cancel beat the on-tour door").toContain(DOOR);
    expect(replies.join("\n"), "wrong precedence: cancel beat the on-tour door").not.toContain("can't cancel");
  });

  it.fails("fixed in pipeline PR 2: STOP beats bare cancel on a booked tour", async () => {
    const { app } = await appAt();
    await app.book();
    // "cancel" is the carrier STOP keyword and a tour-cancel ask. STOP comes first.
    const replies = await app.text("cancel");
    expect(replies, "wrong precedence: cancel beat STOP").toEqual([STOP]);
    expect(consent(app, PHONE), "wrong precedence: cancel beat STOP").toMatchObject({ status: "opted_out", keyword: "STOP" });
  });

  it.fails("fixed in pipeline PR 2: a day menu beats fair housing", async () => {
    const { app } = await appAt();
    await app.optInSms();
    await app.text("1");
    const replies = await app.text("Monday is good for families");
    expect(replies, "wrong precedence: fair housing beat the day menu").toEqual([MONDAY_TIMES]);
    expect(replies.join("\n"), "wrong precedence: fair housing beat the day menu").not.toContain(HELD);
  });

  it.fails("fixed in pipeline PR 2: a broken back is a 911 text, not the unit menu", async () => {
    const { app } = await appAt();
    await app.optInSms();
    const replies = await app.text("my back is broken");
    expect(replies, "missed injury: the unit menu beat 911").toEqual([MEDICAL]);
  });

  it.fails("fixed in pipeline PR 2: HELP beats the keyword prompt", async () => {
    const { app } = await appAt();
    const replies = await app.textFrom("+15550103013", "help, I am lost");
    expect(replies, "wrong precedence: the consent prompt beat HELP").toEqual([HELP_KEYWORD]);
  });

  it.fails("fixed in pipeline PR 2: get_operator_update uses the full number for an unnamed visitor", async () => {
    const { app } = await appAt();
    const phone = "+15550104000";
    await app.textFrom(phone, "TOUR");
    await app.textFrom(phone, "YES");
    await app.textFrom(phone, "Is there a pool?");
    const event = app.routineEvents().find((item) => item.eventType === "exception.created");
    expect(event?.eventId).toBeTruthy();
    const inbox = await app.grok("get_inbox", { eventId: event!.eventId });
    const update = await app.grok("get_operator_update", { eventId: event!.eventId });
    expect(inbox.summary, "get_inbox already says Visitor at the full number").toContain("Visitor at (555) 010-4000");
    expect(update.summary, "PR 74 bug: get_operator_update uses the first chunk of the phone").toBe(inbox.summary);
    expect(String(update.summary), "PR 74 bug: get_operator_update uses the first chunk of the phone").not.toMatch(/^\(555\)/);
  });
});

describe("inbound text order already held on this commit", () => {
  it("regression: emergency beats an on-tour door", async () => {
    const { app, clock } = await appAt();
    await arrive(app, clock);
    const replies = await app.text("I am at unit 101, call 911");
    expect(replies).toEqual([MEDICAL]);
    expect(replies.join("\n")).not.toContain(DOOR);
  });

  it("regression: cancel beats a time-menu number", async () => {
    const { app } = await appAt();
    await app.optInSms();
    await app.text("1");
    await app.text("1");
    const replies = await app.text("2, please cancel");
    expect(replies).toEqual([NOTHING_BOOKED_CANCEL]);
  });

  it("regression: HELP beats a clock in the same text", async () => {
    const { app } = await appAt();
    await app.optInSms();
    await app.text("1");
    await app.text("1");
    const replies = await app.text("help, 2pm please");
    expect(replies).toEqual([HELP_KEYWORD]);
    expect(replies.join("\n")).not.toContain("booked");
  });
});
