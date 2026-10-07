import type { EvalSession, ToolResult } from "./session";
import { confirm } from "./session";

export interface DuplexVariant {
  id: string;
  address: string;
  /** Set only for the live run. The in-process baseline leaves the address as the name. */
  displayName?: string;
  timezone?: string;
  /** Confirm the address before asking the property type. */
  confirmBeforeType: boolean;
  /** Add the entrance before the units. */
  entranceFirst: boolean;
  /** Add unit B before unit A. */
  reverseUnits: boolean;
  nameA: string;
  nameB: string;
  doorNameA?: string;
  doorNameB?: string;
  entrance: string;
  /** Set hours before the units exist. */
  hoursBeforeUnits: boolean;
  days: string;
  start: string;
  end: string;
  details: "bulk" | "structured";
  /** preview_route, then set_route with the names it resolved. */
  preview: boolean;
}

/** Ten equivalent duplex setups. Upper/Lower is a different shape and is not in this list. */
export const DUPLEX_VARIANTS: DuplexVariant[] = [
  {
    id: "canonical",
    address: "18 Maple Street, Teaneck, NJ 07666",
    confirmBeforeType: true,
    entranceFirst: false,
    reverseUnits: false,
    nameA: "Unit A",
    nameB: "Unit B",
    entrance: "Front Door",
    hoursBeforeUnits: false,
    days: "weekdays",
    start: "9am",
    end: "5pm",
    details: "bulk",
    preview: true,
  },
  {
    id: "lowercase-reverse",
    address: "18 maple street, teaneck, nj 07666",
    confirmBeforeType: false,
    entranceFirst: true,
    reverseUnits: true,
    nameA: "unit a",
    nameB: "unit b",
    entrance: "front door",
    hoursBeforeUnits: true,
    days: "Mon-Fri",
    start: "9:00 AM",
    end: "5:00 PM",
    details: "structured",
    preview: false,
  },
  {
    id: "st-abbreviation",
    address: "18 Maple St., Teaneck, NJ 07666",
    confirmBeforeType: true,
    entranceFirst: false,
    reverseUnits: false,
    nameA: "Unit A",
    nameB: "Unit B",
    doorNameA: "Suite A door",
    doorNameB: "Suite B door",
    entrance: "Main Entrance",
    hoursBeforeUnits: false,
    days: "Monday through Friday",
    start: "9",
    end: "5",
    details: "bulk",
    preview: true,
  },
  {
    id: "state-name",
    address: "18 Maple Street, Teaneck, New Jersey 07666",
    confirmBeforeType: true,
    entranceFirst: false,
    reverseUnits: true,
    nameA: "A",
    nameB: "B",
    entrance: "The front door",
    hoursBeforeUnits: false,
    days: "Monday, Tuesday, Wednesday, Thursday and Friday",
    start: "09:00",
    end: "17:00",
    details: "bulk",
    preview: true,
  },
  {
    id: "uppercase",
    address: "18 MAPLE STREET, TEANECK, NJ 07666",
    confirmBeforeType: true,
    entranceFirst: false,
    reverseUnits: false,
    nameA: "UNIT A",
    nameB: "UNIT B",
    entrance: "BUILDING ENTRANCE",
    hoursBeforeUnits: false,
    days: "weekdays",
    start: "9am",
    end: "5pm",
    details: "structured",
    preview: false,
  },
  {
    id: "st-no-period",
    address: "18 Maple St, Teaneck, NJ 07666",
    confirmBeforeType: true,
    entranceFirst: true,
    reverseUnits: false,
    nameA: "Unit a",
    nameB: "Unit b",
    entrance: "Front entrance",
    hoursBeforeUnits: false,
    days: "weekdays",
    start: "9 am",
    end: "5 pm",
    details: "bulk",
    preview: true,
  },
  {
    id: "no-comma-before-state",
    address: "18 Maple Street, Teaneck NJ 07666",
    confirmBeforeType: true,
    entranceFirst: false,
    reverseUnits: true,
    nameA: "Unit A",
    nameB: "Unit B",
    entrance: "Shared front door",
    hoursBeforeUnits: false,
    days: "Mon-Fri",
    start: "9:00 am",
    end: "5:00 pm",
    details: "bulk",
    preview: false,
  },
  {
    id: "nj-periods",
    address: "18 Maple Street, Teaneck, N.J. 07666",
    confirmBeforeType: true,
    entranceFirst: false,
    reverseUnits: false,
    nameA: "Unit A",
    nameB: "Unit B",
    doorNameA: "A's door",
    doorNameB: "B's door",
    entrance: "Front Door",
    hoursBeforeUnits: false,
    days: "weekdays",
    start: "9:00 am",
    end: "5:00 pm",
    details: "structured",
    preview: true,
  },
  {
    id: "eastern-timezone",
    address: "18 Maple Street, teaneck, NJ 07666",
    timezone: "Eastern",
    confirmBeforeType: true,
    entranceFirst: false,
    reverseUnits: false,
    nameA: "Unit A",
    nameB: "Unit B",
    entrance: "Front Door",
    hoursBeforeUnits: false,
    days: "weekdays",
    start: "9am",
    end: "5pm",
    details: "bulk",
    preview: true,
  },
  {
    id: "trimmed-names",
    address: "18 maple st, teaneck, new jersey 07666",
    confirmBeforeType: false,
    entranceFirst: true,
    reverseUnits: false,
    nameA: " unit A ",
    nameB: " unit B ",
    entrance: "the Front Door",
    hoursBeforeUnits: true,
    days: "Monday through Friday",
    start: "9 am",
    end: "5 pm",
    details: "bulk",
    preview: false,
  },
];

