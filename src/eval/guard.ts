import { forbiddenHit } from "./forbidden";

/**
 * Live Scratch guard. Every tool call goes through assertLiveCall before the
 * network, and noteLiveResult after. The run may only touch properties it
 * created in this process, and only on local test texting.
 */
export class EvalGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvalGuardError";
  }
}

export interface GuardState {
  runId: string;
  ownedPropertyIds: Set<string>;
  /** Property ids whose set_services (or property-scoped local provider) already selected local test texting. */
  localTexting: Set<string>;
  observedExceptionIds: Set<string>;
  observedTourRefs: Set<string>;
  observedReservationIds: Set<string>;
  observedTourTimeRequestIds: Set<string>;
  /** Ids a prefix sweep may remove, and no other tool may use. */
  sweepPropertyIds: Set<string>;
}

export function newGuardState(runId: string): GuardState {
  return {
    runId,
    ownedPropertyIds: new Set(),
    localTexting: new Set(),
    observedExceptionIds: new Set(),
    observedTourRefs: new Set(),
    observedReservationIds: new Set(),
    observedTourTimeRequestIds: new Set(),
    sweepPropertyIds: new Set(),
  };
}

/** Install-wide writes. Any of these can change texting, storage, or another landlord's property. */
export const INSTALL_WIDE_WRITES = [
  "choose_messaging_line",
  "reset_hosted_demo",
  "decline_portable_backup",
  "confirm_backup_destination",
  "confirm_backup_stored",
  "create_portable_backup",
  "use_local_demo_storage",
  "begin_google_drive_connect",
  "finish_google_drive_setup",
  "prepare_storage_migration",
  "migrate_storage_to_google_drive",
  "verify_storage_migration",
  "activate_google_drive_storage",
  "discover_storage",
  "takeover_storage_writer",
  "disconnect_google_drive_storage",
  "import_portable_backup",
  "begin_restore_upload",
  "preview_portable_restore",
  "set_notification_preferences",
  "skip_optional_setup",
  "test_operator_alerts",
  "test_storage",
  "test_visitor_messaging",
  "test_access",
  "check_public_endpoint",
  "get_secure_setup_url",
] as const;

const INSTALL_WIDE = new Set<string>(INSTALL_WIDE_WRITES);

/**
 * Reads that do not take a property.
 * `get_next_installation_step` is absent on purpose: reading the next step
 * persists the messaging selection and can rewrite the saved texting-provider choice.
 */
export const LIVE_INSTALL_READS = [
  "get_installation_status",
  "get_installation_component",
  "list_properties",
  "get_backup_status",
  "check_runtime_health",
  "get_notification_preferences",
] as const;

const INSTALL_READS = new Set<string>(LIVE_INSTALL_READS);

const PROPERTY_SCOPED = new Set([
  "update_property_details",
  "add_unit",
  "update_unit",
  "set_unit_details",
  "add_door",
  "preview_route",
  "set_route",
  "set_tour_hours",
  "set_verification_policy",
  "get_tour_hours",
  "get_verification_policy",
  "review_property_setup",
  "get_property_setup",
  "list_units",
  "list_doors",
  "get_unit_details",
  "get_route",
  "get_services",
  "run_readiness_check",
  "run_dry_tour",
  "list_exceptions",
  "list_active_tours",
  "read_local_outbox",
  "export_audit",
  "pause_tours",
  "resume_tours",
  "remove_property",
  "publish_demo_property",
  "schedule_one_off_tour",
  "inject_local_sms",
  "list_tour_time_requests",
]);

const NEEDS_LOCAL = new Set(["publish_demo_property", "schedule_one_off_tour", "inject_local_sms"]);

const ID_TOOLS: Record<string, "exceptionId" | "tourRef" | "tourTimeRequestId"> = {
  inspect_exception: "exceptionId",
  answer_flagged_question: "exceptionId",
  resolve_exception: "exceptionId",
  inspect_tour: "tourRef",
  place_operator_hold: "tourRef",
  clear_operator_hold: "tourRef",
  revoke_tour_access: "tourRef",
  inspect_tour_time_request: "tourTimeRequestId",
  approve_tour_time_request: "tourTimeRequestId",
  decline_tour_time_request: "tourTimeRequestId",
  propose_tour_time: "tourTimeRequestId",
};

