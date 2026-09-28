import type { ConfigIssue, ConfigSection } from "../config/validateConfig";
import { slotStartMinutes } from "../core/schedule";
import { formatClockTime, friendlyTimeZone } from "../core/timezone";
import type { DryTourGroup, DryTourResult } from "./dryTour";
import type { ReadinessResult } from "./readiness";
import {
  CHOICE_LABELS,
  describeDays,
  describeInterval,
  describeMinutes,
  doorFollowsUnitName,
  reviewSetup,
  suggestRoute,
  type SetupDraft,
} from "./setupActions";
import { statusLabel, type SavedProperty, type TourRecord } from "./workspace";
import { describeHistory } from "../audit/describe";
import { validateConfig, type TourCoreConfig } from "../config/tourCoreConfig";
import { formatDay, formatShortDateTime, formatTime } from "../core/timezone";
import type { ExportBundle } from "../export/exportBundle";

/**
 * View models for any setup surface. They carry only plain language plus ids
 * the surface needs to call actions. Anything technical sits under a `dev`
 * key, which the browser server strips unless developer mode is on.
 */

export const SETUP_STEPS = [
  { id: "property", title: "Property" },
  { id: "units", title: "Units" },
  { id: "doors", title: "Doors" },
  { id: "routes", title: "Routes" },
  { id: "hours", title: "Tour hours" },
  { id: "verification", title: "Verification" },
  { id: "services", title: "Records and messages" },
] as const;
export type SetupStep = (typeof SETUP_STEPS)[number]["id"];

export interface Fix {
  step: SetupStep;
  label: string;
  unitId?: string;
}

export interface IssueView {
  message: string;
  unitId?: string;
  fix?: Fix;
  dev: { code: string; detail?: string };
}

const UNIT_CODES = ["NO_UNITS", "UNIT_NAME_MISSING", "DUPLICATE_UNIT_ID", "FACT_TOO_LONG", "TOO_MANY_FACTS"];
const DOOR_CODES = ["NO_ENTRANCE", "DOOR_NAME_MISSING", "DUPLICATE_DOOR_ID", "UNIT_DOOR_MISSING", "UNIT_DOOR_UNKNOWN", "UNIT_DOOR_NOT_UNIT", "UNIT_DOOR_SHARED"];

/** Where to send the operator to fix a problem, in words they'd use. */
export function fixFor(code: string, section?: ConfigSection, unitId?: string): Fix | undefined {
  const withUnit = unitId ? { unitId } : {};
  if (UNIT_CODES.includes(code)) return { step: "units", label: "Fix units", ...withUnit };
  if (DOOR_CODES.includes(code)) return { step: "doors", label: "Fix doors", ...withUnit };
  switch (section) {
    case "property":
      return { step: "property", label: "Fix property details" };
    case "hours":
      return { step: "hours", label: "Fix tour hours" };
    case "routes":
      return { step: "routes", label: "Fix route", ...withUnit };
    case "units":
      return { step: "units", label: "Fix units", ...withUnit };
    case "verification":
      return { step: "verification", label: "Change verification" };
    case "services":
      return { step: "services", label: "Change records and messages" };
    default:
      return undefined;
  }
}

function issueView(issue: ConfigIssue): IssueView {
  const fix = fixFor(issue.code, issue.section, issue.unitId);
  return {
    message: issue.message,
    ...(issue.unitId ? { unitId: issue.unitId } : {}),
    ...(fix ? { fix } : {}),
    dev: { code: issue.code, ...(issue.detail ? { detail: issue.detail } : {}) },
  };
}

export const DOOR_KIND_LABELS = { ENTRANCE: "Entrance", UNIT: "Unit door", COMMON: "Hallway or shared door" } as const;

export const VERIFICATION_OPTIONS = [
  {
    mode: "basic-form" as const,
    title: "Basic identity form",
    recommended: true,
    explanation:
      "Before the tour, visitors fill out a short form with their legal first and last name, email and phone number. It keeps a record of who they say they are, but it doesn't prove who they are.",
  },
  {
    mode: "mock" as const,
    title: "Practice verification",
    recommended: false,
    explanation: "Everyone passes automatically. Use this only while trying Tour Core out.",
  },
];

export const COMMON_TIME_ZONES = [
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Phoenix",
  "America/Los_Angeles",
  "America/Anchorage",
  "Pacific/Honolulu",
  "America/Toronto",
  "America/Vancouver",
  "Europe/London",
  "Europe/Paris",
  "Asia/Tokyo",
  "Australia/Sydney",
].map((id) => ({ id, label: `${friendlyTimeZone(id)} (${id.split("/").pop()!.replace(/_/g, " ")})` }));

