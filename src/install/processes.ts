import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";

/**
 * The few process operations the bootstrap layer needs: start a long-lived
 * process in the background with its output in a log file, see whether it's
 * alive, stop it. Used only by the installer/service commands on the Tour
 * Core computer, never by an operator tool. Tests replace it.
 */
export interface ProcessControl {
  spawnDetached(command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv; logFile: string }): number;
  isAlive(pid: number): boolean;
  kill(pid: number): void;
  /** Absolute path of an executable on PATH, if any. */
  which(command: string): string | undefined;
}

export const nodeProcesses: ProcessControl = {
  spawnDetached(command, args, options) {
    mkdirSync(dirname(options.logFile), { recursive: true });
    const fd = openSync(options.logFile, "a");
    try {
      const child = spawn(command, args, { cwd: options.cwd, env: options.env, detached: true, stdio: ["ignore", fd, fd], windowsHide: true });
      child.on("error", () => {});
      child.unref();
      if (!child.pid) throw new Error(`Couldn't start ${command}.`);
      return child.pid;
    } finally {
      closeSync(fd);
    }
  },
  isAlive(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      return (err as NodeJS.ErrnoException).code === "EPERM";
    }
  },
  kill(pid) {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
      return;
    }
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Already gone.
    }
  },
  which(command) {
    const names = process.platform === "win32" ? [`${command}.exe`, `${command}.cmd`, command] : [command];
    for (const dir of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
      for (const name of names) {
        const candidate = join(dir, name);
        if (existsSync(candidate)) return candidate;
      }
    }
    return undefined;
  },
};

export async function waitFor<T>(check: () => T | undefined | Promise<T | undefined>, options: { timeoutMs: number; intervalMs?: number }): Promise<T | undefined> {
  const end = Date.now() + options.timeoutMs;
  for (;;) {
    const value = await check();
    if (value !== undefined) return value;
    if (Date.now() >= end) return undefined;
    await new Promise((r) => setTimeout(r, options.intervalMs ?? 500));
  }
}
