import { setCleanerTwilioClient } from "../src/cleaner-core/liveSms";
import { resetLiveDesks, setCleanerAlertFetch, setCleanerCalendarFetch } from "../src/cleaner-core/liveDesk";
import type { CleanerAssistant } from "../src/cleaner-core/assistant";
import { TenantRegistry } from "../src/cleaner-core/hosted/registry";
import { CLEANER_SCOPE } from "../src/mcp/oauth/provider";
import { twilioSignature } from "../src/messaging/twilio/signature";
import { BASE, CLEANER_RESOURCE, hostedApp } from "./cleanerOauthHarness";
import { CALENDAR_ICS, CALENDAR_URL, fakeSms } from "./wiringProof";

/**
 * A multi-tenant Cleaner Core on a made-up Railway domain: one server, tenants from the registry,
 * each chat connected with an invite code. Texts go to a fake Twilio. Only 555 numbers.
 */

export const MULTI_AUTH = "multi-tenant-twilio-auth-token";
export const REDIRECTS: Record<CleanerAssistant, string> = {
  grok: "https://grok.com/connectors/oauth/callback",
  claude: "https://claude.ai/api/mcp/auth_callback",
  chatgpt: "https://chatgpt.com/connector_platform_oauth_redirect",
  muse: "https://agent.meta.ai/api/hatch/oauth/callback",
};

export interface Wake {
  url: string;
  body: string;
}

export async function multiTenantApp(options: { now?: () => Date; env?: NodeJS.ProcessEnv } = {}) {
  const sms = fakeSms();
  setCleanerTwilioClient(sms);
  setCleanerCalendarFetch(async (url) => ({
    status: url === CALENDAR_URL ? 200 : 404,
    url,
    async text() {
      return url === CALENDAR_URL ? CALENDAR_ICS : "";
    },
  }));
  const wakes: Wake[] = [];
  let wakeStatus = 200;
  setCleanerAlertFetch(async (url, init) => {
    wakes.push({ url, body: init.body });
    return { status: wakeStatus };
  });
  const now = options.now ?? (() => new Date());
  const app = await hostedApp(
    {
      CLEANER_CORE_MULTI_TENANT: "1",
      CLEANER_CORE_LIVE_SMS: "1",
      CLEANER_CORE_SMS_ALLOWLIST: "*",
      CLEANER_CORE_GROUP_CHAT: "0",
      CLEANER_CORE_TWILIO_ACCOUNT_SID: "ACmultitenant",
      CLEANER_CORE_TWILIO_AUTH_TOKEN: MULTI_AUTH,
      ...options.env,
    },
    undefined,
    undefined,
    now,
  );
  const registry = new TenantRegistry(app.root, now);
  let rpc = 0;

  /** Connects one chat to a tenant with a fresh invite. Returns its access token. */
  const join = async (tenantId: string, assistant: CleanerAssistant) => {
    const redirect = REDIRECTS[assistant];
    const clientId = await app.register(assistant, redirect);
    const inviteCode = registry.invite(tenantId);
    const { access } = await app.connect(clientId, CLEANER_RESOURCE, CLEANER_SCOPE, CLEANER_RESOURCE, { inviteCode, redirect });
    return access;
  };

  const tool = async (token: string, name: string, args: Record<string, unknown> = {}) => {
    const res = await app.http("/mcp/cleaner-core", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++rpc, method: "tools/call", params: { name, arguments: args } }),
    });
    const raw = await res.text();
    const parsed = (raw.startsWith("{") ? JSON.parse(raw) : {}) as { result?: { isError?: boolean; structuredContent?: Record<string, unknown>; content?: { text?: string }[] }; error?: { message?: string } };
    return { status: res.status, raw, isError: parsed.result?.isError === true || Boolean(parsed.error), structured: parsed.result?.structuredContent, text: parsed.result?.content?.[0]?.text ?? parsed.error?.message ?? "" };
  };

  /** A Twilio post signed over the public URL, as Twilio sends it. */
  const twilio = async (path: string, fields: Record<string, string>, signWith = path) => {
    const signature = twilioSignature(MULTI_AUTH, `${BASE}${signWith}`, fields);
    return app.http(path, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": signature }, body: new URLSearchParams(fields).toString() });
  };

  const text = (to: string, from: string, body: string, sid: string) =>
    twilio("/webhooks/twilio/cleaner-core", { MessageSid: sid, From: from, To: to, Body: body, SmsStatus: "received" });

  const close = () => {
    setCleanerTwilioClient(undefined);
    setCleanerCalendarFetch(undefined);
    setCleanerAlertFetch(undefined);
    resetLiveDesks();
  };

  return { app, registry, sms, wakes, setWakeStatus: (status: number) => void (wakeStatus = status), join, tool, twilio, text, close };
}

export type MultiTenantApp = Awaited<ReturnType<typeof multiTenantApp>>;
