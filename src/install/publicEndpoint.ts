import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { publicBase } from "../messaging/sendblue/runtime";
import { writeJsonAtomic } from "../storage/atomicWrite";
import type { PublicEndpointProviderKind } from "./manifest";
import { nodeProcesses, waitFor, type ProcessControl } from "./processes";

/**
 * How Tour Core gets a public https address. Infrastructure only: Tour Core's
 * business logic never knows which provider is in use, only the resulting
 * address (and the installation status notices when it changes).
 *
 * P0 providers:
 *  - ManualPublicEndpointProvider: an address someone else runs (a developer's
 *    tunnel, or a SELF_HOSTED server's stable https URL).
 *  - CloudflareQuickTunnelProvider: a temporary trycloudflare.com address for
 *    GROK_MANAGED_P0 demos. It changes whenever the tunnel restarts.
 *
 * A future stable host (VM, container host, Railway, Render, Fly, ...)
 * implements the same interface.
 */

export interface EndpointResult {
  state: "READY" | "ACTION_REQUIRED" | "ERROR";
  provider: PublicEndpointProviderKind;
  url?: string;
  /** Plain language. For ACTION_REQUIRED, the one thing to do. */
  message: string;
}

export interface PublicEndpointProvider {
  readonly kind: PublicEndpointProviderKind;
  /** Establishes the endpoint for the local runtime (or confirms the one already running). */
  ensure(localUrl: string): Promise<EndpointResult>;
  stop(): Promise<void>;
}

export class ManualPublicEndpointProvider implements PublicEndpointProvider {
  readonly kind = "MANUAL" as const;

  constructor(private readonly url: () => string | undefined) {}

  async ensure(): Promise<EndpointResult> {
    const raw = this.url();
    const url = publicBase(raw);
    if (url) return { state: "READY", provider: this.kind, url, message: "Using the configured public address." };
    return {
      state: "ACTION_REQUIRED",
      provider: this.kind,
      message: raw ? "The configured public address isn't an https address. Set PUBLIC_BASE_URL to https://..." : "Set PUBLIC_BASE_URL to the https address that reaches Tour Core.",
    };
  }

  async stop(): Promise<void> {}
}

interface TunnelRecord {
  schemaVersion: 1;
  pid: number;
  localUrl: string;
  url?: string;
  startedAt: string;
}

const QUICK_TUNNEL_URL = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;
export const CLOUDFLARED_DOWNLOADS = "https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/";

export interface QuickTunnelOptions {
  /** Where the tunnel's pid, address and log are kept (<data>/service). */
  serviceDir: string;
  /** Where a downloaded cloudflared goes (<data>/bin). */
  binDir: string;
  processes?: ProcessControl;
  /** Downloads a file; only used on Linux, where Cloudflare publishes a single static binary. */
  download?: (url: string, dest: string) => Promise<void>;
  platform?: NodeJS.Platform;
  arch?: string;
  /** How long to wait for cloudflared to print its address. */
  waitMs?: number;
  now?: () => Date;
}

/**
 * Runs `cloudflared tunnel --url http://127.0.0.1:<port>` in the background
 * and captures the https address it prints. Reuses a tunnel that's still
 * running for the same local address, so re-running the bootstrap keeps the
 * same public address. If cloudflared isn't available and can't be
 * downloaded safely, returns one clear step instead of guessing.
 */
export class CloudflareQuickTunnelProvider implements PublicEndpointProvider {
  readonly kind = "CLOUDFLARE_QUICK_TUNNEL" as const;
  private readonly processes: ProcessControl;

  constructor(private readonly options: QuickTunnelOptions) {
    this.processes = options.processes ?? nodeProcesses;
  }

  get recordPath(): string {
    return join(this.options.serviceDir, "tunnel.json");
  }

  get logPath(): string {
    return join(this.options.serviceDir, "tunnel.log");
  }

  record(): TunnelRecord | undefined {
    if (!existsSync(this.recordPath)) return undefined;
    try {
      return JSON.parse(readFileSync(this.recordPath, "utf8")) as TunnelRecord;
    } catch {
      return undefined;
    }
  }

