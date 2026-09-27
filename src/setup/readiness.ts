import { TourCoreConfigShape, validateConfig, type TourCoreConfig } from "../config/tourCoreConfig";
import type { ConfigIssue, ConfigSection } from "../config/validateConfig";
import { SimulatedClock } from "../core/clock";
import { nextTourDay } from "../core/schedule";
import { TourCore } from "../core/TourCore";
import { createDurin, createMessenger, createStore, createVerificationProvider } from "../createTourCore";

export type ReadinessCheckId = "property" | "hours" | "routes" | "verification" | "messaging" | "storage" | "access" | "audit";

export interface ReadinessProblem {
  code: string;
  message: string;
  /** Which part of setup the problem lives in, when it comes from the setup answers. */
  section?: ConfigSection;
  unitId?: string;
}

export interface ReadinessCheck {
  id: ReadinessCheckId;
  label: string;
  ok: boolean;
  /** Plain-language problems; empty when ok. */
  problems: string[];
  /** Machine-readable codes matching problems. */
  codes: string[];
  details: ReadinessProblem[];
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
  storage: "Records",
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

/**
 * Deterministic: the same config and clock give the same answer. Each check
 * exercises the real application pieces the config selects, not canned text.
 */
export async function runReadinessCheck(input: unknown, options: { now?: Date } = {}): Promise<ReadinessResult> {
  const now = options.now ?? new Date();
  const problems = new Map<ReadinessCheckId, ReadinessProblem[]>(Object.keys(LABELS).map((k) => [k as ReadinessCheckId, []]));
  const fail = (id: ReadinessCheckId, problem: ReadinessProblem) => problems.get(id)!.push(problem);

  const issues: ConfigIssue[] = validateConfig(input);
  for (const issue of issues) {
    fail(SECTION_TO_CHECK[issue.section], { code: issue.code, message: issue.message, section: issue.section, ...(issue.unitId ? { unitId: issue.unitId } : {}) });
  }

  const shape = TourCoreConfigShape.safeParse(input);
  if (!shape.success) {
    for (const id of ["messaging", "storage", "access", "audit"] as const) fail(id, { code: "SETUP_INCOMPLETE", message: "Finish the setup answers first." });
    return finish(problems, now);
  }
  const config = shape.data;

  if (!issues.some((i) => i.section === "hours" || i.code === "TIMEZONE_INVALID")) {
    try {
      nextTourDay(config, now);
    } catch {
      fail("hours", { code: "NO_UPCOMING_TOURS", message: "There are no tour times in the next two weeks.", section: "hours" });
    }
  }

  await probe(fail, "verification", "verification", () => createVerificationProvider(config));
  await probe(fail, "messaging", "services", () => createMessenger(config, () => {}));
  await probe(fail, "storage", "services", async () => {
    const store = createStore(config);
    const record = { id: "readiness_probe", name: "Readiness probe", phone: "+10000000000", createdAt: now.toISOString() };
    await store.put("prospects", record);
    if ((await store.get("prospects", record.id))?.id !== record.id) throw new Error("Tour records couldn't be saved and read back.");
  });
  await probe(fail, "access", "services", async () => {
    const health = await createDurin(config, new SimulatedClock(now), () => {}).getHealth();
    if (!health.healthy) throw new Error("Durin isn't responding right now, so doors would stay locked.");
  });
  if (issues.length === 0) {
    await probe(fail, "audit", undefined, async () => {
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
    fail("audit", { code: "SETUP_INCOMPLETE", message: "Tour records can be checked once the items above are fixed." });
  }

  return finish(problems, now);
}

async function probe(
  fail: (id: ReadinessCheckId, problem: ReadinessProblem) => void,
  id: ReadinessCheckId,
  section: ConfigSection | undefined,
  fn: () => unknown,
): Promise<void> {
  try {
    await fn();
  } catch (err) {
    const code = (err as { code?: string }).code ?? "CHECK_FAILED";
    fail(id, { code, message: err instanceof Error ? err.message : "Something went wrong during this check.", ...(section ? { section } : {}) });
  }
}

function finish(problems: Map<ReadinessCheckId, ReadinessProblem[]>, now: Date): ReadinessResult {
  const checks = (Object.keys(LABELS) as ReadinessCheckId[]).map((id) => {
    const list = problems.get(id)!;
    return { id, label: LABELS[id], ok: list.length === 0, problems: list.map((p) => p.message), codes: list.map((p) => p.code), details: list };
  });
  return { passed: checks.every((c) => c.ok), checkedAt: now.toISOString(), checks };
}
