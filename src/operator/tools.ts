import { z } from "zod";
import type { Installation } from "../install/installation";
import { secretValues } from "../install/settings";
import { INSTALLATION_TOOLS } from "../install/tools";
import { validateConfig } from "../config/tourCoreConfig";
import { TourCoreError } from "../core/TourCore";
import { InvalidTransitionError } from "../domain/stateMachine";
import { checkMessaging, UnavailableModeError } from "../createTourCore";
import { applySetupCommand } from "../setup/commands";
import { draftView, readinessView, saveStateView } from "../setup/presenters";
import { parseDays, parseMinutes, parseTimeOfDay } from "../setup/parse";
import type { DryTourCheck, DryTourResult } from "../setup/dryTour";
import type { ReadinessResult } from "../setup/readiness";
import { createPropertySetup, SetupInputError, type SetupDraft } from "../setup/setupActions";
import { statusLabel } from "../setup/workspace";
import { exportAudit, parseLocalDate } from "./auditExport";
import type { ConfirmationBook } from "./confirmations";
import {
  answerFlaggedQuestion,
  cleanFact,
  clearHold,
  describeChangeTarget,
  findException,
  inspectException,
  listExceptions,
  placeHold,
  resolveException,
  revokeTour,
  visitorAnswerText,
  type OperatorException,
} from "./exceptions";
import { matchDoor, requireUnit, resolvePropertyId } from "./resolve";
import type { OperatorServices } from "./services";
import { readinessForProperty, runPracticeTour } from "./setupFlow";
import { findTour, inspectTourView, listActiveTours } from "./tours";

/**
 * Tour Core's operator tool contract: a narrow, provider-neutral list of
 * typed actions any agent host (Grok Bot today) can call. Every tool
 * validates its input and calls the same setup, tour and exception actions
 * the browser uses. There is deliberately no tool that opens a door, mints
 * access or edits records directly: door access is only ever requested by a
 * visitor's own tour, through Tour Core's policy, to Durin.
 *
 * Results are plain language. Fields ending in "Id" or "Ref" are handles to
 * pass back to later tools; operators never need to see them.
 */

export interface ToolContext {
  services: OperatorServices;
  confirmations: ConfirmationBook;
  now: () => Date;
  /** Where the operator can open Tour Core on this computer (for export downloads and secure setup). */
  localUrl?: () => string | undefined;
  /** This installation (manifest, provider settings, alerts), for the installation tools. */
  installation?: Installation;
  /** Visitor messaging settings changed: drop any cached connection so the next message uses them. */
  resetMessaging?: () => void;
}

export type ToolKind = "read" | "change" | "consequential";

export interface OperatorTool {
  name: string;
  title: string;
  description: string;
  kind: ToolKind;
  input: z.ZodObject;
  run: (ctx: ToolContext, input: never) => Promise<Record<string, unknown>>;
}

function tool<S extends z.ZodObject>(def: {
  name: string;
  title: string;
  description: string;
  kind: ToolKind;
  input: S;
  run: (ctx: ToolContext, input: z.infer<S>) => Promise<Record<string, unknown>>;
}): OperatorTool {
  return def as unknown as OperatorTool;
}

// ------------------------------------------------------------------ inputs

const Property = z.string().max(200).optional().describe("Which property: its name, address or propertyId. Leave out when there's only one.");
const Unit = z.string().min(1).max(100).describe('The unit, e.g. "Unit 101" or "101".');
const TourRef = z.string().min(3).max(200).describe("The tourRef from list_active_tours or an exception. Never show it to the operator.");
const ExceptionId = z.string().min(3).max(60).describe("The exceptionId from list_exceptions. Never show it to the operator.");
const Code = z.string().max(20).optional().describe("Only after the operator explicitly said yes to the exact question this tool returned earlier.");
const Facts = z.array(z.string().max(300)).max(30);
const Duration = z.union([z.number().int(), z.string().max(40)]);

// ----------------------------------------------------------------- helpers

function openDraft(ctx: ToolContext, property: string | undefined): { id: string; draft: SetupDraft } {
  const id = resolvePropertyId(ctx.services.workspace, property);
  return { id, draft: ctx.services.workspace.openDraft(id).draft };
}

/** Runs one setup edit through the same command table the browser uses, then saves (or keeps a draft). */
function edit(ctx: ToolContext, id: string, draft: SetupDraft, command: string, input: unknown) {
  const next = applySetupCommand(draft, command, input);
  ctx.services.workspace.persistEdit(next, ctx.now());
  return setupState(ctx, id);
}

function setupState(ctx: ToolContext, id: string) {
  const ws = ctx.services.workspace;
  const { draft, unsavedChanges } = ws.openDraft(id);
  const problems = validateConfig(draft).map((i) => i.message);
  return {
    saved: saveStateView(draft, unsavedChanges).label,
    status: ws.has(id) ? statusLabel(ws.load(id)) : "Setup in progress",
    problems,
  };
}

function setupSnapshot(ctx: ToolContext, id: string) {
  const { draft } = ctx.services.workspace.openDraft(id);
  const view = draftView(draft);
  return {
    propertyId: id,
    name: view.property.name,
    address: view.property.address,
    timezone: `${view.property.timezoneLabel} (${view.property.timezone})`,
    propertyFacts: view.property.facts,
    units: view.units.map((u) => ({
      unitId: u.id,
      name: u.name,
      description: u.summary || undefined,
      facts: u.facts,
      door: u.door?.name,
      route: u.route ? u.route.doorNames.join(" \u2192 ") : undefined,
      directions: u.route?.directions || undefined,
    })),
    doors: view.doors.map((d) => ({ doorId: d.id, name: d.name, kind: d.kindLabel, ...(d.unitName ? { forUnit: d.unitName } : {}) })),
    tourHours: view.tourHours.summary ?? `${view.tourHours.daysLabel}, ${view.tourHours.hoursLabel}`,
    tourLength: view.tourHours.lengthLabel,
    newTourEvery: view.tourHours.spacingLabel,
    earlyArrival: view.tourHours.earlyLabel,
    verification: view.reviewCards.find((c) => c.step === "verification")?.rows ?? [],
    recordsAndMessages: view.services.items.map((s) => s.title),
    alertsGoTo: view.operator.name,
    ...setupState(ctx, id),
  };
}

