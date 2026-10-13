import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig, type TourCoreConfig } from "../src/config/tourCoreConfig";
import { NOTHING_BOOKED_CANCEL, VisitorDenialCopy } from "../src/core/TourCore";
import { MessagingEndpoints } from "../src/messaging/endpoints";
import type { OutgoingMessage } from "../src/messaging/Messenger";
import { SendblueMessagingAdapter } from "../src/messaging/sendblue/adapter";
import { renderSms, toursUnavailableText } from "../src/sms/templates";
import { runReadinessCheck } from "../src/setup";
import { smsHelpBody, smsStopAck } from "../src/visitor/smsConsent";
import { at, liveApp, PHONE, publishForVisitors, type LiveApp } from "./liveApp";

/**
 * Full-app inbound SMS: POST /webhooks/sendblue → handleProviderWebhook →
 * the visitor handler → the reply in the outbox. One text that matches more
 * than one intent uses this order: the bare HELP or INFO carrier keyword,
 * emergency/911, on-tour door, STOP/consent, cancel, menus, fair housing last.
 * HELP outranks 911 only when the text is that keyword and nothing else.
 * A clock in the same text is a time, not that keyword. An injury described
 * alongside the word help is an emergency.
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
const COTTAGE_DOOR = "Cottage Door is open for you now.";
const BOOKED_FOR = "Great, you're booked for 2:00 PM on Monday, Sep 28.";
const CANCEL_OPT_OUT = "Your tour is cancelled and you won't get any more texts from us. To come back or book again, reply START.";
const QUEUED_UNREACHED = "We sent them a text to call 911 and said you couldn't be reached, but we can't confirm it got to them.";
const FAIR_Q = "my kid is hurt, are families allowed?";
const NOT_READY = toursUnavailableText("100 Alfred Way", "property team");
const SLOT_2PM = "2026-09-28T18:00:00.000Z";
const SCRATCH_ID = "prop_12_scratch_lane";
const LINE = "+15550009999";

function unit101() {
  const config = loadConfig();
  return { ...config, messagingMode: "live" as const };
}

function consent(app: LiveApp, phone: string, propertyId = unit101().property.id): { status?: string; keyword?: string } {
  const id = propertyId;
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

function scratchHome(): TourCoreConfig {
  const base = loadConfig();
  const swap = (name: string) => name.replaceAll("Unit 101", "Cottage").replaceAll("Unit 102", "Loft");
  return {
    ...base,
    messagingMode: "live",
    property: { ...base.property, id: SCRATCH_ID, name: "Scratch House", address: "12 Scratch Lane, Teaneck, NJ 07666" },
    doors: base.doors.map((door) => ({ ...door, name: swap(door.name) })),
    units: base.units.map((unit) => ({ ...unit, name: swap(unit.name), summary: swap(unit.summary) })),
    routes: base.routes.map((route) => ({ ...route, stops: route.stops.map((stop) => ({ ...stop, guidance: swap(stop.guidance) })) })),
  };
}

/** A second published home on the same texting number as 100 Alfred Way. */
async function sharedLine() {
  const { app, clock } = await appAt();
  const scratch = scratchHome();
  app.ws.save(scratch);
  app.ws.recordReadiness(scratch.property.id, await runReadinessCheck(scratch, { now: new Date(clock.t) }));
  publishForVisitors(app.ws, scratch.property.id, new Date(clock.t));
  new MessagingEndpoints(app.installation.runtime).attach({ address: LINE, provider: "sendblue", propertyId: scratch.property.id });
  return { app, clock };
}

async function pickScratch(app: LiveApp, phone: string) {
  const asked = await app.textFrom(phone, "TOUR");
  const choice = asked.join("\n").split("\n").find((line) => line.includes("12 Scratch Lane"))?.match(/^(\d+)/)?.[1];
  expect(choice, "the shared line did not offer Scratch House").toBeTruthy();
  await app.textFrom(phone, choice!);
  await app.textFrom(phone, "YES");
}

