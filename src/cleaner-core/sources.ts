import { interpretFeed, isCalendarBlock, type FeedBlock, type FeedRead, type Turnover } from "./calendar";

export type BookingSourceKind = "guesty-lite" | "google-calendar";

export interface SourceSnapshot {
  kind: BookingSourceKind;
  tenantId: string;
  turnovers: Turnover[];
  blocks: FeedBlock[];
}

/**
 * One read of one booking source. A live Google Calendar connector implements
 * this same method. The demo ships only the fixture reader. See
 * docs/cleaner-core-v5.1-step-e-rationale.md for the live connector.
 */
export interface BookingSource {
  readonly kind: BookingSourceKind;
  read(): Promise<SourceSnapshot>;
}

export interface SourceConflict {
  jobId: string;
  checkoutDate: string;
  otherCheckoutDate: string;
}

export interface NormalizedSources {
  feed: FeedRead;
  conflicts: SourceConflict[];
}

const SOURCE_ORDER: BookingSourceKind[] = ["guesty-lite", "google-calendar"];

export function guestyLiteSource(ical: string, tenantId: string): BookingSource {
  return {
    kind: "guesty-lite",
    async read() {
      const feed = interpretFeed(ical);
      return { kind: "guesty-lite", tenantId, turnovers: feed.turnovers, blocks: feed.blocks };
    },
  };
}

/**
 * Reads a saved Calendar API `events.list` document. No network and no credentials.
 * A cancelled event is omitted, which is how a removed event leaves the snapshot.
 */
export function googleCalendarFixtureSource(body: string): BookingSource {
  return {
    kind: "google-calendar",
    async read() {
      return readGoogleCalendarFixture(body);
    },
  };
}

export function readGoogleCalendarFixture(body: string): SourceSnapshot {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error("Google Calendar fixture is not JSON.");
  }
  if (!parsed || typeof parsed !== "object") throw new Error("Google Calendar fixture is not a calendar.");
  const record = parsed as { tenantId?: unknown; timeZone?: unknown; items?: unknown };
  if (typeof record.tenantId !== "string" || record.tenantId.trim() === "") {
    throw new Error("Google Calendar fixture needs a tenantId.");
  }
  const timeZone = typeof record.timeZone === "string" && record.timeZone.trim() !== "" ? record.timeZone : "America/New_York";
  const items = Array.isArray(record.items) ? record.items : [];
  const stays: Turnover[] = [];
  const blocks: FeedBlock[] = [];
  for (const item of items) {
    const event = readGoogleEvent(item, timeZone);
    if (!event) continue;
    if (event.block) {
      blocks.push({ uid: event.uid, summary: event.summary });
      continue;
    }
    stays.push({
      id: event.uid,
      departingUid: event.uid,
      arrivingUid: null,
      checkInDate: event.checkInDate,
      checkoutDate: event.checkOutDate,
      nextCheckInDate: null,
      sameDay: false,
      sequence: event.sequence,
      contentHash: "",
    });
  }
  return {
    kind: "google-calendar",
    tenantId: record.tenantId,
    turnovers: linkStays(stays),
    blocks,
  };
}

/**
 * Guesty Lite is the aggregator when both sources have the same stay.
 * Same check-in or same checkout is one booking. A block never becomes a stay.
 * Dates on the merged job come from Guesty Lite. A Google-only date disagreement
 * is a conflict and does not open a second job.
 */
export function normalizeSnapshots(snapshots: SourceSnapshot[]): NormalizedSources {
  const ordered = SOURCE_ORDER.flatMap((kind) => snapshots.filter((snapshot) => snapshot.kind === kind));
  const guesty = ordered.find((snapshot) => snapshot.kind === "guesty-lite");
  const google = ordered.find((snapshot) => snapshot.kind === "google-calendar");
  const primary = guesty?.turnovers ?? [];
  const extra = google?.turnovers ?? [];
  const used = new Set<string>();
  const conflicts: SourceConflict[] = [];
  for (const stay of primary) {
    const match = extra.find((other) => !used.has(other.id) && sameBooking(stay, other));
    if (!match) continue;
    used.add(match.id);
    if (match.checkoutDate !== stay.checkoutDate) {
      conflicts.push({ jobId: stay.id, checkoutDate: stay.checkoutDate, otherCheckoutDate: match.checkoutDate });
    }
  }
  const turnovers = linkStays([...primary, ...extra.filter((stay) => !used.has(stay.id))]);
  const blocks = ordered.flatMap((snapshot) => snapshot.blocks);
  return { feed: { turnovers, blocks }, conflicts };
}

export function linkStays(turnovers: Turnover[]): Turnover[] {
  return turnovers.map((stay) => {
    const next = turnovers
      .filter((other) => other.id !== stay.id && other.checkInDate >= stay.checkoutDate)
      .sort((a, b) => a.checkInDate.localeCompare(b.checkInDate) || a.id.localeCompare(b.id))[0];
    const nextCheckInDate = next?.checkInDate ?? null;
    const arrivingUid = next?.id ?? null;
    return {
      ...stay,
      nextCheckInDate,
      arrivingUid,
      sameDay: nextCheckInDate === stay.checkoutDate,
      contentHash: `${stay.checkoutDate}|${nextCheckInDate ?? ""}|${arrivingUid ?? ""}`,
    };
  });
}

function sameBooking(primary: Turnover, other: Turnover): boolean {
  if (primary.checkoutDate === other.checkoutDate) return true;
  return primary.checkInDate !== "" && primary.checkInDate === other.checkInDate;
}

interface GoogleEvent {
  uid: string;
  summary: string;
  checkInDate: string;
  checkOutDate: string;
  sequence: number;
  block: boolean;
}

function readGoogleEvent(item: unknown, timeZone: string): GoogleEvent | undefined {
  if (!item || typeof item !== "object") return undefined;
  const event = item as {
    id?: unknown;
    status?: unknown;
    summary?: unknown;
    description?: unknown;
    sequence?: unknown;
    eventType?: unknown;
    start?: { date?: unknown; dateTime?: unknown };
    end?: { date?: unknown; dateTime?: unknown };
  };
  if (typeof event.status === "string" && event.status.toLowerCase() === "cancelled") return undefined;
  if (typeof event.id !== "string" || event.id.trim() === "") return undefined;
  const checkInDate = googleDate(event.start, timeZone);
  const checkOutDate = googleDate(event.end, timeZone);
  if (!checkInDate || !checkOutDate || checkOutDate <= checkInDate) return undefined;
  const summary = typeof event.summary === "string" ? event.summary : "";
  const description = typeof event.description === "string" ? event.description : "";
  const sequence = typeof event.sequence === "number" && Number.isFinite(event.sequence) ? event.sequence : 0;
  const eventType = typeof event.eventType === "string" ? event.eventType : "";
  const block = eventType === "outOfOffice" || isCalendarBlock(summary, description);
  return { uid: `google:${event.id}`, summary, checkInDate, checkOutDate, sequence, block };
}

function googleDate(field: { date?: unknown; dateTime?: unknown } | undefined, timeZone: string): string | undefined {
  if (!field) return undefined;
  if (typeof field.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(field.date)) return field.date;
  if (typeof field.dateTime !== "string") return undefined;
  const instant = new Date(field.dateTime);
  if (Number.isNaN(instant.getTime())) return undefined;
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(instant);
}
