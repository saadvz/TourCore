import {
  applySetupCommand,
  COMMON_TIME_ZONES,
  createPropertySetup,
  describeHistory,
  draftView,
  dryTourView,
  formatDay,
  formatTime,
  friendlyZone,
  inferTimeZone,
  liveTourView,
  propertySummary,
  PropertyWorkspace,
  readinessView,
  runDryTour,
  runReadinessCheck,
  SETUP_STEPS,
  SetupInputError,
  tourDetailView,
  tourListView,
  validateConfig,
  VisitorDemoRegistry,
  VisitorDemoSession,
  visitorView,
} from "./setupFacade";

/**
 * The browser's API for both the operator and the visitor phone. Every
 * handler delegates to the setup engine or the visitor session over the real
 * Tour Core engine; no product rule lives here. Anything under a `dev` key is
 * removed unless developer mode is on, so operators and visitors never see
 * codes, adapter names, internal ids or file paths.
 */

export interface ApiContext {
  workspace: PropertyWorkspace;
  visitors?: VisitorDemoRegistry;
  dev: boolean;
  now?: () => Date;
}

export type ApiResult =
  | { status: number; json: unknown }
  | { status: number; download: { filename: string; contentType: string; content: string } };

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export async function handleApi(ctx: ApiContext, method: string, path: string, body: unknown): Promise<ApiResult> {
  try {
    const result = await route(ctx, method, path, (body ?? {}) as Record<string, unknown>);
    return "download" in result ? result : { status: result.status, json: ctx.dev ? result.json : stripDev(result.json) };
  } catch (err) {
    if (err instanceof SetupInputError) return errorResult(ctx, 400, err.code, err.message);
    if (err instanceof ApiError) return errorResult(ctx, err.status, err.code, err.message);
    return errorResult(ctx, 500, "INTERNAL", "Something went wrong. Your saved setup is safe.", err);
  }
}

function errorResult(ctx: ApiContext, status: number, code: string, message: string, err?: unknown): ApiResult {
  const dev = ctx.dev ? { dev: { code, ...(err ? { error: String(err instanceof Error ? err.stack : err) } : {}) } } : {};
  return { status, json: { error: { message, ...dev } } };
}

const ok = (json: unknown) => ({ status: 200, json });

