import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MessagingEndpoints } from "../src/messaging/endpoints";
import { toursUnavailableText } from "../src/sms/templates";
import { FileRuntimeStore } from "../src/storage/runtimeStore";
import { draftStartDisclosure, smsDisclosure, smsHelpBody, smsStopAck } from "../src/visitor/smsConsent";
import { hillsideConfig, liveApp, PHONE, type LiveApp } from "./liveApp";
import { LINE, PUBLIC } from "./fakeSendblue";

const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).forEach((fn) => fn()));

const PROPERTY = "prop_100_alfred_way";
const OTHER = "+15550102099";
const HELP = "+15550107777";
const CHECK_BACK = "Thanks for reaching out to 100 Alfred Way. Tours by text aren't available right now. Please check back soon.";
const CALL_TEAM = "Thanks for reaching out to 100 Alfred Way. Tours by text aren't available right now. You can call the property team at (555) 010-7777.";
const UNAVAILABLE = toursUnavailableText("100 Alfred Way", "property team");
const PASSED_ON = "I'll pass your question to the property team, and they'll reply here as soon as they can.";

function consentOf(app: LiveApp, phone: string) {
  return JSON.parse(readFileSync(join(app.root, "properties", PROPERTY, "sms-campaign-consent.json"), "utf8")).senders[phone];
}

function optedOutAt(app: LiveApp, phone: string): string | undefined {
  return JSON.parse(readFileSync(join(app.root, "properties", PROPERTY, "messaging-opt-outs.json"), "utf8"))[phone];
}

/** A second property on the same line, then removed, so the only open place is the draft. */
function shareLineWithOnlyThisDraft(app: LiveApp): void {
  const extra = hillsideConfig();
  const saved = app.ws.save({
    ...extra,
    property: { ...extra.property, id: "prop_200_scratch_way", name: "200 Scratch Way", address: "200 Scratch Way, Teaneck, NJ 07666" },
  });
  app.ws.patchState(saved.config.property.id, { removedAt: "2026-10-01T00:00:00.000Z" });
  new MessagingEndpoints(new FileRuntimeStore(join(app.root, "runtime"))).attach({
    address: LINE,
    provider: "sendblue",
    propertyId: saved.config.property.id,
  });
  app.ws.patchState(PROPERTY, { status: "DRAFT" });
}

