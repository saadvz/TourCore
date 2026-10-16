import { mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FIRST_QUESTION, resetLiveDesks, setCleanerCalendarFetch } from "../src/cleaner-core/liveDesk";
import { setCleanerTwilioClient } from "../src/cleaner-core/liveSms";
import type { TwilioClient } from "../src/messaging/twilio/client";
import { setTwilioClient } from "../src/messaging/twilio/provider";
import { twilioSignature } from "../src/messaging/twilio/signature";
import { Installation } from "../src/install/installation";
import { PropertyWorkspace, runReadinessCheck } from "../src/setup";
import { FileRuntimeStore } from "../src/storage/runtimeStore";
import { createSetupServer } from "../src/web/server";
import { PUBLIC } from "./fakeSendblue";
import { hillsideConfig, publishForVisitors } from "./liveApp";

export const FROZEN = "2026-10-14T15:00:00.000Z";
export const HOST = "+15555550130";
export const CLEANER = "+15555550131";
export const OBSERVER = "+15555550132";
export const OFF_LIST = "+15555550199";
export const TOUR_LINE = "+15555550123";
export const CLEANER_LINE = "+15555550124";
export const ADDRESS = "12 Practice Lane, Teaneck, NJ 07666";
export const BUSINESS = "Harbor";
export const DOOR_CODE = "8088";
export const CALENDAR_URL = "https://calendar.example/harbor.ics";
export const TOUR_TOKEN = "tour-operator-token-wiring";
export const CLEANER_TOKEN = "cleaner-mcp-token-wiring";
export const TOUR_AUTH = "tour-twilio-auth-token-wiring";
export const CLEANER_AUTH = "cleaner-twilio-auth-token-wiring";
export const EVIDENCE_DIR = ".cursor/skills/verify-cleanercore/evidence/wiring";
export const TEST_PIN_KEY = Buffer.from("0123456789abcdef0123456789abcdef").toString("base64");
export const PIN_KEY_HEADER = "x-cleaner-core-pin-key";

export const CALENDAR_ICS = [
  "BEGIN:VCALENDAR",
  "BEGIN:VEVENT",
  "UID:stay-a",
  "DTSTART;VALUE=DATE:20261014",
  "DTEND;VALUE=DATE:20261018",
  "SUMMARY:Guest",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:stay-b",
  "DTSTART;VALUE=DATE:20261018",
  "DTEND;VALUE=DATE:20261022",
  "SUMMARY:Next guest",
  "END:VEVENT",
  "END:VCALENDAR",
  "",
].join("\n");

export interface SentSms {
  to: string;
  body: string;
  status: string;
  sid: string;
  statusCallback?: string;
}

export interface ToolResult {
  status: number;
  text: string;
  raw: string;
  isError: boolean;
  structured: Record<string, unknown> | undefined;
}

export interface WiredApp {
  port: number;
  root: string;
  /** The server's merged environment, including values saved in the secret store. */
  env: () => NodeJS.ProcessEnv;
  tourSent: SentSms[];
  cleanerSent: SentSms[];
  close: () => Promise<void>;
  tool: (path: string, token: string, name: string, args?: Record<string, unknown>, options?: { pinKey?: string | null }) => Promise<ToolResult>;
  listTools: (path: string, token: string) => Promise<{ status: number; names: string[]; raw: string }>;
  /** `extra` adds signed form fields, like NumMedia and MediaUrl0 for an MMS. */
  postTwilio: (path: string, input: { from: string; to: string; body: string; sid: string; token: string; extra?: Record<string, string> }) => Promise<{ status: number; raw: string }>;
  /** Changes the server's raw environment. An undefined value removes the name. */
  setEnv: (values: NodeJS.ProcessEnv) => void;
  postStatus: (input: { sid: string; status: string; signed?: boolean }) => Promise<{ status: number; raw: string }>;
  logs: string[];
  /** The server's secret store, for a test that makes it fail. */
  secretStore: Installation["secrets"];
  /** Writes to the server's secret store, like the alert upload does. */
  saveSecret: (values: Parameters<Installation["secrets"]["set"]>[0]) => void;
}

