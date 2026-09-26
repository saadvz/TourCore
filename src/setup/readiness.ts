import { TourCoreConfigShape, validateConfig, type TourCoreConfig } from "../config/tourCoreConfig";
import type { ConfigIssue, ConfigSection } from "../config/validateConfig";
import { SimulatedClock } from "../core/clock";
import { nextTourDay } from "../core/schedule";
import { TourCore } from "../core/TourCore";
import { createDurin, createMessenger, createStore, createVerificationProvider } from "../createTourCore";

export type ReadinessCheckId = "property" | "hours" | "routes" | "verification" | "messaging" | "storage" | "access" | "audit";

export interface ReadinessCheck {
  id: ReadinessCheckId;
  label: string;
  ok: boolean;
  /** Plain-language problems; empty when ok. */
  problems: string[];
  /** Machine-readable codes matching problems. */
  codes: string[];
}

export interface ReadinessResult {
  passed: boolean;
  checkedAt: string;
  checks: ReadinessCheck[];
}

const LABELS: Record<ReadinessCheckId, string> = {
  property: "Property details",
  hours: "Tour hours",
  routes: "Unit routes",
  verification: "Verification",
  messaging: "Messaging",
  storage: "Storage",
  access: "Durin access",
  audit: "Audit/export",
};

const SECTION_TO_CHECK: Record<ConfigSection, ReadinessCheckId> = {
  property: "property",
  hours: "hours",
  units: "routes",
  routes: "routes",
  verification: "verification",
  services: "messaging",
};

type Problem = { code: string; message: string };

/**
 * Deterministic: the same config and clock give the same answer. Each check
 * exercises the real application pieces the config selects, not canned text.
 */
export async function runReadinessCheck(input: unknown, options: { now?: Date } = {}): Promise<ReadinessResult> {
  const now = options.now ?? new Date();
  const problems = new Map<ReadinessCheckId, Problem[]>(Object.keys(LABELS).map((k) => [k as ReadinessCheckId, []]));
  const fail = (id: ReadinessCheckId, code: string, message: string) => problems.get(id)!.push({ code, message });

  const issues: ConfigIssue[] = validateConfig(input);
  for (const issue of issues) fail(SECTION_TO_CHECK[issue.section], issue.code, issue.message);

  const shape = TourCoreConfigShape.safeParse(input);
  if (!shape.success) {
    for (const id of ["messaging", "storage", "access", "audit"] as const) fail(id, "SETUP_INCOMPLETE", "Finish the setup answers first.");
    return finish(problems, now);
  }
  const config = shape.data;

  if (!issues.some((i) => i.section === "hours" || i.code === "TIMEZONE_INVALID")) {
    try {
      nextTourDay(config, now);
    } catch {
      fail("hours", "NO_UPCOMING_TOURS", "There are no tour times in the next two weeks.");
    }
  }

  await probe(fail, "verification", () => createVerificationProvider(config));
  await probe(fail, "messaging", () => createMessenger(config, () => {}));
  await probe(fail, "storage", async () => {
    const store = createStore(config);
    const record = { id: "readiness_probe", name: "Readiness probe", phone: "+10000000000", createdAt: now.toISOString() };
    await store.put("prospects", record);
    if ((await store.get("prospects", record.id))?.id !== record.id) throw new Error("Tour records couldn't be saved and read back.");
  });
  await probe(fail, "access", async () => {
    const health = await createDurin(config, new SimulatedClock(now), () => {}).getHealth();
    if (!health.healthy) throw new Error("Durin isn't responding right now, so doors would stay locked.");
  });
  if (issues.length === 0) {
    await probe(fail, "audit", async () => {
      const clock = new SimulatedClock(now);
      const core = new TourCore({
        config: config as TourCoreConfig,
        clock,
        store: createStore(config),
        messenger: createMessenger(config, () => {}),
        verification: createVerificationProvider(config),
        durin: createDurin(config, clock, () => {}),
      });
      await core.exportRecords();
    });
  } else {
    fail("audit", "SETUP_INCOMPLETE", "Tour records can be checked once the items above are fixed.");
  }

  return finish(problems, now);
}

async function probe(
  fail: (id: ReadinessCheckId, code: string, message: string) => void,
  id: ReadinessCheckId,
  fn: () => unknown,
): Promise<void> {
  try {
    await fn();
  } catch (err) {
    const code = (err as { code?: string }).code ?? "CHECK_FAILED";
    fail(id, code, err instanceof Error ? err.message : "Something went wrong during this check.");
  }
}

function finish(problems: Map<ReadinessCheckId, Problem[]>, now: Date): ReadinessResult {
  const checks = (Object.keys(LABELS) as ReadinessCheckId[]).map((id) => {
    const list = problems.get(id)!;
    return { id, label: LABELS[id], ok: list.length === 0, problems: list.map((p) => p.message), codes: list.map((p) => p.code) };
  });
  return { passed: checks.every((c) => c.ok), checkedAt: now.toISOString(), checks };
}
