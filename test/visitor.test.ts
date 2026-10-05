import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig, type TourCoreConfig } from "../src/config/tourCoreConfig";
import { zonedTimeToUtc } from "../src/core/timezone";
import { PropertyWorkspace, tourDetailView } from "../src/setup";
import { liveTourView, VisitorDemoSession, visitorView } from "../src/visitor";

/** Monday 28 Sep 2026, 7:00 AM at the demo property; its tours are at 2:00 PM and 3:30 PM. */
const MONDAY_7AM = zonedTimeToUtc({ year: 2026, month: 9, day: 28, hour: 7, minute: 0 }, "America/New_York").getTime();

function demoConfig(): TourCoreConfig {
  const config = loadConfig();
  return {
    ...config,
    property: { ...config.property, facts: ["Street parking only."] },
    units: config.units.map((u) => (u.id === "apt_101" ? { ...u, facts: ["Heat and hot water are included."] } : u)),
  };
}

function newSession() {
  return new VisitorDemoSession("prop_100_alfred_way", demoConfig(), "test_visitor", { realNow: () => MONDAY_7AM });
}

const lastFromTourCore = (s: VisitorDemoSession) => [...s.conversation].reverse().find((m) => m.from === "tourcore")!.text;

/** The first open day, then its first time. */
async function chooseFirstTime(s: VisitorDemoSession) {
  const day = (await visitorView(s)).choices[0]!;
  await s.act(day.action, day.input);
  const slot = (await visitorView(s)).choices[0]!;
  await s.act(slot.action, slot.input);
}

/** Runs the visitor through booking and verification for Unit 101 at the first tour time. */
async function bookedAndReady() {
  const s = newSession();
  await s.act("begin", { name: "Pat Smith", phone: "(555) 010-2000" });
  await s.act("chooseUnit", { unitId: "apt_101" });
  await chooseFirstTime(s);
  await s.act("consent", { agree: true });
  await s.act("submitIdentity", { firstName: "Pat", lastName: "Smith", email: "pat@example.com", phone: "555-010-2000" });
  return s;
}

async function touring() {
  const s = await bookedAndReady();
  await s.act("demoSkipAhead", {});
  await s.act("arrive", {});
  return s;
}

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((r) => rmSync(r, { recursive: true, force: true })));

