import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { renderPlaybook } from "../src/playbooks/compose";

/**
 * A degraded or error step must not tell Grok to create a routine or ask for
 * an address or a key. A negation passes. Re-entering the existing address
 * and key on the secure page passes. The first-time alerts step may still
 * say to create a routine, in its own paragraph.
 */

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const MARKERS = [
  "A tour update didn't reach you.",
  "I'll send you a secure link to reconnect them.",
  "alerts-degraded",
  "alerts-error",
];
const NEGATED = /\b(?:do not|don't|does not|never)\b/i;
const BAD = [
  /\bcreat(?:e|ing)\b[^.!?\n]{0,80}\broutine\b/i,
  /\bask(?:ing)? for\b[^.!?\n]{0,60}\b(?:address|key)\b/i,
  /webhook address and key/i,
];

function sentences(paragraph: string): string[] {
  return paragraph
    .split(/(?<=[.!?…])\s+/u)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

/** Blank lines split paragraphs. A markdown table row is its own paragraph, so a first-time row can still say to create a routine. */
function paragraphs(text: string): string[] {
  const blocks: string[] = [];
  let current: string[] = [];
  const flush = () => {
    const block = current.join("\n").trim();
    if (block) blocks.push(block);
    current = [];
  };
  for (const line of text.split("\n")) {
    if (!line.trim()) {
      flush();
      continue;
    }
    if (line.trim().startsWith("|")) {
      flush();
      blocks.push(line.trim());
      continue;
    }
    current.push(line);
  }
  flush();
  return blocks;
}

/** Unnegated create-a-routine or ask-for-address/key sentences in paragraphs that name a degraded or error step. */
export function pairingViolations(text: string, options: { all?: boolean } = {}): string[] {
  const found: string[] = [];
  for (const paragraph of paragraphs(text)) {
    if (!options.all && !MARKERS.some((marker) => paragraph.includes(marker))) continue;
    for (const sentence of sentences(paragraph)) {
      if (NEGATED.test(sentence)) continue;
      if (BAD.some((pattern) => pattern.test(sentence))) found.push(sentence);
    }
  }
  return found;
}

function filesUnder(rel: string): string[] {
  const abs = join(ROOT, rel);
  if (!statSync(abs).isDirectory()) return rel.endsWith("SETUP_PROMPT.md") ? [] : [rel];
  return readdirSync(abs).flatMap((name) => {
    if (name === "SETUP_PROMPT.md") return [];
    const child = join(rel, name);
    return statSync(join(ROOT, child)).isDirectory() ? filesUnder(child) : [child];
  });
}

const ROOTS = [".grok/skills", "grok-template", "src/playbooks", "src/install/tools.ts", "src/install/status.ts", "src/install/stateView.ts"];

describe("degraded and error steps do not create a routine", () => {
  it("allows a negation and re-entering the existing address, and rejects an unnegated create next to the degraded line", () => {
    const degraded = "A tour update didn't reach you. Check your inbox for anything new. I'm sending a test so the next ones get through.";
    const allowed = `${degraded} Do not create a routine. Never create a new routine or use a new routine's address or key. Do not ask for an address or a key. The secure page overwrites the saved address and key with no history, so re-enter the existing routine's address and key there.`;
    expect(pairingViolations(allowed)).toEqual([]);
    const reconnect = "I'll send you a secure link to reconnect them. Re-enter the existing routine's address and key there.";
    expect(pairingViolations(reconnect)).toEqual([]);
    const paired = `${degraded} Create the Tour Core Operator Updates routine yourself.`;
    expect(pairingViolations(paired).length).toBeGreaterThan(0);
    const separate = `Create the Tour Core Operator Updates routine yourself.\n\n${degraded} Do not create a routine.`;
    expect(pairingViolations(separate)).toEqual([]);
  });

  it("keeps Grok-facing files and the degraded and error playbooks clear of a new routine", () => {
    const hits: string[] = [];
    for (const rel of ROOTS.flatMap(filesUnder)) {
      for (const sentence of pairingViolations(readFileSync(join(ROOT, rel), "utf8"))) hits.push(`${rel}: ${sentence}`);
    }
    const clients = [undefined, { name: "Grok" }, { name: "Claude" }, { name: "ChatGPT" }] as const;
    for (const client of clients) {
      for (const step of ["alerts-degraded", "alerts-error"] as const) {
        for (const sentence of pairingViolations(renderPlaybook(client, step).text, { all: true })) hits.push(`playbook ${client?.name ?? "baseline"} ${step}: ${sentence}`);
      }
    }
    expect(hits).toEqual([]);
  });
});
