import { afterEach, describe, expect, it } from "vitest";
import { MessagingEndpoints } from "../src/messaging/endpoints";
import { LOCAL_TEST_TEXTING } from "../src/setup/setupActions";
import { inspectTourSummary, tourRef } from "../src/operator/tours";
import { STATUS_LABELS } from "../src/visitor/views";
import { grokHarness, type GrokHarness } from "./grokHarness";
import { installHarness, SB_KEY, SB_SECRET, type InstallHarness } from "./installHarness";

const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).forEach((fn) => fn()));

function app(): GrokHarness {
  const h = grokHarness();
  cleanups.push(h.cleanup);
  return h;
}

const TUNNEL = "https://brave-otter-lamp.trycloudflare.com";
function textingApp(): InstallHarness {
  const h = installHarness({ env: { TOURCORE_DEPLOYMENT_MODE: "GROK_MANAGED_P0" } });
  cleanups.push(h.cleanup);
  const now = new Date(h.now()).toISOString();
  h.inst.files.ensure({ deploymentMode: "GROK_MANAGED_P0" });
  h.inst.files.setPublicBaseUrl(TUNNEL, "CLOUDFLARE_QUICK_TUNNEL");
  h.inst.files.recordCheck("publicEndpointCheck", { ok: true, at: now, message: "ok", url: TUNNEL });
  h.connectGrok();
  h.inst.secrets.set({ SENDBLUE_API_API_KEY: SB_KEY, SENDBLUE_API_API_SECRET: SB_SECRET, SENDBLUE_FROM_NUMBER: "+15550109999" });
  h.inst.files.recordCheck("visitorMessaging", { ok: true, at: now, message: "ok", problems: [], publicBaseUrl: TUNNEL });
  h.services.endpoints = new MessagingEndpoints(h.runtime);
  h.services.messagingLine = () => "+15550109999";
  return h;
}

async function finishSingleFamily(h: InstallHarness, address: string, propertyType: "SINGLE_FAMILY" | "MULTIFAMILY_HOME" | "APARTMENT_OR_CONDO" = "SINGLE_FAMILY") {
  const created = await h.ok("create_property_setup", { address, propertyType });
  const id = created.setup.propertyId as string;
  if (propertyType === "SINGLE_FAMILY") await h.ok("add_unit", {});
  else if (propertyType === "MULTIFAMILY_HOME") await h.ok("add_unit", { name: "1A" });
  else {
    await h.ok("add_unit", { name: "4B" });
    await h.ok("update_property_details", { buildingAccess: "UNIT_ONLY" });
    await h.ok("update_property_details", { skipEntryInstructions: true });
  }
  const unit = propertyType === "SINGLE_FAMILY" ? "Main Home" : propertyType === "MULTIFAMILY_HOME" ? "1A" : "Unit 4B";
  await h.ok("set_unit_details", { units: [{ unit, bedrooms: "3", bathrooms: "2", monthlyRent: "$3,400", availability: "now" }] });
  await h.ok("set_tour_hours", { days: "weekdays", start: "9am", end: "5pm" });
  await h.ok("set_verification_policy", { level: "basic-form" });
  await h.ok("update_property_details", { skipVisitorHelp: true });
  return id;
}

describe("review_property_setup unit headings", () => {
  it("uses the street line for a single-family home, never Main Home", async () => {
    const h = app();
    await h.ok("create_property_setup", { address: "910 QA Gate Rd, Tenafly, NJ 07670", propertyType: "SINGLE_FAMILY" });
    await h.ok("add_unit", {});
    await h.ok("set_unit_details", { units: [{ unit: "Main Home", bedrooms: "3", bathrooms: "2", monthlyRent: "$3,400", availability: "now" }] });
    const review = await h.ok("review_property_setup");
    expect(review.lines).toContain("910 QA Gate Rd");
    expect(review.lines).not.toContain("Main Home");
    expect(h.workspace.openDraft(h.workspace.propertyIds()[0]!).draft.units[0]!.name).toBe("Main Home");
  });

  it("keeps stored names for multifamily and apartment or condo", async () => {
    const multi = app();
    await multi.ok("create_property_setup", { address: "144 Hillside Ave, Teaneck, NJ 07666", propertyType: "MULTIFAMILY_HOME" });
    await multi.ok("add_unit", { name: "1A" });
    expect((await multi.ok("review_property_setup")).lines).toContain("1A");

    const condo = app();
    await condo.ok("create_property_setup", { address: "145 Main St, Hoboken, NJ 07030", propertyType: "APARTMENT_OR_CONDO" });
    await condo.ok("add_unit", { name: "4B" });
    const lines = (await condo.ok("review_property_setup")).lines;
    expect(lines).toContain("Unit 4B");
    expect(lines).not.toContain("Main Home");
  });
});

