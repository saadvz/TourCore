import type { CleanerText } from "./core";

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

export function runDoctor(_env: NodeJS.ProcessEnv = process.env): DoctorReport {
  throw new Error("not implemented");
}

export async function runSmoke(_env: NodeJS.ProcessEnv = process.env): Promise<SmokeReport> {
  throw new Error("not implemented");
}
