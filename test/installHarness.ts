import { join } from "node:path";
import { Installation } from "../src/install/installation";
import { LocalSecretStore } from "../src/install/secretStore";
import { OAuthGrantStore } from "../src/mcp/oauth/store";
import { readSendblueEnv } from "../src/messaging/sendblue/runtime";
import { FileRuntimeStore } from "../src/storage/runtimeStore";
import { at, grokHarness } from "./grokHarness";

export const ROUTINE_URL = "https://routines.example/hooks/tc-routine-SECRETPATH-9f8e7d";
export const ROUTINE_KEY = "routine-bearer-SECRETKEY-1a2b3c4d";
export const SB_KEY = "sb-api-key-SECRETVALUE-11111111";
export const SB_SECRET = "sb-api-secret-SECRETVALUE-22222222";

export interface FakeFetchCall {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

/** Network stand-in for installation checks: the public health page and the Grok Routine webhook. */
export function fakeNetwork() {
  const calls: FakeFetchCall[] = [];
  const state = { routineStatus: 202, routineDown: false, health: undefined as unknown };
  const fetch = async (url: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body });
    if (url.endsWith("/healthz")) return { status: 200, json: async () => (typeof state.health === "function" ? (state.health as () => unknown)() : state.health) };
    if (url.startsWith("https://routines.example/")) {
      if (state.routineDown) throw new Error("connection refused");
      return { status: state.routineStatus, json: async () => ({}) };
    }
    return { status: 404, json: async () => ({}) };
  };
  return { fetch, calls, state, routineCalls: () => calls.filter((c) => c.url.startsWith("https://routines.example/")) };
}

/**
 * A Grok harness (tools over a real workspace) plus a real Installation in the
 * same folder: file-backed manifest, secret store, sessions and outbox.
 */
export function installHarness(options: { env?: NodeJS.ProcessEnv } = {}) {
  const h = grokHarness();
  const env: NodeJS.ProcessEnv = { ...(options.env ?? {}) };
  const net = fakeNetwork();
  const runtime = new FileRuntimeStore(join(h.root, "runtime"));
  let inst!: Installation;
  inst = new Installation({
    root: h.root,
    runtime,
    secrets: new LocalSecretStore(join(h.root, "install", "secrets.json")),
    env: () => env,
    sendblueEnv: () => readSendblueEnv(inst.env()),
    now: () => h.now(),
    fetch: net.fetch as never,
    outbox: { baseDelayMs: 1000 },
  });
  h.ctx.installation = inst;
  h.services.runtime = runtime;
  const connectGrok = (url = inst.publicBaseUrl()!) => {
    const origin = new URL(url).origin;
    new OAuthGrantStore(runtime, () => h.now()).addGrant({
      clientId: "grok-client",
      clientName: "Grok",
      issuer: origin,
      resource: `${origin}/mcp`,
      scopes: ["tourcore.operator"],
      createdAt: h.now(),
      expiresAt: h.now() + 30 * 86_400_000,
      accessHash: "not-a-real-token-hash",
      accessExpiresAt: h.now() + 3_600_000,
    });
  };
  const status = async () => (await h.ok("get_installation_status")) as { components: Array<{ component: string; state: string; next?: { action: string } }>; nextStep: { action: string; performedBy: string; tool?: string; component: string | null }; infrastructureReady: boolean; lines: string[] };
  const component = async (name: string) => (await status()).components.find((c) => c.component === name)!;
  return { ...h, env, net, inst, runtime, connectGrok, status, component, start: at(7) };
}
export type InstallHarness = ReturnType<typeof installHarness>;
