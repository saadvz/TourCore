#!/usr/bin/env node
// Fail when a configured Cleaner Core secret appears outside the historical allowlist.
// Secrets are read from the tenant store and the Annex lock fixture. This file does not repeat them.

import { createDecipheriv, createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const root = process.cwd();
const allow = new Set([
  "src/cleaner-core/tenants.ts",
  "src/cleaner-core/fixtures/annex-lock.txt",
  "src/cleaner-core/fixtures/google-lane-read.json",
  "test/cleanerCore.test.ts",
  "docs/cleaner-core-v5.1-step-d-rationale.md",
  "docs/cleaner-core-v5.1-step-e-rationale.md",
  "docs/cleaner-core-v5.1-plan.pdf",
  ".cursor/skills/verify-cleanercore/SKILL.md",
  ".cursor/skills/verify-cleanercore/features/no-pin.md",
  ".cursor/skills/verify-cleanercore/features/tenant-isolation.md",
  ".cursor/skills/verify-cleanercore/scripts/assert-report.mjs",
  ".cursor/skills/verify-cleanercore/scripts/assert-step-c.mjs",
  ".cursor/skills/verify-cleanercore/scripts/assert-step-d.mjs",
  ".cursor/skills/verify-cleanercore/scripts/assert-step-e.mjs",
  ".cursor/skills/verify-cleanercore/scripts/assert-step-f.mjs",
  ".cursor/skills/verify-cleanercore/scripts/prove-step-c.sh",
  ".cursor/skills/verify-cleanercore/scripts/prove-step-d.sh",
  ".cursor/skills/verify-cleanercore/scripts/prove-step-e.sh",
  ".cursor/skills/verify-cleanercore/scripts/prove-step-f.sh",
]);

const skipDirs = new Set(["node_modules", ".git", "dist", "coverage"]);

function scratchSecrets() {
  const tenants = readFileSync(join(root, "src/cleaner-core/tenants.ts"), "utf8");
  const annex = readFileSync(join(root, "src/cleaner-core/fixtures/annex-lock.txt"), "utf8");
  const found = new Set();
  for (const match of tenants.matchAll(/pin:\s*"(\d{4,8})"/g)) found.add(match[1]);
  for (const match of annex.matchAll(/\b(\d{4,8})\b/g)) found.add(match[1]);
  if (found.size < 3) {
    process.stderr.write("secret scan could not load the configured scratch values\n");
    process.exit(1);
  }
  return [...found];
}

function openSeal(sealed, propertyId) {
  try {
    const key = createHash("sha256").update(`cleaner-core-pin:${propertyId}`).digest();
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(sealed.iv, "base64"));
    decipher.setAuthTag(Buffer.from(sealed.tag, "base64"));
    const pin = Buffer.concat([decipher.update(Buffer.from(sealed.data, "base64")), decipher.final()]).toString("utf8");
    return /^\d{4,8}$/.test(pin) ? pin : undefined;
  } catch {
    return undefined;
  }
}

function collectSeals(value, propertyId, into) {
  if (!value || typeof value !== "object") return;
  const nextId = typeof value.propertyId === "string" ? value.propertyId : propertyId;
  if (value.pinSeal && nextId) {
    const pin = openSeal(value.pinSeal, nextId);
    if (pin) into.add(pin);
  }
  if (Array.isArray(value)) {
    for (const item of value) collectSeals(item, nextId, into);
    return;
  }
  for (const child of Object.values(value)) collectSeals(child, nextId, into);
}

/** Plaintext door-code fields and sealed codes saved with a property id. */
function savedDoorCodes(text) {
  const found = new Set();
  for (const match of text.matchAll(/"(?:pin|doorCode|door_code)"\s*:\s*"(\d{4,8})"/g)) found.add(match[1]);
  if (text.includes("pinSeal")) {
    try {
      collectSeals(JSON.parse(text), undefined, found);
    } catch {
      // Not JSON. The plaintext field scan above still applies.
    }
  }
  return [...found];
}

function walk(dir, out) {
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (skipDirs.has(name)) continue;
    const path = join(dir, name);
    let st;
    try {
      st = statSync(path);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(path, out);
    else if (st.isFile() && st.size > 0 && st.size < 5_000_000) out.push(path);
  }
}

function leak(path, values) {
  let buf;
  try {
    buf = readFileSync(path);
  } catch {
    return false;
  }
  if (buf.includes(0)) {
    const text = buf.toString("latin1");
    return values.some((value) => text.includes(value));
  }
  const text = buf.toString("utf8");
  return values.some((value) => text.includes(value));
}

const scratch = scratchSecrets();
const files = [];
walk(root, files);
for (const extra of process.argv.slice(2)) {
  const path = resolve(extra);
  let st;
  try {
    st = statSync(path);
  } catch {
    process.stderr.write(`secret scan missing path ${extra}\n`);
    process.exit(1);
  }
  if (st.isDirectory()) walk(path, files);
  else files.push(path);
}

// Each code may live in the historical scratch allowlist, or in the file that saved it.
const allowedIn = new Map(scratch.map((value) => [value, new Set(allow)]));
for (const path of files) {
  const rel = relative(root, path);
  let text;
  try {
    const buf = readFileSync(path);
    if (buf.includes(0)) continue;
    text = buf.toString("utf8");
  } catch {
    continue;
  }
  for (const code of savedDoorCodes(text)) {
    if (!allowedIn.has(code)) allowedIn.set(code, new Set());
    allowedIn.get(code).add(rel);
  }
}

const hits = [];
const seen = new Set();
for (const path of files) {
  const rel = relative(root, path);
  if (seen.has(path)) continue;
  seen.add(path);
  const leaked = [];
  for (const [code, sources] of allowedIn) {
    if (sources.has(rel)) continue;
    if (leak(path, [code])) leaked.push(code);
  }
  if (leaked.length > 0) hits.push(rel.startsWith("..") ? path : rel);
}

if (hits.length > 0) {
  process.stderr.write(`secret scan found a saved door code in:\n${hits.join("\n")}\n`);
  process.exit(1);
}
process.stdout.write(`secret scan clean (${allowedIn.size} configured values, ${seen.size} files)\n`);