describe("visitor demo on the real engine", () => {
  it("starts with a welcome and the tourable units", async () => {
    const s = newSession();
    expect((await visitorView(s)).input.kind).toBe("intro");
    await s.act("begin", { name: "Pat Smith", phone: "(555) 010-2000" });
    const v = await visitorView(s);
    expect(v.thread[0]!.text).toContain("Hi! Welcome to the self-guided tours at 100 Alfred Way.");
    expect(v.choices.map((c) => c.label)).toEqual(["Unit 101", "Unit 102"]);
  });

  it("inquiry: replies with the unit's approved description and open times", async () => {
    const s = newSession();
    await s.act("begin", { name: "Pat Smith", phone: "(555) 010-2000" });
    await s.act("chooseUnit", { unitId: "apt_101" });
    expect(await s.stage()).toBe("choose-date");
    expect(lastFromTourCore(s)).toContain("Here's what the property team shared: Two-bedroom, first floor, south-facing.");
    expect(lastFromTourCore(s)).toContain("Which day works for you?");
    const days = await visitorView(s);
    expect(days.choices.map((c) => c.label).slice(0, 2)).toEqual(["Monday, Sep 28", "Tuesday, Sep 29"]);
    await s.act(days.choices[0]!.action, days.choices[0]!.input);
    expect(await s.stage()).toBe("choose-time");
    const v = await visitorView(s);
    expect(v.choices.map((c) => c.label)).toEqual(["Monday, Sep 28 \u00b7 2:00 PM", "Monday, Sep 28 \u00b7 3:30 PM"]);
  });

  it("booking, consent and the basic identity form go through the engine", async () => {
    const s = newSession();
    await s.act("begin", { name: "Pat Smith", phone: "(555) 010-2000" });
    await s.act("chooseUnit", { unitId: "apt_101" });
    await chooseFirstTime(s);
    expect(await s.stage()).toBe("consent");
    expect(lastFromTourCore(s)).toContain("Is it OK if I text you about this tour");

    await s.act("consent", { agree: true });
    const form = await visitorView(s);
    expect(form.input).toMatchObject({ kind: "identity", prefill: { firstName: "Pat", lastName: "Smith" } });

    await s.act("submitIdentity", { firstName: "Pat", lastName: "Smith", email: "pat@example.com", phone: "555-010-2000" });
    expect(await s.stage()).toBe("ready");
    expect(lastFromTourCore(s)).toContain("You're all set for your tour on Monday, Sep 28 at 2:00 PM");
    const verification = (await s.store.list("verifications"))[0]!;
    expect(verification).toMatchObject({ method: "basic-form", status: "PASSED", claimed: { email: "pat@example.com" } });
  });

  it("a form with a different phone number fails verification", async () => {
    const s = newSession();
    await s.act("begin", { name: "Pat Smith", phone: "(555) 010-2000" });
    await s.act("chooseUnit", { unitId: "apt_101" });
    await chooseFirstTime(s);
    await s.act("consent", { agree: true });
    await s.act("submitIdentity", { firstName: "Pat", lastName: "Smith", email: "pat@example.com", phone: "555-999-0000" });
    expect(await s.stage()).toBe("stopped");
    expect(lastFromTourCore(s)).toBe(
      "I can't open doors for this tour yet. The leasing team is reviewing your details and will text you here. Stay where you are and reply here. The leasing team usually replies within 15 minutes.",
    );
    expect(lastFromTourCore(s)).not.toContain(s.config.operator.contact);
  });

  it("early arrival is denied by the real policy, without contacting Durin", async () => {
    const s = await bookedAndReady();
    await s.act("arrive", {});
    expect(await s.stage()).toBe("ready");
    expect(lastFromTourCore(s)).toBe("You're a little early! I can open the doors from 1:50 PM.");
    expect(s.lastAccess).toMatchObject({ allowed: false, code: "DENY_TOO_EARLY", durinCalled: false });
    expect(s.durin.requestCount).toBe(0);
    expect((await visitorView(s)).demoControls.map((c) => c.action)).toContain("demoSkipAhead");
  });

  it("valid arrival opens the entrance through Durin and guides to the unit", async () => {
    const s = await touring();
    expect(await s.stage()).toBe("touring");
    expect(s.lastAccess).toMatchObject({ allowed: true, code: "ALLOW", durinCalled: true });
    expect(s.durin.requestCount).toBe(1);
    expect(lastFromTourCore(s)).toContain("Entrance is open for you now.");
    expect((await visitorView(s)).choices[0]).toMatchObject({ label: "I'm at Unit 101", action: "atStop", input: { doorId: "unit_101" } });
  });

  it("the next door on the route opens", async () => {
    const s = await touring();
    await s.act("atStop", { doorId: "unit_101" });
    expect(s.lastAccess).toMatchObject({ doorId: "unit_101", allowed: true, durinCalled: true });
    expect(lastFromTourCore(s)).toContain("Welcome to Unit 101!");
    expect(await s.remainingStops()).toEqual([]);
    expect((await visitorView(s)).choices[0]).toMatchObject({ label: "Finish tour", tone: "primary" });
  });

  it("a door outside the route is denied before Durin is contacted", async () => {
    const s = await touring();
    const before = s.durin.requestCount;
    await s.act("demoWrongDoor", {});
    expect(s.lastAccess).toMatchObject({ doorId: "unit_102", allowed: false, code: "DENY_WRONG_ROUTE", durinCalled: false });
    expect(s.durin.requestCount).toBe(before);
    expect(s.conversation.at(-2)!.text).toContain("That door isn't part of your tour");
    expect(s.conversation.at(-1)).toMatchObject({ from: "demo", text: "Demo safety check: Tour Core refused this door and never contacted Durin." });

    const live = await liveTourView(s);
    expect(live.recent.map((e) => e.text)).toContain("Access to Unit 102 Door was denied because it was not part of Pat's tour.");
  });

  it("answers from approved facts only", async () => {
    const s = await touring();
    await s.act("ask", { question: "How many bedrooms is this?" });
    expect(lastFromTourCore(s)).toBe("Unit 101 has 2 bedrooms.");
    await s.act("ask", { question: "Does this unit have parking?" });
    expect(lastFromTourCore(s)).toBe("Here's what the property team shared: Street parking only.");
    await s.act("ask", { question: "What's included?" });
    expect(lastFromTourCore(s)).toContain("Heat and hot water are included.");
    expect((await s.store.listAudit()).filter((e) => e.type === "QUESTION_ANSWERED")).toHaveLength(3);
  });

  it("says so, and flags it, when there is no approved answer", async () => {
    const s = await touring();
    await s.act("ask", { question: "Is there a gym?" });
    expect(lastFromTourCore(s)).toBe("I don't have that information for this property. I've flagged it for the property team so they can get back to you.");
    expect((await s.store.listAudit()).some((e) => e.type === "QUESTION_UNANSWERED" && e.detail === "Is there a gym?")).toBe(true);
    const live = await liveTourView(s);
    expect(live.questions.map((q) => q.text)).toContain('Pat asked "Is there a gym?". There was no approved answer, so it was flagged for your team.');
  });

  it("finishing the tour locks up and asks the follow-up question, and the answer is recorded", async () => {
    const s = await touring();
    await s.act("atStop", { doorId: "unit_101" });
    await s.act("finish", {});
    expect(await s.stage()).toBe("follow-up");
    expect(lastFromTourCore(s)).toContain("Would you like someone from the property team to follow up?");
    expect((await s.core.listGrants(s.reservationId!)).every((g) => g.status === "REVOKED")).toBe(true);

    await s.act("followUp", { wantsContact: true });
    expect(await s.stage()).toBe("done");
    expect((await s.store.listAudit()).find((e) => e.type === "FOLLOW_UP_RESPONSE")?.detail).toBe("yes");
    expect((await liveTourView(s)).followUp).toBe("Wants someone to follow up");
    await expect(s.act("followUp", { wantsContact: false })).rejects.toThrow("That isn't available right now.");
  });

  it("refuses actions that don't fit the current step", async () => {
    const s = await bookedAndReady();
    await expect(s.act("finish", {})).rejects.toThrow("That isn't available right now.");
    await expect(s.act("teleport", {})).rejects.toThrow("That isn't something I can do.");
  });
});

