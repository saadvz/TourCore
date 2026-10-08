import { afterEach, describe, expect, it } from "vitest";
import { validateConfig } from "../src/config/tourCoreConfig";
import { resolveQuestion } from "../src/core/questions";
import { OPERATOR_MESSAGES } from "../src/install/status";
import { TEXTING_NOT_USED } from "../src/operator/setupFlow";
import { handleVisitorText } from "../src/visitor/conversation";
import { VisitorDemoSession } from "../src/visitor";
import { DemoMessagingAdapter } from "../src/messaging/Messenger";
import { at } from "./grokHarness";
import { installHarness, SB_KEY, SB_SECRET, type InstallHarness } from "./installHarness";

/**
 * Property identity (canonical address, optional operator-given name, a
 * property type that shapes setup) and real visitor texting that a new
 * property can't accidentally miss.
 */

const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).forEach((c) => c()));

const TUNNEL = "https://brave-otter-lamp.trycloudflare.com";
function harness(options: { texting?: boolean } = {}): InstallHarness {
  const h = installHarness({ env: { TOURCORE_DEPLOYMENT_MODE: "GROK_MANAGED_P0" } });
  cleanups.push(h.cleanup);
  const now = new Date(h.now()).toISOString();
  h.inst.files.ensure({ deploymentMode: "GROK_MANAGED_P0" });
  h.inst.files.setPublicBaseUrl(TUNNEL, "CLOUDFLARE_QUICK_TUNNEL");
  h.inst.files.recordCheck("publicEndpointCheck", { ok: true, at: now, message: "ok", url: TUNNEL });
  h.connectGrok();
  if (options.texting !== false) {
    h.inst.secrets.set({ SENDBLUE_API_API_KEY: SB_KEY, SENDBLUE_API_API_SECRET: SB_SECRET, SENDBLUE_FROM_NUMBER: "+15550109999" });
    h.inst.files.recordCheck("visitorMessaging", { ok: true, at: now, message: "ok", problems: [], publicBaseUrl: TUNNEL });
    h.inst.files.writeState({ ...h.inst.files.state(), storage: { mode: "LOCAL_DEMO", phase: "READY", chosenAt: now } });
  }
  return h;
}

/** The rest of an apartment building's setup, in the operator's words. */
async function finishHillside(h: InstallHarness) {
  await h.ok("add_unit", { name: "Unit 1A" });
  await h.ok("add_unit", { name: "Unit 2B" });
  await h.ok("set_unit_details", { details: "1A is 2 bed 1 bath for $2,300, available now. 2B is 1 bed 1 bath for $1,950, available now." });
  await h.ok("add_door", { name: "Front Door", kind: "entrance" });
  for (const unit of ["1A", "2B"]) await h.ok("set_route", { unit, doors: ["Front Door", `Unit ${unit} Door`] });
  await h.ok("set_tour_hours", { days: "weekdays", start: "9am", end: "5pm" });
  await h.ok("set_verification_policy", { level: "basic-form" });
}

function welcomeFor(h: InstallHarness, propertyId: string): Promise<string> {
  const sent: string[] = [];
  const session = new VisitorDemoSession(propertyId, h.workspace.load(propertyId).config, "t", { realNow: () => at(7), kind: "messaging", transport: new DemoMessagingAdapter((l) => sent.push(l), "MESSAGING") });
  return handleVisitorText(session, "+15550102000", "TOUR")
    .then(() => handleVisitorText(session, "+15550102000", "YES"))
    .then(() => session.conversation.filter((m) => m.from === "tourcore").map((m) => m.text).join("\n"));
}