export function evalNamePrefix(runId: string): string {
  return `eval-${runId}`;
}

function refuse(message: string): never {
  throw new EvalGuardError(message);
}

function ownedProperty(state: GuardState, property: unknown, tool: string): string {
  if (typeof property !== "string" || !property.trim()) {
    refuse(`Refusing ${tool}: it needs a property id this run created. Omitting it could hit another building.`);
  }
  if (!state.ownedPropertyIds.has(property)) {
    refuse(`Refusing ${tool}: property id "${property}" is not one this run created.`);
  }
  return property;
}

function observed(state: GuardState, kind: "exceptionId" | "tourRef" | "reservationId" | "tourTimeRequestId", id: unknown, tool: string): void {
  const set =
    kind === "exceptionId"
      ? state.observedExceptionIds
      : kind === "tourRef"
        ? state.observedTourRefs
        : kind === "reservationId"
          ? state.observedReservationIds
          : state.observedTourTimeRequestIds;
  if (typeof id !== "string" || !set.has(id)) {
    refuse(`Refusing ${tool}: ${kind} is not one this run observed on a property it created.`);
  }
}

/**
 * Hard-stop before the tool call. A foreign property id, a protected name,
 * an install-wide write, or live texting never reaches the server.
 */
export function assertLiveCall(state: GuardState, name: string, args: Record<string, unknown> = {}): void {
  const forbidden = forbiddenHit(args);
  if (forbidden) refuse(`Refusing ${name}: arguments mention a protected property (145 Tenafly Road or 914B).`);

  if (name === "get_next_installation_step") {
    refuse("Refusing get_next_installation_step: it can rewrite the saved texting-provider choice.");
  }

  if (INSTALL_WIDE.has(name)) {
    refuse(`Refusing ${name}: that changes the whole installation, not a property this run created.`);
  }

  if (name === "create_property_setup") {
    const prefix = evalNamePrefix(state.runId);
    const displayName = typeof args.name === "string" ? args.name : "";
    const address = typeof args.address === "string" ? args.address : "";
    if (!displayName.startsWith(prefix)) {
      refuse(`Refusing create_property_setup: the name must start with ${prefix}.`);
    }
    if (!address.includes(state.runId)) {
      refuse(`Refusing create_property_setup: the address must include this run id (${state.runId}).`);
    }
    return;
  }

  if (name === "choose_messaging_provider") {
    if (args.provider !== "local") {
      refuse(`Refusing choose_messaging_provider: provider "${String(args.provider)}" would change the live texting line.`);
    }
    if (typeof args.property !== "string") {
      refuse("Refusing choose_messaging_provider: without a property this run created, that would change texting for the whole installation.");
    }
    ownedProperty(state, args.property, name);
    return;
  }

  if (name === "set_services") {
    ownedProperty(state, args.property, name);
    if (args.messaging !== "local") {
      refuse(`Refusing set_services: messaging "${String(args.messaging ?? "")}" would use the real texting line. This run only uses local test texting.`);
    }
    if (args.records !== undefined) {
      refuse("Refusing set_services: changing where records are kept is an install-wide storage change.");
    }
    return;
  }

  const idField = ID_TOOLS[name];
  if (idField) {
    observed(state, idField, args[idField], name);
    if (args.property !== undefined) ownedProperty(state, args.property, name);
    return;
  }

  if (name === "reschedule_tour") {
    const reservation = args.reservationId;
    const tour = args.tourRef;
    if (reservation !== undefined) observed(state, "reservationId", reservation, name);
    else if (tour !== undefined) observed(state, "tourRef", tour, name);
    else refuse("Refusing reschedule_tour: it needs a reservation or tour this run observed on a property it created.");
    if (args.property !== undefined) ownedProperty(state, args.property, name);
    return;
  }

  if (name === "remove_property" && typeof args.property === "string" && state.sweepPropertyIds.has(args.property)) {
    return;
  }

  if (PROPERTY_SCOPED.has(name)) {
    const property = ownedProperty(state, args.property, name);
    if (NEEDS_LOCAL.has(name) && !state.localTexting.has(property)) {
      refuse(`Refusing ${name}: local test texting is not set on this property yet.`);
    }
    return;
  }

  if (INSTALL_READS.has(name)) {
    if (args.property !== undefined) ownedProperty(state, args.property, name);
    return;
  }

  refuse(`Refusing ${name}: this live run only calls tools against properties it created.`);
}

