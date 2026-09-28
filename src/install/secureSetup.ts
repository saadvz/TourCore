import { z } from "zod";
import { toE164 } from "../messaging/Messenger";
import type { OperatorServices } from "../operator/services";
import { testOperatorAlerts, testVisitorMessaging } from "./checks";
import type { Installation } from "./installation";
import { secretValues } from "./settings";
import { SETUP_SESSION_HEADER } from "./setupSessions";
import { getInstallationStatus } from "./status";

/**
 * The secure setup page's API, served only on the Tour Core computer's own
 * address (never through the public tunnel) and only with a live setup
 * session. This is the one place provider credentials enter Tour Core in a
 * Grok-managed install: the operator types them into the page in the Tour
 * Core computer's browser, they go straight into the SecretStore, and
 * nothing here ever sends a credential back.
 */

export const INSTALL_PAGE_PATHS = ["/install", "/install.js"];
export const isInstallApiPath = (path: string) => path === "/api/install" || path.startsWith("/api/install/");

/** Headers a proxy or tunnel adds. A request carrying any of them didn't come from this computer's own browser. */
export const PROXY_HEADERS = ["cf-connecting-ip", "cf-ray", "cdn-loop", "x-forwarded-for", "x-forwarded-host", "x-real-ip", "forwarded"];

export interface SecureSetupContext {
  installation: Installation;
  services: OperatorServices;
  resetMessaging?: () => void;
}

export type SecureSetupResult = { status: number; json: unknown };

const Messaging = z.strictObject({
  apiKey: z.string().trim().max(300).optional(),
  apiSecret: z.string().trim().max(300).optional(),
  fromNumber: z.string().trim().max(30).optional(),
});

const Alerts = z.strictObject({
  webhookUrl: z.string().trim().max(2000),
  key: z.string().trim().max(1000),
});

const fail = (status: number, message: string): SecureSetupResult => ({ status, json: { ok: false, error: { message } } });

export async function handleSecureSetupApi(ctx: SecureSetupContext, method: string, path: string, headers: Record<string, string | string[] | undefined>, body: unknown): Promise<SecureSetupResult> {
  const inst = ctx.installation;
  const header = headers[SETUP_SESSION_HEADER];
  const session = inst.sessions.check(Array.isArray(header) ? header[0] : header);
  if (!session.ok) {
    return fail(401, session.reason === "expired" ? "This secure setup link has expired. Ask Grok for a new one." : "This page needs a secure setup link from Grok (or `npm run install:link` on this computer).");
  }
  const at = () => new Date(inst.now());
  const route = path.replace(/^\/api\/install\/?/, "");
  const reply = (status: number, json: Record<string, unknown>) => ({ status, json: withoutSecrets(inst, { ...json, session: { expiresAt: new Date(session.expiresAt).toISOString() } }) });

  if (method === "GET" && route === "status") {
    const s = getInstallationStatus(inst, ctx.services);
    const env = inst.sendblueEnv();
    const set = (v: string | undefined) => !!v?.trim();
    return reply(200, {
      ok: true,
      summary: s.summary,
      lines: s.lines,
      components: s.components.map((c) => ({ component: c.component, label: c.label, state: c.state, summary: c.summary })),
      nextStep: s.nextStep,
      settings: {
        visitorMessaging: { apiKey: set(env.apiKey), apiSecret: set(env.apiSecret), fromNumber: env.fromNumber ?? null, incomingSecret: set(env.webhookSecret) },
        operatorAlerts: { webhookUrl: set(inst.env().TOURCORE_GROK_ROUTINE_URL), key: set(inst.env().TOURCORE_GROK_ROUTINE_KEY) },
      },
    });
  }

  if (method === "POST" && route === "visitor-messaging") {
    const parsed = Messaging.safeParse(body ?? {});
    if (!parsed.success) return fail(400, "Please check the Sendblue details.");
    const { apiKey, apiSecret, fromNumber } = parsed.data;
    const env = inst.sendblueEnv();
    if (!(apiKey || env.apiKey) || !(apiSecret || env.apiSecret) || !(fromNumber || env.fromNumberRaw)) return fail(400, "Enter the Sendblue API key, API secret and texting number.");
    if (apiKey && apiKey.length < 8) return fail(400, "That API key looks too short.");
    if (apiSecret && apiSecret.length < 8) return fail(400, "That API secret looks too short.");
    const number = fromNumber ? toE164(fromNumber) : undefined;
    if (fromNumber && !number) return fail(400, "Enter the texting number in full, like +15551234567.");
    inst.secrets.set({ SENDBLUE_API_API_KEY: apiKey, SENDBLUE_API_API_SECRET: apiSecret, SENDBLUE_FROM_NUMBER: number }, at());
    ctx.resetMessaging?.();
    const result = await testVisitorMessaging(inst, { onConnected: ctx.resetMessaging });
    return reply(200, { ok: result.ok, saved: true, message: result.message, checks: result.checks, incomingMessages: result.incomingMessages });
  }

  if (method === "POST" && route === "visitor-messaging/test") {
    const result = await testVisitorMessaging(inst, { onConnected: ctx.resetMessaging });
    return reply(200, { ok: result.ok, message: result.message, checks: result.checks, incomingMessages: result.incomingMessages });
  }

  if (method === "POST" && route === "operator-alerts") {
    const parsed = Alerts.safeParse(body ?? {});
    if (!parsed.success) return fail(400, "Enter the routine's webhook address and key.");
    let url: URL;
    try {
      url = new URL(parsed.data.webhookUrl);
    } catch {
      return fail(400, "That webhook address isn't a web address.");
    }
    if (url.protocol !== "https:") return fail(400, "The webhook address must start with https://.");
    if (parsed.data.key.length < 8) return fail(400, "That key looks too short.");
    inst.secrets.set({ TOURCORE_GROK_ROUTINE_URL: url.toString(), TOURCORE_GROK_ROUTINE_KEY: parsed.data.key }, at());
    inst.files.update({ operatorNotificationProvider: "GROK_ROUTINE" }, at());
    const result = await testOperatorAlerts(inst);
    return reply(200, { ok: result.ok, saved: true, message: result.message });
  }

  if (method === "POST" && route === "operator-alerts/test") {
    const result = await testOperatorAlerts(inst);
    return reply(200, { ok: result.ok, message: result.message });
  }

  return fail(404, "That page doesn't exist.");
}

/** Last line of defense: nothing this API returns may contain a configured credential. */
function withoutSecrets(inst: Installation, value: Record<string, unknown>): Record<string, unknown> {
  const text = JSON.stringify(value);
  const leaked = secretValues(process.env, inst.settingsSource()).filter((s) => text.includes(s));
  if (!leaked.length) return value;
  return JSON.parse(leaked.reduce((t, s) => t.split(s).join("[hidden]"), text));
}
