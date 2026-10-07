import { readFileSync } from "node:fs";
import { formatLocalDate } from "../core/timezone";
import type { ClickStep, EvalSession, ToolResult } from "./session";
import { confirmationCode, redactArgs } from "./session";

export interface GoldenPrompt {
  id: string;
  title: string;
  prompt: string;
}

export interface GoldenTaskResult {
  id: string;
  title: string;
  prompt: string;
  tools: string[];
  calls: number;
  passed: boolean;
  detail: string;
}

interface RecordedCall {
  tool: string;
  args: Record<string, unknown>;
  result: ToolResult;
}

const TODAY = formatLocalDate({ year: 2026, month: 9, day: 28 }, "America/New_York");

export function loadGoldenPrompts(): GoldenPrompt[] {
  const file = new URL("../../eval/fixtures/golden-prompts.json", import.meta.url);
  return JSON.parse(readFileSync(file, "utf8")) as GoldenPrompt[];
}

function prompt(prompts: GoldenPrompt[], id: string): GoldenPrompt {
  const found = prompts.find((item) => item.id === id);
  if (!found) throw new Error(`missing golden prompt ${id}`);
  return found;
}

/** Tasks b–e on an already published canonical duplex. Task a is the click path. */
export async function runFollowOnTasks(
  session: EvalSession,
  propertyId: string,
  nameA: string,
  nameB: string,
  setup: { tools: string[]; calls: number; passed: boolean; detail: string },
): Promise<GoldenTaskResult[]> {
  const prompts = loadGoldenPrompts();
  const a = prompt(prompts, "full-setup");
  const tasks: GoldenTaskResult[] = [
    { id: a.id, title: a.title, prompt: a.prompt, tools: setup.tools, calls: setup.calls, passed: setup.passed, detail: setup.detail },
  ];

  tasks.push(await task(session, prompt(prompts, "one-off"), async (call) => {
    const asked = await call("schedule_one_off_tour", {
      property: propertyId,
      phone: "+15555550200",
      visitorName: "Dana",
      unit: nameA,
      startsAt: "3:15 PM today",
    });
    if (asked.status !== "needs-confirmation") return fail("schedule did not ask", asked);
    const booked = await call("schedule_one_off_tour", {
      property: propertyId,
      phone: "+15555550200",
      visitorName: "Dana",
      unit: nameA,
      startsAt: "3:15 PM today",
      confirmationCode: confirmationCode(asked),
    });
    const messaging = session.workspace.listTours(propertyId).some((tour) => tour.kind === "messaging");
    if (booked.scheduled !== true || typeof booked.tourRef !== "string" || !messaging) {
      return fail("one-off did not leave a messaging tour", booked);
    }
    return "scheduled, with a messaging tour record";
  }));

  tasks.push(await task(session, prompt(prompts, "flagged-question"), async (call) => {
    await call("inject_local_sms", { from: "+15555550199", text: "TOUR", property: propertyId, id: "eval-tour" });
    await call("inject_local_sms", { from: "+15555550199", text: "YES", property: propertyId, id: "eval-yes" });
    await call("inject_local_sms", { from: "+15555550199", text: "Is there a gym?", property: propertyId, id: "eval-gym" });
    const listed = await call("list_exceptions", { property: propertyId });
    const exceptions = listed.exceptions as Array<{ exceptionId?: string; status?: string; summary?: string }> | undefined;
    const open = exceptions?.find((item) => item.status === "open" && /gym/i.test(item.summary ?? ""));
    if (!open?.exceptionId) return fail("gym question was not flagged", listed);
    const asked = await call("answer_flagged_question", { exceptionId: open.exceptionId, approvedFact: "There's no gym" });
    if (asked.status !== "needs-confirmation") return fail("answer did not ask", asked);
    const answered = await call("answer_flagged_question", {
      exceptionId: open.exceptionId,
      approvedFact: "There's no gym",
      confirmationCode: confirmationCode(asked),
    });
    const facts = session.workspace.load(propertyId).config.property.facts;
    const stillPublished = session.workspace.load(propertyId).state.status === "PUBLISHED_FOR_DEMO";
    const after = await call("list_exceptions", { property: propertyId });
    const stillOpen = (after.exceptions as Array<{ status?: string; summary?: string }> | undefined)?.some(
      (item) => item.status === "open" && /gym/i.test(item.summary ?? ""),
    );
    if (!facts.includes("There's no gym.") || !stillPublished || stillOpen) {
      return fail("fact was not saved on the published property", { facts, stillPublished, stillOpen, answered: answered.summary });
    }
    return "saved There's no gym. and the question is no longer open";
  }));

  tasks.push(await task(session, prompt(prompts, "pause-unit"), async (call) => {
    const asked = await call("pause_tours", { property: propertyId, unit: nameB });
    if (asked.status !== "needs-confirmation") return fail("pause did not ask", asked);
    const paused = await call("pause_tours", {
      property: propertyId,
      unit: nameB,
      ...(typeof asked.bookedTours === "number" && asked.bookedTours > 0 ? { bookedTours: "keep" } : {}),
      confirmationCode: confirmationCode(asked),
    });
    const saved = session.workspace.load(propertyId);
    const unit = saved.config.units.find((item) => item.name === nameB);
    const pausedIds = saved.state.pausedUnitIds ?? [];
    if (paused.status !== "paused" || !unit || !pausedIds.includes(unit.id)) {
      return fail("unit was not paused", { status: paused.status, pausedIds, unit: unit?.id });
    }
    return `${nameB} is paused`;
  }));

  tasks.push(await task(session, prompt(prompts, "export-audit"), async (call) => {
    const exported = await call("export_audit", { property: propertyId, day: "today" });
    const totals = exported.totals as { practiceTours?: number; day?: string } | undefined;
    if (!totals || (totals.practiceTours ?? 0) < 1 || totals.day !== TODAY) {
      return fail("audit did not include today's practice tour", { totals, expectedDay: TODAY });
    }
    return `${totals.day}: ${totals.practiceTours} practice tour${totals.practiceTours === 1 ? "" : "s"}`;
  }));

  return tasks;
}

async function task(session: EvalSession, item: GoldenPrompt, run: (call: (name: string, args?: Record<string, unknown>) => Promise<ToolResult>) => Promise<string>): Promise<GoldenTaskResult> {
  const calls: RecordedCall[] = [];
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await session.call(name, args, false);
    calls.push({ tool: name, args: redactArgs(args), result });
    return result;
  };
  try {
    const detail = await run(call);
    return { id: item.id, title: item.title, prompt: item.prompt, tools: calls.map((item) => item.tool), calls: calls.length, passed: true, detail };
  } catch (err) {
    return {
      id: item.id,
      title: item.title,
      prompt: item.prompt,
      tools: calls.map((item) => item.tool),
      calls: calls.length,
      passed: false,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

function fail(message: string, extra: unknown): never {
  throw new Error(`${message}: ${JSON.stringify(extra).slice(0, 800)}`);
}

export function setupTaskFromSteps(steps: ClickStep[], passed: boolean, detail: string): { tools: string[]; calls: number; passed: boolean; detail: string } {
  return { tools: steps.map((step) => step.tool), calls: steps.length, passed, detail };
}
