import { z } from "zod";
import { DoorSchema, PropertySchema, RouteSchema, UnitSchema, type TourCoreConfig } from "../config/tourCoreConfig";
import {
  AccessGrantSchema,
  AuditEventSchema,
  ConsentSchema,
  MessageSchema,
  ProspectSchema,
  ReservationSchema,
  SCHEMA_VERSION,
  TourTimeRequestSchema,
  VerificationSchema,
} from "../domain/model";
import type { TourCoreStore } from "../storage/Store";

/** Provider-neutral, versioned export. Validated before it leaves Tour Core. */
export const ExportBundleSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  exportedAt: z.iso.datetime({ offset: true }),
  property: PropertySchema,
  units: z.array(UnitSchema),
  doors: z.array(DoorSchema),
  routes: z.array(RouteSchema),
  prospects: z.array(ProspectSchema),
  reservations: z.array(ReservationSchema),
  consents: z.array(ConsentSchema),
  verifications: z.array(VerificationSchema),
  accessGrants: z.array(AccessGrantSchema),
  messages: z.array(MessageSchema),
  auditEvents: z.array(AuditEventSchema),
  /** Absent on records saved before custom time requests existed. */
  tourTimeRequests: z.array(TourTimeRequestSchema).default([]),
});
export type ExportBundle = z.infer<typeof ExportBundleSchema>;

export async function buildExport(config: TourCoreConfig, store: TourCoreStore, at: Date): Promise<ExportBundle> {
  return ExportBundleSchema.parse({
    schemaVersion: SCHEMA_VERSION,
    exportedAt: at.toISOString(),
    property: config.property,
    units: config.units,
    doors: config.doors,
    routes: config.routes,
    prospects: await store.list("prospects"),
    reservations: await store.list("reservations"),
    consents: await store.list("consents"),
    verifications: await store.list("verifications"),
    accessGrants: await store.list("accessGrants"),
    messages: await store.list("messages"),
    auditEvents: await store.listAudit(),
    tourTimeRequests: await store.list("tourTimeRequests"),
  });
}
