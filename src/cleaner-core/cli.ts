import { pathToFileURL } from "node:url";
import { cleanerCoreEnabled } from "./flag";
import { openCleanerCore, type CleanerText } from "./core";
import { isScratchTestNumber } from "./scratch";

/**
 * Launch: `npx tsx src/cleaner-core/cli.ts doctor` or
 * `CLEANER_CORE_ENABLED=1 npx tsx src/cleaner-core/cli.ts smoke`.
 * Ready: doctor prints JSON and `"sends": false`. Smoke exits 0 only after one Scratch turnover.
 * Teardown: the process exits. It does not listen.
 * Drive: smoke reads a Guesty Lite-style iCal fixture and texts the test owner.
 * With no `--reply`, it injects YES from the owner and texts the door code only to the approved test cleaner.
 * `--reply <from>=<text>` is repeatable and replaces that YES. `from` must be a Scratch test number.
 * Any other argument fails the process and sends nothing.
 * Evidence: JSON on stdout (`sent`, `pinRecipients`). No socket is opened.
 */
export interface DoctorReport {
  ok: true;
  enabled: boolean;
  sends: false;
  note: string;
}

export interface SmokeReply {
  from: string;
  text: string;
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

export async function runSmoke(env: NodeJS.ProcessEnv = process.env, replies?: SmokeReply[]): Promise<SmokeReport> {
  if (replies) {
    for (const reply of replies) {
      if (!isScratchTestNumber(reply.from)) {
        throw new Error(`Cleaner Core only texts Scratch test numbers. Refusing ${reply.from}.`);
      }
    }
  }
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
  if (replies) {
    for (let i = 0; i < replies.length; i++) {
      const reply = replies[i];
      if (!reply) throw new Error("Cleaner Core failed");
      await core.receive({ id: `smoke-reply-${i + 1}`, from: reply.from, text: reply.text });
    }
  } else {
    await core.receive({ id: "smoke-yes", from: OWNER, text: "YES" });
  }
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

const DOCTOR_USAGE = "Usage: tsx src/cleaner-core/cli.ts doctor";
const SMOKE_USAGE = "Usage: tsx src/cleaner-core/cli.ts smoke [--reply <from>=<text> ...]";

export function parseSmokeArgs(argv: string[]): SmokeReply[] | undefined {
  const replies: SmokeReply[] = [];
  let sawReply = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--reply") {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) throw new Error(`smoke --reply needs <from>=<text>. ${SMOKE_USAGE}`);
      i++;
      sawReply = true;
      const eq = value.indexOf("=");
      if (eq <= 0) throw new Error(`smoke --reply must look like <from>=<text>. Got ${value}. ${SMOKE_USAGE}`);
      const from = value.slice(0, eq);
      const text = value.slice(eq + 1);
      if (text.length === 0) throw new Error(`smoke --reply text is empty for ${from}. ${SMOKE_USAGE}`);
      if (!isScratchTestNumber(from)) throw new Error(`Cleaner Core only texts Scratch test numbers. Refusing ${from}.`);
      replies.push({ from, text });
      continue;
    }
    throw new Error(`Unexpected argument ${arg ?? ""}. ${SMOKE_USAGE}`);
  }
  return sawReply ? replies : undefined;
}

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command === "doctor") {
    const extra = process.argv[3];
    if (extra !== undefined) throw new Error(`Unexpected argument ${extra}. ${DOCTOR_USAGE}`);
    process.stdout.write(`${JSON.stringify(runDoctor(), null, 2)}\n`);
    return;
  }
  if (command === "smoke") {
    const replies = parseSmokeArgs(process.argv.slice(3));
    const report = await runSmoke(process.env, replies);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (!report.ok) process.exit(2);
    return;
  }
  process.stderr.write(`${DOCTOR_USAGE}\n${SMOKE_USAGE}\n`);
  process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.message : "Cleaner Core failed"}\n`);
    process.exit(1);
  });
}
