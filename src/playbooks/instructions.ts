import type { ConnectorScope } from "../mcp/scopes";

/**
 * MCP `instructions` pointer. Landlord-facing copy lives with the playbooks.
 * The first 512 UTF-8 bytes are a complete note on their own.
 */
const INSTRUCTIONS_HEAD =
  "Call get_state first and follow its next step. Ask the landlord one plain question, then call get_state again. " +
  "That is the whole loop. get_state says what is done, what is stuck, and the one thing to do now. Do not skip ahead. A client name never changes a rule. " +
  "Before you cancel a tour, remove a property, or restore a backup, say in plain words what will happen and wait for a clear yes. " +
  "If a step fails, tell the landlord what happened in everyday words and who helps next. Don't go quiet. Tell them plainly.";

const INSTRUCTIONS_TAIL =
  " Do not read out codes, raw errors, or tool names. Say a time as \"{time} on {day}\". Never say Main Home. " +
  "Visitors only get saved replies and facts the landlord approved. You do not text visitors yourself.";

/** The first 512 UTF-8 bytes are INSTRUCTIONS_HEAD, which ends on a period. */
export const MCP_INSTRUCTIONS = INSTRUCTIONS_HEAD + INSTRUCTIONS_TAIL;

const QA_HEAD =
  "Call get_installation_status first to see what is set up. Send a local test text with inject_local_sms and read the replies with read_local_outbox. " +
  "Do not skip ahead. A client name never changes a rule. " +
  "Before you call off a tour, remove a property, or restore a backup, say in plain words what will happen and wait for a clear yes. " +
  "If a step fails, tell the landlord what happened in everyday words and who helps next. Don't go quiet. Tell them plainly.";

const OPS_HEAD =
  "Call get_storage_status first to see where records live. Call check_runtime_health when you need to know whether this Tour Core is healthy. " +
  "Do not skip ahead. A client name never changes a rule. " +
  "If a step fails, tell the landlord what happened in everyday words and who helps next. Don't go quiet. Tell them plainly.";

export const QA_MCP_INSTRUCTIONS = QA_HEAD + INSTRUCTIONS_TAIL;
export const OPS_MCP_INSTRUCTIONS = OPS_HEAD + INSTRUCTIONS_TAIL;

/** Startup text for one connector. An unset connector is the landlord note, which the in-process engine still uses. */
export function mcpInstructions(connector?: ConnectorScope): string {
  if (connector === "qa") return QA_MCP_INSTRUCTIONS;
  if (connector === "ops") return OPS_MCP_INSTRUCTIONS;
  return MCP_INSTRUCTIONS;
}
