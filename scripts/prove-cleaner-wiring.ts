/**
 * Scratch proof for the Cleaner Core live wiring.
 * Writes .cursor/skills/verify-cleanercore/evidence/wiring and exits non-zero
 * when a demo blocker fails. Sends nothing to a real phone.
 */
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const evidence = ".cursor/skills/verify-cleanercore/evidence/wiring";
const run = spawnSync(process.execPath, ["node_modules/vitest/vitest.mjs", "run", "test/cleanerCoreWiring.test.ts"], {
  stdio: "inherit",
});
if (run.status !== 0) process.exit(run.status ?? 1);

const files = readdirSync(evidence);
const required = ["flow.json", "failed-send.json", "result.txt"];
for (const name of required) {
  if (!files.includes(name)) {
    process.stderr.write(`missing ${name}\n`);
    process.exit(1);
  }
}
const combined = files.map((name) => readFileSync(join(evidence, name), "utf8")).join("\n");
if (combined.includes("8088")) {
  process.stderr.write("wiring evidence contains a door code\n");
  process.exit(1);
}
process.stdout.write(`${evidence}\n`);