async function route(ctx: ApiContext, method: string, path: string, body: Record<string, unknown>): Promise<ApiResult> {
  const ws = ctx.workspace;
  const visitors = (ctx.visitors ??= new VisitorDemoRegistry());
  const now = ctx.now?.() ?? new Date();
  const parts = path.replace(/^\/api\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);

  if (method === "GET" && parts[0] === "meta") {
    return ok({ dev: ctx.dev, steps: SETUP_STEPS, timeZones: COMMON_TIME_ZONES });
  }

  if (method === "POST" && parts[0] === "timezone" && parts[1] === "suggest") {
    const guess = inferTimeZone(String(body.address ?? ""));
    return ok({ timezone: guess.timezone, label: friendlyZone(guess.timezone), basis: guess.basis });
  }

  // --------------------------------------------------------- visitor phone

  if (parts[0] === "visitor-demos" && parts[1]) {
    const session = visitors.get(parts[1]);
    if (method === "GET" && !parts[2]) return ok({ visitor: await visitorView(session) });
    if (method === "GET" && parts[2] === "live") return ok({ live: await liveTourView(session) });
    if (method === "POST" && parts[2] === "actions" && parts[3]) {
      await session.act(parts[3], body.input);
      const { record, bundle } = await session.record();
      ws.recordVisitorDemo(session.propertyId, record, bundle);
      return ok({ visitor: await visitorView(session) });
    }
  }

  // ------------------------------------------------------------ properties

  if (parts[0] !== "properties") throw new ApiError(404, "NOT_FOUND", "That page doesn't exist.");

  if (parts.length === 1) {
    if (method === "GET") return ok({ properties: await Promise.all(ws.propertyIds().map((id) => summaryFor(ctx, id))) });
    if (method === "POST") {
      const draft = createPropertySetup({
        address: String(body.address ?? ""),
        name: body.name === undefined ? undefined : String(body.name),
        timezone: body.timezone ? String(body.timezone) : undefined,
        existingPropertyIds: ws.propertyIds(),
      });
      ws.saveDraft(draft);
      return ok(await propertyPayload(ctx, draft.property.id));
    }
  }

  const id = parts[1]!;
  const action = parts[2];

  if (method === "GET" && !action) return ok(await propertyPayload(ctx, id));

  if (method === "POST" && action === "commands" && parts[3]) {
    const { draft } = ws.openDraft(id);
    ws.persistEdit(applySetupCommand(draft, parts[3], body.input), now);
    return ok(await propertyPayload(ctx, id));
  }

  if (method === "POST" && action === "discard") {
    ws.discardDraft(id);
    return ok(ws.has(id) ? await propertyPayload(ctx, id) : { discarded: true });
  }

  if (method === "POST" && action === "readiness") {
    const { draft, unsavedChanges } = ws.openDraft(id);
    if (unsavedChanges) {
      if (validateConfig(draft).length) {
        const result = await runReadinessCheck(draft, { now });
        return ok({ readiness: readinessView(result), savedChanges: false, summary: await summaryFor(ctx, id) });
      }
      ws.save(draft, now);
    }
    const { config } = ws.load(id);
    const result = await runReadinessCheck(config, { now });
    ws.recordReadiness(id, result);
    return ok({ readiness: readinessView(result), savedChanges: unsavedChanges, summary: await summaryFor(ctx, id) });
  }

  if (method === "POST" && (action === "practice" || action === "visitor-demos")) {
    const gate = await checkedConfig(ctx, id, now);
    if ("readiness" in gate) return ok({ readiness: gate.readiness, summary: await summaryFor(ctx, id) });
    const { config } = gate;

    if (action === "visitor-demos") {
      const session = visitors.add(new VisitorDemoSession(id, config, ws.newVisitorTourId(id, now)));
      const { record, bundle } = await session.record();
      ws.recordVisitorDemo(id, record, bundle);
      return ok({ sessionId: session.id, visitorUrl: `/visitor?s=${encodeURIComponent(session.id)}`, summary: await summaryFor(ctx, id) });
    }

    const unitId = typeof body.unitId === "string" && config.units.some((u) => u.id === body.unitId) ? body.unitId : undefined;
    const result = await runDryTour(config, { unitId, now });
    const saved = ws.recordDryTour(id, result);
    const view = dryTourView(result);
    return ok({
      practice: { ...view, tourId: saved.dryTour?.tourId, dev: { ...view.dev, recordsFolder: saved.dryTour?.recordsFolder } },
      summary: await summaryFor(ctx, id),
    });
  }

  if (method === "POST" && action === "publish") {
    const result = await ws.publishDemoProperty(id, now);
    if (result.published) return ok({ published: true, summary: await summaryFor(ctx, id) });
    return ok({
      published: false,
      blockers: result.blockers.map((b) => ({ message: b.message, next: nextStepFor(b.code), dev: { code: b.code } })),
      summary: await summaryFor(ctx, id),
    });
  }

  if (method === "GET" && action === "tours") {
    const { config } = ws.load(id);
    const tourId = parts[3];
    if (!tourId) return ok({ tours: tourListView(ws.listTours(id), config.property.timezone) });
    if (parts[4] === "export") return download(ws, id, parts[5], tourId);
    const tour = ws.loadTour(id, tourId);
    if (!tour) throw new ApiError(404, "TOUR_NOT_FOUND", "I couldn't find that tour.");
    const view = tourDetailView(tour.record, tour.bundle, config);
    return ok({ tour: { ...view, dev: { ...view.dev, folder: tour.folder } } });
  }

  if (method === "GET" && action === "history") {
    const { config, state } = ws.load(id);
    const latest = ws.latestPracticeTour(id);
    if (!latest) return ok({ available: false });
    const entries = describeHistory(latest.bundle.auditEvents, { ...latest.bundle, operatorName: config.operator.name }, config.property.timezone);
    const tz = config.property.timezone;
    // A practice tour runs now but simulates the next open tour time; show both so the dates make sense.
    const ranAt = new Date(state.dryTour?.ranAt ?? latest.bundle.exportedAt);
    const simulated = latest.bundle.reservations[0]?.slotStart;
    return ok({
      available: true,
      ranAt: ranAt.toISOString(),
      ranAtLabel:
        `Run ${formatDay(ranAt, tz)} at ${formatTime(ranAt, tz)}` +
        (simulated ? `, practicing a ${formatTime(new Date(simulated), tz)} tour on ${formatDay(new Date(simulated), tz)}.` : "."),
      entries,
      dev: { folder: latest.folder },
    });
  }

  if (method === "GET" && action === "export") return download(ws, id, parts[3]);

  throw new ApiError(404, "NOT_FOUND", "That page doesn't exist.");
}

