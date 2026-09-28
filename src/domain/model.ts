import { randomUUID } from "node:crypto";
import { z } from "zod";

export const SCHEMA_VERSION = 1;

export const ReservationStatusSchema = z.enum([
  "INQUIRY",
  "RESERVED",
  "AWAITING_CONSENT",
  "AWAITING_VERIFICATION",
  "READY",
  "TOURING",
  "COMPLETED",
  "CANCELLED",
  "VERIFICATION_FAILED",
  "EXPIRED",
  "REVOKED",
  "OPERATOR_HOLD",
  "PROVIDER_FAILURE",
]);
export type ReservationStatus = z.infer<typeof ReservationStatusSchema>;

const IsoDate = z.iso.datetime({ offset: true });

export const ProspectSchema = z.object({
  id: z.string(),
  name: z.string(),
  phone: z.string(),
  createdAt: IsoDate,
  /** The visitor asked Tour Core to stop messaging them (STOP, UNSUBSCRIBE, ...). */
  messagingOptedOut: z.boolean().optional(),
});

/** Name used until a visitor who started by text tells us who they are. */
export const UNNAMED_VISITOR = "Visitor";

export const ReservationSchema = z.object({
  id: z.string(),
  prospectId: z.string(),
  propertyId: z.string(),
  unitId: z.string(),
  routeId: z.string(),
  /** Exact, ordered list of Tour Core door ids this reservation may open. */
  allowedRoute: z.array(z.string()).min(1),
  status: ReservationStatusSchema,
  /** Status to return to when an operator hold or provider failure is resolved. */
  heldFromStatus: ReservationStatusSchema.optional(),
  slotStart: IsoDate.optional(),
  windowStart: IsoDate.optional(),
  windowEnd: IsoDate.optional(),
  /**
   * A one-off time outside the property's normal touring hours. The recurring
   * schedule is unchanged; access uses this reservation's own times.
   */
  scheduleOverride: z
    .object({
      kind: z.literal("OUTSIDE_HOURS"),
      approvedAt: IsoDate,
    })
    .optional(),
  consentId: z.string().optional(),
  verificationId: z.string().optional(),
  createdAt: IsoDate,
  updatedAt: IsoDate,
});

export const ConsentSchema = z.object({
  id: z.string(),
  prospectId: z.string(),
  reservationId: z.string(),
  granted: z.boolean(),
  scope: z.array(z.enum(["messaging", "tour_records"])),
  text: z.string(),
  recordedAt: IsoDate,
});

export const VerificationSchema = z.object({
  id: z.string(),
  prospectId: z.string(),
  reservationId: z.string(),
  method: z.enum(["basic-form", "mock"]),
  status: z.enum(["PASSED", "FAILED"]),
  /** Provider reference (form response id). No ID images are ever stored. */
  reference: z.string(),
  claimed: z
    .object({ firstName: z.string(), lastName: z.string(), email: z.string(), phone: z.string() })
    .optional(),
  failureReason: z.string().optional(),
  completedAt: IsoDate,
  validUntil: IsoDate,
});

export const AccessGrantSchema = z.object({
  id: z.string(),
  reservationId: z.string(),
  prospectId: z.string(),
  doorId: z.string(),
  durinGrantRef: z.string(),
  status: z.enum(["ACTIVE", "REVOKED"]),
  validFrom: IsoDate,
  validUntil: IsoDate,
  createdAt: IsoDate,
  revokedAt: IsoDate.optional(),
});

export const MessageSchema = z.object({
  id: z.string(),
  direction: z.enum(["INBOUND", "OUTBOUND"]),
  audience: z.enum(["PROSPECT", "OPERATOR"]),
  channel: z.string(),
  counterparty: z.string(),
  body: z.string(),
  prospectId: z.string().optional(),
  reservationId: z.string().optional(),
  at: IsoDate,
  /** Delivery details reported by the messaging adapter (never credentials). */
  provider: z.string().optional(),
  providerMessageId: z.string().optional(),
  deliveryChannel: z.enum(["IMESSAGE", "SMS", "RCS", "WEB", "DEMO", "UNKNOWN"]).optional(),
  deliveryStatus: z.enum(["QUEUED", "SENT", "DELIVERED", "FAILED", "SUPPRESSED", "SKIPPED", "RECEIVED"]).optional(),
  deliveryError: z.string().optional(),
  correlationId: z.string().optional(),
});