describe("shared texting number names the other property by street", () => {
  it("readiness says the Critiquito line with the other home's street, never an id or Main Home", async () => {
    const h = textingApp();
    const scratch = await finishSingleFamily(h, "12 Scratch Lane, Teaneck, NJ 07666");
    const first = await h.ok("run_readiness_check", { property: scratch });
    expect(first.passed).toBe(true);
    expect(JSON.stringify(first)).not.toMatch(/prop_/);

    const gate = await finishSingleFamily(h, "910 QA Gate Rd, Tenafly, NJ 07670");
    const second = await h.ok("run_readiness_check", { property: gate });
    const messaging = (second.checks as Array<{ check: string; problems: string[] }>).find((c) =>
      c.problems.some((p) => p.includes("already used")),
    );
    expect(messaging?.problems).toEqual(["This texting number is already used for 12 Scratch Lane."]);
    expect(second.lines.join("\n")).toContain("This texting number is already used for 12 Scratch Lane.");
    expect(JSON.stringify(second)).not.toMatch(/prop_/);
    expect(JSON.stringify(second)).not.toContain("Main Home");
  });
});

describe("local test texting status", () => {
  it("get_services and set_services local pin the test-mode sentence, not live", async () => {
    const h = app();
    await h.ok("create_property_setup", { address: "12 Scratch Lane, Teaneck, NJ 07666", propertyType: "SINGLE_FAMILY" });
    const set = await h.ok("set_services", { messaging: "local" });
    expect(set.summary).toBe(LOCAL_TEST_TEXTING);
    expect(set.summary).toBe("Texting is in test mode, so texts don't reach real phones. Real visitors won't get anything until live texting is turned on.");
    expect(set.summary.match(/\blive\b/gi)).toEqual(["live"]);
    expect(set.summary).not.toMatch(/Sendblue|Twilio|Photon|outbox|loopback|provider/i);

    const got = await h.ok("get_services");
    expect(got.summary).toBe(LOCAL_TEST_TEXTING);
    expect(got.summary.match(/\blive\b/gi)).toEqual(["live"]);
    expect(got.summary).not.toMatch(/Sendblue|Twilio|Photon|outbox|loopback|provider/i);
  });
});

describe("inspect_tour summary does not repeat terminal status", () => {
  it("dedupes when the step is the same word as the status", () => {
    const who = { visitorName: "Pat Smith", unitName: "Unit 101" };
    expect(inspectTourSummary({ ...who, status: "Cancelled", currentStep: "Cancelled" })).toBe("Pat Smith, Unit 101: Cancelled.");
    expect(inspectTourSummary({ ...who, status: "Called off", currentStep: "Called off" })).toBe("Pat Smith, Unit 101: Called off.");
    expect(inspectTourSummary({ ...who, status: "Identity check didn't pass", currentStep: "Identity check didn't pass" })).toBe(
      "Pat Smith, Unit 101: Identity check didn't pass.",
    );
    expect(inspectTourSummary({ ...who, status: "Tour time ended", currentStep: "Tour time ended" })).toBe("Pat Smith, Unit 101: Tour time ended.");
    expect(inspectTourSummary({ ...who, status: "Finished", currentStep: "Left the property" })).toBe("Pat Smith, Unit 101: Finished. Left the property.");
    expect(inspectTourSummary({ ...who, status: "Touring", currentStep: "At Unit 101" })).toBe("Pat Smith, Unit 101: Touring. At Unit 101.");
    for (const status of ["COMPLETED", "CANCELLED", "VERIFICATION_FAILED", "EXPIRED", "REVOKED"] as const) {
      const label = STATUS_LABELS[status];
      const summary = inspectTourSummary({ ...who, status: label, currentStep: label });
      expect(summary).toBe(`Pat Smith, Unit 101: ${label}.`);
      expect(summary).not.toMatch(new RegExp(`${label}\\. ${label}\\.`));
    }
  });

  it("inspect_tour cancelled and completed summaries name the status once", async () => {
    const h = app();
    const id = await h.publish();
    const booked = await h.visitor(id, { name: "Alex Reed", phone: "(555) 010-2002" });
    await booked.act("chooseTime", { slotStart: booked.slot().toISOString() });
    await booked.act("consent", { agree: true });
    await booked.act("submitIdentity", { firstName: "Alex", lastName: "Reed", email: "alex@example.com", phone: "555-010-2002" });
    const asked = await h.ok("pause_tours", { property: id });
    await h.ok("pause_tours", { property: id, bookedTours: "cancel", confirmationCode: asked.confirmation.code });
    const cancelled = await h.ok("inspect_tour", { tourRef: tourRef(id, booked.session.tourId) });
    expect(cancelled.summary).toBe("Alex Reed, Unit 101: Cancelled.");
    expect(cancelled.summary).not.toMatch(/Cancelled\. Cancelled\./);

    const finished = app();
    const finishedId = await finished.publish();
    const v = await finished.touringVisitor(finishedId);
    await v.act("finish");
    const done = await finished.ok("inspect_tour", { tourRef: tourRef(finishedId, v.session.tourId) });
    expect(done.summary).toBe("Pat Smith, Unit 101: Finished. Left the property.");
    expect(done.summary).not.toMatch(/Finished\. Finished\./);
  });
});
