import { pathToFileURL } from "node:url";
import { cleanerCoreEnabled } from "./flag";
import { openCleanerCore, type CleanerText } from "./core";

/**
 * Launch: `npx tsx src/cleaner-core/cli.ts doctor` or
 * `CLEANER_CORE_ENABLED=1 npx tsx src/cleaner-core/cli.ts smoke`.
 * Ready: doctor prints JSON and `"sends": false`. Smoke exits 0 only after one Scratch turnover.
 * Teardown: the process exits. It does not listen.
 * Drive: smoke reads a Guesty Lite-style iCal fixture, texts the test owner, replies YES,
 * and texts the door code only to the approved test cleaner.
 * Evidence: JSON on stdout (`sent`, `pinRecipients`). No socket is opened.
 */
export interface DoctorReport {
  ok: true;
  enabled: boolean;
  sends: false;
  note: string;
}

export interface SmokeReport {
  ok: boolean;
  reason?: "disabled";
  flag?: true;
  property?: string;
  checkout?: string;
  nextArrival?: string;
  sent: CleanerText[];
  pinRecipients: string[];
}

const ADDRESS = "12 Scratch Lane, Teaneck, NJ 07666";
const OWNER = "+15555550100";
const CLEANER = "+15555550101";
const PIN = "4821";

/** Same-day Scratch turnover. The later stay is first. The checkout date is folded. */
const SCRATCH_ICAL = [
  "BEGIN:VCALENDAR",
  "BEGIN:VEVENT",
  "UID:stay-b",
  "DTSTART;VALUE=DATE:20261018",
  "DTEND;VALUE=DATE:20261020",
  "SUMMARY:Reserved",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:stay-a",
  "DTSTART;VALUE=DATE:20261016",
  "DTEND;VALUE=DATE:202610",
  " 18",
  "SUMMARY:Reserved",
  "END:VEVENT",
  "END:VCALENDAR",
].join("\n");

export function runDoctor(env: NodeJS.ProcessEnv = process.env): DoctorReport {
  const enabled = cleanerCoreEnabled(env);
  return {
    ok: true,
    enabled,
    sends: false,
    note: enabled ? "Cleaner Core is on. doctor does not send texts." : "Cleaner Core is off. Touring texts are unchanged.",
  };
}

export async function runSmoke(env: NodeJS.ProcessEnv = process.env): Promise<SmokeReport> {
  if (!cleanerCoreEnabled(env)) return { ok: false, reason: "disabled", sent: [], pinRecipients: [] };
  const sent: CleanerText[] = [];
  const core = openCleanerCore({
    enabled: true,
    property: { id: "prop_12_scratch_lane", address: ADDRESS, timeZone: "America/New_York" },
    ownerPhone: OWNER,
    cleaner: { phone: CLEANER, approved: true },
    pin: PIN,
    consented: true,
    sink: { send: (text) => { sent.push(text); } },
    now: () => new Date("2026-10-14T15:00:00.000Z"),
  });
  const offer = await core.scheduleFromIcal(SCRATCH_ICAL);
  await core.receive({ id: "smoke-yes", from: OWNER, text: "YES" });
  return {
    ok: true,
    flag: true,
    property: ADDRESS,
    checkout: offer.turnover?.checkout,
    nextArrival: offer.turnover?.nextArrival,
    sent,
    pinRecipients: sent.filter((text) => text.kind === "pin").map((text) => text.to),
  };
}

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command === "doctor") {
    process.stdout.write(`${JSON.stringify(runDoctor(), null, 2)}\n`);
    return;
  }
  if (command === "smoke") {
    const report = await runSmoke();
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (!report.ok) process.exit(2);
    return;
  }
  process.stderr.write("Usage: tsx src/cleaner-core/cli.ts doctor|smoke\n");
  process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.message : "Cleaner Core failed"}\n`);
    process.exit(1);
  });
}