function servicesView(draft: SetupDraft) {
  const demo = draft.storageMode === "memory" && draft.messagingMode === "demo" && draft.accessMode === "durin-mock";
  const sendblue = draft.messagingMode === "sendblue";
  return {
    allDemo: demo,
    messaging: {
      mode: draft.messagingMode,
      options: [
        { mode: "demo" as const, title: "Demo messaging", explanation: "Messages to visitors appear on screen. Nothing is actually texted." },
        {
          mode: "sendblue" as const,
          title: "Sendblue",
          explanation: "Visitors text a real number from their own phone and get real replies. Needs Sendblue set up on this computer.",
        },
      ],
    },
    items: [
      {
        title: draft.storageMode === "memory" ? "Demo records" : CHOICE_LABELS.storage[draft.storageMode],
        text: "Tour records are kept on this computer.",
        dev: { mode: draft.storageMode, adapter: "InMemoryStore" },
      },
      {
        title: sendblue ? "Sendblue messaging" : "Demo messaging",
        text: sendblue
          ? "Visitors text the property's Sendblue number and get real replies. Practice tours and the visitor demo still use demo messaging."
          : "Messages to visitors appear on screen. Nothing is actually texted.",
        demo: !sendblue,
        dev: { mode: draft.messagingMode, adapter: sendblue ? "SendblueMessagingAdapter" : "DemoMessagingAdapter" },
      },
      {
        title: draft.accessMode === "durin-mock" ? "Durin demo mode" : CHOICE_LABELS.access[draft.accessMode],
        text: "No real doors open. Tour Core asks Durin for access only after its own safety checks pass.",
        dev: { mode: draft.accessMode, adapter: "MockDurinAccessAdapter" },
      },
    ],
  };
}

export function draftView(draft: SetupDraft) {
  const review = reviewSetup(draft);
  const issues = review.issues.map(issueView);
  const doorName = (id: string) => draft.doors.find((d) => d.id === id)?.name ?? "(a door that no longer exists)";
  const th = draft.tourHours;
  const entrances = draft.doors.filter((d) => d.kind === "ENTRANCE");
  const verification = VERIFICATION_OPTIONS.find((o) => o.mode === draft.verificationMode);

  const units = draft.units.map((u) => {
    const route = draft.routes.find((r) => r.unitId === u.id);
    const door = draft.doors.find((d) => d.id === u.doorId);
    return {
      id: u.id,
      name: u.name,
      summary: u.summary,
      facts: u.facts,
      door: door ? { id: door.id, name: door.name } : undefined,
      doorFollowsName: doorFollowsUnitName(draft, u.id),
      route: route?.stops.length
        ? { doorIds: route.stops.map((s) => s.doorId), doorNames: route.stops.map((s) => doorName(s.doorId)), directions: route.directions ?? "" }
        : undefined,
      suggestedRoute: suggestRoute(draft, u.id),
      issues: issues.filter((i) => i.unitId === u.id),
      dev: { id: u.id, doorId: u.doorId },
    };
  });

  const hoursValid = !issues.some((i) => i.fix?.step === "hours");
  const tourHours = {
    ...th,
    daysLabel: describeDays(th.days),
    hoursLabel: `${formatClockTime(th.start)}-${formatClockTime(th.end)}`,
    lengthLabel: describeMinutes(th.tourLengthMinutes),
    spacingLabel: describeInterval(th.slotEveryMinutes),
    earlyLabel: describeMinutes(th.earlyArrivalMinutes),
    valid: hoursValid,
    /** Only when the schedule is valid; an overlapping schedule has no honest count. */
    toursPerDay: hoursValid ? slotStartMinutes(th).length : undefined,
    summary: hoursValid
      ? `${describeDays(th.days)}, ${formatClockTime(th.start)}-${formatClockTime(th.end)}. That's up to ${slotStartMinutes(th).length} tours a day.`
      : undefined,
  };

  const property = {
    id: draft.property.id,
    name: draft.property.name,
    address: draft.property.address,
    timezone: draft.property.timezone,
    timezoneLabel: friendlyTimeZone(draft.property.timezone),
    facts: draft.property.facts,
  };

  const services = servicesView(draft);
  const reviewCards = [
    {
      step: "property" as SetupStep,
      title: property.name,
      rows: [
        ...(property.address !== property.name ? [property.address] : []),
        `Timezone: ${property.timezoneLabel}`,
        ...property.facts,
      ],
    },
    {
      step: "hours" as SetupStep,
      title: "Tours",
      rows: [
        tourHours.daysLabel,
        tourHours.hoursLabel,
        `Each tour lasts ${tourHours.lengthLabel}, and a new one can start every ${tourHours.spacingLabel}`,
        `Visitors can get in up to ${tourHours.earlyLabel} early`,
      ],
    },
    ...units.map((u) => ({
      step: "units" as SetupStep,
      unitId: u.id,
      title: u.name,
      rows: [u.summary || "No description yet", ...u.facts],
      route: { step: "routes" as SetupStep, text: u.route ? u.route.doorNames.join(" \u2192 ") : "No route yet" },
    })),
    {
      step: "verification" as SetupStep,
      title: "Verification",
      rows: [verification?.title ?? CHOICE_LABELS.verification[draft.verificationMode], `A check can be reused for ${draft.verificationValidForDays} days`],
    },
    { step: "services" as SetupStep, title: "Records and messages", rows: [...services.items.map((s) => s.title), `Alerts go to: ${draft.operator.name}`] },
  ];

  return {
    property,
    operator: { name: draft.operator.name },
    units,
    doors: draft.doors.map((d) => ({
      id: d.id,
      name: d.name,
      kind: d.kind,
      kindLabel: DOOR_KIND_LABELS[d.kind],
      unitName: draft.units.find((u) => u.doorId === d.id)?.name,
      removable: d.kind === "COMMON" || (d.kind === "ENTRANCE" && entrances.length > 1),
    })),
    tourHours,
    verification: { mode: draft.verificationMode, reuseForDays: draft.verificationValidForDays, options: VERIFICATION_OPTIONS },
    services,
    steps: SETUP_STEPS.map((s) => ({ ...s, issueCount: issues.filter((i) => i.fix?.step === s.id).length })),
    issues,
    reviewCards,
    canSave: review.canSave,
    dev: { propertyId: draft.property.id, modes: { verification: draft.verificationMode, messaging: draft.messagingMode, storage: draft.storageMode, access: draft.accessMode } },
  };
}
export type DraftView = ReturnType<typeof draftView>;

