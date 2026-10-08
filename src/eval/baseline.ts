import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { diffNormalized, type ConfigDiff } from "./diffConfig";
import { DUPLEX_VARIANTS } from "./duplex";
import { publishDuplex } from "./duplex";
import { runClickPath } from "./clickPath";
import { exitsFromClickPath, followOnExits, probeTextingExit, type ExitRecord } from "./exits";
import { runFollowOnTasks, setupTaskFromSteps, type GoldenTaskResult } from "./golden";
import { milestonePathMarkdown, publishMilestoneDuplex, runMilestoneTranscript, type MilestoneStep } from "./milestonePath";
import { normalizeStoredConfig } from "./normalize";
import { EvalSession, type ClickStep } from "./session";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
export const baselineDir = join(repoRoot, "eval/baseline");

export interface BaselineReport {
  configDiff: ConfigDiff;
  milestoneDiff: ConfigDiff;
  milestoneMatchesOld: boolean;
  clickPath: ClickStep[];
  golden: GoldenTaskResult[];
  exits: ExitRecord[];
  milestonePath: MilestoneStep[];
}

export async function buildBaseline(): Promise<BaselineReport> {
  const normalized: unknown[] = [];
  const runIds: string[] = [];
  let clickPath: ClickStep[] = [];
  let golden: GoldenTaskResult[] = [];
  let exits: ExitRecord[] = [];

  for (const [index, variant] of DUPLEX_VARIANTS.entries()) {
    const session = await EvalSession.open();
    try {
      if (index === 0) {
        const setup = await runClickPath(session, variant);
        const saved = session.workspace.load(setup.propertyId);
        normalized.push(normalizeStoredConfig(saved.config));
        runIds.push(variant.id);
        clickPath = session.steps.map((step) => ({ ...step }));
        const published = saved.state.status === "PUBLISHED_FOR_DEMO";
        const hours = saved.config.tourHours;
        const weekdayHours = hours.start === "09:00" && hours.end === "17:00" && hours.days.join(",") === "MON,TUE,WED,THU,FRI";
        const detail = published && saved.config.units.length === 2 && saved.config.routes.length === 2 && weekdayHours
          ? "published, 2 units, routes, weekdays 09:00–17:00"
          : `unexpected end state ${saved.state.status}`;
        golden = await runFollowOnTasks(
          session,
          setup.propertyId,
          setup.nameA,
          setup.nameB,
          setupTaskFromSteps(clickPath, published && weekdayHours && saved.config.units.length === 2, detail),
        );
        exits = [...exitsFromClickPath(clickPath, session.exitHints), ...followOnExits()];
      } else {
        const setup = await publishDuplex(session, variant);
        normalized.push(normalizeStoredConfig(session.workspace.load(setup.propertyId).config));
        runIds.push(variant.id);
      }
    } finally {
      await session.close();
    }
  }

  const probe = await EvalSession.open();
  try {
    const texting = await probeTextingExit(probe);
    const withoutDuplicate = exits.filter((exit) => exit.what !== texting.what);
    exits = [texting, ...withoutDuplicate];
  } finally {
    await probe.close();
  }

  const milestoneNormalized: unknown[] = [];
  for (const variant of DUPLEX_VARIANTS) {
    const session = await EvalSession.open();
    try {
      const setup = await publishMilestoneDuplex(session, variant);
      milestoneNormalized.push(normalizeStoredConfig(session.workspace.load(setup.propertyId).config));
    } finally {
      await session.close();
    }
  }

  let milestonePath: MilestoneStep[] = [];
  const transcript = await EvalSession.open();
  try {
    milestonePath = await runMilestoneTranscript(transcript);
  } finally {
    await transcript.close();
  }

  const configDiff = diffNormalized(runIds, normalized);
  const milestoneDiff = diffNormalized(runIds, milestoneNormalized);
  const milestoneMatchesOld = milestoneNormalized.every((config, index) => JSON.stringify(config) === JSON.stringify(normalized[index]));
  return { configDiff, milestoneDiff, milestoneMatchesOld, clickPath, golden, exits, milestonePath };
}

export function saveBaseline(report: BaselineReport): void {
  mkdirSync(baselineDir, { recursive: true });
  writeJson("config-diff.json", report.configDiff);
  writeFileSync(join(baselineDir, "config-diff.md"), configDiffMarkdown(report.configDiff, "Old tools. Ids and timestamps were normalized away. Stored order is deterministic. Equivalent duplex inputs must not differ."));
  writeJson("config-diff-milestones.json", { diff: report.milestoneDiff, matchesOldTools: report.milestoneMatchesOld });
  writeFileSync(
    join(baselineDir, "config-diff-milestones.md"),
    configDiffMarkdown(report.milestoneDiff, "Milestone tools, same ten duplexes. This must be zero, and each run must match the old-tool canonical config."),
  );
  writeJson("milestone-path.json", report.milestonePath);
  writeFileSync(join(baselineDir, "milestone-path.md"), milestonePathMarkdown(report.milestonePath));
  writeJson("click-path.json", report.clickPath);
  writeFileSync(join(baselineDir, "click-path.md"), clickPathMarkdown(report.clickPath));
  writeJson("golden-tasks.json", report.golden);
  writeFileSync(join(baselineDir, "golden-tasks.md"), goldenMarkdown(report.golden));
  writeJson("exits.json", report.exits);
  writeFileSync(join(baselineDir, "exits.md"), exitsMarkdown(report.exits));
}