export const AuditEventTypeSchema = z.enum([
  "PROSPECT_CREATED",
  "PROSPECT_RETURNED",
  "INQUIRY_STARTED",
  "RESERVATION_CREATED",
  "CONSENT_REQUESTED",
  "CONSENT_RECORDED",
  "VERIFICATION_REQUESTED",
  "VERIFICATION_COMPLETED",
  "VERIFICATION_REUSED",
  "VERIFICATION_FAILED",
  "TOUR_READY",
  "ACCESS_REQUESTED",
  "ACCESS_ALLOWED",
  "ACCESS_DENIED",
  "ACCESS_REVOKED",
  "TOUR_STARTED",
  "TOUR_COMPLETED",
  "FOLLOW_UP_SENT",
  "RESERVATION_CANCELLED",
  "RESERVATION_REVOKED",
  "OPERATOR_HOLD_PLACED",
  "RESERVATION_RESUMED",
  "PROVIDER_FAILURE",
  "OPERATOR_NOTIFIED",
  "QUESTION_ANSWERED",
  "QUESTION_UNANSWERED",
  "HELP_REQUESTED",
  "FOLLOW_UP_RESPONSE",
  "MESSAGING_OPTED_OUT",
  "MESSAGING_OPTED_IN",
  "MESSAGE_FAILED",
  "RESERVATION_RESCHEDULED",
  "TOUR_TIME_REQUESTED",
  "TOUR_TIME_REQUEST_APPROVED",
  "TOUR_TIME_REQUEST_DECLINED",
  "TOUR_TIME_ALTERNATIVE_PROPOSED",
  "TOUR_RESCHEDULED",
  "TOUR_TIME_OVERRIDE_APPROVED",
]);
export type AuditEventType = z.infer<typeof AuditEventTypeSchema>;

export const AuditEventSchema = z.object({
  id: z.string(),
  seq: z.number().int().positive(),
  type: AuditEventTypeSchema,
  at: IsoDate,
  reservationId: z.string().optional(),
  prospectId: z.string().optional(),
  doorId: z.string().optional(),
  /** The unit a visitor's question was about, when it was asked before (or apart from) a booking. */
  unitId: z.string().optional(),
  code: z.string().optional(),
  detail: z.string(),
  statusChange: z.object({ from: ReservationStatusSchema, to: ReservationStatusSchema }).optional(),
});

export type Prospect = z.infer<typeof ProspectSchema>;
export type Reservation = z.infer<typeof ReservationSchema>;
export type Consent = z.infer<typeof ConsentSchema>;
export type Verification = z.infer<typeof VerificationSchema>;
export type AccessGrant = z.infer<typeof AccessGrantSchema>;
export const TourTimeRequestSchema = z.object({
  id: z.string(),
  propertyId: z.string(),
  prospectId: z.string(),
  /** Set when the visitor already has a reservation, including one that is only an inquiry. */
  reservationId: z.string().optional(),
  /** The unit they had selected, so a request before a confirmed time doesn't lose it. */
  unitId: z.string().optional(),
  requestedStartsAt: IsoDate,
  requestedEndsAt: IsoDate,
  requestSource: z.enum(["VISITOR", "OPERATOR"]),
  status: z.enum(["PENDING", "APPROVED", "DECLINED", "SUPERSEDED"]),
  createdAt: IsoDate,
  resolvedAt: IsoDate.optional(),
  resolvedBy: z.enum(["OPERATOR", "VISITOR"]).optional(),
  operatorNote: z.string().optional(),
  /** A time the property team offered instead. The booking stays put until the visitor accepts. */
  proposedAlternativeAt: IsoDate.optional(),
  /** The provider's message id, so a retried text cannot open a second request. */
  sourceMessageId: z.string().optional(),
});

export type Message = z.infer<typeof MessageSchema>;
export type AuditEvent = z.infer<typeof AuditEventSchema>;
export type TourTimeRequest = z.infer<typeof TourTimeRequestSchema>;

/** Stable ids: assigned once, never reused or rewritten. */
export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
}