export function readinessView(result: ReadinessResult) {
  return {
    passed: result.passed,
    headline: result.passed ? "Everything's ready." : "A few things need fixing first.",
    checks: result.checks.map((c) => ({
      id: c.id,
      label: c.label,
      ok: c.ok,
      problems: c.details.map((p) => {
        const fix = fixFor(p.code, p.section, p.unitId);
        return { message: p.message, ...(fix ? { fix } : {}), dev: { code: p.code } };
      }),
    })),
  };
}

const GROUP_TITLES: Record<DryTourGroup, string> = { journey: "The visitor's journey", safety: "Safety test", wrapup: "Finishing up" };

export function dryTourView(result: DryTourResult) {
  return {
    passed: result.passed,
    headline: result.passed ? "Practice tour passed." : "The practice tour stopped.",
    failure: result.failure,
    groups: (Object.keys(GROUP_TITLES) as DryTourGroup[])
      .map((group) => ({
        id: group,
        title: GROUP_TITLES[group],
        items: result.checks.filter((c) => c.group === group).map((c) => ({ label: c.label, outcome: c.outcome, ok: c.ok, detail: c.detail, dev: { id: c.id } })),
      }))
      .filter((g) => g.items.length),
    messages: (result.messages ?? []).map((m) => ({ time: m.time, to: m.audience === "OPERATOR" ? "Alert to your team" : "Text to the visitor", body: m.body })),
    recordsSaved: !!result.bundle,
    dev: { devLines: result.devLines ?? [], auditEventCount: result.audit.length },
  };
}

/**
 * Whether the operator's latest edits are in the saved setup. Valid edits are
 * saved automatically; edits with problems are kept as a draft until fixed.
 */
export function saveStateView(draft: SetupDraft, unsaved: boolean) {
  if (!unsaved) return { state: "saved" as const, label: "All changes saved" };
  const count = validateConfig(draft).length;
  return {
    state: "draft" as const,
    label: `Changes kept as a draft until ${count === 1 ? "1 problem is" : `${count} problems are`} fixed`,
  };
}