export function loadBaseline(): BaselineReport {
  const milestones = readJson<{ diff: ConfigDiff; matchesOldTools: boolean }>("config-diff-milestones.json");
  return {
    configDiff: readJson("config-diff.json"),
    milestoneDiff: milestones.diff,
    milestoneMatchesOld: milestones.matchesOldTools,
    clickPath: readJson("click-path.json"),
    golden: readJson("golden-tasks.json"),
    exits: readJson("exits.json"),
    milestonePath: readJson("milestone-path.json"),
  };
}

export function baselineDrift(actual: BaselineReport, saved: BaselineReport): string | undefined {
  const parts: string[] = [];
  if (JSON.stringify(actual.configDiff) !== JSON.stringify(saved.configDiff)) parts.push("config-diff");
  if (JSON.stringify(actual.milestoneDiff) !== JSON.stringify(saved.milestoneDiff) || actual.milestoneMatchesOld !== saved.milestoneMatchesOld) parts.push("config-diff-milestones");
  if (JSON.stringify(actual.milestonePath) !== JSON.stringify(saved.milestonePath)) parts.push("milestone-path");
  if (JSON.stringify(actual.clickPath) !== JSON.stringify(saved.clickPath)) parts.push("click-path");
  if (JSON.stringify(actual.golden) !== JSON.stringify(saved.golden)) parts.push("golden-tasks");
  if (JSON.stringify(actual.exits) !== JSON.stringify(saved.exits)) parts.push("exits");
  if (!parts.length) return undefined;
  return `Baseline drift in ${parts.join(", ")}. Re-run with EVAL_REBASELINE=1 or npm run eval:baseline -- rebaseline after you mean to accept today's behavior.`;
}

export function configDiffMarkdown(diff: ConfigDiff, note: string): string {
  const lines = [
    `# Config diff`,
    ``,
    `${diff.differingFieldCount} fields differ across ${diff.runs} runs.`,
    ``,
    note,
    ``,
    `| Field | Distinct values |`,
    `| --- | --- |`,
    ...diff.fields.map((field) => `| \`${field.path}\` | ${field.distinct.length} |`),
    ``,
  ];
  return lines.join("\n");
}

export function clickPathMarkdown(steps: ClickStep[]): string {
  const lines = [
    `# Demo click path`,
    ``,
    `Hosted demo order for the duplex at 18 Maple Street, from texting through publish. Confirmation codes are replaced with \`<confirmation>\`.`,
    ``,
    ...steps.map((step, index) => {
      const next = step.next?.action ? ` → ${step.next.action}` : "";
      const summary = typeof step.outcome.summary === "string" ? ` — ${step.outcome.summary}` : "";
      return `${index + 1}. \`${step.tool}\` ${JSON.stringify(step.args)}${next}${summary}`;
    }),
    ``,
  ];
  return lines.join("\n");
}

export function goldenMarkdown(tasks: GoldenTaskResult[]): string {
  const lines = [
    `# Golden landlord tasks`,
    ``,
    `| Task | Calls | Tools | Result | Detail |`,
    `| --- | --- | --- | --- | --- |`,
    ...tasks.map((task) => `| ${task.title} | ${task.calls} | ${task.tools.join(", ")} | ${task.passed ? "pass" : "fail"} | ${task.detail.replace(/\|/g, "/")} |`),
    ``,
    `Natural-language prompts for a later model-driven run are in \`eval/fixtures/golden-prompts.json\`. This harness does not call a model.`,
    ``,
  ];
  return lines.join("\n");
}

export function exitsMarkdown(exits: ExitRecord[]): string {
  const lines = [
    `# Out-of-chat exits`,
    ``,
    `\`key\` means the landlord leaves the chat to enter an API key or similar secret. A Google sign-in or an Allow click is \`not key\`.`,
    ``,
    `| Task | Exit | Label | Taken |`,
    `| --- | --- | --- | --- |`,
    ...exits.map((exit) => `| ${exit.task} | ${exit.what} | ${exit.label} | ${exit.taken ? "yes" : "no"} |`),
    ``,
  ];
  return lines.join("\n");
}

function writeJson(name: string, value: unknown): void {
  writeFileSync(join(baselineDir, name), JSON.stringify(value, null, 2) + "\n");
}

function readJson<T>(name: string): T {
  return JSON.parse(readFileSync(join(baselineDir, name), "utf8")) as T;
}
