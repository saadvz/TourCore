import { randomBytes } from "node:crypto";
import { DUPLEX_VARIANTS, type DuplexVariant } from "./duplex";
import { evalNamePrefix, guardedCall, liveSkipReason, newGuardState } from "./guard";

export interface LiveReport {
  ok: boolean;
  skipped: boolean;
  reason?: string;
  runId?: string;
  created: string[];
  removed: string[];
  skippedSteps: string[];
  failures: string[];
}

type RawCall = (name: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>;

const SKIPPED_STEPS = [
  "choose_messaging_provider without a property (would change the live texting line)",
  "test_visitor_messaging (would re-test the live line)",
  "decline_portable_backup (install-wide backup choice)",
  "skip_optional_setup and set_notification_preferences (install-wide tour updates)",
  "storage and backup writes",
  "reset_hosted_demo",
];

/**
 * Point the same duplex flow at a live Scratch MCP server.
 * Skips cleanly when the URL or token is absent. Never selects the live line,
 * never calls an install-wide write, and removes every property it created.
 */
export async function runLive(env: NodeJS.ProcessEnv = process.env): Promise<LiveReport> {
  const reason = liveSkipReason(env);
  if (reason) return { ok: true, skipped: true, reason, created: [], removed: [], skippedSteps: [], failures: [] };

  const url = env.TOURCORE_MCP_URL!.trim();
  const token = (env.TOURCORE_MCP_TOKEN?.trim() || env.TOURCORE_OPERATOR_TOKEN?.trim())!;
  const runId = `r${randomBytes(4).toString("hex")}`;
  const state = newGuardState(runId);
  const raw = liveRpc(url, token);
  const call = (name: string, args: Record<string, unknown> = {}) => guardedCall(state, raw, name, args);
  const created: string[] = [];
  const removed: string[] = [];
  const failures: string[] = [];

  for (const [index, variant] of DUPLEX_VARIANTS.entries()) {
    const before = new Set(state.ownedPropertyIds);
    let propertyId: string | undefined;
    try {
      propertyId = await runLiveDuplex(call, liveVariant(variant, runId, index));
    } catch (err) {
      failures.push(`${variant.id}: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      const ownedNow = [...state.ownedPropertyIds].filter((id) => !before.has(id));
      const id = propertyId ?? ownedNow[0];
      if (id && !created.includes(id)) created.push(id);
      if (id && state.ownedPropertyIds.has(id)) {
        try {
          await removeOwned(call, id);
          removed.push(id);
        } catch (err) {
          failures.push(`remove ${id}: ${err instanceof Error ? err.message : String(err)}`);
        }
      } else if (id) {
        removed.push(id);
      }
    }
    if (failures.length) break;
  }

  if (state.ownedPropertyIds.size) {
    for (const id of [...state.ownedPropertyIds]) {
      try {
        await removeOwned(call, id);
        removed.push(id);
      } catch (err) {
        failures.push(`remove ${id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  return {
    ok: failures.length === 0,
    skipped: false,
    runId,
    created,
    removed,
    skippedSteps: SKIPPED_STEPS,
    failures,
  };
}

function liveVariant(variant: DuplexVariant, runId: string, index: number): DuplexVariant {
  return {
    ...variant,
    address: `${100 + index} Eval ${runId} Lane, Teaneck, NJ 07666`,
    displayName: evalNamePrefix(runId),
    timezone: variant.timezone,
  };
}

async function runLiveDuplex(call: RawCall, variant: DuplexVariant): Promise<string> {
  const created = await call("create_property_setup", {
    address: variant.address,
    name: variant.displayName,
    ...(variant.timezone ? { timezone: variant.timezone } : {}),
  });
  const propertyId = (created.setup as { propertyId?: string } | undefined)?.propertyId;
  if (!propertyId) throw new Error("create_property_setup did not return a property id");
  await call("set_services", { property: propertyId, messaging: "local" });

  const confirmAddress = () => call("update_property_details", { property: propertyId, confirmAddress: true });
  const setType = () => call("update_property_details", { property: propertyId, propertyType: "MULTIFAMILY_HOME" });
  if (variant.confirmBeforeType) {
    await confirmAddress();
    await setType();
  } else {
    await setType();
    await confirmAddress();
  }
  if (variant.hoursBeforeUnits) {
    await call("set_tour_hours", { property: propertyId, days: variant.days, start: variant.start, end: variant.end });
  }
  if (variant.entranceFirst) await call("add_door", { property: propertyId, name: variant.entrance, kind: "entrance" });

  const order = variant.reverseUnits
    ? [
        [variant.nameB, variant.doorNameB],
        [variant.nameA, variant.doorNameA],
      ]
    : [
        [variant.nameA, variant.doorNameA],
        [variant.nameB, variant.doorNameB],
      ];
  const stored: Array<{ name: string; door: string }> = [];
  for (const [name, doorName] of order) {
    const added = await call("add_unit", { property: propertyId, name, ...(doorName ? { doorName } : {}) });
    const unit = added.unit as { name?: string; door?: string } | undefined;
    if (!unit?.name || !unit.door) throw new Error(`add_unit did not return a door for ${name}`);
    stored.push({ name: unit.name, door: unit.door });
  }
  const [first, second] = variant.reverseUnits ? [stored[0]!, stored[1]!] : [stored[0]!, stored[1]!];
  const nameA = variant.reverseUnits ? second.name : first.name;
  const nameB = variant.reverseUnits ? first.name : second.name;
  if (variant.details === "bulk") {
    await call("set_unit_details", {
      property: propertyId,
      details: `${nameA} is 2 bed 1 bath for $2,200, available now. ${nameB} is 1 bed 1 bath for $1,950, available October 15.`,
    });
  } else {
    await call("set_unit_details", {
      property: propertyId,
      units: [
        { unit: nameA, bedrooms: 2, bathrooms: 1, monthlyRent: 2200, availability: "now" },
        { unit: nameB, bedrooms: 1, bathrooms: 1, monthlyRent: 1950, availability: "October 15" },
      ],
    });
  }
  if (!variant.entranceFirst) await call("add_door", { property: propertyId, name: variant.entrance, kind: "entrance" });
  for (const unit of stored) {
    const doors = [variant.entrance, unit.door];
    if (variant.preview) {
      const preview = await call("preview_route", { property: propertyId, unit: unit.name, doors });
      const resolved = preview.route as string[] | undefined;
      if (preview.status !== "ok" || !resolved) throw new Error(`preview_route ${unit.name}: ${String(preview.summary)}`);
      await call("set_route", { property: propertyId, unit: unit.name, doors: resolved });
    } else {
      await call("set_route", { property: propertyId, unit: unit.name, doors });
    }
  }
  if (!variant.hoursBeforeUnits) {
    await call("set_tour_hours", { property: propertyId, days: variant.days, start: variant.start, end: variant.end });
  }
  await call("set_verification_policy", { property: propertyId, level: "basic-form" });
  await call("update_property_details", { property: propertyId, skipVisitorHelp: true });
  const readiness = await call("run_readiness_check", { property: propertyId });
  if (readiness.passed !== true) throw new Error(`readiness: ${String(readiness.summary)}`);
  const dry = await call("run_dry_tour", { property: propertyId });
  if (dry.passed !== true) throw new Error(`practice tour: ${String(dry.summary)}`);
  const asked = await call("publish_demo_property", { property: propertyId });
  const code = (asked.confirmation as { code?: string } | undefined)?.code;
  if (!code) throw new Error(`publish did not ask: ${String(asked.summary ?? asked.status)}`);
  const published = await call("publish_demo_property", { property: propertyId, confirmationCode: code });
  if (published.published !== true) throw new Error(`publish: ${String(published.summary)}`);
  return propertyId;
}

async function removeOwned(call: RawCall, propertyId: string): Promise<void> {
  const asked = await call("remove_property", { property: propertyId });
  if (asked.status === "removed") return;
  const code = (asked.confirmation as { code?: string } | undefined)?.code;
  if (!code) throw new Error(`remove did not ask: ${String(asked.summary ?? asked.status)}`);
  const removed = await call("remove_property", { property: propertyId, confirmationCode: code });
  if (removed.status !== "removed" && removed.removed !== true) {
    throw new Error(`remove did not finish: ${String(removed.summary ?? removed.status)}`);
  }
}

function liveRpc(url: string, token: string): RawCall {
  let id = 0;
  return async (name, args) => {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name, arguments: args } }),
    });
    const body = (await res.json()) as {
      error?: { message?: string };
      result?: { isError?: boolean; structuredContent?: Record<string, unknown>; content?: Array<{ text?: string }> };
    };
    if (!res.ok || body.error) throw new Error(body.error?.message ?? `MCP ${name} failed (${res.status})`);
    if (body.result?.isError) throw new Error(body.result.content?.[0]?.text ?? `${name} failed`);
    return body.result?.structuredContent ?? {};
  };
}