describe("canonical property identity", () => {
  it("keeps the address as the identity, uses it with visitors, and never invents a friendly name", async () => {
    const h = harness();
    const created = await h.ok("create_property_setup", { address: "144 Hillside Ave, Teaneck, NJ" });
    expect(created.setup).toMatchObject({ name: "144 Hillside Avenue", address: "144 Hillside Avenue, Teaneck, NJ", propertyType: "Not chosen yet" });
    expect(created.setup.propertyName).toBeUndefined();
    const id = created.setup.propertyId as string;
    expect(h.workspace.openDraft(id).draft.property.displayName).toBeUndefined();

    await h.ok("update_property_details", { propertyType: "APARTMENT_BUILDING" });
    await finishHillside(h);
    const review = await h.ok("review_property_setup");
    expect(review.lines.slice(0, 3)).toEqual(["144 Hillside Avenue, Teaneck, NJ", "Apartment building", ""]);
    expect(review.lines.join("\n")).not.toMatch(/Called:/);
    expect(await welcomeFor(h, id)).toContain("Hi! Welcome to the self-guided tours at 144 Hillside Avenue, Teaneck, NJ.");
  });

  it("stores an operator-given name separately; visitors hear it, the address stays canonical, and it can be removed", async () => {
    const h = harness();
    const created = await h.ok("create_property_setup", { address: "144 Hillside Ave, Teaneck, NJ", name: "Hillside Apartments", propertyType: "APARTMENT_BUILDING" });
    const id = created.setup.propertyId as string;
    expect(h.workspace.openDraft(id).draft.property).toMatchObject({ address: "144 Hillside Avenue, Teaneck, NJ", displayName: "Hillside Apartments", name: "Hillside Apartments" });
    await finishHillside(h);
    expect((await h.ok("review_property_setup")).lines.slice(0, 3)).toEqual(["144 Hillside Avenue, Teaneck, NJ", "Called: Hillside Apartments", "Apartment building"]);
    const named = await welcomeFor(h, id);
    expect(named).toContain("Hillside Apartments");
    expect(named).toContain("144 Hillside Avenue, Teaneck, NJ");

    await h.ok("update_property_details", { name: "" });
    const property = h.workspace.load(id).config.property;
    expect(property).toMatchObject({ name: "144 Hillside Avenue, Teaneck, NJ", address: "144 Hillside Avenue, Teaneck, NJ" });
    expect(property.displayName).toBeUndefined();
  });
});

