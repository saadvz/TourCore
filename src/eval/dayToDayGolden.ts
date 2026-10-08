import { formatLocalDate } from "../core/timezone";
import { confirmationCode, type EvalSession, type ToolResult } from "./session";
import { loadGoldenPrompts, type GoldenTaskResult } from "./golden";

/**
 * The five Phase 0 landlord tasks, using get_state, the milestone writes,
 * and the Phase 4 day-to-day tools. Older day-to-day tools are refused.
 */

export const OLD_DAY_TO_DAY_TOOLS = [
  "list_active_tours",
  "inspect_tour",
  "schedule_one_off_tour",
  "reschedule_tour",
  "revoke_tour_access",
  "place_operator_hold",
  "clear_operator_hold",
  "resume_tours",
  "list_exceptions",
  "inspect_exception",
  "resolve_exception",
  "answer_flagged_question",
  "list_tour_time_requests",
  "inspect_tour_time_request",
  "approve_tour_time_request",
  "decline_tour_time_request",
  "propose_tour_time",
  "export_audit",
  "get_operator_update",
  "get_backup_status",
  "create_portable_backup",
  "confirm_backup_destination",
  "confirm_backup_stored",
  "decline_portable_backup",
  "create_readable_export",
  "begin_restore_upload",
  "preview_portable_restore",
  "import_portable_backup",
] as const;

const FORBIDDEN = new Set<string>(OLD_DAY_TO_DAY_TOOLS);
const TODAY = formatLocalDate({ year: 2026, month: 9, day: 28 }, "America/New_York");

/** The golden-task wrapper. An older day-to-day tool throws before the session runs. */
export function goldenDayToDayCall(
  session: Pick<EvalSession, "call">,
  calls: Array<{ tool: string; args: Record<string, unknown> }>,
): (name: string, args?: Record<string, unknown>) => Promise<ToolResult> {
  return async (name, args = {}) => {
    if (FORBIDDEN.has(name)) throw new Error(`old day-to-day tool ${name} is forbidden`);
    const result = await session.call(name, args, false);
    calls.push({ tool: name, args });
    return result;
  };
}

export interface DayToDayTaskTrace {
  id: string;
  tools: string[];
  calls: Array<{ tool: string; args: Record<string, unknown> }>;
}

function fail(message: string, extra: unknown): never {
  throw new Error(`${message}: ${JSON.stringify(extra).slice(0, 800)}`);
}

