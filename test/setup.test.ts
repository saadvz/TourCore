import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { zonedTimeToUtc } from "../src/core/timezone";
import {
  addDoor,
  addUnit,
  createPropertySetup,
  parseDays,
  parseMinutes,
  parseTimeOfDay,
  PropertyWorkspace,
  publishDemoProperty,
  removeDoor,
  renameUnit,
  resolveTimeZone,
  reviewSetup,
  runDryTour,
  runReadinessCheck,
  OperatorTeamCopy,
  setAlertContact,
  setPropertyDetails,
  setRoute,
  setTourHours,
  setUnitProfile,
  setVerificationPolicy,
  SetupInputError,
  validateConfig,
  visitorHelpQuestion,
  VISITOR_HELP_NUMBER_QUESTION,
  VISITOR_HELP_QUESTION,
  type DryTourResult,
  type SetupDraft,
} from "../src/setup";

/** Monday 28 Sep 2026, 7:00 AM at the property. */
const MONDAY_MORNING = zonedTimeToUtc({ year: 2026, month: 9, day: 28, hour: 7, minute: 0 }, "America/New_York");

function buildProperty() {
  let draft = createPropertySetup({ address: "100 Alfred Way, Brooklyn, NY", name: "100 Alfred Way", propertyType: "APARTMENT_BUILDING" });
  const entrance = addDoor(draft, { name: "Lobby Entrance", kind: "ENTRANCE" });
  draft = entrance.draft;
  const u101 = addUnit(draft, { name: "Unit 101" });
  draft = u101.draft;
  const u102 = addUnit(draft, { name: "Unit 102" });
  draft = u102.draft;
  const d101 = addDoor(draft, { name: "Unit 101 Door", kind: "UNIT", unitId: u101.unit.id });
  draft = d101.draft;
  const d102 = addDoor(draft, { name: "Unit 102 Door", kind: "UNIT", unitId: u102.unit.id });
  draft = d102.draft;
  draft = setRoute(draft, u101.unit.id, [entrance.door.id, d101.door.id], { directions: "straight ahead, first door on the left" });
  draft = setRoute(draft, u102.unit.id, [entrance.door.id, d102.door.id]);
  draft = setUnitProfile(draft, u101.unit.id, { bedrooms: "2", bathrooms: "1", monthlyRent: "$2,300", availability: "now" });
  draft = setUnitProfile(draft, u102.unit.id, { bedrooms: "1", bathrooms: "1", monthlyRent: "don't list the price", availability: "not sure" });
  return {
    draft,
    ids: { entrance: entrance.door.id, u101: u101.unit.id, u102: u102.unit.id, d101: d101.door.id, d102: d102.door.id },
  };
}

const codes = (draft: SetupDraft) => validateConfig(draft).map((i) => i.code);

