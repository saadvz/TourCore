import { randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, renameSync, rmSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Local demo storage only. A crash mid-save leaves either the old file or the
 * new one, never half of each: write a temp file, flush it, then rename over
 * the target (rename is atomic on the same volume).
 */

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Synced folders (OneDrive, antivirus) can briefly lock a file; retry a few times. */
function renameWithRetry(from: string, to: string): void {
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (attempt >= 6 || (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES")) throw err;
      sleepSync(25 * (attempt + 1));
    }
  }
}

export function writeFileAtomic(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  const fd = openSync(temp, "w");
  try {
    writeSync(fd, content);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameWithRetry(temp, path);
  } catch (err) {
    rmSync(temp, { force: true });
    throw err;
  }
}

/** Serializes, re-parses to prove the bytes are valid JSON, then writes atomically. */
export function writeJsonAtomic(path: string, value: unknown): void {
  const text = JSON.stringify(value, null, 2) + "\n";
  JSON.parse(text);
  writeFileAtomic(path, text);
}

/**
 * Creates a whole folder of files at once: everything is written into a
 * hidden temp folder, which is renamed into place only when complete.
 */
export function writeFolderAtomic(folder: string, files: Record<string, string>): void {
  if (existsSync(folder)) throw new Error(`Folder already exists: ${folder}`);
  const temp = join(dirname(folder), `.tmp-${randomUUID().slice(0, 8)}`);
  mkdirSync(temp, { recursive: true });
  try {
    for (const [name, content] of Object.entries(files)) writeFileAtomic(join(temp, name), content);
    renameWithRetry(temp, folder);
  } catch (err) {
    rmSync(temp, { recursive: true, force: true });
    throw err;
  }
}
