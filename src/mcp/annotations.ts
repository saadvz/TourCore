import type { ToolKind } from "../operator/tools";

/**
 * MCP hints only. They do not change tool behavior or confirmation checks.
 * A non-read-only tool defaults to destructive in the MCP spec, so every
 * write sets destructiveHint explicitly.
 */

/**
 * Phase 4 destructive tools are cancel_tour and restore_records, plus the
 * existing remove_property. revoke_tour_access and import_portable_backup
 * stay destructive so those older tools keep the hint they already had.
 */
const DESTRUCTIVE = new Set(["cancel_tour", "restore_records", "remove_property", "revoke_tour_access", "import_portable_backup"]);

/**
 * The plan didn't cover these. Keep today's hint instead of flipping them.
 */
export const KEPT_ANNOTATION_TOOLS = ["reset_hosted_demo", "disconnect_google_drive_storage", "takeover_storage_writer", "migrate_storage_to_google_drive"] as const;

/**
 * Reads whose handlers write. readOnlyHint stays false, and destructiveHint
 * is explicitly false.
 */
const SIDE_EFFECT_READS = new Set(["get_next_installation_step", "get_installation_status", "get_installation_component", "check_runtime_health", "verify_storage_migration"]);

export interface ToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: false;
}

export function annotationsFor(tool: { name: string; kind: ToolKind }): ToolAnnotations {
  const kept = (KEPT_ANNOTATION_TOOLS as readonly string[]).includes(tool.name);
  if (kept) {
    const destructiveHint = tool.kind === "consequential";
    return { readOnlyHint: false, destructiveHint, idempotentHint: false, openWorldHint: false };
  }
  if (DESTRUCTIVE.has(tool.name)) {
    return { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };
  }
  const readOnlyHint = tool.kind === "read" && !SIDE_EFFECT_READS.has(tool.name);
  if (readOnlyHint) return { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
  return { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
}

export const ANNOTATION_DECISIONS_FOR_SAAD = [
  {
    name: "reset_hosted_demo",
    decision: "Kept destructiveHint true. It was already consequential. The plan did not name it, so it was not flipped.",
  },
  {
    name: "disconnect_google_drive_storage",
    decision: "Kept destructiveHint true. It was already consequential. The plan did not name it, so it was not flipped.",
  },
  {
    name: "takeover_storage_writer",
    decision: "Kept destructiveHint true. It was already consequential. The plan did not name it, so it was not flipped.",
  },
  {
    name: "migrate_storage_to_google_drive",
    decision: "Kept destructiveHint false. It was already an ordinary write (kind change), not consequential. It was not upgraded to destructive.",
  },
  {
    name: "activate_google_drive_storage",
    decision: "Marked destructiveHint false. It was consequential, and it is not one of the three destructive tools or the kept edge cases. Saad can put it back.",
  },
] as const;