describe("property type", () => {
  it("asks for a missing ZIP, then confirms the address, before property type", async () => {
    const h = harness();
    const created = await h.ok("create_property_setup", { address: "144 Hillside Ave, Teaneck, NJ" });
    expect(created.nextQuestion).toBe("What ZIP code should I use?");
    expect(created.choices).toBeUndefined();
    const zipped = await h.ok("update_property_details", { postalCode: "07666" });
    expect(zipped.nextQuestion).toBe("I have:\n144 Hillside Avenue\nTeaneck, NJ 07666\nIs that the address?");
    const confirmed = await h.ok("update_property_details", { confirmAddress: true });
    expect(confirmed).toMatchObject({ nextQuestion: "What type of property is this?" });
    expect(confirmed.choices.map((c: { label: string }) => c.label)).toEqual([
      "Single-family home",
      "Multifamily (duplex / small building you own)",
      "Apartment or condo (one unit)",
    ]);
    const draft = h.workspace.openDraft(created.setup.propertyId).draft;
    expect(draft.property.propertyType).toBeUndefined();
    expect(draft.property.canonicalAddress).toMatchObject({ street: "144 Hillside Avenue", city: "Teaneck", state: "NJ", postalCode: "07666" });
    expect(draft.property.addressConfirmed).toBe(true);
    expect(validateConfig(draft).map((i) => i.code)).toContain("PROPERTY_TYPE_MISSING");
    expect(await h.fails("update_property_details", { propertyType: "CASTLE" })).toContain("doesn't fit update_property_details");
  });

  it("apartment buildings and multifamily homes ask for units, and a unit needs the operator's own name", async () => {
    const h = harness();
    await h.ok("create_property_setup", { address: "12 Elm St, Brooklyn, NY" });
    await h.ok("update_property_details", { postalCode: "11201" });
    await h.ok("update_property_details", { confirmAddress: true });
    expect((await h.ok("update_property_details", { propertyType: "MULTIFAMILY_HOME" })).nextQuestion).toBe("Which units can people tour?");
    expect(await h.fails("add_unit", {})).toContain("What's the unit called?");
    expect((await h.ok("add_unit", { name: "Unit 1A" })).unit).toMatchObject({ name: "Unit 1A", door: "Unit 1A Door" });
  });

  it("other properties ask how the spaces are named", async () => {
    const h = harness();
    await h.ok("create_property_setup", { address: "9 Mill Rd, Hudson, NY" });
    await h.ok("update_property_details", { postalCode: "12534" });
    await h.ok("update_property_details", { confirmAddress: true });
    expect((await h.ok("update_property_details", { propertyType: "OTHER" })).nextQuestion).toBe("How would you like the spaces people tour to be named?");
  });

  it("a single-family home has one space on its own front door, no fake unit number, and goes all the way to published", async () => {
    const h = harness();
    await h.ok("create_property_setup", { address: "27 Oak Ln, Teaneck, NJ" });
    await h.ok("update_property_details", { postalCode: "07666" });
    await h.ok("update_property_details", { confirmAddress: true });
    const typed = await h.ok("update_property_details", { propertyType: "SINGLE_FAMILY" });
    expect(typed).toMatchObject({ nextQuestion: 'People will tour the whole home. Should I call it "Main Home", or would you like another name?', suggestedName: "Main Home" });
    const added = await h.ok("add_unit", {});
    expect(added.unit).toMatchObject({ name: "Main Home", door: "Front Door", route: "Front Door" });
    expect(await h.fails("add_unit", { name: "Garage" })).toContain("A single-family home has one tourable space");
    await h.ok("set_unit_details", { units: [{ unit: "Main Home", bedrooms: "3", bathrooms: "2", monthlyRent: "$3,400", availability: "now" }] });
    await h.ok("set_tour_hours", { days: "weekdays", start: "9am", end: "5pm" });
    const id = "prop_27_oak_lane_teaneck_nj";
    expect(validateConfig(h.workspace.load(id).config)).toEqual([]);
    expect((await h.ok("review_property_setup")).lines).toEqual(expect.arrayContaining(["Single-family home", "27 Oak Lane", "  3 bed \u00b7 2 bath \u00b7 $3,400/month \u00b7 available now", "  Route: Front Door"]));
    expect((await h.ok("review_property_setup")).lines).not.toContain("Main Home");
    expect((await h.ok("run_readiness_check")).passed).toBe(true);
    expect((await h.ok("run_dry_tour")).passed).toBe(true);
    expect((await h.approve("publish_demo_property", {})).done.published).toBe(true);
    // Visitors aren't asked to pick from a one-item unit menu.
    const welcome = await welcomeFor(h, id);
    expect(welcome).toContain("Hi! Welcome to the self-guided tour for 27 Oak Lane, Teaneck, NJ 07666.");
    expect(welcome).toContain("questions about the home");
    expect(welcome).toContain("Which day works for you?");
    expect(welcome).not.toContain("Which unit");
    expect(welcome).not.toContain("Main Home");
    expect(welcome).not.toContain("Happy to set up");
    const config = h.workspace.load(id).config;
    const rent = resolveQuestion(config, "How much is the rent for this home?");
    expect(rent).toMatchObject({ kind: "answer", facts: [{ text: "27 Oak Lane rents for $3,400 a month." }] });
    expect(rent.kind === "answer" ? rent.facts.map((fact) => fact.text).join(" ") : "").not.toMatch(/Main Home|\bunit\b/i);
    const guidance = config.routes[0]!.stops.map((stop) => stop.guidance).join(" ");
    expect(guidance).toContain("Welcome to 27 Oak Lane");
    expect(guidance).not.toContain("Main Home");
  });
});