describe("unpublished properties do not take a new visitor text", () => {
  it("a published property sends the campaign disclosure, and the same property back in draft refuses a new visitor", async () => {
    const app = await liveApp({ cleanups });
    expect(app.ws.load(PROPERTY).state.status).toBe("PUBLISHED_FOR_DEMO");

    const before = await app.text("TOUR");
    expect(before).toEqual([smsDisclosure(PUBLIC)]);
    expect(app.visitors.latestForPhone(PROPERTY, PHONE, "messaging")).toBeTruthy();

    app.ws.patchState(PROPERTY, { status: "DRAFT" });
    expect(app.ws.load(PROPERTY).state.readiness?.passed).toBe(true);
    const after = await app.textFrom(OTHER, "TOUR");
    expect(after).toEqual([UNAVAILABLE]);
    expect(app.visitors.latestForPhone(PROPERTY, OTHER, "messaging")).toBeUndefined();
  });

  it("keeps a tour that was booked before the property went back to draft", async () => {
    const app = await liveApp({ cleanups });
    await app.book();
    const booked = app.visitors.latestForPhone(PROPERTY, PHONE, "messaging");
    expect(booked).toBeTruthy();
    app.ws.patchState(PROPERTY, { status: "DRAFT" });
    const replies = await app.text("Is there a gym?");
    expect(replies).toEqual([PASSED_ON]);
    expect(app.visitors.latestForPhone(PROPERTY, PHONE, "messaging")?.id).toBe(booked!.id);
  });

  it("tells a new visitor to check back when no help number is saved", async () => {
    const app = await liveApp({ cleanups });
    expect(app.ws.load(PROPERTY).config.operator.visitorContact).toBeUndefined();
    app.ws.patchState(PROPERTY, { status: "DRAFT" });
    expect(await app.textFrom(OTHER, "TOUR")).toEqual([CHECK_BACK]);
    expect(CHECK_BACK).toBe(UNAVAILABLE);
  });

  it("gives a new visitor the saved help number", async () => {
    const app = await liveApp({ cleanups });
    const saved = app.ws.load(PROPERTY);
    app.ws.save({
      ...saved.config,
      operator: { ...saved.config.operator, visitorContact: HELP, visitorHelpDecided: true },
    });
    app.ws.patchState(PROPERTY, { status: "DRAFT" });
    expect(app.ws.load(PROPERTY).config.operator.visitorContact).toBe(HELP);
    expect(await app.textFrom("+15550102100", "TOUR")).toEqual([CALL_TEAM]);
    expect(CALL_TEAM).toBe(toursUnavailableText("100 Alfred Way", "property team", HELP));
  });

  it("STOP on a draft records the opt-out and sends the opt-out reply", async () => {
    const app = await liveApp({ cleanups });
    app.ws.patchState(PROPERTY, { status: "DRAFT" });
    const phone = "+15550102111";
    expect(await app.textFrom(phone, "STOP")).toEqual([smsStopAck()]);
    expect(consentOf(app, phone)).toMatchObject({ status: "opted_out", method: "keyword", keyword: "STOP" });
    expect(optedOutAt(app, phone)).toBeTruthy();
    expect(app.visitors.latestForPhone(PROPERTY, phone, "messaging")).toBeUndefined();
    expect(await app.textFrom(phone, "TOUR")).toEqual([]);
  });

  it("HELP on a draft sends the help line", async () => {
    const app = await liveApp({ cleanups });
    const saved = app.ws.load(PROPERTY);
    app.ws.save({ ...saved.config, operator: { ...saved.config.operator, visitorContact: HELP, visitorHelpDecided: true } });
    app.ws.patchState(PROPERTY, { status: "DRAFT" });
    const phone = "+15550102112";
    expect(await app.textFrom(phone, "HELP")).toEqual([smsHelpBody(process.env, { visitorContact: HELP })]);
    expect(app.visitors.latestForPhone(PROPERTY, phone, "messaging")).toBeUndefined();
    expect(await app.textFrom(phone, "TOUR")).toEqual([CALL_TEAM]);
  });

  it("START on a draft sends the disclosure and does not open a tour", async () => {
    const app = await liveApp({ cleanups });
    app.ws.patchState(PROPERTY, { status: "DRAFT" });
    const phone = "+15550102113";
    const start = await app.textFrom(phone, "START");
    expect(start).toEqual([draftStartDisclosure(PUBLIC)]);
    expect(start[0]).not.toContain("Reply YES to continue");
    expect(start[0]).toContain("Please check back soon. Reply HELP for help or STOP to opt out.");
    expect(() => consentOf(app, phone)).toThrow();
    expect(app.visitors.latestForPhone(PROPERTY, phone, "messaging")).toBeUndefined();
    expect(await app.textFrom(phone, "TOUR")).toEqual([CHECK_BACK]);
  });

  it("STOP on a shared line whose only open property is a draft records the opt-out", async () => {
    const app = await liveApp({ cleanups });
    shareLineWithOnlyThisDraft(app);
    const phone = "+15550102114";
    expect(await app.textFrom(phone, "STOP")).toEqual([smsStopAck()]);
    expect(consentOf(app, phone)).toMatchObject({ status: "opted_out", keyword: "STOP" });
    expect(optedOutAt(app, phone)).toBeTruthy();
    expect(app.visitors.latestForPhone(PROPERTY, phone, "messaging")).toBeUndefined();
    expect(await app.textFrom(phone, "TOUR")).toEqual([]);
  });

  it("HELP on a shared line whose only open property is a draft sends the help line", async () => {
    const app = await liveApp({ cleanups });
    shareLineWithOnlyThisDraft(app);
    const phone = "+15550102115";
    expect(await app.textFrom(phone, "HELP")).toEqual([smsHelpBody()]);
    expect(app.visitors.latestForPhone(PROPERTY, phone, "messaging")).toBeUndefined();
    expect(await app.textFrom(phone, "TOUR")).toEqual([CHECK_BACK]);
  });

  it("an injury on a draft single line and a shared line sends the 911 line and opens Possible injury", async () => {
    const sent = "If someone is hurt, call 911 now. I've also let the property team know, and they'll text you here as soon as they can.";
    for (const shared of [false, true]) {
      const app = await liveApp({ cleanups });
      if (shared) shareLineWithOnlyThisDraft(app);
      else app.ws.patchState(PROPERTY, { status: "DRAFT" });
      const phones = shared ? ["+15550104201", "+15550104202"] : ["+15550104101", "+15550104102"];
      for (const [index, phrase] of ["my dad passed out", "call 911"].entries()) {
        const phone = phones[index]!;
        const replies = await app.textFrom(phone, phrase);
        expect(replies, `${shared ? "shared" : "single"} ${phrase}`).toEqual([sent]);
        expect(replies.join("\n")).not.toContain("aren't available");
        const alerts = app.ws.listTours(PROPERTY).flatMap((record) => {
          const tour = app.ws.loadTour(PROPERTY, record.tourId);
          if (!tour?.bundle.auditEvents.some((event) => event.type === "HELP_REQUESTED" && event.code === phrase)) return [];
          return tour.bundle.messages.filter((message) => message.audience === "OPERATOR" && message.body.includes("asked for help"));
        });
        expect(alerts, phrase).toHaveLength(1);
        expect(app.visitors.latestForPhone(PROPERTY, phone, "messaging")).toBeUndefined();
        const inbox = await app.grok("get_inbox", { property: "100 Alfred Way" });
        const injury = (inbox.items as Array<{ what?: string; summary?: string }>).filter((item) => item.what === "Possible injury" && item.summary?.includes(`They texted: "${phrase}"`));
        expect(injury, phrase).toHaveLength(1);
        expect(injury[0]?.summary).toContain("They were told to call 911 if someone is hurt, and that you'd text them here.");
      }
      const hi = shared ? "+15550104299" : "+15550104199";
      expect(await app.textFrom(hi, "Hi")).toEqual([CHECK_BACK]);
    }
  });

  it("START on a shared line whose only open property is a draft sends the disclosure", async () => {
    const app = await liveApp({ cleanups });
    shareLineWithOnlyThisDraft(app);
    const phone = "+15550102116";
    const start = await app.textFrom(phone, "START");
    expect(start).toEqual([draftStartDisclosure(PUBLIC)]);
    expect(start[0]).not.toContain("Reply YES to continue");
    expect(() => consentOf(app, phone)).toThrow();
    expect(app.visitors.latestForPhone(PROPERTY, phone, "messaging")).toBeUndefined();
    expect(await app.textFrom(phone, "TOUR")).toEqual([CHECK_BACK]);
  });
});
