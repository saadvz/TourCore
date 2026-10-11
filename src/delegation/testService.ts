import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { DelegationError, DelegationPrototype, LocalReplySink } from "./prototype";
import { delegationApp } from "./mcp";
import { startDelegationWorker } from "./worker";
import { DelegationNotifications, type WebhookSettings, type FetchWebhook } from "./notifications";
import { join } from "node:path";
import { z } from "zod";

/** Isolated synthetic fixtures only. No production configuration or provider is loaded. */
export function createDelegationTestService(options: {
  root: string; agentToken: string; adminToken: string; publicBaseUrl?: string;
  deadlineMs?: number; intervalMs?: number; now?: () => number; railwayHealthcheck?: boolean;
  webhook?: WebhookSettings; webhookFetch?: FetchWebhook;
}) {
  if (options.adminToken.length < 32 || options.adminToken === options.agentToken) throw new Error("Separate test administrator credentials are required.");
  const allowedHosts = ["127.0.0.1", "localhost", "[::1]"];
  if (options.railwayHealthcheck) allowedHosts.push("healthcheck.railway.app");
  if (options.publicBaseUrl) {
    const url = new URL(options.publicBaseUrl);
    if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error("Public address must be an HTTPS origin.");
    allowedHosts.push(url.hostname);
  }
  const identity = { tenantId: "synthetic_host", agentId: "grok_test_agent" };
  const sink = new LocalReplySink(join(options.root, "replies.json"));
  sink.replies(); // Fail closed on a damaged message ledger before accepting traffic.
  const engine = new DelegationPrototype(options.root, sink, { now: options.now, deadlineMs: options.deadlineMs });
  const app = delegationApp(engine, [{ ...identity, token: options.agentToken }], { allowedHosts });
  const notifications = options.webhook ? new DelegationNotifications(options.root, engine, identity, options.webhook, { now: options.now, fetch: options.webhookFetch }) : undefined;
  let failed = false;
  const worker = startDelegationWorker(engine, { intervalMs: options.intervalMs, onError: () => { failed = true; console.error("Cleaner Core test worker failed; inspect local storage before continuing."); } });
  const notificationWorker = notifications ? startDelegationWorker(notifications, { intervalMs: options.intervalMs, onError: () => { failed = true; console.error("Cleaner Core notification worker failed; check notifications.json and volume permissions."); } }) : undefined;
  app.get("/healthz", (_req, res) => { res.status(failed ? 503 : 200).json({ service: "cleaner-core-test", mode: "synthetic", ready: !failed }); });
  app.use("/test", (req, res, next) => {
    const actual = Buffer.from(req.headers.authorization ?? "");
    const expected = Buffer.from(`Bearer ${options.adminToken}`);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) { res.status(401).json({ error: "Unauthorized" }); return; }
    res.setHeader("Cache-Control", "no-store"); next();
  });
  let fixtureQueue: Promise<unknown> = Promise.resolve();
  app.post("/test/events", async (req, res) => {
    const parsed = z.strictObject({ eventId: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/) }).safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: "Provide only a synthetic eventId." }); return; }
    const run = fixtureQueue.then(async () => {
      const providerEventId = `test_${parsed.data.eventId}`;
      const id = `work_${createHash("sha256").update(JSON.stringify([identity.tenantId, providerEventId])).digest("hex").slice(0, 32)}`;
      try { return await engine.get(identity, id); }
      catch (error) { if (!(error instanceof DelegationError) || error.code !== "NOT_FOUND") throw error; }
      const now = (options.now ?? Date.now)();
      const iso = (hours: number) => new Date(now + hours * 3_600_000).toISOString();
      const turnId = `turn_${randomUUID().replaceAll("-", "")}`;
      await engine.saveTurn({ tenantId: identity.tenantId, id: turnId, version: 1,
        recipient: "synthetic_cleaning_service_owner", timeZone: "America/New_York",
        windowStart: iso(24), windowEnd: iso(30), nextArrival: iso(31), minimumMinutes: 90 });
      await engine.receive({ tenantId: identity.tenantId, providerEventId, turnId, requestedStart: iso(25) });
      return await engine.get(identity, id);
    });
    fixtureQueue = run.catch(() => {});
    try { res.status(200).json({ mode: "synthetic", work: await run }); }
    catch { res.status(503).json({ error: "Synthetic request could not be confirmed. Retry the same eventId." }); }
  });
  app.get("/test/evidence/:id", async (req, res) => {
    try {
      const evidence = await engine.evidence(identity, req.params.id as string);
      res.json({ mode: "synthetic", ...evidence, replies: sink.replies().filter((reply) => reply.key === `reply_${evidence.work.id}`),
        notification: notifications ? await notifications.status(evidence.work.id) : { status: "disabled" } });
    } catch (error) {
      res.status(error instanceof DelegationError && error.code === "NOT_FOUND" ? 404 : 503).json({ error: "Evidence unavailable." });
    }
  });
  return { app, engine, sink, notifications, stop: async () => { await fixtureQueue; await notificationWorker?.stop(); await worker.stop(); } };
}