describe("real visitor texting can't be missed", () => {
  it("a new property uses the installed Sendblue number on its own; nobody is asked how to text people", async () => {
    const h = harness();
    await h.ok("create_property_setup", { address: "144 Hillside Ave, Teaneck, NJ", propertyType: "APARTMENT_BUILDING" });
    await finishHillside(h);
    expect(h.workspace.load("prop_144_hillside_avenue_teaneck_nj").config.messagingMode).toBe("live");
    const review = await h.ok("review_property_setup");
    expect(review.lines.slice(-4)).toEqual([
      "Visitor texting: Connected",
      "Door access: Demo",
      "Visitors can call: not set",
      "Settings: Basic identity form.",
    ]);
    expect(review.lines.join("\n")).not.toMatch(/https?:|trycloudflare|\/mcp|\+1555/);
    const services = await h.ok("get_services");
    expect(services.summary).toBe("Visitor texting is live. Door access is still in demo mode, so no physical locks will open.");
  });

  it("in a Grok-managed install, texting that's set up but not re-tested still isn't swapped for demo texting", async () => {
    const h = harness({ texting: false });
    h.inst.secrets.set({ SENDBLUE_API_API_KEY: SB_KEY, SENDBLUE_API_API_SECRET: SB_SECRET, SENDBLUE_FROM_NUMBER: "+15550109999" });
    await h.ok("create_property_setup", { address: "144 Hillside Ave, Teaneck, NJ", propertyType: "APARTMENT_BUILDING" });
    expect(h.workspace.openDraft("prop_144_hillside_avenue_teaneck_nj").draft.messagingMode).toBe("live");
    expect((await h.ok("get_services")).messaging).toMatchObject({ visitorTexting: "Not working yet" });
  });

  it("without real texting installed, a property is practice-only and says so plainly", async () => {
    const h = harness({ texting: false });
    await h.ok("create_property_setup", { address: "144 Hillside Ave, Teaneck, NJ", propertyType: "APARTMENT_BUILDING" });
    expect(h.workspace.openDraft("prop_144_hillside_avenue_teaneck_nj").draft.messagingMode).toBe("demo");
    expect((await h.ok("get_services")).summary).toBe("Visitor texts are practice only, so nobody is texted. Door access is still in demo mode, so no physical locks will open.");
  });

  it("publish refuses a property left on demo texting, says how Tour Core will fix it, and works once fixed", async () => {
    const h = harness();
    await h.ok("create_property_setup", { address: "144 Hillside Ave, Teaneck, NJ", propertyType: "APARTMENT_BUILDING" });
    await finishHillside(h);
    await h.ok("set_services", { messaging: "demo" });
    const status = await h.ok("get_next_installation_step");
    expect(status).toMatchObject({ component: "PROPERTY", action: "FINISH_PROPERTY_SETUP", performedBy: "GROK", tool: "set_services" });
    expect(status.operatorMessage).toBe("Visitor texting is connected, but this property isn't using it yet. I'm connecting the property to your touring number.");
    await h.ok("run_readiness_check");
    await h.ok("run_dry_tour");
    const refused = await h.ok("publish_demo_property", {});
    expect(refused).toMatchObject({ published: false, status: "blocked", summary: TEXTING_NOT_USED });
    expect(refused.remediation).toMatch(/set_services with messaging sendblue, then run_readiness_check and run_dry_tour/);
    expect(h.workspace.load("prop_144_hillside_avenue_teaneck_nj").state.status).toBe("DRAFT");

    await h.ok("set_services", { messaging: "sendblue" });
    await h.ok("run_readiness_check");
    await h.ok("run_dry_tour");
    const { done } = await h.approve("publish_demo_property", {});
    expect(done.summary).toBe(
      "144 Hillside Avenue, Teaneck, NJ is published for demo. Visitors can start a tour by texting your touring number. Visitor texting is live. Door access is still in demo mode, so no physical locks will open.",
    );
    expect(done.summary).not.toMatch(/everything (runs|is) in demo/i);
  });

  it("a property published on demo texting before Sendblue was connected never shows as live afterwards", async () => {
    const h = harness({ texting: false });
    await h.ok("create_property_setup", { address: "144 Hillside Ave, Teaneck, NJ", propertyType: "APARTMENT_BUILDING" });
    await finishHillside(h);
    await h.ok("skip_optional_setup", { component: "OPERATOR_ALERTS" });
    await h.ok("run_readiness_check");
    await h.ok("run_dry_tour");
    await h.approve("publish_demo_property", {});
    // Texting gets connected later.
    const now = new Date(h.now()).toISOString();
    h.inst.secrets.set({ SENDBLUE_API_API_KEY: SB_KEY, SENDBLUE_API_API_SECRET: SB_SECRET, SENDBLUE_FROM_NUMBER: "+15550109999" });
    h.inst.files.recordCheck("visitorMessaging", { ok: true, at: now, message: "ok", problems: [], publicBaseUrl: TUNNEL });
    h.inst.files.writeState({ ...h.inst.files.state(), storage: { mode: "LOCAL_DEMO", phase: "READY", chosenAt: now } });
    const s = await h.status();
    expect(s.phase).not.toBe("OPERATE");
    expect(s.nextStep).toMatchObject({ action: "FINISH_PROPERTY_SETUP", performedBy: "GROK", tool: "set_services" });
    expect(s.lines.join("\n")).not.toMatch(/Visitor texting: live/);
    expect(s.nextStep.action).not.toBe("DONE");
    expect(OPERATOR_MESSAGES.operate).toContain("Visitor texting is live. Door access is still in demo mode, so no physical locks will open.");
  });
});
