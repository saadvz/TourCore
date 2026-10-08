import { canonicalUnitName } from "../setup/normalizeDraft";
import type { DuplexVariant } from "./duplex";
import { confirmationCode, type EvalSession, type ToolResult } from "./session";

export interface MilestoneStep {
  tool: string;
  status?: string;
  milestone?: string;
  next?: string;
  message?: string;
  code?: string;
}

function fail(variant: string, step: string, result: ToolResult): never {
  throw new Error(`${variant} ${step}: ${JSON.stringify({ status: result.status, code: result.code, message: result.message ?? result.summary }).slice(0, 800)}`);
}

export function milestoneStep(tool: string, result: ToolResult): MilestoneStep {
  return {
    tool,
    status: typeof result.status === "string" ? result.status : undefined,
    milestone: typeof result.milestone === "string" ? result.milestone : undefined,
    next: typeof result.next === "string" ? result.next : undefined,
    message: typeof result.message === "string" ? result.message : typeof result.summary === "string" ? result.summary : undefined,
    code: typeof result.code === "string" ? result.code : undefined,
  };
}

/** The same duplex, written with the milestone tools. Final stored config should match the old tools. */
export async function publishMilestoneDuplex(session: EvalSession, variant: DuplexVariant): Promise<{ propertyId: string }> {
  const call = session.call.bind(session);
  const texting = await call("set_up_texting", { provider: "local" });
  if (texting.status !== "done") fail(variant.id, "set_up_texting", texting);
  await call("decline_portable_backup");

  const saved = await call("save_property", {
    address: variant.address,
    ...(variant.displayName ? { name: variant.displayName } : {}),
    ...(variant.timezone ? { timezone: variant.timezone } : {}),
    propertyType: "MULTIFAMILY_HOME",
    confirmAddress: true,
    skipVisitorHelp: true,
  });
  if (saved.status !== "done" || typeof saved.propertyId !== "string") fail(variant.id, "save_property", saved);
  const propertyId = saved.propertyId;

  const settings = await call("save_settings", { property: propertyId, verification: "basic-form", skipAlerts: true });
  if (settings.status !== "done") fail(variant.id, "save_settings", settings);

  const order = variant.reverseUnits
    ? [
        ["B", variant.nameB, variant.doorNameB, 1, 1950, "October 15"],
        ["A", variant.nameA, variant.doorNameA, 2, 2200, "now"],
      ]
    : [
        ["A", variant.nameA, variant.doorNameA, 2, 2200, "now"],
        ["B", variant.nameB, variant.doorNameB, 1, 1950, "October 15"],
      ];
  const structured = variant.details === "structured";
  const units = await call("save_units", {
    property: propertyId,
    units: order.map(([, name, doorName, bedrooms, rent, availability]) => ({
      name,
      ...(doorName ? { doorName } : {}),
      ...(structured ? { bedrooms, bathrooms: 1, monthlyRent: rent, availability } : {}),
    })),
    ...(structured
      ? {}
      : {
          details: `${variant.nameA} is 2 bed 1 bath for $2,200, available now. ${variant.nameB} is 1 bed 1 bath for $1,950, available October 15.`,
        }),
  });
  if (units.status !== "done") fail(variant.id, "save_units", units);

  const doors = [{ name: variant.entrance, kind: "entrance" as const }];
  const routes = order.map(([, name, doorName]) => ({
    unit: canonicalUnitName(String(name), "MULTIFAMILY_HOME"),
    doors: [variant.entrance, doorName ?? `${name} door`],
  }));
  if (variant.preview) {
    const preview = await call("save_doors_and_routes", { property: propertyId, preview: true, doors, routes });
    if (preview.status !== "next" || preview.preview !== true) fail(variant.id, "save_doors_and_routes preview", preview);
  }
  const routed = await call("save_doors_and_routes", { property: propertyId, doors, routes });
  if (routed.status !== "done") fail(variant.id, "save_doors_and_routes", routed);

  const hours = await call("save_hours", { property: propertyId, days: variant.days, start: variant.start, end: variant.end });
  if (hours.status !== "done") fail(variant.id, "save_hours", hours);

  const checks = await call("run_checks", { property: propertyId });
  if (checks.status !== "done") fail(variant.id, "run_checks", checks);

  const asked = await call("publish", { property: propertyId });
  if (asked.status !== "next") fail(variant.id, "publish", asked);
  const published = await call("publish", { property: propertyId, confirmationCode: confirmationCode(asked) });
  if (published.published !== true) fail(variant.id, "publish confirm", published);
  return { propertyId };
}