export function redactCode(value: string, code = DOOR_CODE): string {
  return value.split(code).join("[redacted]");
}

export function fakeSms(decide: (body: string) => string = () => "queued"): TwilioClient & { sent: SentSms[] } {
  const sent: SentSms[] = [];
  return {
    sent,
    async getAccount() {
      return { sid: "ACfake", status: "active" };
    },
    async findNumber() {
      return { sid: "PNfake", phoneNumber: TOUR_LINE, smsUrl: `${PUBLIC}/webhooks/twilio` };
    },
    async setSmsUrl() {},
    async sendSms(input) {
      const status = decide(input.body);
      const sid = `SM${sent.length + 1}`;
      sent.push({ to: input.to, body: input.body, status, sid, ...(input.statusCallback ? { statusCallback: input.statusCallback } : {}) });
      return { sid, status };
    },
  };
}

export async function startWiredApp(options: { live?: boolean; enabled?: boolean; scratchTools?: boolean; allowlist?: string; groupChat?: boolean; now?: () => Date; calendar?: () => string } = {}): Promise<WiredApp> {
  const live = options.live !== false;
  const now = options.now ?? (() => new Date(FROZEN));
  const enabled = options.enabled !== false;
  const root = mkdtempSync(join(tmpdir(), "cleaner-wiring-"));
  const ws = new PropertyWorkspace(root);
  const { config } = ws.save(hillsideConfig());
  ws.recordReadiness(config.property.id, await runReadinessCheck(config));
  publishForVisitors(ws, config.property.id, new Date());
  const env: NodeJS.ProcessEnv = {
    PUBLIC_BASE_URL: PUBLIC,
    TOURCORE_SMS_CONSENT_MODE: "keyword_confirm",
    TOURCORE_TWILIO_ACCOUNT_SID: "ACtourwiring",
    TOURCORE_TWILIO_AUTH_TOKEN: TOUR_AUTH,
    TOURCORE_TWILIO_PHONE_NUMBER: TOUR_LINE,
    TOURCORE_OPERATOR_TOKEN: TOUR_TOKEN,
    ...(enabled ? { CLEANER_CORE_ENABLED: "1" } : {}),
    ...(live ? { CLEANER_CORE_LIVE_SMS: "1" } : {}),
    CLEANER_CORE_SMS_ALLOWLIST: options.allowlist ?? `${HOST},${CLEANER}`,
    ...(options.scratchTools ? { CLEANER_CORE_SCRATCH_TOOLS: "1" } : {}),
    ...(options.groupChat ? { CLEANER_CORE_GROUP_CHAT: "1" } : { CLEANER_CORE_GROUP_CHAT: "0" }),
    CLEANER_CORE_MCP_TOKEN: CLEANER_TOKEN,
    CLEANER_CORE_TWILIO_ACCOUNT_SID: "ACcleanerwiring",
    CLEANER_CORE_TWILIO_AUTH_TOKEN: CLEANER_AUTH,
    CLEANER_CORE_TWILIO_PHONE_NUMBER: CLEANER_LINE,
  };
  const runtime = new FileRuntimeStore(join(root, "runtime"));
  const installation = new Installation({ root, runtime, env: () => env, now: () => now().getTime() });
  installation.files.ensure({ deploymentMode: "LOCAL_DEVELOPER" });
  installation.files.setPublicBaseUrl(PUBLIC, "MANUAL");
  installation.files.writeState({ ...installation.files.state(), messagingProviderChoice: "twilio" });
  installation.secrets.set({
    TOURCORE_TWILIO_ACCOUNT_SID: "ACtourwiring",
    TOURCORE_TWILIO_AUTH_TOKEN: TOUR_AUTH,
    TOURCORE_TWILIO_PHONE_NUMBER: TOUR_LINE,
  });
  const tour = fakeSms();
  const cleaner = fakeSms();
  const restoreTour = setTwilioClient(() => tour);
  setCleanerTwilioClient(cleaner);
  setCleanerCalendarFetch(async (url) => ({
    status: url === CALENDAR_URL ? 200 : 404,
    url,
    async text() {
      return url === CALENDAR_URL ? (options.calendar?.() ?? CALENDAR_ICS) : "";
    },
  }));
  const logs: string[] = [];
  const server: Server = createSetupServer({
    toolSurface: "all",
    workspace: ws,
    installation,
    operatorToken: () => TOUR_TOKEN,
    now,
    log: (line) => {
      logs.push(line);
    },
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  let rpc = 0;
  const close = async () => {
    restoreTour();
    setCleanerTwilioClient(undefined);
    setCleanerCalendarFetch(undefined);
    resetLiveDesks();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  };
  const tool = async (path: string, token: string, name: string, args: Record<string, unknown> = {}, options?: { pinKey?: string | null }): Promise<ToolResult> => {
    const pinKey = options?.pinKey === null ? undefined : (options?.pinKey ?? TEST_PIN_KEY);
    const headers: Record<string, string> = { "Content-Type": "application/json", Authorization: `Bearer ${token}` };
    if (pinKey) headers[PIN_KEY_HEADER] = pinKey;
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: ++rpc, method: "tools/call", params: { name, arguments: args } }),
    });
    const raw = await res.text();
    const parsed = JSON.parse(raw) as {
      result?: { isError?: boolean; structuredContent?: Record<string, unknown>; content?: Array<{ text?: string }> };
      error?: { message?: string };
    };
    const text = parsed.result?.content?.[0]?.text ?? parsed.error?.message ?? "";
    return { status: res.status, text, raw, isError: parsed.result?.isError === true || Boolean(parsed.error), structured: parsed.result?.structuredContent };
  };
  const listTools = async (path: string, token: string) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++rpc, method: "tools/list" }),
    });
    const raw = await res.text();
    const parsed = JSON.parse(raw) as { result?: { tools?: Array<{ name: string }> } };
    return { status: res.status, names: parsed.result?.tools?.map((item) => item.name) ?? [], raw };
  };
  const postTwilio = async (path: string, input: { from: string; to: string; body: string; sid: string; token: string; extra?: Record<string, string> }) => {
    const fields: Record<string, string> = { MessageSid: input.sid, From: input.from, To: input.to, Body: input.body, SmsStatus: "received", ...input.extra };
    const rawBody = new URLSearchParams(fields).toString();
    const signature = twilioSignature(input.token, `${PUBLIC}${path}`, fields);
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Twilio-Signature": signature },
      body: rawBody,
    });
    return { status: res.status, raw: await res.text() };
  };
  const postStatus = async (input: { sid: string; status: string; signed?: boolean }) => {
    const path = "/webhooks/twilio/cleaner-core/status";
    const fields = { MessageSid: input.sid, MessageStatus: input.status, From: CLEANER_LINE, To: CLEANER };
    const rawBody = new URLSearchParams(fields).toString();
    const headers: Record<string, string> = { "Content-Type": "application/x-www-form-urlencoded" };
    if (input.signed !== false) headers["X-Twilio-Signature"] = twilioSignature(CLEANER_AUTH, `${PUBLIC}${path}`, fields);
    const res = await fetch(`http://127.0.0.1:${port}${path}`, { method: "POST", headers, body: rawBody });
    return { status: res.status, raw: await res.text() };
  };
  const setEnv = (values: NodeJS.ProcessEnv) => {
    for (const [name, value] of Object.entries(values)) {
      if (value === undefined) delete env[name];
      else env[name] = value;
    }
  };
  return { port, root, env: () => installation.env(), tourSent: tour.sent, cleanerSent: cleaner.sent, close, tool, listTools, postTwilio, setEnv, postStatus, logs, secretStore: installation.secrets, saveSecret: (values) => installation.secrets.set(values) };
}

export function toCleaner(sent: SentSms[]): SentSms[] {
  return sent.filter((item) => item.to === CLEANER);
}

export function bodies(sent: SentSms[]): string[] {
  return sent.map((item) => item.body);
}

export { FIRST_QUESTION };