/** Setup through publish on 18 Maple Street, then the four follow-on tasks. */
export async function runDayToDayGolden(session: EvalSession): Promise<{ tasks: GoldenTaskResult[]; traces: DayToDayTaskTrace[] }> {
  const prompts = loadGoldenPrompts();
  const traces: DayToDayTaskTrace[] = [];
  const tasks: GoldenTaskResult[] = [];

  const run = async (id: string, body: (call: (name: string, args?: Record<string, unknown>) => Promise<ToolResult>) => Promise<string>) => {
    const prompt = prompts.find((item) => item.id === id);
    if (!prompt) throw new Error(`missing golden prompt ${id}`);
    const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
    const call = goldenDayToDayCall(session, calls);
    try {
      const detail = await body(call);
      traces.push({ id, tools: calls.map((item) => item.tool), calls });
      tasks.push({ id, title: prompt.title, prompt: prompt.prompt, tools: calls.map((item) => item.tool), calls: calls.length, passed: true, detail });
    } catch (err) {
      traces.push({ id, tools: calls.map((item) => item.tool), calls });
      tasks.push({
        id,
        title: prompt.title,
        prompt: prompt.prompt,
        tools: calls.map((item) => item.tool),
        calls: calls.length,
        passed: false,
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  };

  await run("full-setup", async (call) => {
    await call("get_state");
    const texting = await call("set_up_texting", { provider: "local" });
    if (texting.status !== "done" || texting.next !== "backup_records") fail("texting did not point at backup_records", texting);
    const declined = await call("backup_records", { action: "decline" });
    if (declined.status !== "done") fail("backup decline did not finish", declined);
    const property = await call("save_property", {
      address: "18 Maple Street, Teaneck, NJ 07666",
      propertyType: "MULTIFAMILY_HOME",
      confirmAddress: true,
      skipVisitorHelp: true,
    });
    if (property.status !== "done" || typeof property.propertyId !== "string") fail("property did not save", property);
    const propertyId = property.propertyId;
    const settings = await call("save_settings", { property: propertyId, verification: "basic-form", skipAlerts: true });
    if (settings.status !== "done") fail("settings did not save", settings);
    const units = await call("save_units", {
      property: propertyId,
      units: [{ name: "Unit A" }, { name: "Unit B" }],
      details: "Unit A is 2 bed 1 bath for $2,200, available now. Unit B is 1 bed 1 bath for $1,950, available October 15.",
    });
    if (units.status !== "done") fail("units did not save", units);
    const doors = [{ name: "Front Door", kind: "entrance" as const }];
    const routes = [
      { unit: "Unit A", doors: ["Front Door", "Unit A Door"] },
      { unit: "Unit B", doors: ["Front Door", "Unit B Door"] },
    ];
    const routed = await call("save_doors_and_routes", { property: propertyId, doors, routes });
    if (routed.status !== "done") fail("routes did not save", routed);
    const hours = await call("save_hours", { property: propertyId, days: "weekdays", start: "9am", end: "5pm" });
    if (hours.status !== "done") fail("hours did not save", hours);
    const checks = await call("run_checks", { property: propertyId });
    if (checks.status !== "done") fail("checks did not pass", checks);
    const asked = await call("publish", { property: propertyId });
    if (asked.status !== "next") fail("publish did not ask", asked);
    const published = await call("publish", { property: propertyId, confirmationCode: confirmationCode(asked) });
    if (published.status !== "done" || published.published !== true) fail("publish did not finish", published);
    if (published.next !== "get_inbox") fail("published next step is not the inbox", published);
    return "published, 2 units, routes, weekdays 09:00–17:00";
  });

  const propertyId = session.workspace.propertyIds()[0];
  if (!propertyId) throw new Error("setup did not leave a property");
  const names = session.workspace.load(propertyId).config.units.map((unit) => unit.name);
  const nameA = names[0] ?? "Unit A";
  const nameB = names[1] ?? "Unit B";

  await run("one-off", async (call) => {
    const asked = await call("schedule_tour", {
      property: propertyId,
      phone: "+15555550200",
      visitorName: "Dana",
      unit: nameA,
      startsAt: "3:15 PM today",
    });
    if (asked.status !== "next") return fail("schedule did not ask", asked);
    const booked = await call("schedule_tour", {
      property: propertyId,
      phone: "+15555550200",
      visitorName: "Dana",
      unit: nameA,
      startsAt: "3:15 PM today",
      confirmationCode: confirmationCode(asked),
    });
    const messaging = session.workspace.listTours(propertyId).some((tour) => tour.kind === "messaging");
    if (booked.status !== "done" || booked.scheduled !== true || typeof booked.tourRef !== "string" || !messaging) {
      return fail("one-off did not leave a messaging tour", booked);
    }
    return "scheduled, with a messaging tour record";
  });

  await run("flagged-question", async (call) => {
    await call("inject_local_sms", { from: "+15555550199", text: "TOUR", property: propertyId, id: "day-tour" });
    await call("inject_local_sms", { from: "+15555550199", text: "YES", property: propertyId, id: "day-yes" });
    await call("inject_local_sms", { from: "+15555550199", text: "Is there a gym?", property: propertyId, id: "day-gym" });
    const listed = await call("get_inbox", { property: propertyId });
    const items = listed.items as Array<{ exceptionId?: string; status?: string; summary?: string; kind?: string }> | undefined;
    const open = items?.find((item) => item.kind === "flagged-question" && item.status === "open" && /gym/i.test(item.summary ?? ""));
    if (!open?.exceptionId) return fail("gym question was not flagged", listed);
    const asked = await call("resolve_issue", { action: "answer", exceptionId: open.exceptionId, approvedFact: "There's no gym" });
    if (asked.status !== "next") return fail("answer did not ask", asked);
    const answered = await call("resolve_issue", {
      action: "answer",
      exceptionId: open.exceptionId,
      approvedFact: "There's no gym",
      confirmationCode: confirmationCode(asked),
    });
    if (answered.status !== "done") return fail("answer did not finish", answered);
    const facts = session.workspace.load(propertyId).config.property.facts;
    const stillPublished = session.workspace.load(propertyId).state.status === "PUBLISHED_FOR_DEMO";
    const after = await call("get_inbox", { property: propertyId });
    const stillOpen = (after.items as Array<{ status?: string; summary?: string }> | undefined)?.some(
      (item) => item.status === "open" && /gym/i.test(item.summary ?? ""),
    );
    if (!facts.includes("There's no gym.") || !stillPublished || stillOpen) {
      return fail("fact was not saved on the published property", { facts, stillPublished, stillOpen, answered: answered.message });
    }
    return "saved There's no gym. and the question is no longer open";
  });

  await run("pause-unit", async (call) => {
    const asked = await call("pause_tours", { property: propertyId, unit: nameB, paused: true });
    if (asked.status !== "next") return fail("pause did not ask", asked);
    const paused = await call("pause_tours", {
      property: propertyId,
      unit: nameB,
      paused: true,
      ...(typeof asked.bookedTours === "number" && asked.bookedTours > 0 ? { bookedTours: "keep" } : {}),
      confirmationCode: confirmationCode(asked),
    });
    const saved = session.workspace.load(propertyId);
    const unit = saved.config.units.find((item) => item.name === nameB);
    const pausedIds = saved.state.pausedUnitIds ?? [];
    if (paused.status !== "done" || !unit || !pausedIds.includes(unit.id)) {
      return fail("unit was not paused", { status: paused.status, pausedIds, unit: unit?.id });
    }
    return `${nameB} is paused`;
  });

  await run("export-audit", async (call) => {
    const exported = await call("export_records", { property: propertyId, day: "today" });
    const totals = exported.totals as { practiceTours?: number; day?: string } | undefined;
    if (!totals || (totals.practiceTours ?? 0) < 1 || totals.day !== TODAY) {
      return fail("audit did not include today's practice tour", { totals, expectedDay: TODAY });
    }
    return `${totals.day}: ${totals.practiceTours} practice tour${totals.practiceTours === 1 ? "" : "s"}`;
  });

  return { tasks, traces };
}
