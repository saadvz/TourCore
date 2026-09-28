import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The canonical public repository is recorded once, in
 * grok-template/template.json (`repository.url`). A bootstrap from a clone of
 * some other repository is refused rather than silently trusted.
 */

/** "https://github.com/Owner/Repo.git/", "git@github.com:Owner/Repo" → "github.com/owner/repo". */
export function normalizeRepoUrl(url: string | undefined): string | undefined {
  const raw = url?.trim();
  if (!raw) return undefined;
  const ssh = /^[\w.-]+@([\w.-]+):(.+)$/.exec(raw);
  let host: string;
  let path: string;
  if (ssh) [host, path] = [ssh[1]!, ssh[2]!];
  else {
    try {
      const u = new URL(raw);
      [host, path] = [u.hostname, u.pathname];
    } catch {
      return undefined;
    }
  }
  const clean = path.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "");
  return clean ? `${host.toLowerCase()}/${clean.toLowerCase()}` : undefined;
}

export function canonicalRepoUrl(repoDir: string): string | undefined {
  const file = join(repoDir, "grok-template", "template.json");
  if (!existsSync(file)) return undefined;
  try {
    return (JSON.parse(readFileSync(file, "utf8")) as { repository?: { url?: string } }).repository?.url?.trim() || undefined;
  } catch {
    return undefined;
  }
}

export function originUrl(repoDir: string): string | undefined {
  const r = spawnSync("git", ["remote", "get-url", "origin"], { cwd: repoDir, encoding: "utf8", windowsHide: true });
  return r.status === 0 ? r.stdout.trim() || undefined : undefined;
}

export function checkRepositorySource(input: { canonical?: string; actual?: string }): { ok: boolean; message: string } {
  const canonical = normalizeRepoUrl(input.canonical);
  const actual = normalizeRepoUrl(input.actual);
  if (!canonical) return { ok: true, message: "No canonical repository is recorded yet; using this clone." };
  if (!actual) return { ok: true, message: `Canonical repository: ${input.canonical}. This folder has no git origin to compare.` };
  if (canonical === actual) return { ok: true, message: `Repository matches the canonical Tour Core repository (${input.canonical}).` };
  return {
    ok: false,
    message: `This clone comes from ${input.actual}, but Tour Core's canonical repository is ${input.canonical}. Not starting an unexpected repository: confirm with the operator which one to use (a fork must set its own repository.url in grok-template/template.json).`,
  };
}
