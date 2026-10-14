import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export function scratchSecrets(root = process.cwd()) {
  const tenants = readFileSync(join(root, "src/cleaner-core/tenants.ts"), "utf8");
  const annex = readFileSync(join(root, "src/cleaner-core/fixtures/annex-lock.txt"), "utf8");
  const found = new Set();
  for (const match of tenants.matchAll(/pin:\s*"(\d{4,8})"/g)) found.add(match[1]);
  for (const match of annex.matchAll(/\b(\d{4,8})\b/g)) found.add(match[1]);
  if (found.size < 3) throw new Error("secret scan could not load the configured scratch values");
  return [...found];
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    process.stdout.write(scratchSecrets().join("|"));
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : "secret scan could not load the configured scratch values"}\n`);
    process.exit(1);
  }
}