const MESSAGING_CHOICES = [
  { choice: "sendblue", label: "Real texts to visitors' phones (Sendblue)", recommended: true },
  { choice: "demo", label: "Practice only: texts show on screen, nobody is texted", recommended: false },
] as const;

const RECORDS_CHOICES = [
  { choice: "this-computer", label: "On this computer", available: true },
  { choice: "google-drive", label: "A folder in your Google Drive", available: false, note: "Coming next; not available yet." },
] as const;

function readinessOut(result: ReadinessResult, savedChanges: boolean) {
  const view = readinessView(result);
  return {
    passed: result.passed,
    summary: view.headline,
    checks: view.checks.map((c) => ({ check: c.label, ok: c.ok, problems: c.problems.map((p) => p.message) })),
    lines: view.checks.map((c) => (c.ok ? `\u2713 ${c.label}` : `\u2717 ${c.label}: ${c.problems.map((p) => p.message).join(" ")}`)),
    savedChanges,
  };
}

const PROOF: Record<string, (c: DryTourCheck) => string | undefined> = {
  inquiry: () => undefined,
  reserved: () => "Booking worked",
  consent: () => "Consent to texts and tour records was recorded",
  identity: (c) => (c.label.includes("skipped") ? "Verification was skipped (practice verification)" : "Verification worked"),
  ready: () => undefined,
  early_arrival: () => "Early arrival was denied",
  entrance: () => "Entrance access was allowed at the right time",
  duplicate: () => "A repeated request didn't create a second access grant",
  wrong_door: (c) => `${c.label.replace(/^Visitor tries /, "")} (not on the route) was denied before Durin was contacted`,
  completed: () => "Tour completed",
  revoked: () => "Every door was locked again afterwards",
  follow_up: () => "Follow-up worked",
  records: () => "Tour records were saved",
};

function proofPoints(result: DryTourResult): string[] {
  return result.checks.flatMap((c) => {
    if (!c.ok) return [`\u2717 ${c.label}${c.detail ? `: ${c.detail}` : ""}`];
    const text = (PROOF[c.id] ?? ((x: DryTourCheck) => (x.id === "unit_door" ? `${x.label.replace(/^Visitor enters /, "")} access was allowed` : x.label)))(c);
    return text ? [`\u2713 ${text}`] : [];
  });
}

function exceptionLine(x: OperatorException) {
  return {
    exceptionId: x.exceptionId,
    tourRef: x.tourRef,
    property: x.property,
    visitorName: x.visitorName,
    unitName: x.unitName,
    what: x.title,
    summary: x.summary,
    tourStatus: x.tourStatus,
    accessBlocked: x.accessBlocked,
    when: x.when,
    status: x.status,
    ...(x.resolution ? { resolution: x.resolution.note, ...(x.resolution.approvedFact ? { approvedFact: x.resolution.approvedFact } : {}) } : {}),
  };
}

function needsConfirmation(ctx: ToolContext, action: string, target: string, fingerprint: string, question: string, details: Record<string, unknown> = {}) {
  const request = ctx.confirmations.issue(action, target, fingerprint, question);
  return {
    status: "needs-confirmation",
    summary: question,
    confirmation: request,
    instructions: "Ask the operator exactly this question. Call this tool again with confirmationCode only if they clearly say yes.",
    ...details,
  };
}

const reservationFingerprint = (r: { id: string; status: string; updatedAt: string }) => `${r.id}|${r.status}|${r.updatedAt}`;

function parseHours(input: { days?: string | string[]; start?: string; end?: string; tourLength?: string | number; newTourEvery?: string | number; earlyArrival?: string | number }) {
  const out: Record<string, unknown> = {};
  if (input.days !== undefined) {
    const text = Array.isArray(input.days) ? input.days.join(", ") : input.days;
    const days = parseDays(text);
    if (!days) throw new SetupInputError("TOUR_DAYS_UNREADABLE", `I didn't understand the days "${text}". Try "weekdays", "every day" or "Mon-Sat".`);
    out.days = days;
  }
  for (const key of ["start", "end"] as const) {
    if (input[key] === undefined) continue;
    const t = parseTimeOfDay(input[key]!);
    if (!t) throw new SetupInputError("TOUR_TIME_UNREADABLE", `I didn't understand the time "${input[key]}". Try something like "9am" or "5:30 PM".`);
    out[key] = t;
  }
  const minutes = (v: string | number | undefined, label: string) => {
    if (v === undefined) return undefined;
    const n = typeof v === "number" ? v : parseMinutes(v);
    if (n === undefined) throw new SetupInputError("TOUR_MINUTES_UNREADABLE", `I didn't understand ${label} "${v}". Try "45 minutes" or "an hour".`);
    return n;
  };
  const length = minutes(input.tourLength, "the tour length");
  const spacing = minutes(input.newTourEvery, "how often tours start");
  const early = minutes(input.earlyArrival, "the early-arrival time");
  if (length !== undefined) out.tourLengthMinutes = length;
  if (spacing !== undefined) out.slotEveryMinutes = spacing;
  if (early !== undefined) out.earlyArrivalMinutes = early;
  return out;
}

// ------------------------------------------------------------------- tools