  /** The address of a tunnel that's still running, if any. */
  running(): TunnelRecord | undefined {
    const r = this.record();
    return r && this.processes.isAlive(r.pid) ? r : undefined;
  }

  private urlFromLog(): string | undefined {
    if (!existsSync(this.logPath)) return undefined;
    return QUICK_TUNNEL_URL.exec(readFileSync(this.logPath, "utf8"))?.[0];
  }

  async locate(): Promise<{ path?: string; problem?: string }> {
    const onPath = this.processes.which("cloudflared");
    if (onPath) return { path: onPath };
    const platform = this.options.platform ?? process.platform;
    const local = join(this.options.binDir, platform === "win32" ? "cloudflared.exe" : "cloudflared");
    if (existsSync(local)) return { path: local };
    const arch = this.options.arch ?? process.arch;
    const asset = platform === "linux" ? ({ x64: "cloudflared-linux-amd64", arm64: "cloudflared-linux-arm64" } as Record<string, string>)[arch] : undefined;
    if (!asset || !this.options.download) {
      return { problem: `cloudflared isn't installed on this computer. Install it (${CLOUDFLARED_DOWNLOADS}), or set PUBLIC_BASE_URL to an https address that reaches Tour Core, then run the bootstrap again.` };
    }
    try {
      mkdirSync(this.options.binDir, { recursive: true });
      await this.options.download(`https://github.com/cloudflare/cloudflared/releases/latest/download/${asset}`, local);
      chmodSync(local, 0o755);
      return { path: local };
    } catch {
      rmSync(local, { force: true });
      return { problem: `cloudflared couldn't be downloaded. Install it (${CLOUDFLARED_DOWNLOADS}), or set PUBLIC_BASE_URL, then run the bootstrap again.` };
    }
  }

  async ensure(localUrl: string): Promise<EndpointResult> {
    const existing = this.running();
    if (existing && existing.localUrl === localUrl) {
      const url = existing.url ?? this.urlFromLog();
      if (url) {
        if (!existing.url) writeJsonAtomic(this.recordPath, { ...existing, url });
        return { state: "READY", provider: this.kind, url, message: "The public tunnel is running." };
      }
    }
    if (existing) this.processes.kill(existing.pid);

    const bin = await this.locate();
    if (!bin.path) return { state: "ACTION_REQUIRED", provider: this.kind, message: bin.problem! };

    mkdirSync(this.options.serviceDir, { recursive: true });
    writeFileSync(this.logPath, "");
    let pid: number;
    try {
      pid = this.processes.spawnDetached(bin.path, ["tunnel", "--no-autoupdate", "--url", localUrl], { logFile: this.logPath });
    } catch {
      return { state: "ERROR", provider: this.kind, message: "cloudflared couldn't be started." };
    }
    writeJsonAtomic(this.recordPath, { schemaVersion: 1, pid, localUrl, startedAt: (this.options.now?.() ?? new Date()).toISOString() } satisfies TunnelRecord);
    const url = await waitFor(() => (this.processes.isAlive(pid) ? this.urlFromLog() : "stopped"), { timeoutMs: this.options.waitMs ?? 45_000, intervalMs: 500 });
    if (!url || url === "stopped") {
      this.processes.kill(pid);
      rmSync(this.recordPath, { force: true });
      return { state: "ERROR", provider: this.kind, message: url === "stopped" ? "cloudflared stopped before it had a public address. Check the internet connection and run the bootstrap again." : "cloudflared didn't report a public address in time. Run the bootstrap again." };
    }
    writeJsonAtomic(this.recordPath, { ...this.record()!, url });
    return { state: "READY", provider: this.kind, url, message: "Started a public tunnel." };
  }

  async stop(): Promise<void> {
    const r = this.record();
    if (r) this.processes.kill(r.pid);
    rmSync(this.recordPath, { force: true });
  }
}

export async function downloadFile(url: string, dest: string): Promise<void> {
  const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`download failed (${res.status})`);
  writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
}
