import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { zonedTimeToUtc } from "../core/timezone";
import { publicHealth } from "../install/checks";
import { Installation } from "../install/installation";
import { readSendblueEnv } from "../messaging/sendblue/runtime";
import { resetLocalSmsOutbox } from "../messaging/local/outbox";
import { PropertyWorkspace } from "../setup/workspace";
import { FileRuntimeStore } from "../storage/runtimeStore";
import { createSetupServer, type TourCoreServer } from "../web/server";

/** Monday 28 Sep 2026, 7:00am America/New_York. "today" and "3:15 PM today" use this clock. */
export const EVAL_CLOCK = zonedTimeToUtc({ year: 2026, month: 9, day: 28, hour: 7, minute: 0 }, "America/New_York").getTime();

const PUBLIC = "https://eval.example";
const TOKEN = "eval-operator-token-local";

export interface NextSlice {
  action?: string;
  component?: string;
  phase?: string;
  performedBy?: string;
  tool?: string;
  operatorMessage?: string;
  infrastructureReady?: boolean;
}

export interface ClickStep {
  tool: string;
  args: Record<string, unknown>;
  outcome: Record<string, unknown>;
  next?: NextSlice;
}

/** Enough of a next step to classify an out-of-chat exit, with no secrets or instructions text. */
export interface ExitHint {
  action?: string;
  performedBy?: string;
  tool?: string;
  secureSetupStep?: string;
  mentionsSecureSetup: boolean;
}

export type ToolResult = Record<string, unknown>;

/**
 * One hosted-demo Tour Core on a temp folder, with local test texting only.
 * The environment object is closed: a machine that has real texting credentials
 * does not leak them into the session.
 */
export class EvalSession {
  readonly workspace: PropertyWorkspace;
  readonly steps: ClickStep[] = [];
  readonly exitHints: ExitHint[] = [];
  recording = false;
  private readonly root: string;
  private readonly server: TourCoreServer;
  private readonly port: number;
  private readonly restoreOutbox: () => void;
  private rpcId = 0;
  private closed = false;

  private constructor(root: string, workspace: PropertyWorkspace, server: TourCoreServer, port: number, restoreOutbox: () => void) {
    this.root = root;
    this.workspace = workspace;
    this.server = server;
    this.port = port;
    this.restoreOutbox = restoreOutbox;
  }