type Call = EvalSession["call"];

function fail(variant: string, step: string, result: ToolResult): never {
  const checks = result.checks ?? result.problems ?? result.blockers;
  throw new Error(`${variant} ${step}: ${JSON.stringify({ outcome: result.summary ?? result.status, checks }).slice(0, 1200)}`);
}

async function hours(call: Call, property: string, variant: DuplexVariant): Promise<void> {
  await call("set_tour_hours", { property, days: variant.days, start: variant.start, end: variant.end });
}

async function addUnits(call: Call, property: string, variant: DuplexVariant): Promise<{ nameA: string; doorA: string; nameB: string; doorB: string }> {
  const order = variant.reverseUnits
    ? [
        ["B", variant.nameB, variant.doorNameB],
        ["A", variant.nameA, variant.doorNameA],
      ]
    : [
        ["A", variant.nameA, variant.doorNameA],
        ["B", variant.nameB, variant.doorNameB],
      ];
  const stored: Record<string, { name: string; door: string }> = {};
  for (const [key, name, doorName] of order) {
    const added = await call("add_unit", { property, name, ...(doorName ? { doorName } : {}) });
    const unit = added.unit as { name?: string; door?: string } | undefined;
    if (!unit?.name || !unit.door) fail(variant.id, `add_unit ${name}`, added);
    stored[key!] = { name: unit.name, door: unit.door };
  }
  return { nameA: stored.A!.name, doorA: stored.A!.door, nameB: stored.B!.name, doorB: stored.B!.door };
}

async function details(call: Call, property: string, variant: DuplexVariant, nameA: string, nameB: string): Promise<void> {
  if (variant.details === "bulk") {
    const text = `${nameA} is 2 bed 1 bath for $2,200, available now. ${nameB} is 1 bed 1 bath for $1,950, available October 15.`;
    const saved = await call("set_unit_details", { property, details: text });
    if (saved.notOnFile) fail(variant.id, "set_unit_details", saved);
    return;
  }
  await call("set_unit_details", {
    property,
    units: [
      { unit: nameA, bedrooms: 2, bathrooms: 1, monthlyRent: 2200, availability: "now" },
      { unit: nameB, bedrooms: 1, bathrooms: 1, monthlyRent: 1950, availability: "October 15" },
    ],
  });
}

