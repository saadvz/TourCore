import { z } from "zod";

/** Reference adapter contract. URLs/tokens stay in private runtime settings. */
export const GrokAgentAdapter = Object.freeze({
  id: "grok" as const,
  transport: "stateless_streamable_http_mcp",
  connectorAuth: "bearer_header",
  trigger: "authenticated_routine_webhook",
  triggerAuth: "authorization_header_value",
  approvalPolicy: "observe_per_probe",
  ownsMessageSending: false,
  supportedProfileModes: ["interactive", "scheduled", "autonomous"] as const,
});

export const GrokWorkEvent = z.strictObject({ schemaVersion: z.literal(1), eventType: z.literal("cleaner.reschedule_requested"),
  eventId: z.string().regex(/^work_[a-f0-9]{32}$/), workId: z.string().regex(/^work_[a-f0-9]{32}$/), deadlineAt: z.iso.datetime(),
}).refine((event) => event.eventId === event.workId, "Event and work IDs must match");

export function grokWorkEvent(work: { id: string; deadlineAt: string }) {
  return GrokWorkEvent.parse({ schemaVersion: 1, eventType: "cleaner.reschedule_requested", eventId: work.id, workId: work.id, deadlineAt: work.deadlineAt });
}

export const GROK_RECEIVER_INSTRUCTIONS = `For eventType=cleaner.reschedule_requested, use workId with only the Cleaner Core connector.
Read current work. Stop if completed, in review, or past deadline. Claim the work before proposing requestedStart with the returned leaseToken, turn.version and stable actionKey grok_<workId>.
Read authoritative status after proposal; accepted alone is not completion. On error, read status and report it without inventing another action key.
The authorized isolated SMS proof permits the engine to send one reply to its configured test phone. The receiver never selects recipients or calls a messaging API.
Record run times and approval behavior without keys, private URLs or lease tokens. Preserve Tour Core and external bookings. Engine deadlines and fallback remain active.`;