export const OPERATOR_TOOLS: OperatorTool[] = [
  // ---------------------------------------------------- setup: property
  tool({
    name: "list_properties",
    title: "List properties",
    kind: "read",
    description: "Every property set up in Tour Core, with its status. Use first when the operator hasn't said which property.",
    input: z.strictObject({}),
    run: async (ctx) => {
      const ws = ctx.services.workspace;
      const properties = ws.propertyIds().map((id) => {
        const { draft } = ws.openDraft(id);
        return { propertyId: id, name: draft.property.name, address: draft.property.address, status: ws.has(id) ? statusLabel(ws.load(id)) : "Setup in progress" };
      });
      return { summary: properties.length ? `${properties.length} ${properties.length === 1 ? "property" : "properties"}.` : "No properties are set up yet.", properties };
    },
  }),
  tool({
    name: "get_property_setup",
    title: "Get property setup",
    kind: "read",
    description: "The property's current setup: address, units, doors, routes, tour hours, verification, messaging, and any problems. Read-only.",
    input: z.strictObject({ property: Property }),
    run: async (ctx, i) => {
      const id = resolvePropertyId(ctx.services.workspace, i.property);
      const setup = setupSnapshot(ctx, id);
      return { summary: `${setup.name}: ${setup.status}.`, setup };
    },
  }),
  tool({
    name: "create_property_setup",
    title: "Start a property setup",
    kind: "change",
    description:
      "Starts a new property from its address (and optional name). The time zone is guessed from the address: always confirm it with the operator. If a property with that address already exists, it's returned instead of creating a second one.",
    input: z.strictObject({
      address: z.string().min(1).max(200).describe("The property's street address, as the operator said it."),
      name: z.string().max(120).optional().describe("A friendly name. Defaults to the address."),
      timezone: z.string().max(60).optional().describe('Only if the operator said it, e.g. "Eastern" or "America/Chicago".'),
    }),
    run: async (ctx, i) => {
      const ws = ctx.services.workspace;
      const existing = ws.propertyIds().find((id) => ws.openDraft(id).draft.property.address.trim().toLowerCase() === i.address.trim().toLowerCase());
      if (existing) return { status: "already-exists", summary: `${i.address} is already set up. I'll keep working on that one.`, setup: setupSnapshot(ctx, existing) };
      const draft = createPropertySetup({ address: i.address, name: i.name, timezone: i.timezone, existingPropertyIds: ws.propertyIds() });
      ws.saveDraft(draft);
      const view = draftView(draft);
      return {
        status: "created",
        summary: `Started ${draft.property.name}. I guessed ${view.property.timezoneLabel} for the time zone; please confirm.`,
        timezoneGuess: view.property.timezoneLabel,
        setup: setupSnapshot(ctx, draft.property.id),
      };
    },
  }),
  tool({
    name: "update_property_details",
    title: "Update property details",
    kind: "change",
    description:
      "Changes the property's name, address, time zone, approved property facts (replaces the whole list), or who gets alerts. Facts must be the operator's own words; never write facts yourself.",
    input: z.strictObject({
      property: Property,
      name: z.string().max(120).optional(),
      address: z.string().max(200).optional(),
      timezone: z.string().max(60).optional(),
      facts: Facts.optional().describe("The full list of approved property facts, in the operator's words."),
      alertName: z.string().max(120).optional().describe("Who should hear about problems, e.g. \"Leasing team\"."),
      alertContact: z.string().max(200).optional(),
    }),
    run: async (ctx, i) => {
      const { id, draft } = openDraft(ctx, i.property);
      let next = applySetupCommand(draft, "setPropertyDetails", { name: i.name, address: i.address, timezone: i.timezone, facts: i.facts });
      if (i.alertName !== undefined || i.alertContact !== undefined) next = applySetupCommand(next, "setAlertContact", { name: i.alertName, contact: i.alertContact });
      ctx.services.workspace.persistEdit(next, ctx.now());
      const setup = setupSnapshot(ctx, id);
      return { summary: `Updated ${setup.name}. ${setup.saved}.`, setup };
    },
  }),

  // ------------------------------------------------ setup: units, doors
  tool({
    name: "list_units",
    title: "List units",
    kind: "read",
    description: "The tourable units with their description, approved facts, own door and route.",
    input: z.strictObject({ property: Property }),
    run: async (ctx, i) => {
      const id = resolvePropertyId(ctx.services.workspace, i.property);
      const { units } = setupSnapshot(ctx, id);
      return { summary: units.length ? units.map((u) => u.name).join(", ") : "No units yet.", units };
    },
  }),
  tool({
    name: "add_unit",
    title: "Add a unit",
    kind: "change",
    description: 'Adds one tourable unit. Its own door is added with it (named "<unit> Door" unless the operator names it). Description and facts must be the operator\'s words.',
    input: z.strictObject({
      property: Property,
      name: z.string().min(1).max(100),
      description: z.string().max(300).optional(),
      facts: Facts.optional(),
      doorName: z.string().max(100).optional(),
    }),
    run: async (ctx, i) => {
      const { id, draft } = openDraft(ctx, i.property);
      const state = edit(ctx, id, draft, "addUnit", { name: i.name, summary: i.description, facts: i.facts, doorName: i.doorName });
      const setup = setupSnapshot(ctx, id);
      const unit = setup.units.find((u) => u.name.toLowerCase() === i.name.trim().toLowerCase());
      return { summary: `Added ${unit?.name} with ${unit?.door}.`, unit, ...state };
    },
  }),
  tool({
    name: "update_unit",
    title: "Update a unit",
    kind: "change",
    description: "Renames a unit or changes its description or approved facts (facts replace the whole list). Only the operator's words.",
    input: z.strictObject({
      property: Property,
      unit: Unit,
      newName: z.string().max(100).optional(),
      alsoRenameDoor: z.boolean().optional().describe("Rename the unit's door to match, if it still has the suggested name."),
      description: z.string().max(300).optional(),
      facts: Facts.optional(),
    }),
    run: async (ctx, i) => {
      const { id, draft } = openDraft(ctx, i.property);
      const unit = requireUnit(draft, i.unit);
      let next = draft;
      if (i.description !== undefined || i.facts !== undefined) next = applySetupCommand(next, "setUnitDetails", { unitId: unit.id, summary: i.description, facts: i.facts });
      if (i.newName !== undefined) next = applySetupCommand(next, "renameUnit", { unitId: unit.id, name: i.newName, alsoRenameDoor: i.alsoRenameDoor });
      ctx.services.workspace.persistEdit(next, ctx.now());
      const setup = setupSnapshot(ctx, id);
      return { summary: `Updated ${i.newName ?? unit.name}.`, unit: setup.units.find((u) => u.unitId === unit.id), ...setupState(ctx, id) };
    },
  }),
  tool({
    name: "list_doors",
    title: "List doors",
    kind: "read",
    description: "Every door on file: entrances, unit doors and hallway doors. Use this to map routes; never assume a door exists.",
    input: z.strictObject({ property: Property }),
    run: async (ctx, i) => {
      const id = resolvePropertyId(ctx.services.workspace, i.property);
      const { doors } = setupSnapshot(ctx, id);
      return { summary: doors.length ? doors.map((d) => d.name).join(", ") : "No doors yet.", doors };
    },
  }),
  tool({
    name: "add_door",
    title: "Add a door",
    kind: "change",
    description: "Adds an entrance or a hallway/shared door the operator described. Unit doors come with add_unit. Only add doors the operator actually named.",
    input: z.strictObject({
      property: Property,
      name: z.string().min(1).max(100),
      kind: z.enum(["entrance", "hallway"]).describe("entrance = a way into the building; hallway = an inside or shared door on the way to a unit."),
    }),
    run: async (ctx, i) => {
      const { id, draft } = openDraft(ctx, i.property);
      const state = edit(ctx, id, draft, "addDoor", { name: i.name, kind: i.kind === "entrance" ? "ENTRANCE" : "COMMON" });
      return { summary: `Added ${i.name.trim()}.`, ...state };
    },
  }),

  // --------------------------------------------------------- routes
  tool({
    name: "get_route",
    title: "Get a unit's route",
    kind: "read",
    description: "The doors a visitor to this unit passes through, in order, plus a suggested route when none is saved.",
    input: z.strictObject({ property: Property, unit: Unit }),
    run: async (ctx, i) => {
      const { id, draft } = openDraft(ctx, i.property);
      const unit = requireUnit(draft, i.unit);
      const view = draftView(draft).units.find((u) => u.id === unit.id)!;
      const name = (d: string) => draft.doors.find((x) => x.id === d)?.name ?? "a door that no longer exists";
      return {
        summary: view.route ? `${unit.name}: ${view.route.doorNames.join(" \u2192 ")}` : `${unit.name} doesn't have a route yet.`,
        unit: unit.name,
        route: view.route?.doorNames,
        directions: view.route?.directions || undefined,
        suggested: view.route ? undefined : view.suggestedRoute.map(name),
        problems: view.issues.map((p) => p.message),
        propertyId: id,
      };
    },
  }),
  tool({
    name: "preview_route",
    title: "Preview a route",
    kind: "read",
    description:
      "Works out which doors on file the operator meant, in order, WITHOUT saving. Use before set_route and show the operator the result. Unknown doors are never created; ambiguous ones come back as a question.",
    input: z.strictObject({
      property: Property,
      unit: Unit,
      doors: z.array(z.string().min(1).max(100)).min(1).max(12).describe('Doors in walking order, in the operator\'s words, e.g. ["lobby entrance", "unit door"].'),
    }),
    run: async (ctx, i) => {
      const { draft } = openDraft(ctx, i.property);
      const unit = requireUnit(draft, i.unit);
      const resolved: string[] = [];
      const questions: string[] = [];
      const unknown: string[] = [];
      for (const ref of i.doors) {
        const m = matchDoor(draft, ref, unit);
        if (m.kind === "exact" || m.kind === "inferred") resolved.push(m.item.name);
        else if (m.kind === "ambiguous") questions.push(`"${ref}" could be ${m.candidates.map((d) => d.name).join(" or ")}. Which one?`);
        else unknown.push(ref);
      }
      const known = draft.doors.map((d) => d.name);
      if (unknown.length) {
        return {
          status: "unknown-doors",
          summary: `I don't have ${unknown.map((u) => `"${u}"`).join(" or ")} on file. The doors are ${known.join(", ") || "none yet"}. Should I add a new door, or did you mean one of these?`,
          knownDoors: known,
        };
      }
      if (questions.length) return { status: "needs-clarification", summary: questions.join(" "), questions };
      const ids = resolved.map((n) => draft.doors.find((d) => d.name === n)!.id);
      const check = applySetupCommand(draft, "setRoute", { unitId: unit.id, doorIds: ids });
      const problems = validateConfig(check).filter((p) => p.section === "routes" && p.unitId === unit.id).map((p) => p.message);
      return {
        status: problems.length ? "has-problems" : "ok",
        summary: `I have: ${resolved.join(" \u2192 ")}.${problems.length ? ` But: ${problems.join(" ")}` : " Is that right?"}`,
        unit: unit.name,
        route: resolved,
        problems,
      };
    },
  }),
  tool({
    name: "set_route",
    title: "Save a unit's route",
    kind: "change",
    description:
      "Saves the doors for one unit in walking order. Door names must match doors on file exactly (use preview_route first and pass its names). Invalid routes are refused, never saved.",
    input: z.strictObject({
      property: Property,
      unit: Unit,
      doors: z.array(z.string().min(1).max(100)).min(1).max(12).describe("Exact door names from preview_route or list_doors, in walking order."),
      directions: z.string().max(300).optional().describe("The operator's own directions from the entrance to the unit."),
    }),
    run: async (ctx, i) => {
      const { id, draft } = openDraft(ctx, i.property);
      const unit = requireUnit(draft, i.unit);
      const doors = i.doors.map((ref) => {
        const m = matchDoor(draft, ref);
        if (m.kind === "exact") return m.item;
        const hint =
          m.kind === "inferred"
            ? ` Did you mean ${m.item.name}?`
            : m.kind === "ambiguous"
              ? ` It could be ${m.candidates.map((d) => d.name).join(" or ")}.`
              : ` The doors are ${draft.doors.map((d) => d.name).join(", ") || "none yet"}.`;
        throw new SetupInputError("ROUTE_DOOR_UNKNOWN", `"${ref}" isn't a door on file.${hint} Nothing was saved.`);
      });
      const state = edit(ctx, id, draft, "setRoute", { unitId: unit.id, doorIds: doors.map((d) => d.id), directions: i.directions, onlyIfValid: true });
      return { summary: `Saved ${unit.name}: ${doors.map((d) => d.name).join(" \u2192 ")}.`, ...state };
    },
  }),

  // --------------------------------------------------- hours, policy
  tool({
    name: "get_tour_hours",
    title: "Get tour hours",
    kind: "read",
    description: "When people can tour: days, hours, tour length, how often tours start, and how early visitors can get in.",
    input: z.strictObject({ property: Property }),
    run: async (ctx, i) => {
      const id = resolvePropertyId(ctx.services.workspace, i.property);
      const s = setupSnapshot(ctx, id);
      return { summary: s.tourHours, tourHours: s.tourHours, tourLength: s.tourLength, newTourEvery: s.newTourEvery, earlyArrival: s.earlyArrival };
    },
  }),
  tool({
    name: "set_tour_hours",
    title: "Set tour hours",
    kind: "change",
    description:
      'Sets tour hours from everyday words: days ("weekdays", "Mon-Sat"), start/end ("9am", "5 PM"), tour length, how often a new tour starts, early arrival ("10 minutes"). Only pass what the operator said; defaults stay visible.',
    input: z.strictObject({
      property: Property,
      days: z.union([z.string().max(80), z.array(z.string().max(20)).max(7)]).optional(),
      start: z.string().max(20).optional(),
      end: z.string().max(20).optional(),
      tourLength: Duration.optional(),
      newTourEvery: Duration.optional(),
      earlyArrival: Duration.optional(),
    }),
    run: async (ctx, i) => {
      const { id, draft } = openDraft(ctx, i.property);
      const state = edit(ctx, id, draft, "setTourHours", parseHours(i));
      const s = setupSnapshot(ctx, id);
      return { summary: s.tourHours, tourLength: s.tourLength, newTourEvery: s.newTourEvery, earlyArrival: s.earlyArrival, ...state };
    },
  }),
  tool({
    name: "get_verification_policy",
    title: "Get visitor verification",
    kind: "read",
    description: "How visitors confirm who they are before any door opens, and how long a check can be reused.",
    input: z.strictObject({ property: Property }),
    run: async (ctx, i) => {
      const { draft } = openDraft(ctx, i.property);
      const view = draftView(draft);
      return {
        summary: view.reviewCards.find((c) => c.step === "verification")!.rows.join(". "),
        current: draft.verificationMode === "mock" ? "practice" : draft.verificationMode,
        reuseForDays: draft.verificationValidForDays,
        choices: [
          { choice: "basic-form", label: "Basic identity form (free)", recommended: true, explanation: view.verification.options[0]!.explanation },
          { choice: "practice", label: "Practice verification", recommended: false, explanation: view.verification.options[1]!.explanation },
          { choice: "document-check", label: "Full ID check", available: false, explanation: "Not available yet." },
        ],
      };
    },
  }),
  tool({
    name: "set_verification_policy",
    title: "Set visitor verification",
    kind: "change",
    description: "Chooses how visitors confirm who they are: the basic identity form (recommended) or practice verification. Optionally how many days a check can be reused.",
    input: z.strictObject({ property: Property, level: z.enum(["basic-form", "practice"]).optional(), reuseForDays: z.number().int().optional() }),
    run: async (ctx, i) => {
      const { id, draft } = openDraft(ctx, i.property);
      const state = edit(ctx, id, draft, "setVerificationPolicy", { mode: i.level === "practice" ? "mock" : i.level, reuseForDays: i.reuseForDays });
      return { summary: setupSnapshot(ctx, id).verification.join(". "), ...state };
    },
  }),
  tool({
    name: "get_services",
    title: "Get messaging and records",
    kind: "read",
    description: "How visitors are texted, whether that's connected, where tour records are kept, and door access mode. Never contains credentials.",
    input: z.strictObject({ property: Property }),
    run: async (ctx, i) => {
      const { id, draft } = openDraft(ctx, i.property);
      const checks = await checkMessaging(draft).catch(() => [{ label: "Visitor messaging", ok: false, message: "Couldn't check visitor messaging right now." }]);
      const line = ctx.services.endpoints?.forProperty(id)?.address;
      return {
        summary: setupSnapshot(ctx, id).recordsAndMessages.join(". "),
        messaging: {
          current: draft.messagingMode,
          connected: checks.every((c) => c.ok),
          checks: checks.map((c) => ({ check: c.label, ok: c.ok, message: c.message })),
          ...(line ? { textingNumber: line } : {}),
          choices: MESSAGING_CHOICES,
        },
        records: { current: "this-computer", choices: RECORDS_CHOICES },
        doorAccess: "Durin demo mode: no real doors open. Tour Core asks Durin only after its own checks pass.",
        alertsGoTo: draft.operator.name,
      };
    },
  }),
  tool({
    name: "set_services",
    title: "Set messaging and records",
    kind: "change",
    description:
      'Chooses how visitors are texted ("sendblue" for real texts, "demo" for practice only) and where records are kept ("this-computer" is the only choice today). Door access mode can\'t be changed here. Credentials are never set through chat.',
    input: z.strictObject({ property: Property, messaging: z.enum(["sendblue", "demo"]).optional(), records: z.enum(["this-computer", "google-drive"]).optional() }),
    run: async (ctx, i) => {
      if (i.records === "google-drive") throw new SetupInputError("STORAGE_UNAVAILABLE", "Keeping records in Google Drive isn't available yet. They'll stay on this computer for now.");
      const { id, draft } = openDraft(ctx, i.property);
      const state = edit(ctx, id, draft, "setServices", { messagingMode: i.messaging });
      return { summary: setupSnapshot(ctx, id).recordsAndMessages.join(". "), ...state };
    },
  }),

  // ------------------------------------------- review, checks, publish
  tool({
    name: "review_property_setup",
    title: "Review the setup",
    kind: "read",
    description: 'Everything on one page, as short lines to read back to the operator ("Here\'s what I have: ..."), plus anything still missing.',
    input: z.strictObject({ property: Property }),
    run: async (ctx, i) => {
      const { id, draft } = openDraft(ctx, i.property);
      const view = draftView(draft);
      const lines = view.reviewCards.flatMap((c) => [c.title, ...c.rows.map((r) => `  ${r}`), ...("route" in c && c.route ? [`  Route: ${c.route.text}`] : [])]);
      return { summary: view.canSave ? "Setup looks complete." : `${view.issues.length} thing${view.issues.length === 1 ? "" : "s"} still need${view.issues.length === 1 ? "s" : ""} an answer.`, lines, canSave: view.canSave, ...setupState(ctx, id) };
    },
  }),
  tool({
    name: "run_readiness_check",
    title: "Run the readiness check",
    kind: "change",
    description:
      "Runs Tour Core's real readiness checks (property, hours, routes, verification, messaging, records, tour progress, Durin access, audit/export). Report the result as-is; never claim a check passed if it didn't.",
    input: z.strictObject({ property: Property }),
    run: async (ctx, i) => {
      const id = resolvePropertyId(ctx.services.workspace, i.property);
      const { result, savedChanges } = await readinessForProperty(ctx.services, id, ctx.now());
      return readinessOut(result, savedChanges);
    },
  }),
  tool({
    name: "run_dry_tour",
    title: "Run a practice tour",
    kind: "change",
    description:
      "Runs one complete practice tour through the real engine (no one is texted, no real door opens) and returns the proof points: booking, verification, early denial, entrance, unit, off-route denial, duplicate, completion, follow-up.",
    input: z.strictObject({ property: Property, unit: Unit.optional() }),
    run: async (ctx, i) => {
      const { id, draft } = openDraft(ctx, i.property);
      const unitId = i.unit ? requireUnit(draft, i.unit).id : undefined;
      const outcome = await runPracticeTour(ctx.services, id, { unitId, now: ctx.now() });
      if (outcome.kind === "unchecked-changes") {
        return { passed: false, status: "blocked", summary: "Some setup changes still need fixing before a practice tour can run.", problems: setupState(ctx, id).problems };
      }
      if (outcome.kind === "not-ready") return { passed: false, status: "not-ready", summary: "The readiness check found problems, so the practice tour didn't run.", readiness: readinessOut(outcome.readiness, false) };
      const r = outcome.result;
      return { passed: r.passed, summary: r.passed ? "Practice tour passed." : `The practice tour stopped: ${r.failure}`, proofPoints: proofPoints(r), ...(r.failure ? { failure: r.failure } : {}), status: statusLabel(ctx.services.workspace.load(id)) };
    },
  }),
  tool({
    name: "publish_demo_property",
    title: "Publish for demo",
    kind: "consequential",
    description:
      "Publishes the property for demo so visitors can start tours. Only works when the saved setup is valid and both the readiness check and a practice tour passed for this exact setup. First call returns a yes/no question; ask it and call again with confirmationCode only after an explicit yes.",
    input: z.strictObject({ property: Property, confirmationCode: Code }),
    run: async (ctx, i) => {
      const ws = ctx.services.workspace;
      const id = resolvePropertyId(ws, i.property);
      const blockers = ws.has(id) ? await ws.publishBlockers(id, ctx.now()) : [{ code: "NOT_SAVED", message: "Finish the setup answers first." }];
      if (blockers.length) return { published: false, status: "blocked", summary: "It can't be published yet.", blockers: blockers.map((b) => b.message) };
      const { config, state } = ws.load(id);
      if (state.status === "PUBLISHED_FOR_DEMO") return { published: true, status: "already-published", summary: `${config.property.name} is already published for demo.` };
      const fingerprint = `${state.configHash}|${state.readiness?.checkedAt}|${state.dryTour?.ranAt}`;
      if (!i.confirmationCode) return needsConfirmation(ctx, "publish", id, fingerprint, `Everything passed. Do you want me to publish ${config.property.name} for demo?`);
      ctx.confirmations.redeem(i.confirmationCode, "publish", id, fingerprint);
      const result = await ws.publishDemoProperty(id, ctx.now());
      if (!result.published) return { published: false, status: "blocked", summary: "It can't be published yet.", blockers: result.blockers.map((b) => b.message) };
      return { published: true, status: "published", summary: `${config.property.name} is published for demo. Visitors can start a tour by text.` };
    },
  }),

  // -------------------------------------------------------- live tours
  tool({
    name: "list_active_tours",
    title: "Show active tours",
    kind: "read",
    description: "Visitor tours happening now: who, which unit, tour time, status, and where they are.",
    input: z.strictObject({ property: Property }),
    run: async (ctx, i) => {
      const id = i.property ? resolvePropertyId(ctx.services.workspace, i.property) : undefined;
      const tours = await listActiveTours(ctx.services, id);
      return { summary: tours.length ? `${tours.length} active tour${tours.length === 1 ? "" : "s"}.` : "No tours are active right now.", tours };
    },
  }),
  tool({
    name: "inspect_tour",
    title: "Inspect a tour",
    kind: "read",
    description: "What's happening on one tour: status, latest activity, questions, access denials, recent messages, and anything that needs the team.",
    input: z.strictObject({ tourRef: TourRef }),
    run: async (ctx, i) => {
      const tour = await findTour(ctx.services, i.tourRef);
      const attention = (await listExceptions(ctx.services, { propertyId: tour.propertyId })).filter((x) => x.tourRef === i.tourRef).map(exceptionLine);
      const view = inspectTourView(tour);
      return { summary: `${view.visitorName}${view.unitName ? `, ${view.unitName}` : ""}: ${view.status}. ${view.currentStep}.`, tour: view, needsAttention: attention };
    },
  }),

  // -------------------------------------------------------- exceptions
  tool({
    name: "list_exceptions",
    title: "Show what needs attention",
    kind: "read",
    description: "The queue of issues that need the team: unanswered questions, help requests, door problems, off-route attempts, paused tours, failed identity checks, tours that couldn't be restored.",
    input: z.strictObject({ property: Property, includeHandled: z.boolean().optional() }),
    run: async (ctx, i) => {
      const id = i.property ? resolvePropertyId(ctx.services.workspace, i.property) : undefined;
      const list = await listExceptions(ctx.services, { propertyId: id, includeClosed: i.includeHandled });
      const open = list.filter((x) => x.status === "open").length;
      return { summary: open ? `${open} thing${open === 1 ? "" : "s"} need${open === 1 ? "s" : ""} attention.` : "Nothing needs attention right now.", exceptions: list.map(exceptionLine) };
    },
  }),
  tool({
    name: "inspect_exception",
    title: "Open an issue",
    kind: "read",
    description: "One issue in detail: what happened, the visitor's words, where the tour stands, recent messages, and what the team can do next.",
    input: z.strictObject({ exceptionId: ExceptionId }),
    run: async (ctx, i) => {
      const x = await inspectException(ctx.services, i.exceptionId);
      return { summary: `${x.visitorName}${x.unitName ? `, ${x.unitName}` : ""}: ${x.summary}`, issue: { ...exceptionLine(x), question: x.question, nextSteps: x.nextSteps, tour: x.tour, recentMessages: x.recentMessages } };
    },
  }),
  tool({
    name: "resolve_exception",
    title: "Mark an issue handled",
    kind: "change",
    description: "Closes one issue with the operator's note. Changes nothing else: no tour, access or setup change.",
    input: z.strictObject({ exceptionId: ExceptionId, resolutionNote: z.string().min(1).max(500) }),
    run: async (ctx, i) => {
      const { alreadyResolved, exception } = await resolveException(ctx.services, i.exceptionId, i.resolutionNote, ctx.now());
      return { summary: alreadyResolved ? "That was already marked handled." : `Marked handled: ${exception.visitorName}, ${exception.title.toLowerCase()}.`, issue: exceptionLine(exception) };
    },
  }),
  tool({
    name: "answer_flagged_question",
    title: "Answer a flagged question with a new approved fact",
    kind: "consequential",
    description:
      "Only when the OPERATOR supplied the answer. Adds their exact words as an approved fact (property or unit), texts the visitor exactly that fact, and marks the question handled. Never make up or reword the fact. First call returns a yes/no question; call again with confirmationCode only after an explicit yes.",
    input: z.strictObject({
      exceptionId: ExceptionId,
      approvedFact: z.string().min(1).max(300).describe("The operator's own words, e.g. \"Parking is included.\""),
      appliesTo: z.enum(["property", "unit"]).optional().describe("Whole property (default) or just the visitor's unit."),
      confirmationCode: Code,
    }),
    run: async (ctx, i) => {
      const x = await findException(ctx.services, i.exceptionId);
      if (x.kind !== "unanswered-question" || !x.question) throw new SetupInputError("NOT_A_QUESTION", "That issue isn't an unanswered question.");
      if (x.status === "resolved") throw new SetupInputError("ALREADY_RESOLVED", "That question has already been handled.");
      const fact = cleanFact(i.approvedFact);
      const appliesTo = i.appliesTo ?? "property";
      const fingerprint = `${x.exceptionId}|${appliesTo}|${fact}`;
      if (!i.confirmationCode) {
        const where = appliesTo === "unit" ? (x.unitName ?? "the unit") : x.property;
        const first = x.visitorName.split(/\s+/)[0];
        return needsConfirmation(ctx, "answer", x.exceptionId, fingerprint, `I can add "${fact}" to the approved facts for ${where} and answer ${first}. Want me to?`, {
          visitorWillReceive: visitorAnswerText(x.question, fact),
        });
      }
      ctx.confirmations.redeem(i.confirmationCode, "answer", x.exceptionId, fingerprint);
      const out = await answerFlaggedQuestion(ctx.services, { exceptionId: x.exceptionId, approvedFact: fact, appliesTo }, ctx.now());
      return {
        summary: `Added "${out.approvedFact}" to ${out.addedTo}'s approved facts${out.visitorAnswered ? ` and texted ${x.visitorName.split(/\s+/)[0]}` : "; their tour isn't running, so they weren't texted"}.${out.needsRecheck ? " The setup changed, so run the readiness check and a practice tour again before publishing." : ""}`,
        ...out,
      };
    },
  }),
  tool({
    name: "place_operator_hold",
    title: "Pause a tour",
    kind: "consequential",
    description:
      "Pauses one running tour: its doors are switched off and none open until the team resumes it. First call returns a yes/no question; call again with confirmationCode only after an explicit yes.",
    input: z.strictObject({ tourRef: TourRef, reason: z.string().min(1).max(300), confirmationCode: Code }),
    run: async (ctx, i) => {
      const target = await describeChangeTarget(ctx.services, i.tourRef, "hold");
      const fingerprint = reservationFingerprint(target.reservation);
      if (!i.confirmationCode) return needsConfirmation(ctx, "hold", i.tourRef, fingerprint, `Pause ${target.name}'s tour of ${target.unit}? Their doors will be switched off until you resume it.`);
      ctx.confirmations.redeem(i.confirmationCode, "hold", i.tourRef, fingerprint);
      const tour = await placeHold(ctx.services, i.tourRef, i.reason);
      return { summary: `${target.name}'s tour is paused. No doors will open until you resume it.`, tour };
    },
  }),
  tool({
    name: "clear_operator_hold",
    title: "Resume a paused tour",
    kind: "consequential",
    description:
      "Resumes a tour paused by the team or by a door-system problem. Doors still open only when Tour Core's policy allows (right time, right route). First call returns a yes/no question; call again with confirmationCode only after an explicit yes.",
    input: z.strictObject({ tourRef: TourRef, confirmationCode: Code }),
    run: async (ctx, i) => {
      const target = await describeChangeTarget(ctx.services, i.tourRef, "resume");
      const fingerprint = reservationFingerprint(target.reservation);
      if (!i.confirmationCode) return needsConfirmation(ctx, "resume", i.tourRef, fingerprint, `Resume ${target.name}'s tour of ${target.unit}? Doors on their route can open again during their tour time.`);
      ctx.confirmations.redeem(i.confirmationCode, "resume", i.tourRef, fingerprint);
      const tour = await clearHold(ctx.services, i.tourRef);
      return { summary: `${target.name}'s tour is resumed.`, tour };
    },
  }),
  tool({
    name: "revoke_tour_access",
    title: "Call off a tour",
    kind: "consequential",
    description:
      "Calls off one tour for good: all its access is switched off and the visitor is told. This can't be undone. First call returns a yes/no question; call again with confirmationCode only after an explicit yes.",
    input: z.strictObject({ tourRef: TourRef, reason: z.string().min(1).max(300), confirmationCode: Code }),
    run: async (ctx, i) => {
      const target = await describeChangeTarget(ctx.services, i.tourRef, "revoke");
      const fingerprint = reservationFingerprint(target.reservation);
      if (!i.confirmationCode) return needsConfirmation(ctx, "revoke", i.tourRef, fingerprint, `Call off ${target.name}'s tour of ${target.unit}? All their access will be switched off and they'll be told. This can't be undone.`);
      ctx.confirmations.redeem(i.confirmationCode, "revoke", i.tourRef, fingerprint);
      const tour = await revokeTour(ctx.services, i.tourRef, i.reason);
      return { summary: `${target.name}'s tour is called off and their access is switched off.`, tour };
    },
  }),

  // ------------------------------------------------------------ export
  tool({
    name: "export_audit",
    title: "Export the audit",
    kind: "change",
    description: 'Exports one day\'s tour records for a property as a validated, provider-neutral file (JSON + CSV) and summarizes it. Day is "today" (default) or YYYY-MM-DD.',
    input: z.strictObject({ property: Property, day: z.string().max(20).optional() }),
    run: async (ctx, i) => {
      const id = resolvePropertyId(ctx.services.workspace, i.property);
      const day = !i.day || i.day.trim().toLowerCase() === "today" ? undefined : parseLocalDate(i.day);
      if (i.day && i.day.trim().toLowerCase() !== "today" && !day) throw new SetupInputError("DAY_UNREADABLE", 'Use "today" or a date like 2026-09-28.');
      const out = await exportAudit(ctx.services, id, { day, now: ctx.now() });
      const s = out.summary;
      const base = ctx.localUrl?.();
      return {
        summary: `${s.day}: ${s.tours} visitor tour${s.tours === 1 ? "" : "s"} (${s.completed} completed, ${s.active} active, ${s.stopped} stopped), ${s.accessDenials} access denial${s.accessDenials === 1 ? "" : "s"}, ${s.questionsNeedingAttention} question${s.questionsNeedingAttention === 1 ? "" : "s"} needing attention, plus ${s.practiceTours} practice tour${s.practiceTours === 1 ? "" : "s"}.`,
        totals: s,
        reference: `Audit export ${out.exportId}, saved with ${ctx.services.workspace.load(id).config.property.name}'s tour records on the Tour Core computer.`,
        files: out.files.map((f) => ({ file: f, ...(base ? { openOnTourCoreComputer: `${base}/api/properties/${id}/audit-exports/${out.exportId}/${f}` } : {}) })),
      };
    },
  }),

  // ------------------------------------------------------ installation
  ...INSTALLATION_TOOLS,
];

