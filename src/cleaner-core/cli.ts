import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { cleanerCoreEnabled } from "./flag";
import { openCleanerCore, type CleanerText, type JobView, type OutboxView, type SyncState } from "./core";
import type { FeedBlock } from "./calendar";
import { isScratchTestNumber } from "./scratch";
import { googleCalendarFixtureSource } from "./sources";
import { scratchTenant } from "./tenants";

/**
 * Launch: `npx tsx src/cleaner-core/cli.ts doctor` or
 * `CLEANER_CORE_ENABLED=1 npx tsx src/cleaner-core/cli.ts smoke`.
 * Ready: doctor prints JSON and `"sends": false`. Smoke exits 0 only after the Scratch script finishes.
 * Teardown: the process exits. It does not listen.
 * Drive: smoke reads a Guesty Lite-style iCal feed and texts the test owner.
 * With no arguments it asks the host, accepts the proposed times, and confirms the cleaning.
 * It does not text a door code unless `--with-pin` is set, and then only after the cleaner opts in
 * and the host says the guests have left. The printed JSON redacts that code.
 * `--reply`, `--feed`, `--then-feed`, `--google`, `--remind`, `--data`, and `--now` run in argument order.
 * `--no-poll` reloads a data directory without reading the feed again.
 * `--google` reads a fixture through the Google Calendar adapter. `--closed` syncs with no open conversation.
 * `--tenant scratch-court` is the second Scratch tenant. It does not read Scratch Lane's calendar on its own.
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

export type SmokeOp =
  | { type: "poll"; ical: string }
  | { type: "google"; body: string }
  | { type: "reply"; from: string; text: string }
  | { type: "remind" }
  | { type: "now"; iso: string }
  | { type: "fail"; n: number };

export interface SmokeReport {
  ok: boolean;
  reason?: "disabled";
  flag?: true;
  property?: string;
  checkout?: string;
  nextArrival?: string;
  sent: CleanerText[];
  pinRecipients: string[];
  jobs?: JobView[];
  outbox?: OutboxView[];
  transcript?: string[];
  blocks?: FeedBlock[];
  tenant?: string;
  sync?: SyncState;
}

const LANE = scratchTenant("scratch-lane");
if (!LANE) throw new Error("Scratch Lane is missing.");
const ADDRESS = LANE.property.address;
const OWNER = LANE.ownerPhone;
const CLEANER = LANE.cleanerPhone;
const NOW = "2026-10-14T15:00:00.000Z";

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

export async function runSmoke(
  env: NodeJS.ProcessEnv = process.env,
  replies?: SmokeReply[],
  extra?: { ops?: SmokeOp[]; dataDir?: string; withPin?: boolean; groupPhones?: string[]; approved?: boolean; tenantId?: string; closed?: boolean; stepE?: boolean },
): Promise<SmokeReport> {
  const tenant = scratchTenant(extra?.tenantId ?? "scratch-lane");
  if (!tenant) throw new Error("Unknown Scratch tenant.");
  const ops = extra?.ops ?? defaultOps(replies);
  for (const op of ops) {
    if (op.type === "reply" && !isScratchTestNumber(op.from)) {
      throw new Error(`Cleaner Core only texts Scratch test numbers. Refusing ${op.from}.`);
    }
  }
  if (!cleanerCoreEnabled(env)) return { ok: false, reason: "disabled", sent: [], pinRecipients: [] };
  const sent: CleanerText[] = [];
  let now = NOW;
  let failures = 0;
  const conversation = extra?.closed ? "closed" : "open";
  const core = openCleanerCore({
    enabled: true,
    tenantId: tenant.id,
    property: tenant.property,
    ownerPhone: tenant.ownerPhone,
    cleaner: { phone: tenant.cleanerPhone, approved: extra?.approved !== false },
    ...(extra?.withPin ? { pin: tenant.pin, hostName: tenant.hostName } : {}),
    ...(extra?.groupPhones?.length ? { groupPhones: extra.groupPhones } : {}),
    consented: true,
    sink: {
      send: (text) => {
        if (failures > 0) {
          failures -= 1;
          throw new Error("send failed");
        }
        sent.push(text);
      },
    },
    now: () => new Date(now),
    ...(extra?.dataDir ? { dataDir: extra.dataDir } : {}),
  });
  for (let index = 0; index < ops.length; index++) {
    const op = ops[index];
    if (!op) continue;
    if (op.type === "now") now = op.iso;
    else if (op.type === "fail") failures += op.n;
    else if (op.type === "poll") await core.pollFeed(op.ical, { conversation });
    else if (op.type === "google") await core.readSource(googleCalendarFixtureSource(op.body), { conversation });
    else if (op.type === "reply") await core.receive({ id: `smoke-op-${index}`, from: op.from, text: op.text });
    else await core.runReminders();
  }
  const jobs = core.jobs();
  const primary = jobs.find((job) => job.status === "done" || job.status === "cleared" || job.status === "in_progress") ?? jobs.find((job) => job.status === "confirmed") ?? jobs.find((job) => job.checkoutAt);
  const report: SmokeReport = {
    ok: true,
    flag: true,
    property: tenant.property.address,
    ...(primary?.checkoutAt ? { checkout: primary.checkoutAt } : {}),
    ...(primary?.nextCheckInAt ? { nextArrival: primary.nextCheckInAt } : {}),
    sent,
    pinRecipients: sent.filter((text) => text.kind === "pin").map((text) => text.to),
    jobs,
    outbox: core.outbox(),
    transcript: core.transcript(),
    blocks: core.blocks(),
    ...(extra?.stepE ? { tenant: tenant.id, sync: core.lastSync() } : {}),
  };
  return JSON.parse(JSON.stringify(report).split(tenant.pin).join("[redacted]")) as SmokeReport;
}

function defaultOps(replies?: SmokeReply[]): SmokeOp[] {
  const ops: SmokeOp[] = [{ type: "poll", ical: SCRATCH_ICAL }];
  if (replies) {
    for (const reply of replies) ops.push({ type: "reply", from: reply.from, text: reply.text });
    return ops;
  }
  ops.push({ type: "reply", from: OWNER, text: "YES" }, { type: "reply", from: OWNER, text: "YES" }, { type: "reply", from: OWNER, text: "YES" });
  return ops;
}

const DOCTOR_USAGE = "Usage: tsx src/cleaner-core/cli.ts doctor";
const SMOKE_USAGE = "Usage: tsx src/cleaner-core/cli.ts smoke [--data <dir>] [--no-poll] [--feed <file>] [--then-feed <file>] [--google <file>] [--tenant scratch-lane|scratch-court] [--closed] [--now <iso>] [--remind] [--fail-sends <n>] [--with-pin] [--unapproved] [--group <phone>] [--reply <from>=<text> ...]";

export function parseSmokeArgs(argv: string[]): { replies?: SmokeReply[]; ops: SmokeOp[]; dataDir?: string; explicit: boolean; withPin: boolean; approved: boolean; groupPhones: string[]; tenantId: string; closed: boolean; stepE: boolean } {
  const ops: SmokeOp[] = [];
  const replies: SmokeReply[] = [];
  const groupPhones: string[] = [];
  let dataDir: string | undefined;
  let noPoll = false;
  let sawReply = false;
  let explicit = false;
  let withPin = false;
  let approved = true;
  let tenantId = "scratch-lane";
  let closed = false;
  let stepE = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--reply") {
      const value = argv[++i];
      if (value === undefined || value.startsWith("--")) throw new Error(`smoke --reply needs <from>=<text>. ${SMOKE_USAGE}`);
      sawReply = true;
      explicit = true;
      const eq = value.indexOf("=");
      if (eq <= 0) throw new Error(`smoke --reply must look like <from>=<text>. Got ${value}. ${SMOKE_USAGE}`);
      const from = value.slice(0, eq);
      const text = value.slice(eq + 1);
      if (text.length === 0) throw new Error(`smoke --reply text is empty for ${from}. ${SMOKE_USAGE}`);
      if (!isScratchTestNumber(from)) throw new Error(`Cleaner Core only texts Scratch test numbers. Refusing ${from}.`);
      replies.push({ from, text });
      ops.push({ type: "reply", from, text });
      continue;
    }
    if (arg === "--feed" || arg === "--then-feed") {
      const value = argv[++i];
      if (value === undefined || value.startsWith("--")) throw new Error(`${arg} needs a fixture path. ${SMOKE_USAGE}`);
      explicit = true;
      ops.push({ type: "poll", ical: readFileSync(value, "utf8") });
      continue;
    }
    if (arg === "--google") {
      const value = argv[++i];
      if (value === undefined || value.startsWith("--")) throw new Error(`smoke --google needs a fixture path. ${SMOKE_USAGE}`);
      explicit = true;
      stepE = true;
      ops.push({ type: "google", body: readFileSync(value, "utf8") });
      continue;
    }
    if (arg === "--tenant") {
      const value = argv[++i];
      const tenant = value ? scratchTenant(value) : undefined;
      if (!tenant) throw new Error(`smoke --tenant must be scratch-lane or scratch-court. ${SMOKE_USAGE}`);
      explicit = true;
      stepE = true;
      tenantId = tenant.id;
      continue;
    }
    if (arg === "--closed") {
      explicit = true;
      stepE = true;
      closed = true;
      continue;
    }
    if (arg === "--data") {
      const value = argv[++i];
      if (value === undefined || value.startsWith("--")) throw new Error(`smoke --data needs a directory. ${SMOKE_USAGE}`);
      explicit = true;
      dataDir = value;
      continue;
    }
    if (arg === "--now") {
      const value = argv[++i];
      if (value === undefined || value.startsWith("--")) throw new Error(`smoke --now needs an ISO time. ${SMOKE_USAGE}`);
      explicit = true;
      ops.push({ type: "now", iso: value });
      continue;
    }
    if (arg === "--remind") {
      explicit = true;
      ops.push({ type: "remind" });
      continue;
    }
    if (arg === "--fail-sends") {
      const value = argv[++i];
      if (value === undefined || !/^\d+$/.test(value)) throw new Error(`smoke --fail-sends needs a number. ${SMOKE_USAGE}`);
      explicit = true;
      ops.push({ type: "fail", n: Number(value) });
      continue;
    }
    if (arg === "--no-poll") {
      explicit = true;
      noPoll = true;
      continue;
    }
    if (arg === "--with-pin") {
      explicit = true;
      withPin = true;
      continue;
    }
    if (arg === "--unapproved") {
      explicit = true;
      approved = false;
      continue;
    }
    if (arg === "--group") {
      const value = argv[++i];
      if (value === undefined || value.startsWith("--")) throw new Error(`smoke --group needs a Scratch test number. ${SMOKE_USAGE}`);
      if (!isScratchTestNumber(value)) throw new Error(`Cleaner Core only texts Scratch test numbers. Refusing ${value}.`);
      explicit = true;
      groupPhones.push(value);
      continue;
    }
    throw new Error(`Unexpected argument ${arg ?? ""}. ${SMOKE_USAGE}`);
  }
  if (!noPoll && !ops.some((op) => op.type === "poll" || op.type === "google")) {
    if (tenantId !== "scratch-lane") throw new Error(`scratch-court needs --google or --feed. It does not read Scratch Lane's calendar. ${SMOKE_USAGE}`);
    ops.unshift({ type: "poll", ical: SCRATCH_ICAL });
  }
  if (!explicit) {
    return { ops: defaultOps(undefined), ...(dataDir ? { dataDir } : {}), explicit, withPin, approved, groupPhones, tenantId, closed, stepE };
  }
  return { ops, ...(sawReply ? { replies } : {}), ...(dataDir ? { dataDir } : {}), explicit, withPin, approved, groupPhones, tenantId, closed, stepE };
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
    const parsed = parseSmokeArgs(process.argv.slice(3));
    const report = await runSmoke(process.env, parsed.explicit ? [] : undefined, {
      ops: parsed.ops,
      ...(parsed.dataDir ? { dataDir: parsed.dataDir } : {}),
      ...(parsed.withPin ? { withPin: true } : {}),
      ...(parsed.approved ? {} : { approved: false }),
      ...(parsed.groupPhones.length ? { groupPhones: parsed.groupPhones } : {}),
      tenantId: parsed.tenantId,
      ...(parsed.closed ? { closed: true } : {}),
      ...(parsed.stepE ? { stepE: true } : {}),
    });
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
