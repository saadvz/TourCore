import { z } from "zod";
import { toE164 } from "../messaging/Messenger";
import { createMessagingProvider, ensureMessagingSelection } from "../messaging/registry";
import { chooseMessagingProvider } from "../messaging/switchProvider";
import type { SettingName } from "./secretStore";
import type { OperatorServices } from "../operator/services";
import { testOperatorAlerts, testVisitorMessaging } from "./checks";
import type { Installation } from "./installation";
import { secretValues } from "./settings";
import { isHostedRailway } from "./deployment";
import { SETUP_CSRF_HEADER, SETUP_SESSION_HEADER } from "./setupSessions";
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

const Messaging = z.object({
  apiKey: z.string().trim().max(300).optional(),
  apiSecret: z.string().trim().max(300).optional(),
  fromNumber: z.string().trim().max(40).optional(),
  values: z.record(z.string(), z.string().trim().max(300)).optional(),
  line: z.string().trim().max(40).optional(),
});

const Alerts = z.union([
  z.strictObject({ webhookUrl: z.string().trim().max(2000), key: z.string().trim().max(1000) }),
  /** The routine panel's whole webhook example (e.g. a curl command), pasted in one go. */
  z.strictObject({ snippet: z.string().trim().min(1).max(5000) }),
]);

/**
 * Finds the webhook address and bearer key in whatever the routine panel
 * shows for its trigger: a curl example, "URL: ... Key: ...", or the two
 * values on separate lines. Only runs on this page; nothing is logged.
 */