async function route(call: Call, property: string, variant: DuplexVariant, unit: string, doors: string[]): Promise<void> {
  if (!variant.preview) {
    await call("set_route", { property, unit, doors });
    return;
  }
  const preview = await call("preview_route", { property, unit, doors });
  const resolved = preview.route as string[] | undefined;
  if (preview.status !== "ok" || !resolved?.length) fail(variant.id, `preview_route ${unit}`, preview);
  await call("set_route", { property, unit, doors: resolved });
}

/** Property, units, doors, routes, hours, verification, and the visitor-help skip. */
export async function setupDuplex(session: EvalSession, variant: DuplexVariant): Promise<{ propertyId: string; nameA: string; nameB: string }> {
  const call = session.call.bind(session);
  const created = await call("create_property_setup", {
    address: variant.address,
    ...(variant.displayName ? { name: variant.displayName } : {}),
    ...(variant.timezone ? { timezone: variant.timezone } : {}),
  });
  if (created.status !== "created") fail(variant.id, "create_property_setup", created);
  const propertyId = (created.setup as { propertyId?: string } | undefined)?.propertyId;
  if (!propertyId) fail(variant.id, "create_property_setup", created);

  const confirmAddress = () => call("update_property_details", { property: propertyId, confirmAddress: true });
  const setType = () => call("update_property_details", { property: propertyId, propertyType: "MULTIFAMILY_HOME" });
  if (variant.confirmBeforeType) {
    await confirmAddress();
    await setType();
  } else {
    await setType();
    await confirmAddress();
  }

  if (variant.hoursBeforeUnits) await hours(call, propertyId, variant);

  let entrance = variant.entrance;
  const addEntrance = async () => {
    const added = await call("add_door", { property: propertyId, name: variant.entrance, kind: "entrance" });
    const door = added.door as { name?: string } | undefined;
    entrance = door?.name ?? variant.entrance;
  };
  if (variant.entranceFirst) await addEntrance();

  const units = await addUnits(call, propertyId, variant);
  await details(call, propertyId, variant, units.nameA, units.nameB);
  if (!variant.entranceFirst) await addEntrance();

  const pairs = variant.reverseUnits
    ? [
        [units.nameB, units.doorB],
        [units.nameA, units.doorA],
      ]
    : [
        [units.nameA, units.doorA],
        [units.nameB, units.doorB],
      ];
  for (const [unit, door] of pairs) await route(call, propertyId, variant, unit!, [entrance, door!]);

  if (!variant.hoursBeforeUnits) await hours(call, propertyId, variant);
  await call("set_verification_policy", { property: propertyId, level: "basic-form" });
  await call("update_property_details", { property: propertyId, skipVisitorHelp: true });
  return { propertyId, nameA: units.nameA, nameB: units.nameB };
}

/** Today's hosted demo order up to a published duplex: local texting, decline backups, property, skip alerts. */
export async function publishDuplex(session: EvalSession, variant: DuplexVariant): Promise<{ propertyId: string; nameA: string; nameB: string }> {
  const call = session.call.bind(session);
  await call("choose_messaging_provider", { provider: "local" });
  const tested = await call("test_visitor_messaging");
  if (tested.ok !== true) fail(variant.id, "test_visitor_messaging", tested);
  await call("decline_portable_backup");
  const setup = await setupDuplex(session, variant);
  await call("review_property_setup", { property: setup.propertyId });
  await call("skip_optional_setup", { component: "OPERATOR_ALERTS" });
  const readiness = await call("run_readiness_check", { property: setup.propertyId });
  if (readiness.passed !== true) fail(variant.id, "run_readiness_check", readiness);
  const dry = await call("run_dry_tour", { property: setup.propertyId });
  if (dry.passed !== true) fail(variant.id, "run_dry_tour", dry);
  const published = await confirm(session, "publish_demo_property", { property: setup.propertyId });
  if (published.published !== true) fail(variant.id, "publish_demo_property", published);
  return setup;
}