function harvest(state: GuardState, value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) harvest(state, item);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (key === "exceptionId" && typeof child === "string") state.observedExceptionIds.add(child);
    else if (key === "tourRef" && typeof child === "string") state.observedTourRefs.add(child);
    else if (key === "reservationId" && typeof child === "string") state.observedReservationIds.add(child);
    else if (key === "tourTimeRequestId" && typeof child === "string") state.observedTourTimeRequestIds.add(child);
    else harvest(state, child);
  }
}

function scopedToOwned(state: GuardState, args: Record<string, unknown>): boolean {
  if (typeof args.property === "string" && state.ownedPropertyIds.has(args.property)) return true;
  if (typeof args.tourRef === "string" && state.observedTourRefs.has(args.tourRef)) return true;
  if (typeof args.exceptionId === "string" && state.observedExceptionIds.has(args.exceptionId)) return true;
  if (typeof args.reservationId === "string" && state.observedReservationIds.has(args.reservationId)) return true;
  if (typeof args.tourTimeRequestId === "string" && state.observedTourTimeRequestIds.has(args.tourTimeRequestId)) return true;
  return false;
}

/** Records ids the server just returned. Already-exists is not adopted. */
export function noteLiveResult(state: GuardState, name: string, args: Record<string, unknown>, result: unknown): void {
  if (name === "create_property_setup") {
    const body = result as { status?: string; setup?: { propertyId?: string } };
    if (body.status !== "created" || typeof body.setup?.propertyId !== "string") {
      throw new EvalGuardError(
        `Refusing to adopt a property from create_property_setup (status ${String(body.status)}). This run only keeps properties it just created.`,
      );
    }
    state.ownedPropertyIds.add(body.setup.propertyId);
    return;
  }
  if (name === "set_services" && args.messaging === "local" && typeof args.property === "string") {
    state.localTexting.add(args.property);
  }
  if (name === "choose_messaging_provider" && args.provider === "local" && typeof args.property === "string") {
    state.localTexting.add(args.property);
  }
  if (name === "remove_property") {
    const body = result as { status?: string; removed?: boolean };
    if ((body.status === "removed" || body.removed === true) && typeof args.property === "string") {
      state.ownedPropertyIds.delete(args.property);
      state.localTexting.delete(args.property);
      state.sweepPropertyIds.delete(args.property);
    }
  }
  if (scopedToOwned(state, args)) harvest(state, result);
}

/** Assert, call, then record. The inner function is not invoked when the guard refuses. */
export async function guardedCall<T>(
  state: GuardState,
  inner: (name: string, args: Record<string, unknown>) => Promise<T>,
  name: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  assertLiveCall(state, name, args);
  const result = await inner(name, args);
  noteLiveResult(state, name, args, result);
  return result;
}

/**
 * Why the live script should exit without calling Scratch.
 * Hosted Scratch needs the one-hour sign-in access token. The dev static
 * operator token is not that credential.
 */
export function liveSkipReason(env: NodeJS.ProcessEnv): string | undefined {
  const url = env.TOURCORE_MCP_URL?.trim();
  const token = env.TOURCORE_MCP_TOKEN?.trim();
  if (!url || !token) {
    return "Live Scratch eval skipped: set TOURCORE_MCP_URL and TOURCORE_MCP_TOKEN (the one-hour Tour Core sign-in access token from the owner's Allow click). TOURCORE_OPERATOR_TOKEN is only for dev static-token mode. Nothing was called.";
  }
  return undefined;
}
