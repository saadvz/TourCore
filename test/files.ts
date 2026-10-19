import { readdirSync, statSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/** The repository root, for tests that read checked-in files. */
export const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

/** Every regular file under `dir`, recursively, as full paths. */
export function filesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? filesUnder(path) : entry.isFile() ? [path] : [];
  });
}

/**
 * Repo-relative paths of the files under `rel`, which may be a folder or one
 * file. Files whose name is in `except` are left out.
 */
export function repoFilesUnder(rel: string, except: readonly string[] = []): string[] {
  const abs = join(REPO_ROOT, rel);
  const paths = statSync(abs).isDirectory() ? filesUnder(abs) : [abs];
  return paths.filter((path) => !except.includes(basename(path))).map((path) => relative(REPO_ROOT, path));
}