describe("operator live view", () => {
  it("shows who is touring, where they are and recent activity in plain words", async () => {
    const s = await touring();
    const live = await liveTourView(s);
    expect(live).toMatchObject({
      active: true,
      visitorName: "Pat Smith",
      unitName: "Unit 101",
      tourTime: "Monday, Sep 28, 2:00 PM\u20132:45 PM",
      status: "Touring",
      currentStep: "At the entrance, next: Unit 101",
    });
    const recent = live.recent.map((e) => e.text).join("\n");
    expect(recent).toContain("Entrance access was approved for Pat.");
    expect(recent).not.toMatch(/[A-Z]{3,}_[A-Z_]+/);
  });
});

describe("visitor message history", () => {
  it("is saved with the demo records and can be reopened later", async () => {
    const root = mkdtempSync(join(tmpdir(), "tourcore-visitor-"));
    roots.push(root);
    const ws = new PropertyWorkspace(root);
    const config = demoConfig();
    ws.save(config);

    const s = await touring();
    await s.act("ask", { question: "Is there a gym?" });
    const { record, bundle } = await s.record();
    ws.recordVisitorDemo(config.property.id, record, bundle);

    const reopened = new PropertyWorkspace(root);
    const [listed] = reopened.listTours(config.property.id);
    expect(listed).toMatchObject({ kind: "visitor-demo", visitorName: "Pat Smith", outcome: "in-progress" });
    const tour = reopened.loadTour(config.property.id, listed!.tourId)!;
    const view = tourDetailView(tour.record, tour.bundle, config);
    const texts = view.conversation.map((m) => `${m.from}: ${m.text}`);
    expect(texts).toContain("visitor: I'd like to see Unit 101.");
    expect(texts).toContain("visitor: Is there a gym?");
    expect(texts.some((t) => t.startsWith("tourcore: Entrance is open for you now."))).toBe(true);
    expect(texts.some((t) => t.startsWith("demo: Demo: the clock skipped ahead"))).toBe(true);
    expect(view.accessDecisions.map((e) => e.text)).toContain("Entrance access was approved for Pat.");
  });
});