/**
 * Demo order on the canonical duplex, with one deliberate block (practice
 * checks before any route) and the recovery that follows.
 */
export async function runMilestoneTranscript(session: EvalSession): Promise<MilestoneStep[]> {
  const call = session.call.bind(session);
  const steps: MilestoneStep[] = [];
  const note = (tool: string, result: ToolResult) => steps.push(milestoneStep(tool, result));

  const texting = await call("set_up_texting", { provider: "local" });
  note("set_up_texting", texting);
  const declined = await call("decline_portable_backup");
  note("decline_portable_backup", declined);
  const property = await call("save_property", {
    address: "18 Maple Street, Teaneck, NJ 07666",
    propertyType: "MULTIFAMILY_HOME",
    confirmAddress: true,
    skipVisitorHelp: true,
  });
  note("save_property", property);
  const propertyId = property.propertyId as string;
  const settings = await call("save_settings", { property: propertyId, skipAlerts: true });
  note("save_settings", settings);
  const units = await call("save_units", {
    property: propertyId,
    units: [{ name: "Unit A" }, { name: "Unit B" }],
    details: "Unit A is 2 bed 1 bath for $2,200, available now. Unit B is 1 bed 1 bath for $1,950, available October 15.",
  });
  note("save_units", units);
  const blocked = await call("run_checks", { property: propertyId });
  note("run_checks", blocked);
  const doors = [{ name: "Front Door", kind: "entrance" as const }];
  const routes = [
    { unit: "Unit A", doors: ["Front Door", "Unit A Door"] },
    { unit: "Unit B", doors: ["Front Door", "Unit B Door"] },
  ];
  const preview = await call("save_doors_and_routes", { property: propertyId, preview: true, doors, routes });
  note("save_doors_and_routes", preview);
  const routed = await call("save_doors_and_routes", { property: propertyId, doors, routes });
  note("save_doors_and_routes", routed);
  const hours = await call("save_hours", { property: propertyId, days: "weekdays", start: "9am", end: "5pm" });
  note("save_hours", hours);
  const checks = await call("run_checks", { property: propertyId });
  note("run_checks", checks);
  const asked = await call("publish", { property: propertyId });
  note("publish", asked);
  const published = await call("publish", { property: propertyId, confirmationCode: confirmationCode(asked) });
  note("publish", published);
  return steps;
}

export function milestonePathMarkdown(steps: MilestoneStep[]): string {
  const lines = [
    `# Milestone demo path`,
    ``,
    `18 Maple Street duplex through the milestone tools. Local texting, backups declined, then property, a skipped alerts step, units, a blocked practice check, the route preview and save, hours, the checks, and publish. Confirmation codes are not included.`,
    ``,
    ...steps.map((step, index) => {
      const bits = [
        step.status ? `status ${step.status}` : undefined,
        step.milestone ? `milestone ${step.milestone}` : undefined,
        step.next ? `next ${step.next}` : undefined,
        step.code ? `code ${step.code}` : undefined,
        step.message ? step.message : undefined,
      ].filter(Boolean);
      return `${index + 1}. \`${step.tool}\` — ${bits.join(" — ")}`;
    }),
    ``,
  ];
  return lines.join("\n");
}
