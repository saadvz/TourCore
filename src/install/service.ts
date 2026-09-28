import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { writeJsonAtomic } from "../storage/atomicWrite";
import { nodeProcesses, waitFor, type ProcessControl } from "./processes";

/**
 * A small service manager for the Tour Core runtime, for the install layer
 * only (bootstrap and `npm run service:*`). Starts the server in the
 * background with its output in a log file, reports whether it's running and
 * healthy, stops and restarts it. Deliberately simple: no systemd, no
 * containers. Never reachable from an operator tool.
 */

export interface RuntimeInfo {
  schemaVersion: 1;
  pid: number;
  port: number;
  url: string;
  startedAt: string;
}

export const serviceDir = (root: string) => join(root, "service");
export const runtimeInfoPath = (root: string) => join(serviceDir(root), "runtime.json");

/** Written by the running server once it's listening; removed when it stops cleanly. */
export function writeRuntimeInfo(root: string, info: Omit<RuntimeInfo, "schemaVersion">): void {
  writeJsonAtomic(runtimeInfoPath(root), { schemaVersion: 1, ...info } satisfies RuntimeInfo);
}

export function readRuntimeInfo(root: string): RuntimeInfo | undefined {
  const path = runtimeInfoPath(root);
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as RuntimeInfo;
  } catch {
    return undefined;
  }
}

export function clearRuntimeInfo(root: string, pid: number): void {
  if (readRuntimeInfo(root)?.pid === pid) rmSync(runtimeInfoPath(root), { force: true });
}

type Fetch = (url: string, init?: { signal?: AbortSignal }) => Promise<{ status: number; json(): Promise<unknown> }>;

export interface ServiceStatus {
  running: boolean;
  healthy: boolean;
  pid?: number;
  localUrl?: string;
  /** Started by this manager (true) or by someone else, e.g. `npm run setup` (false). */
  managed?: boolean;
  message: string;
}

export interface ServiceManagerOptions {
  root: string;
  repoDir: string;
  port?: number;
  processes?: ProcessControl;
  fetch?: Fetch;
  env?: NodeJS.ProcessEnv;
  nodePath?: string;
  startTimeoutMs?: number;
}

export class ServiceManager {
  private readonly processes: ProcessControl;

  constructor(private readonly options: ServiceManagerOptions) {
    this.processes = options.processes ?? nodeProcesses;
  }

  get logPath(): string {
    return join(serviceDir(this.options.root), "tourcore.log");
  }

  private get port(): number {
    return this.options.port ?? 4321;
  }

  private async health(port: number): Promise<{ pid?: number } | undefined> {
    const doFetch: Fetch = this.options.fetch ?? ((u, init) => fetch(u, init));
    try {
      const res = await doFetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(3000) });
      if (res.status !== 200) return undefined;
      const body = (await res.json()) as { service?: string; pid?: number };
      return body.service === "tour-core" ? { pid: body.pid } : undefined;
    } catch {
      return undefined;
    }
  }

  async status(): Promise<ServiceStatus> {
    const info = readRuntimeInfo(this.options.root);
    if (info) {
      const alive = this.processes.isAlive(info.pid);
      const health = alive ? await this.health(info.port) : undefined;
      if (health && (health.pid === undefined || health.pid === info.pid)) {
        return { running: true, healthy: true, pid: info.pid, localUrl: `http://localhost:${info.port}`, managed: true, message: "Tour Core is running." };
      }
      if (alive) return { running: true, healthy: false, pid: info.pid, localUrl: `http://localhost:${info.port}`, managed: true, message: "Tour Core is running but not answering." };
    }
    // Something else may already be serving Tour Core here (e.g. a developer's `npm run setup`).
    const other = await this.health(this.port);
    if (other) return { running: true, healthy: true, pid: other.pid, localUrl: `http://localhost:${this.port}`, managed: false, message: "Tour Core is already running." };
    return { running: false, healthy: false, message: info ? "Tour Core stopped." : "Tour Core isn't running." };
  }

  /** Starts Tour Core unless a healthy one is already running. A stuck one is restarted. */
  async start(): Promise<ServiceStatus & { started: boolean }> {
    const current = await this.status();
    if (current.healthy) return { ...current, started: false };
    if (current.running && current.pid) this.processes.kill(current.pid);
    rmSync(runtimeInfoPath(this.options.root), { force: true });
    const pid = this.processes.spawnDetached(
      this.options.nodePath ?? process.execPath,
      ["--import", "tsx", join("src", "web", "server.ts"), "--no-open", `--port=${this.port}`],
      { cwd: this.options.repoDir, env: { ...(this.options.env ?? process.env), TOURCORE_HOME: this.options.root }, logFile: this.logPath },
    );
    const ready = await waitFor(
      async () => {
        const s = await this.status();
        if (s.healthy) return s;
        return this.processes.isAlive(pid) ? undefined : s;
      },
      { timeoutMs: this.options.startTimeoutMs ?? 60_000, intervalMs: 500 },
    );
    if (ready?.healthy) return { ...ready, started: true };
    return { running: this.processes.isAlive(pid), healthy: false, pid, started: false, message: `Tour Core didn't start. See ${this.logPath}.` };
  }

  async stop(): Promise<{ stopped: boolean; message: string }> {
    const info = readRuntimeInfo(this.options.root);
    if (!info || !this.processes.isAlive(info.pid)) {
      rmSync(runtimeInfoPath(this.options.root), { force: true });
      const other = await this.health(this.port);
      return { stopped: false, message: other ? "Tour Core is running, but it wasn't started by the service manager. Stop it where it was started." : "Tour Core wasn't running." };
    }
    this.processes.kill(info.pid);
    await waitFor(() => (this.processes.isAlive(info.pid) ? undefined : true), { timeoutMs: 10_000, intervalMs: 200 });
    rmSync(runtimeInfoPath(this.options.root), { force: true });
    return { stopped: true, message: "Tour Core stopped. Its records are saved." };
  }

  async restart(): Promise<ServiceStatus & { started: boolean }> {
    await this.stop();
    return this.start();
  }
}