async function bookScratch(app: LiveApp, phone: string) {
  await pickScratch(app, phone);
  await app.textFrom(phone, "1");
  await app.textFrom(phone, "1");
  await app.textFrom(phone, "1");
  const yes = await app.textFrom(phone, "YES");
  const token = /\/verify\/([A-Za-z0-9_-]+)/.exec(yes.join("\n"))?.[1];
  expect(token).toBeTruthy();
  const form = await fetch(`http://127.0.0.1:${(app.server.address() as { port: number }).port}/api/verify/${token}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ firstName: "Testy", lastName: "McTest", email: "testy@example.com", phone }),
  });
  expect(((await form.json()) as { ok: boolean }).ok).toBe(true);
  await app.server.tourCore.settled();
}

function bundles(app: LiveApp, propertyId = unit101().property.id) {
  return app.ws.listTours(propertyId).flatMap((record) => {
    const tour = app.ws.loadTour(propertyId, record.tourId);
    return tour ? [tour.bundle] : [];
  });
}

async function inboxItems(app: LiveApp, property: string) {
  const body = await app.grok("get_inbox", { property });
  return body.items as Array<{ what?: string; summary?: string }>;
}

/** Visitor 911 texts stay queued. The team text fails. */
function failTeamAlerts(): () => void {
  const original = SendblueMessagingAdapter.prototype.send;
  SendblueMessagingAdapter.prototype.send = async function (message: OutgoingMessage) {
    if (message.audience === "OPERATOR") {
      return {
        provider: "sendblue",
        channel: "UNKNOWN",
        status: "FAILED",
        sentAt: new Date().toISOString(),
        error: { code: "NOT_DELIVERED", message: "The message couldn't be delivered." },
      };
    }
    return original.call(this, message);
  };
  return () => {
    SendblueMessagingAdapter.prototype.send = original;
  };
}

describe("inbound text order", () => {
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

  it.fails("fixed in pipeline PR 2: bare cancel on a booked tour cancels it and opts out", async () => {
    const { app } = await appAt();
    await app.book();
    // "cancel" is the carrier STOP keyword and a tour-cancel ask. Both happen, in one reply.
    const replies = await app.text("cancel");
    expect(replies, "bare cancel asked to confirm and left the tour booked").toEqual([CANCEL_OPT_OUT]);
    expect(consent(app, PHONE), "bare cancel did not opt the visitor out").toMatchObject({ status: "opted_out", keyword: "STOP" });
    const saved = bundles(app);
    const reservations = saved.flatMap((bundle) => bundle.reservations);
    expect(reservations.some((reservation) => reservation.slotStart === SLOT_2PM && reservation.status !== "CANCELLED"), "the 2:00 PM slot is still held").toBe(false);
    expect(saved.flatMap((bundle) => bundle.accessGrants).some((grant) => grant.status === "ACTIVE"), "a door grant is still active").toBe(false);
    expect(
      saved.some((bundle) => bundle.messages.some((message) => message.audience === "OPERATOR") || bundle.auditEvents.some((event) => event.type === "OPERATOR_NOTIFIED")),
      "no team alert was sent",
    ).toBe(true);
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

  it.fails("fixed in pipeline PR 2: a lost visitor gets the help acknowledgement, not the consent prompt", async () => {
    const { app } = await appAt();
    // "I am lost" is a real request, not filler around the carrier keyword.
    const replies = await app.textFrom("+15550103013", "help, I am lost");
    expect(replies, "wrong precedence: the consent prompt beat the help acknowledgement").toEqual([HELP_ACK]);
  });

  it.fails("fixed in pipeline PR 2: bare HELP returns the keyword body mid-tour", async () => {
    const { app, clock } = await appAt();
    await arrive(app, clock);
    const replies = await app.text("HELP");
    expect(replies, "wrong precedence: the live-tour help acknowledgement beat the HELP keyword").toEqual([HELP_KEYWORD]);
  });

  it.fails("fixed in pipeline PR 2: help, 2pm please is a time, not the HELP keyword", async () => {
    const { app } = await appAt();
    await app.optInSms();
    await app.text("1");
    await app.text("1");
    const replies = await app.text("help, 2pm please");
    expect(replies[0], "wrong precedence: the HELP keyword beat the time").toBe(BOOKED_FOR);
    expect(replies.join("\n"), "wrong precedence: the HELP keyword beat the time").toContain("please fill out this short form");
    expect(replies.join("\n"), "wrong precedence: the HELP keyword beat the time").not.toContain("For help with your property tour");
  });

  it.fails("fixed in pipeline PR 2: an emergency on a shared line is the 911 line, not the place picker", async () => {
    const { app } = await sharedLine();
    const replies = await app.textFrom("+15550103079", "he passed out, call 911");
    expect(replies, "wrong precedence: the place picker beat emergency").toEqual([MEDICAL]);
    expect(replies.join("\n"), "wrong precedence: the place picker beat emergency").not.toContain("Which place");
  });

  it.fails("fixed in pipeline PR 2: an on-tour door on a shared line beats STOP", async () => {
    const { app, clock } = await sharedLine();
    const phone = "+15550103080";
    await bookScratch(app, phone);
    clock.t = at(13, 58);
    const here = await app.textFrom(phone, "I'm here");
    expect(here.join("\n")).toContain("Entrance is open for you now.");
    const replies = await app.textFrom(phone, "stop texting my family, I am at cottage");
    expect(replies.join("\n"), "wrong precedence: STOP beat the on-tour door").toContain(COTTAGE_DOOR);
    expect(replies.join("\n"), "wrong precedence: STOP beat the on-tour door").not.toContain("opted out");
  });

  it.fails("fixed in pipeline PR 2: START after bare cancel restores a booking on one property", async () => {
    const { app } = await appAt();
    await app.book();
    await app.text("cancel");
    await app.text("START");
    const next = await app.text("Hi");
    expect(next.join("\n"), "START left the cancelled tour in place").toContain("Which unit would you like to see?");
    expect(consent(app, PHONE).status, "START did not restore consent").toBe("opted_in");
  });

  it.fails("fixed in pipeline PR 2: START after bare cancel restores a booking on a shared line", async () => {
    const { app } = await sharedLine();
    const phone = "+15550103081";
    await bookScratch(app, phone);
    await app.textFrom(phone, "cancel");
    await app.textFrom(phone, "START");
    const next = await app.textFrom(phone, "Hi");
    expect(next.join("\n"), "START left the cancelled tour in place").toContain("Which unit would you like to see?");
    expect(consent(app, phone, SCRATCH_ID).status, "START did not restore consent").toBe("opted_in");
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
  it("regression: an injury that also says help gets the 911 line", async () => {
    const { app, clock } = await appAt();
    await arrive(app, clock);
    const replies = await app.text("my elderly mom fell, help");
    expect(replies).toEqual([MEDICAL]);
    expect(replies.join("\n")).not.toContain(HELD);
  });

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

  it("regression: bare HELP at the time menu returns the keyword body", async () => {
    const { app } = await appAt();
    await app.optInSms();
    await app.text("1");
    await app.text("1");
    const replies = await app.text("HELP");
    expect(replies).toEqual([HELP_KEYWORD]);
    expect(replies.join("\n")).not.toContain("booked");
  });

  it("regression: an injury that names a protected group is only the 911 line", async () => {
    const { app, clock } = await appAt();
    await arrive(app, clock);
    const onTour = await app.text(FAIR_Q);
    expect(onTour).toEqual([MEDICAL]);
    expect(onTour.join("\n")).not.toContain(HELD);

    const before = await appAt();
    await before.app.optInSms();
    const early = await before.app.textFrom("+15550103071", FAIR_Q);
    expect(early).toEqual([MEDICAL]);
    expect(early.join("\n")).not.toContain(HELD);

    for (const [label, running, property] of [
      ["mid-tour", app, "100 Alfred Way"],
      ["before a booking", before.app, "100 Alfred Way"],
    ] as const) {
      const flagged = (await inboxItems(running, property)).find((item) => item.what === "Possible fair-housing question");
      expect(flagged?.summary, label).toContain(FAIR_Q);
    }
  });

  it("regression: an opted-out visitor still gets the 911 line, and stays opted out", async () => {
    const { app } = await appAt();
    const bare = "+15550103072";
    await app.textFrom(bare, "STOP");
    expect(await app.textFrom(bare, "he passed out, call 911")).toEqual([MEDICAL]);
    expect(await app.textFrom(bare, "Hi")).toEqual([]);
    expect(consent(app, bare).status).toBe("opted_out");

    await app.book();
    await app.text("STOP");
    expect(await app.text("he passed out, call 911")).toEqual([MEDICAL]);
    expect(await app.text("Hi")).toEqual([]);
    expect(consent(app, PHONE).status).toBe("opted_out");
  });

  it("regression: a draft answers HELP, STOP, and an emergency instead of not-ready", async () => {
    const { app } = await appAt();
    app.ws.patchState(unit101().property.id, { status: "DRAFT" });
    const help = await app.textFrom("+15550103073", "HELP");
    const stop = await app.textFrom("+15550103074", "STOP");
    const injury = await app.textFrom("+15550103075", "he passed out");
    expect(help).toEqual([HELP_KEYWORD]);
    expect(stop).toEqual([STOP]);
    expect(injury).toEqual([MEDICAL]);
    for (const replies of [help, stop, injury]) expect(replies.join("\n")).not.toContain("aren't available");
    expect(await app.textFrom("+15550103076", "Hi")).toEqual([NOT_READY]);
  });

  it("regression: bare HELP on a shared line is the keyword body", async () => {
    const { app } = await sharedLine();
    const replies = await app.textFrom("+15550103077", "HELP");
    expect(replies).toEqual([HELP_KEYWORD]);
    expect(replies.join("\n")).not.toContain("Which place");
  });

  it("regression: STOP on a shared line is the opt-out, not the place picker", async () => {
    const { app } = await sharedLine();
    const phone = "+15550103078";
    const replies = await app.textFrom(phone, "STOP");
    expect(replies).toEqual([STOP]);
    expect(replies.join("\n")).not.toContain("Which place");
    expect(await app.textFrom(phone, "Hi")).toEqual([]);
  });

  it("regression: a queued 911 text and a failed team alert end the inbox on the unconfirmed line", async () => {
    const restore = failTeamAlerts();
    cleanups.push(restore);
    const { app } = await appAt();
    await app.optInSms();
    await app.text("she's not breathing");
    const saved = bundles(app);
    const messages = saved.flatMap((bundle) => bundle.messages);
    const queued = messages.filter((message) => message.audience === "PROSPECT" && message.body.includes("call 911 now") && message.deliveryStatus === "QUEUED");
    const failed = messages.filter((message) => message.audience === "OPERATOR" && message.body.includes("asked for help") && message.deliveryStatus === "FAILED");
    expect(queued).toHaveLength(1);
    expect(failed).toHaveLength(1);
    const injury = (await inboxItems(app, "100 Alfred Way")).find((item) => item.what === "Possible injury");
    expect(injury?.summary).toBe(`They texted: "she's not breathing". ${QUEUED_UNREACHED}`);
  });
});