export function propertySummary(
  saved: SavedProperty | undefined,
  draft: SetupDraft | undefined,
  unsaved: boolean,
  extra: { tourCount?: number; activeVisitorDemo?: string } = {},
) {
  const config = saved?.config ?? draft!;
  const state = saved?.state;
  const hash = state?.configHash;
  const readinessCurrent = !!state?.readiness && state.readiness.configHash === hash;
  const practiceCurrent = !!state?.dryTour && state.dryTour.configHash === hash;
  return {
    id: config.property.id,
    name: config.property.name,
    address: config.property.address,
    saved: !!saved,
    unsavedChanges: unsaved,
    save: saveStateView(draft ?? config, unsaved),
    status: saved ? state!.status : ("IN_PROGRESS" as const),
    statusLabel: saved ? statusLabel(saved) : "Setup in progress",
    published: state?.status === "PUBLISHED_FOR_DEMO",
    readinessPassed: readinessCurrent && !!state?.readiness?.passed,
    practicePassed: practiceCurrent && !!state?.dryTour?.passed,
    hasHistory: (extra.tourCount ?? 0) > 0,
    activeVisitorDemo: extra.activeVisitorDemo,
    dev: { propertyId: config.property.id, configHash: hash, recordsFolder: state?.dryTour?.recordsFolder },
  };
}

// ------------------------------------------------------------ tour records

const OUTCOME_LABELS: Record<TourRecord["outcome"], string> = {
  passed: "Passed",
  stopped: "Stopped early",
  "in-progress": "In progress",
  finished: "Finished",
};

const KIND_LABELS: Record<TourRecord["kind"], string> = { practice: "Practice tour", "visitor-demo": "Visitor demo", messaging: "Text message tour" };

export function tourListView(records: TourRecord[], timeZone: string) {
  return records.map((r) => ({
    id: r.tourId,
    label: formatShortDateTime(new Date(r.ranAt), timeZone),
    kindLabel: KIND_LABELS[r.kind],
    outcomeLabel: OUTCOME_LABELS[r.outcome],
    ok: r.outcome === "passed" || r.outcome === "finished" ? true : r.outcome === "stopped" ? false : null,
    visitorName: r.visitorName,
  }));
}

const ACCESS_TYPES = new Set(["ACCESS_ALLOWED", "ACCESS_DENIED", "ACCESS_REVOKED"]);

/** Everything the operator needs to reopen one tour: conversation, access decisions, safety, timeline. */
export function tourDetailView(record: TourRecord, bundle: ExportBundle, config: TourCoreConfig) {
  const tz = config.property.timezone;
  const timeline = describeHistory(bundle.auditEvents, { ...bundle, operatorName: config.operator.name }, tz);
  const conversation =
    record.conversation?.map((m) => ({ from: m.from, text: m.text, time: formatTime(new Date(m.at), tz), ...(m.delivery ? { dev: m.delivery } : {}) })) ??
    bundle.messages
      .filter((m) => m.audience === "PROSPECT")
      .map((m) => ({ from: m.direction === "INBOUND" ? ("visitor" as const) : ("tourcore" as const), text: m.body, time: formatTime(new Date(m.at), tz) }));
  const unit = config.units.find((u) => u.id === (record.unitId ?? bundle.reservations[0]?.unitId));
  const reservation = bundle.reservations[0];
  return {
    id: record.tourId,
    title: KIND_LABELS[record.kind],
    visitorPhone: record.kind === "messaging" ? record.visitorPhone : undefined,
    ranAtLabel: formatShortDateTime(new Date(record.ranAt), tz),
    outcomeLabel: OUTCOME_LABELS[record.outcome],
    ok: record.outcome === "passed" || record.outcome === "finished",
    failure: record.failure,
    visitorName: record.visitorName ?? bundle.prospects[0]?.name,
    unitName: unit?.name,
    tourTime: reservation?.slotStart ? `${formatDay(new Date(reservation.slotStart), tz)}, ${formatTime(new Date(reservation.slotStart), tz)}` : undefined,
    conversation,
    safetyChecks: record.checks ? dryTourView({ passed: record.outcome === "passed", ranAt: record.ranAt, checks: record.checks, audit: [] }).groups : undefined,
    accessDecisions: timeline.filter((e) => ACCESS_TYPES.has(e.dev.type)),
    safetyEvents: timeline.filter((e) => e.tone === "blocked"),
    timeline,
    dev: { tourId: record.tourId, auditEventCount: bundle.auditEvents.length },
  };
}
