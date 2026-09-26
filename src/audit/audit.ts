import { newId, type AuditEvent, type AuditEventType } from "../domain/model";
import type { Clock } from "../core/clock";
import { formatTime } from "../core/timezone";
import type { TourCoreStore } from "../storage/Store";

export type AuditInput = Omit<AuditEvent, "id" | "seq" | "at" | "type">;

export class AuditLog {
  private seq = 0;
  constructor(
    private readonly store: TourCoreStore,
    private readonly clock: Clock,
  ) {}

  async record(type: AuditEventType, input: AuditInput): Promise<AuditEvent> {
    const event: AuditEvent = { id: newId("evt"), seq: ++this.seq, type, at: this.clock.now().toISOString(), ...input };
    await this.store.appendAudit(event);
    return event;
  }
}

export function formatAudit(events: AuditEvent[], timeZone: string): string {
  return events
    .map((e) => {
      const time = formatTime(new Date(e.at), timeZone);
      const parts = [
        String(e.seq).padStart(3),
        time.padStart(8),
        e.type.padEnd(24),
        e.doorId ? `door=${e.doorId}` : "",
        e.code ? `code=${e.code}` : "",
        e.statusChange ? `${e.statusChange.from}->${e.statusChange.to}` : "",
        e.detail,
      ];
      return parts.filter(Boolean).join("  ");
    })
    .join("\n");
}

const CSV_COLUMNS = ["seq", "at", "type", "reservationId", "prospectId", "doorId", "code", "statusFrom", "statusTo", "detail"] as const;

export function auditToCsv(events: AuditEvent[]): string {
  const esc = (v: unknown) => {
    const s = v === undefined ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const rows = events.map((e) =>
    [e.seq, e.at, e.type, e.reservationId, e.prospectId, e.doorId, e.code, e.statusChange?.from, e.statusChange?.to, e.detail]
      .map(esc)
      .join(","),
  );
  return [CSV_COLUMNS.join(","), ...rows].join("\n") + "\n";
}