/** The saved setup, once it's free of unchecked changes and passes readiness (run automatically if needed). */
async function checkedConfig(ctx: ApiContext, id: string, now: Date) {
  const ws = ctx.workspace;
  if (!ws.has(id) || ws.openDraft(id).unsavedChanges) {
    throw new ApiError(409, "UNCHECKED_CHANGES", "Some changes still need fixing. Open the review to see what's left.");
  }
  let { config, state } = ws.load(id);
  if (!state.readiness?.passed || state.readiness.configHash !== state.configHash) {
    const readiness = await runReadinessCheck(config, { now });
    ws.recordReadiness(id, readiness);
    if (!readiness.passed) return { readiness: readinessView(readiness) };
    ({ config, state } = ws.load(id));
  }
  return { config };
}

function download(ws: PropertyWorkspace, id: string, file: string | undefined, tourId?: string): ApiResult {
  if (file !== "records.json" && file !== "history.csv") throw new ApiError(404, "NOT_FOUND", "That page doesn't exist.");
  const files = ws.exportTour(id, tourId);
  if (!files) throw new ApiError(404, "NO_RECORDS", "There are no tour records yet. Run a practice tour first.");
  const json = file === "records.json";
  return {
    status: 200,
    download: {
      filename: `${id}${tourId ? `-${tourId}` : ""}-${json ? "tour-records.json" : "tour-history.csv"}`,
      contentType: json ? "application/json" : "text/csv",
      content: json ? files.json : files.csv,
    },
  };
}

function nextStepFor(code: string): { action: "readiness" | "practice" | "review"; label: string } {
  if (code.startsWith("READINESS")) return { action: "readiness", label: "Run readiness check" };
  if (code.startsWith("DRY_TOUR")) return { action: "practice", label: "Run a practice tour" };
  return { action: "review", label: "Review setup" };
}

async function summaryFor(ctx: ApiContext, id: string) {
  const ws = ctx.workspace;
  const { draft, unsavedChanges } = ws.openDraft(id);
  const active = await ctx.visitors?.activeFor(id);
  return propertySummary(ws.has(id) ? ws.load(id) : undefined, draft, unsavedChanges, {
    tourCount: ws.has(id) ? ws.listTours(id).length : 0,
    activeVisitorDemo: active?.id,
  });
}

async function propertyPayload(ctx: ApiContext, id: string) {
  const { draft } = ctx.workspace.openDraft(id);
  return { summary: await summaryFor(ctx, id), view: draftView(draft) };
}

/** Removes developer-only details (any `dev` key) from a response. */
export function stripDev(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripDev);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).filter(([k]) => k !== "dev").map(([k, v]) => [k, stripDev(v)]));
  }
  return value;
}
