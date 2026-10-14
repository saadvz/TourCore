export interface TurnoverWindow {
  checkout: string;
  nextArrival: string;
}

const CHECKOUT_LOCAL = "11:00";
const CHECK_IN_LOCAL = "16:00";
const MINIMUM_MINUTES = 120;

/**
 * Same-day gap between one stay's checkout and the next stay's check-in.
 * Guesty Lite publishes reservations as an iCal feed. This reads that text.
 * It does not call the Guesty API, and a free night is not a turnover.
 */
export function turnoverFromIcal(ical: string, timeZone: string, now: Date): TurnoverWindow | undefined {
  const stays = reservations(ical, timeZone).sort((a, b) => Date.parse(a.checkOut) - Date.parse(b.checkOut));
  const nowMs = now.getTime();
  for (let i = 0; i < stays.length - 1; i++) {
    const previous = stays[i];
    const next = stays[i + 1];
    if (!previous || !next) continue;
    if (localDay(previous.checkOut, timeZone) !== localDay(next.checkIn, timeZone)) continue;
    if (Date.parse(next.checkIn) - Date.parse(previous.checkOut) < MINIMUM_MINUTES * 60_000) continue;
    if (Date.parse(previous.checkOut) <= nowMs) continue;
    return { checkout: previous.checkOut, nextArrival: next.checkIn };
  }
  return undefined;
}

interface Reservation {
  checkIn: string;
  checkOut: string;
}

function reservations(ical: string, timeZone: string): Reservation[] {
  const text = ical.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\n[ \t]/g, "");
  const found: Reservation[] = [];
  for (const match of text.matchAll(/BEGIN:VEVENT\n([\s\S]*?)END:VEVENT/g)) {
    const block = match[1] ?? "";
    const start = prop(block, "DTSTART");
    const end = prop(block, "DTEND");
    if (!start || !end) continue;
    const checkIn = instant(start, "checkIn", timeZone);
    const checkOut = instant(end, "checkOut", timeZone);
    if (checkIn && checkOut && Date.parse(checkOut) > Date.parse(checkIn)) found.push({ checkIn, checkOut });
  }
  return found;
}

function prop(block: string, name: string): { params: string; value: string } | undefined {
  for (const line of block.split("\n")) {
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const left = line.slice(0, idx);
    const [key, ...params] = left.split(";");
    if (key?.toUpperCase() === name) return { params: params.join(";"), value: line.slice(idx + 1).trim() };
  }
  return undefined;
}

function instant(field: { params: string; value: string }, role: "checkIn" | "checkOut", timeZone: string): string | undefined {
  const dateOnly = /^(\d{4})(\d{2})(\d{2})$/.exec(field.value);
  if (dateOnly) {
    const ymd = `${dateOnly[1]}-${dateOnly[2]}-${dateOnly[3]}`;
    return zonedInstant(ymd, role === "checkOut" ? CHECKOUT_LOCAL : CHECK_IN_LOCAL, timeZone);
  }
  const timed = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/.exec(field.value);
  if (!timed) return undefined;
  if (timed[7] === "Z") {
    return new Date(Date.UTC(Number(timed[1]), Number(timed[2]) - 1, Number(timed[3]), Number(timed[4]), Number(timed[5]), Number(timed[6]))).toISOString();
  }
  const tzid = /TZID=([^;]+)/.exec(field.params)?.[1] ?? timeZone;
  return zonedInstant(`${timed[1]}-${timed[2]}-${timed[3]}`, `${timed[4]}:${timed[5]}`, tzid);
}

function zonedInstant(ymd: string, hm: string, timeZone: string): string {
  const [year, month, day] = ymd.split("-").map(Number);
  const [hour, minute] = hm.split(":").map(Number);
  if (!year || !month || !day || hour === undefined || minute === undefined) throw new Error("Bad local time");
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const refined = zoneOffsetMs(new Date(guess - zoneOffsetMs(new Date(guess), timeZone)), timeZone);
  return new Date(guess - refined).toISOString();
}

function zoneOffsetMs(instant: Date, timeZone: string): number {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts: Record<string, string> = {};
  for (const part of fmt.formatToParts(instant)) parts[part.type] = part.value;
  const asUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour) % 24, Number(parts.minute), Number(parts.second));
  return asUtc - instant.getTime();
}

function localDay(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
}