const roots: string[] = [];
function tempWorkspace(): PropertyWorkspace {
  const root = mkdtempSync(join(tmpdir(), "tourcore-test-"));
  roots.push(root);
  return new PropertyWorkspace(root);
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("guided setup actions", () => {
  it("builds a valid property and a readable review", () => {
    const { draft } = buildProperty();
    expect(validateConfig(draft)).toEqual([]);
    expect(draft.property.timezone).toBe("America/New_York");

    const review = reviewSetup(draft);
    expect(review.canSave).toBe(true);
    const section = (title: string) => review.sections.find((s) => s.title === title)?.lines;
    expect(section("PROPERTY")).toEqual(["100 Alfred Way, Brooklyn, NY", "Called: 100 Alfred Way", "Apartment building"]);
    expect(section("TOUR HOURS")?.slice(0, 2)).toEqual(["Monday-Friday", "9:00 AM-5:00 PM"]);
    expect(section("UNITS")).toEqual(["Unit 101", "Unit 102"]);
    expect(section("ROUTE: UNIT 101")).toEqual(["Lobby Entrance", "Unit 101 Door"]);
    expect(section("ROUTE: UNIT 102")).toEqual(["Lobby Entrance", "Unit 102 Door"]);
    expect(section("VERIFICATION")?.[0]).toBe("Basic identity form");
    expect(section("ALERTS")).toEqual([
      "If a visitor needs help: property team",
      "Visitors can call: not set",
    ]);
  });

  it("sets an optional visitor help number separately from the operator alert line", () => {
    const { draft } = buildProperty();
    expect(draft.operator.contact).toBe("Shown on screen (demo)");
    expect(draft.operator.visitorContact).toBeUndefined();

    const withNumber = setAlertContact(draft, { visitorContact: "(555) 010-8888" });
    expect(withNumber.operator.visitorContact).toBe("+15550108888");
    expect(withNumber.operator.contact).toBe("Shown on screen (demo)");
    expect(withNumber.operator.visitorHelpDecided).toBe(true);
    expect(reviewSetup(withNumber).sections.find((s) => s.title === "ALERTS")?.lines).toEqual([
      "If a visitor needs help: property team",
      "Visitors can call: (555) 010-8888",
    ]);

    const cleared = setAlertContact(withNumber, { visitorContact: "" });
    expect(cleared.operator.visitorContact).toBeUndefined();
    expect(cleared.operator.contact).toBe("Shown on screen (demo)");
    expect(cleared.operator.visitorHelpDecided).toBe(true);
    expect(() => setAlertContact(draft, { visitorContact: "123" })).toThrow(new SetupInputError("PHONE_INVALID", "Please enter a full phone number."));

    const bad = { ...draft, operator: { ...draft.operator, visitorContact: "not-a-phone" } };
    expect(validateConfig(bad).map((i) => i.code)).toContain("VISITOR_CONTACT_INVALID");
    expect(validateConfig(withNumber)).toEqual([]);
  });

  it("asks for a team name that reads naturally after \"the\"", () => {
    expect(OperatorTeamCopy.hint()).toBe(
      'Use a team name that reads naturally after "the", for example leasing team or Maple Leasing team.',
    );
    expect(OperatorTeamCopy.cliPrompt()).toBe(
      'Who should we alert if a visitor needs help? Use a team name that reads naturally after "the", for example leasing team or Maple Leasing team.',
    );
  });

  it("records an explicit skip of the optional visitor help number", () => {
    const { draft } = buildProperty();
    expect(draft.operator.visitorHelpDecided).toBeUndefined();

    const skipped = setAlertContact(draft, { skipVisitorHelp: true });
    expect(skipped.operator.visitorContact).toBeUndefined();
    expect(skipped.operator.visitorHelpDecided).toBe(true);
    expect(reviewSetup(skipped).sections.find((s) => s.title === "ALERTS")?.lines).toEqual([
      "If a visitor needs help: property team",
      "Visitors can call: not set",
    ]);

    expect(VISITOR_HELP_NUMBER_QUESTION).toBe("What number can stuck visitors call? Pick one someone answers during tour hours.");
    expect(VISITOR_HELP_QUESTION).toBe(VISITOR_HELP_NUMBER_QUESTION);
    expect(visitorHelpQuestion(draft)).toEqual({ nextQuestion: VISITOR_HELP_QUESTION });
    expect(visitorHelpQuestion(skipped)).toBeUndefined();
    expect(visitorHelpQuestion(createPropertySetup({ address: "100 Alfred Way, Brooklyn, NY", propertyType: "APARTMENT_BUILDING" }))).toBeUndefined();

    const cli = readFileSync(new URL("../src/cli/setup.ts", import.meta.url), "utf8");
    const web = readFileSync(new URL("../src/web/public/app.js", import.meta.url), "utf8");
    expect(cli).toContain("VISITOR_HELP_NUMBER_QUESTION");
    expect(cli).not.toMatch(/supportEmail|VISITOR_HELP_EMAIL|What email should visitors/);
    expect(web).toContain(VISITOR_HELP_NUMBER_QUESTION);
    expect(web).not.toMatch(/supportEmail|What email should visitors/);
  });

  it("keeps policy values in config with visible defaults", () => {
    const { draft } = buildProperty();
    expect(draft.tourHours).toMatchObject({ tourLengthMinutes: 45, earlyArrivalMinutes: 10, slotEveryMinutes: 60 });
    expect(draft.verificationValidForDays).toBe(30);
    const changed = setVerificationPolicy(setTourHours(draft, { earlyArrivalMinutes: 5 }), { reuseForDays: 14 });
    expect(changed.tourHours.earlyArrivalMinutes).toBe(5);
    expect(changed.verificationValidForDays).toBe(14);
  });

  it("rejects an invalid timezone in plain language", () => {
    const { draft } = buildProperty();
    expect(() => setPropertyDetails(draft, { timezone: "Mars/Olympus" })).toThrow(SetupInputError);
    const bad = { ...draft, property: { ...draft.property, timezone: "Mars/Olympus" } };
    const issue = validateConfig(bad).find((i) => i.code === "TIMEZONE_INVALID");
    expect(issue?.message).toContain("We don't recognize the time zone");
    expect(resolveTimeZone("Eastern")).toBe("America/New_York");
    expect(resolveTimeZone("america/los_angeles")).toBe("America/Los_Angeles");
  });

  it("flags a unit with no route", () => {
    let { draft } = buildProperty();
    const u103 = addUnit(draft, { name: "Unit 103" });
    draft = addDoor(u103.draft, { name: "Unit 103 Door", kind: "UNIT", unitId: u103.unit.id }).draft;
    const issue = validateConfig(draft).find((i) => i.code === "UNIT_ROUTE_MISSING");
    expect(issue?.message).toBe("Unit 103 does not have a complete route.");
    expect(reviewSetup(draft).canSave).toBe(false);
  });

  it("flags a route that refers to a missing door", () => {
    const { draft, ids } = buildProperty();
    const issue = validateConfig(removeDoor(draft, ids.d101)).find((i) => i.code === "ROUTE_DOOR_MISSING");
    expect(issue?.message).toBe("Unit 101's route refers to a door that no longer exists.");
  });

  it("requires routes to start at an entrance and not pass through another unit", () => {
    const { draft, ids } = buildProperty();
    expect(codes(setRoute(draft, ids.u101, [ids.d101]))).toContain("ROUTE_START_NOT_ENTRANCE");
    expect(codes(setRoute(draft, ids.u101, [ids.entrance, ids.d102, ids.d101]))).toContain("ROUTE_THROUGH_OTHER_UNIT");
  });

  it("makes duplicate ids impossible", () => {
    const { draft } = buildProperty();
    expect(() => addDoor(draft, { name: "lobby entrance", kind: "ENTRANCE" })).toThrow(/already a door/);
    expect(() => addUnit(draft, { name: "Unit 101" })).toThrow(/already a unit/);
    const similar = addDoor(draft, { name: "Lobby-Entrance!", kind: "ENTRANCE" });
    expect(similar.door.id).not.toBe(draft.doors[0]!.id);
    const hacked = { ...draft, doors: [...draft.doors, { ...draft.doors[0]! }] };
    expect(codes(hacked)).toContain("DUPLICATE_DOOR_ID");
  });

  it("rejects incoherent tour hours and access windows", () => {
    const { draft } = buildProperty();
    const overnight = { ...draft, tourHours: { ...draft.tourHours, start: "17:00", end: "09:00" } };
    expect(codes(overnight)).toContain("TOUR_HOURS_BACKWARDS");
    expect(() => setTourHours(draft, { start: "17:00", end: "09:00" })).toThrow(/end later the same day/);
    expect(codes(setTourHours(draft, { slotEveryMinutes: 30 }))).toContain("ACCESS_WINDOWS_OVERLAP");
    expect(codes(setTourHours(draft, { days: [] }))).toContain("TOUR_DAYS_MISSING");
    expect(codes(setTourHours(draft, { earlyArrivalMinutes: 90 }))).toContain("EARLY_ARRIVAL_INVALID");
  });

  it("understands everyday answers", () => {
    expect(parseDays("Mon-Fri")).toEqual(["MON", "TUE", "WED", "THU", "FRI"]);
    expect(parseDays("weekends")).toEqual(["SAT", "SUN"]);
    expect(parseDays("Mon, Wed and Sat")).toEqual(["MON", "WED", "SAT"]);
    expect(parseDays("Sat Sun Mon")).toEqual(["MON", "SAT", "SUN"]);
    expect(parseDays("sat to mon")).toEqual(["MON", "SAT", "SUN"]);
    expect(parseDays("someday")).toBeUndefined();
    expect(parseTimeOfDay("9am")).toBe("09:00");
    expect(parseTimeOfDay("5")).toBe("17:00");
    expect(parseTimeOfDay("12:30 pm")).toBe("12:30");
    expect(parseMinutes("1 hour")).toBe(60);
    expect(parseMinutes("45 min")).toBe(45);
  });
});

describe("readiness check", () => {
  it("passes every check for a complete property", async () => {
    const previous = process.env.TOURCORE_PUBLIC_CONTACT_EMAIL;
    delete process.env.TOURCORE_PUBLIC_CONTACT_EMAIL;
    const result = await runReadinessCheck(buildProperty().draft, { now: MONDAY_MORNING });
    if (previous === undefined) delete process.env.TOURCORE_PUBLIC_CONTACT_EMAIL;
    else process.env.TOURCORE_PUBLIC_CONTACT_EMAIL = previous;
    expect(result.passed).toBe(true);
    expect(result.checks.map((c) => c.label)).toEqual([
      "Property details",
      "Unit information",
      "Tour hours",
      "Unit routes",
      "Verification",
      "Messaging",
      "Records",
      "Door access",
      "Audit/export",
    ]);
    expect(result.advisories).toEqual(["No visitor help number is set, so stuck visitors can only text back."]);
  });

  it("does not fail readiness when visitor help is missing, and drops the advisory once a number is set", async () => {
    const { draft } = buildProperty();
    const missing = await runReadinessCheck(draft, { now: MONDAY_MORNING });
    expect(missing.passed).toBe(true);
    expect(missing.advisories).toEqual(["No visitor help number is set, so stuck visitors can only text back."]);
    const withNumber = await runReadinessCheck(setAlertContact(draft, { visitorContact: "(555) 010-8888" }), { now: MONDAY_MORNING });
    expect(withNumber.passed).toBe(true);
    expect(withNumber.advisories).toEqual([]);
  });

  it("fails with a clear reason when a unit has no route", async () => {
    let { draft } = buildProperty();
    draft = { ...draft, routes: draft.routes.slice(0, 1) };
    const result = await runReadinessCheck(draft, { now: MONDAY_MORNING });
    expect(result.passed).toBe(false);
    const routes = result.checks.find((c) => c.id === "routes")!;
    expect(routes.ok).toBe(false);
    expect(routes.problems).toContain("Unit 102 does not have a complete route.");
    expect(result.checks.find((c) => c.id === "property")!.ok).toBe(true);
  });

  it("fails when a chosen option isn't available yet", async () => {
    const draft = setVerificationPolicy(buildProperty().draft, { mode: "document-check" });
    const verification = (await runReadinessCheck(draft, { now: MONDAY_MORNING })).checks.find((c) => c.id === "verification")!;
    expect(verification.ok).toBe(false);
    expect(verification.problems[0]).toMatch(/Full ID checks aren't available yet/);
  });
});

describe("practice tour", () => {
  it("runs the whole journey on the operator's own setup", async () => {
    const result = await runDryTour(buildProperty().draft, { now: MONDAY_MORNING });
    expect(result.failure).toBeUndefined();
    expect(result.passed).toBe(true);
    const types = result.audit.map((e) => e.type);
    for (const t of ["INQUIRY_STARTED", "RESERVATION_CREATED", "CONSENT_RECORDED", "VERIFICATION_COMPLETED", "TOUR_STARTED", "TOUR_COMPLETED", "FOLLOW_UP_SENT"] as const) {
      expect(types).toContain(t);
    }
    expect(result.bundle?.schemaVersion).toBe(1);
  });

  it("proves an off-route door is denied before Durin is called", async () => {
    const { draft, ids } = buildProperty();
    const result = await runDryTour(draft, { unitId: ids.u101, now: MONDAY_MORNING });
    const safety = result.checks.find((c) => c.id === "wrong_door");
    expect(safety).toMatchObject({ ok: true, group: "safety", outcome: "turned away before any door was unlocked" });
    const denied = result.audit.find((e) => e.type === "ACCESS_DENIED" && e.doorId === ids.d102);
    expect(denied?.code).toBe("DENY_WRONG_ROUTE");
    expect(result.bundle!.accessGrants.some((g) => g.doorId === ids.d102)).toBe(false);
  });

  it("works with practice verification and a single unit", async () => {
    let draft = createPropertySetup({ address: "5 Elm St, Austin, TX", propertyType: "MULTIFAMILY_HOME" });
    const e = addDoor(draft, { name: "Front Door", kind: "ENTRANCE" });
    const u = addUnit(e.draft, { name: "Loft" });
    const d = addDoor(u.draft, { name: "Loft Door", kind: "UNIT", unitId: u.unit.id });
    draft = setVerificationPolicy(setRoute(d.draft, u.unit.id, [e.door.id, d.door.id]), { mode: "mock" });
    expect(draft.property.timezone).toBe("America/Chicago");
    const result = await runDryTour(draft, { now: MONDAY_MORNING });
    expect(result.passed).toBe(true);
  });
});

describe("saving and publishing for demo", () => {
  const passedDryTour = (): DryTourResult => ({ passed: true, ranAt: MONDAY_MORNING.toISOString(), checks: [], audit: [] });

  it("blocks publish before the readiness check", async () => {
    const ws = tempWorkspace();
    const { config } = ws.save(buildProperty().draft);
    const result = await publishDemoProperty(ws, config.property.id, MONDAY_MORNING);
    expect(result.published).toBe(false);
    if (!result.published) expect(result.blockers.map((b) => b.code)).toEqual(["READINESS_NOT_RUN", "DRY_TOUR_NOT_RUN"]);
  });

  it("blocks publish until a practice tour passes, then publishes for demo only", async () => {
    const ws = tempWorkspace();
    const { config } = ws.save(buildProperty().draft);
    const id = config.property.id;
    ws.recordReadiness(id, await runReadinessCheck(config, { now: MONDAY_MORNING }));

    let result = await ws.publishDemoProperty(id, MONDAY_MORNING);
    expect(!result.published && result.blockers.map((b) => b.code)).toEqual(["DRY_TOUR_NOT_RUN"]);

    ws.recordDryTour(id, { ...passedDryTour(), passed: false, failure: "stopped" });
    result = await ws.publishDemoProperty(id, MONDAY_MORNING);
    expect(!result.published && result.blockers.map((b) => b.code)).toEqual(["DRY_TOUR_FAILED"]);

    ws.recordDryTour(id, await runDryTour(config, { now: MONDAY_MORNING }));
    result = await ws.publishDemoProperty(id, MONDAY_MORNING);
    expect(result.published).toBe(true);
    expect(ws.load(id).state.status).toBe("PUBLISHED_FOR_DEMO");
    expect(ws.latestPracticeTour(id)?.bundle.auditEvents.length).toBeGreaterThan(0);
  });

  it("sends an edited property back to draft and requires fresh checks", async () => {
    const ws = tempWorkspace();
    const { config } = ws.save(buildProperty().draft);
    const id = config.property.id;
    ws.recordReadiness(id, await runReadinessCheck(config, { now: MONDAY_MORNING }));
    ws.recordDryTour(id, passedDryTour());
    expect((await ws.publishDemoProperty(id, MONDAY_MORNING)).published).toBe(true);

    ws.save(setTourHours(config, { end: "18:00" }));
    expect(ws.load(id).state.status).toBe("DRAFT");
    const result = await ws.publishDemoProperty(id, MONDAY_MORNING);
    expect(!result.published && result.blockers.map((b) => b.code)).toEqual(["READINESS_OUT_OF_DATE", "DRY_TOUR_OUT_OF_DATE"]);
  });

  it("reloads and edits an existing property with stable ids", () => {
    const ws = tempWorkspace();
    const { draft, ids } = buildProperty();
    ws.save(draft);

    const reloaded = new PropertyWorkspace(ws.root).load(draft.property.id);
    expect(reloaded.config).toEqual(draft);

    ws.save(renameUnit(reloaded.config, ids.u101, "Unit 101A"));
    const edited = new PropertyWorkspace(ws.root).load(draft.property.id).config;
    expect(edited.units.find((u) => u.id === ids.u101)?.name).toBe("Unit 101A");
    expect(edited.property.id).toBe(draft.property.id);
    expect(edited.routes.find((r) => r.unitId === ids.u101)?.stops[0]?.guidance).toContain("Unit 101A");
    expect(ws.list()).toHaveLength(1);
  });

  it("refuses to save an invalid setup", () => {
    const ws = tempWorkspace();
    const { draft } = buildProperty();
    expect(() => ws.save({ ...draft, routes: [] })).toThrow(/need attention/);
    expect(ws.list()).toHaveLength(0);
  });
});