export const OPERATOR_TOOL_NAMES = OPERATOR_TOOLS.map((t) => t.name);

export class UnknownToolError extends Error {}

export type ToolOutcome = { ok: true; result: Record<string, unknown> } | { ok: false; error: string };

/**
 * The one entry point for any agent host: validate, run the Tour Core
 * action, and return plain language. Errors come back as a plain message
 * the operator can be told, never a stack or a code.
 */
export async function callOperatorTool(ctx: ToolContext, name: string, args: unknown): Promise<ToolOutcome> {
  const def = OPERATOR_TOOLS.find((t) => t.name === name);
  if (!def) throw new UnknownToolError(`There's no Tour Core tool called "${name}".`);
  const parsed = def.input.safeParse(args ?? {});
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((i) => (i.code === "unrecognized_keys" ? `unexpected ${i.keys.join(", ")}` : i.path.join(".") || "input")))];
    return { ok: false, error: `That request doesn't fit ${def.name} (${fields.join("; ")}). Nothing was changed.` };
  }
  try {
    return { ok: true, result: redactSecrets(await def.run(ctx, parsed.data as never)) as Record<string, unknown> };
  } catch (err) {
    if (err instanceof SetupInputError || err instanceof TourCoreError || err instanceof UnavailableModeError) return { ok: false, error: err.message };
    if (err instanceof InvalidTransitionError) return { ok: false, error: "That tour can't make that change from where it is now. Nothing was changed." };
    return { ok: false, error: "Something went wrong in Tour Core. Nothing else was changed." };
  }
}

/** Defense in depth: no tool result may carry a configured secret (environment or secure setup), whatever path produced it. */
export function redactSecrets(value: unknown, env: NodeJS.ProcessEnv = process.env): unknown {
  const secrets = secretValues(env);
  if (!secrets.length) return value;
  const text = JSON.stringify(value);
  if (!secrets.some((s) => text.includes(s))) return value;
  return JSON.parse(secrets.reduce((t, s) => t.split(s).join("[hidden]"), text));
}