export function parseRoutineSnippet(text: string): { webhookUrl: string; key: string } | undefined {
  const url = /https:\/\/[^\s"'<>`]+/i.exec(text)?.[0]?.replace(/[),.;]+$/, "");
  const key =
    /authorization\s*[:=]\s*["']?\s*bearer\s+([^\s"'`]+)/i.exec(text)?.[1] ??
    /\bbearer\s+([A-Za-z0-9._~+/=-]{8,})/i.exec(text)?.[1] ??
    /\b(?:key|token|secret)\b["']?\s*[:=]\s*["']?([A-Za-z0-9._~+/=-]{8,})/i.exec(text)?.[1] ??
    text
      .split(/\s+/)
      .map((w) => w.replace(/^["'`]+|["'`,;]+$/g, ""))
      .find((w) => w.length >= 16 && !/^https?:/i.test(w) && /^[A-Za-z0-9._~+/=-]+$/.test(w) && /\d/.test(w) && /[A-Za-z]/.test(w));
  return url && key ? { webhookUrl: url, key } : undefined;
}

const fail = (status: number, message: string): SecureSetupResult => ({ status, json: { ok: false, error: { message } } });

const headerValue = (headers: Record<string, string | string[] | undefined>, name: string) => {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
};

export async function handleSecureSetupApi(ctx: SecureSetupContext, method: string, path: string, headers: Record<string, string | string[] | undefined>, body: unknown): Promise<SecureSetupResult> {
  const inst = ctx.installation;
  const token = headerValue(headers, SETUP_SESSION_HEADER);
  const session = inst.sessions.check(token, headerValue(headers, SETUP_CSRF_HEADER));
  if (!session.ok) {
    const message =
      session.reason === "expired"
        ? "This secure setup link has expired. Ask Grok for a new one."
        : session.reason === "spent"
          ? "This secure setup link has already been used. Ask Grok for a new one."
          : "This page needs a secure setup link from Grok (or `npm run install:link` on this computer).";
    return fail(401, message);
  }
  const hosted = isHostedRailway(inst.deploymentMode());
  if (hosted && method === "POST" && !session.csrfOk) return fail(403, "This setup page couldn't be verified. Ask for a new secure setup link.");
  if (hosted && method === "POST") {
    const origin = headerValue(headers, "origin");
    const base = inst.publicBaseUrl();
    if (origin && base && origin !== new URL(base).origin) return fail(403, "This setup page couldn't be verified. Ask for a new secure setup link.");
  }
  const at = () => new Date(inst.now());
  const wrote = () => {
    if (token) inst.sessions.noteWrite(token);
  };
  const route = path.replace(/^\/api\/install\/?/, "");
  const reply = (status: number, json: Record<string, unknown>) => ({ status, json: withoutSecrets(inst, { ...json, session: { expiresAt: new Date(session.expiresAt).toISOString() } }) });

  if (method === "GET" && route === "status") {
    const s = getInstallationStatus(inst, ctx.services);
    const alerts = s.components.find((c) => c.component === "OPERATOR_ALERTS")!;
    return reply(200, {
      ok: true,
      summary: s.summary,
      lines: s.lines,
      components: s.components.map((c) => ({ component: c.component, label: c.label, state: c.state, summary: c.summary })),
      nextStep: s.nextStep,
      sections: { visitorMessaging: true, operatorAlerts: alerts.state !== "NOT_CONFIGURED" || !!alerts.next || alerts.optionalActions.length > 0 },
      settings: {
        visitorMessaging: messagingForm(inst),
        operatorAlerts: { webhookUrl: !!inst.env().TOURCORE_GROK_ROUTINE_URL?.trim(), key: !!inst.env().TOURCORE_GROK_ROUTINE_KEY?.trim() },
      },
    });
  }

  if (method === "POST" && route === "visitor-messaging") {
    const parsed = Messaging.safeParse(body ?? {});
    if (!parsed.success) return fail(400, "Please check the messaging details.");
    let selection = ensureMessagingSelection(inst);
    const legacySendblue = parsed.data.apiKey || parsed.data.apiSecret || parsed.data.fromNumber;
    if (!selection.provider && legacySendblue) {
      await chooseMessagingProvider(inst, "sendblue");
      selection = ensureMessagingSelection(inst);
    }
    if (selection.invalid) return fail(400, `Tour Core doesn't include a messaging provider named "${selection.invalid}".`);
    if (!selection.provider) return fail(400, "Choose how prospects will text Tour Core first.");
    const provider = createMessagingProvider(selection.provider, { env: () => inst.env(), sendblue: () => inst.sendblueEnv() });
    const values: Record<string, string> = { ...(parsed.data.values ?? {}) };
    if (selection.provider === "sendblue") {
      if (parsed.data.apiKey) values.SENDBLUE_API_API_KEY = parsed.data.apiKey;
      if (parsed.data.apiSecret) values.SENDBLUE_API_API_SECRET = parsed.data.apiSecret;
      if (parsed.data.fromNumber) values.SENDBLUE_FROM_NUMBER = parsed.data.fromNumber;
    }
    if (parsed.data.line) values.TOURCORE_PHOTON_PHONE_NUMBER = parsed.data.line;
    const current = inst.env();
    for (const field of provider.configFields()) {
      if (!field.required) continue;
      const incoming = values[field.name]?.trim();
      const existing = current[field.name]?.trim();
      if (!incoming && !existing) return fail(400, `Enter the ${field.label}.`);
      if (field.secret && incoming && incoming.length < 8) return fail(400, `That ${field.label} looks too short.`);
    }
    for (const name of ["SENDBLUE_FROM_NUMBER", "TOURCORE_TWILIO_PHONE_NUMBER", "TOURCORE_PHOTON_PHONE_NUMBER"] as const) {
      if (!values[name]) continue;
      const number = toE164(values[name]);
      if (!number) return fail(400, "Enter the texting number in full, like +15551234567.");
      values[name] = number;
    }
    const known = new Set(provider.settingNames());
    const accepted = Object.fromEntries(Object.entries(values).filter(([name, value]) => known.has(name) && value.trim()));
    inst.secrets.set(accepted as Partial<Record<SettingName, string>>, at());
    wrote();
    ctx.resetMessaging?.();
    const result = await testVisitorMessaging(inst, { onConnected: ctx.resetMessaging });
    return reply(200, { ok: result.ok, saved: true, message: result.message, checks: result.checks, incomingMessages: result.incomingMessages, ...(result.needsLineChoice ? { needsLineChoice: true, lines: result.lines ?? [] } : {}) });
  }

  if (method === "POST" && route === "visitor-messaging/test") {
    wrote();
    const result = await testVisitorMessaging(inst, { onConnected: ctx.resetMessaging });
    return reply(200, { ok: result.ok, message: result.message, checks: result.checks, incomingMessages: result.incomingMessages });
  }

  if (method === "POST" && route === "operator-alerts") {
    const parsed = Alerts.safeParse(body ?? {});
    if (!parsed.success) return fail(400, "Enter the routine's webhook address and key.");
    const values = "snippet" in parsed.data ? parseRoutineSnippet(parsed.data.snippet) : parsed.data;
    if (!values) return fail(400, "I couldn't find both the webhook address and the key in what you pasted. Paste them into the two fields instead.");
    let url: URL;
    try {
      url = new URL(values.webhookUrl);
    } catch {
      return fail(400, "That webhook address isn't a web address.");
    }
    if (url.protocol !== "https:") return fail(400, "The webhook address must start with https://.");
    if (values.key.length < 8) return fail(400, "That key looks too short.");
    inst.secrets.set({ TOURCORE_GROK_ROUTINE_URL: url.toString(), TOURCORE_GROK_ROUTINE_KEY: values.key }, at());
    wrote();
    inst.files.update({ operatorNotificationProvider: "GROK_ROUTINE" }, at());
    const result = await testOperatorAlerts(inst);
    return reply(200, { ok: result.ok, saved: true, message: result.message });
  }

  if (method === "POST" && route === "operator-alerts/test") {
    wrote();
    const result = await testOperatorAlerts(inst);
    return reply(200, { ok: result.ok, message: result.message });
  }

  return fail(404, "That page doesn't exist.");
}

function messagingForm(inst: Installation) {
  const selection = ensureMessagingSelection(inst);
  if (!selection.provider) {
    return { provider: null, title: "Visitor texting", intro: "Choose how prospects will text Tour Core before entering account details.", fields: [], lines: [] };
  }
  const provider = createMessagingProvider(selection.provider, { env: () => inst.env(), sendblue: () => inst.sendblueEnv() });
  const env = inst.env();
  const sendblue = selection.provider === "sendblue" ? inst.sendblueEnv() : undefined;
  const rawFor = (name: string): string | undefined => {
    if (name === "SENDBLUE_API_API_KEY") return sendblue?.apiKey;
    if (name === "SENDBLUE_API_API_SECRET") return sendblue?.apiSecret;
    if (name === "SENDBLUE_FROM_NUMBER") return sendblue?.fromNumberRaw;
    return env[name];
  };
  return {
    provider: provider.id,
    title: `Visitor texting (${provider.displayName})`,
    intro: provider.description,
    fields: provider.configFields().map((field) => {
      const raw = rawFor(field.name)?.trim();
      const value = field.secret ? undefined : nameValue(field.name, raw, sendblue?.fromNumber);
      return { name: field.name, label: field.label, hint: field.hint, secret: field.secret, required: field.required, set: !!raw, ...(value ? { value } : {}) };
    }),
    lines: inst.files.state().messagingLines ?? [],
  };
}

function nameValue(name: string, raw: string | undefined, sendblueNumber: string | undefined): string | undefined {
  if (!raw) return undefined;
  if (name === "SENDBLUE_FROM_NUMBER") return sendblueNumber;
  if (name.endsWith("PHONE_NUMBER")) return toE164(raw) ?? raw;
  return undefined;
}

/** Last line of defense: nothing this API returns may contain a configured credential. */
function withoutSecrets(inst: Installation, value: Record<string, unknown>): Record<string, unknown> {
  const text = JSON.stringify(value);
  const leaked = secretValues(process.env, inst.settingsSource()).filter((s) => text.includes(s));
  if (!leaked.length) return value;
  return JSON.parse(leaked.reduce((t, s) => t.split(s).join("[hidden]"), text));
}