  static async open(): Promise<EvalSession> {
    const root = mkdtempSync(join(tmpdir(), "tourcore-eval-"));
    const restoreOutbox = resetLocalSmsOutbox();
    const env: NodeJS.ProcessEnv = {
      TOURCORE_DEPLOYMENT_MODE: "HOSTED_RAILWAY_P0",
      PUBLIC_BASE_URL: PUBLIC,
      TOURCORE_OPERATOR_TOKEN: TOKEN,
      TOURCORE_MCP_AUTH_MODE: "static",
    };
    const workspace = new PropertyWorkspace(root);
    const runtime = new FileRuntimeStore(join(root, "runtime"));
    let installation!: Installation;
    const fetchImpl = async (url: string) => {
      if (url === `${PUBLIC}/healthz`) return { status: 200, json: async () => publicHealth(installation) };
      return { status: 404, json: async () => ({}) };
    };
    installation = new Installation({
      root,
      runtime,
      env: () => env,
      sendblueEnv: () => readSendblueEnv(env),
      now: () => EVAL_CLOCK,
      fetch: fetchImpl,
      log: () => {},
    });
    installation.files.ensure({ deploymentMode: "HOSTED_RAILWAY_P0", now: new Date(EVAL_CLOCK) });
    installation.files.setPublicBaseUrl(PUBLIC, "MANUAL", new Date(EVAL_CLOCK));
    const server = createSetupServer({
      workspace,
      installation,
      now: () => new Date(EVAL_CLOCK),
      realNow: () => EVAL_CLOCK,
      operatorToken: () => TOKEN,
      log: () => {},
      alertRetryMs: 3_600_000,
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("eval server did not bind a port");
    const session = new EvalSession(root, workspace, server, address.port, restoreOutbox);
    await server.tourCore.settled();
    const gate = await server.tourCore.storageReady;
    if (!gate.ok) throw new Error(gate.summary);
    const checked = await session.call("check_public_endpoint", {}, false);
    if (checked.ok !== true) throw new Error(`public endpoint check failed: ${JSON.stringify(checked.summary)}`);
    return session;
  }

  async call(name: string, args: Record<string, unknown> = {}, record = this.recording): Promise<ToolResult> {
    const result = await this.rpc(name, args);
    if (record) {
      this.steps.push({ tool: name, args: redactArgs(args), outcome: pickOutcome(result), next: nextOf(name, result) });
      for (const hint of exitHintsOf(result)) this.exitHints.push(hint);
    }
    return result;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.server.tourCore.settled().catch(() => undefined);
    await new Promise<void>((resolve, reject) => {
      (this.server as Server).close((err) => (err ? reject(err) : resolve()));
    });
    this.restoreOutbox();
    rmSync(this.root, { recursive: true, force: true });
  }

  private async rpc(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    const res = await fetch(`http://127.0.0.1:${this.port}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++this.rpcId, method: "tools/call", params: { name, arguments: args } }),
    });
    const body = (await res.json()) as {
      error?: { message?: string };
      result?: { isError?: boolean; structuredContent?: ToolResult; content?: Array<{ text?: string }> };
    };
    if (!res.ok || body.error) throw new Error(body.error?.message ?? `MCP ${name} failed (${res.status})`);
    if (body.result?.isError) throw new Error(body.result.content?.[0]?.text ?? `${name} failed`);
    return body.result?.structuredContent ?? {};
  }
}

export function redactArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (key === "confirmationCode") out[key] = "<confirmation>";
    else if (typeof value === "string" && /url/i.test(key)) out[key] = "<redacted-url>";
    else out[key] = value;
  }
  return out;
}

const OUTCOME_KEYS = ["ok", "passed", "published", "status", "summary", "phase", "infrastructureReady", "scope", "provider"] as const;

export function pickOutcome(result: ToolResult): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of OUTCOME_KEYS) {
    if (result[key] !== undefined) out[key] = result[key];
  }
  return out;
}

export function nextOf(name: string, result: ToolResult): NextSlice | undefined {
  const step = (name === "get_next_installation_step" ? result : result.nextStep) as ToolResult | undefined;
  if (!step || typeof step !== "object" || typeof step.action !== "string") return undefined;
  const slice: NextSlice = {
    action: step.action,
    component: typeof step.component === "string" ? step.component : undefined,
    phase: typeof step.phase === "string" ? step.phase : undefined,
    performedBy: typeof step.performedBy === "string" ? step.performedBy : undefined,
    tool: typeof step.tool === "string" ? step.tool : undefined,
    operatorMessage: typeof step.operatorMessage === "string" ? step.operatorMessage : undefined,
  };
  if (typeof result.infrastructureReady === "boolean") slice.infrastructureReady = result.infrastructureReady;
  return slice;
}

export function exitHintsOf(result: ToolResult): ExitHint[] {
  const steps: ToolResult[] = [];
  if (typeof result.action === "string") steps.push(result);
  if (result.nextStep && typeof result.nextStep === "object") steps.push(result.nextStep as ToolResult);
  return steps.map((step) => {
    const instructions = typeof step.grokInstructions === "string" ? step.grokInstructions : "";
    return {
      action: typeof step.action === "string" ? step.action : undefined,
      performedBy: typeof step.performedBy === "string" ? step.performedBy : undefined,
      tool: typeof step.tool === "string" ? step.tool : undefined,
      secureSetupStep: typeof step.secureSetupStep === "string" ? step.secureSetupStep : undefined,
      mentionsSecureSetup: instructions.includes("get_secure_setup_url"),
    };
  });
}

export function confirmationCode(result: ToolResult): string {
  const confirmation = result.confirmation as { code?: string } | undefined;
  if (!confirmation?.code) throw new Error(`expected a confirmation, got ${JSON.stringify(pickOutcome(result))}`);
  return confirmation.code;
}

export async function confirm(session: EvalSession, name: string, args: Record<string, unknown>, record = session.recording): Promise<ToolResult> {
  const asked = await session.call(name, args, record);
  if (asked.status !== "needs-confirmation") return asked;
  return session.call(name, { ...args, confirmationCode: confirmationCode(asked) }, record);
}
