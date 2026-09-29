import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { canonicalRepoUrl, checkRepositorySource, normalizeRepoUrl } from "../src/install/repoSource";

/** GROK_BOOTSTRAP.md is the one entry point for a blank Grok Bot: short, safe, and pointing at the skill. */

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const BOOTSTRAP = "GROK_BOOTSTRAP.md";

describe("GROK_BOOTSTRAP.md", () => {
  const text = existsSync(new URL(`../${BOOTSTRAP}`, import.meta.url)) ? read(BOOTSTRAP) : "";

  it("exists at the repository root and gives the self-discovery sequence", () => {
    expect(text.length).toBeGreaterThan(0);
    const order = ["Clone the repository", "npm run bootstrap:grok", ".grok/skills/install-tour-core/SKILL.md", "get_installation_status", "get_next_installation_step", "infrastructure ready"];
    const positions = order.map((s) => text.indexOf(s));
    for (const [i, p] of positions.entries()) expect(p, order[i]).toBeGreaterThan(-1);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(text).toContain("`.grok/skills/`");
    expect(text).toMatch(/visitor texting → Google Drive\s+\(recommended; local demo only if they decline\) → property → alerts\s+\(recommended\) → readiness check → practice tour → publish/);
    expect(text).toMatch(/Never ask the operator "what next\?" while Tour Core has a next step/);
    expect(text).toMatch(/don't offer parallel or optional paths while required setup is incomplete/);
    expect(text).toMatch(/move fully to the property/);
    expect(text).toMatch(/Keep infrastructure out of the conversation/);
    expect(text).toMatch(/explicit yes/);
  });

  it("says Tour Core's tools are authoritative, secrets never go in chat, and people act in secure setup", () => {
    expect(text).toMatch(/installation tools are authoritative/);
    expect(text).toMatch(/Never request secrets in chat/);
    expect(text).toMatch(/secure setup page/);
    expect(text).toMatch(/Never ask the operator to run a command/);
    expect(text).toMatch(/No\s+attachments are needed/);
    expect(text).toMatch(/Don't continue with an unexpected\s+repository/);
  });

  it("contains no secrets or values from .env", () => {
    expect(text).not.toMatch(/Bearer [A-Za-z0-9_-]{20,}/);
    expect(text).not.toMatch(/\b(sk|xai|sb)[-_][A-Za-z0-9]{16,}/);
    expect(text).not.toMatch(/[A-Z_]+(KEY|SECRET|TOKEN)\s*=\s*\S/);
    if (existsSync(new URL("../.env", import.meta.url))) {
      for (const line of read(".env").split("\n")) {
        const value = /^[A-Z_]+=(.+)$/.exec(line.trim())?.[1]?.trim();
        if (value && value.length >= 8) expect(text.includes(value)).toBe(false);
      }
    }
  });

  it("stays a short entry point and doesn't copy the Install Tour Core skill", () => {
    const skill = read(".grok/skills/install-tour-core/SKILL.md");
    expect(text.split("\n").length).toBeLessThan(80);
    expect(text.length).toBeLessThan(skill.length / 2);
    // No run of 12 words appears in both.
    const words = (s: string) => s.toLowerCase().replace(/[^a-z0-9' ]+/g, " ").split(/\s+/).filter(Boolean);
    const skillText = ` ${words(skill).join(" ")} `;
    const w = words(text);
    for (let i = 0; i + 12 <= w.length; i++) {
      const run = w.slice(i, i + 12).join(" ");
      expect(skillText.includes(` ${run} `), run).toBe(false);
    }
  });
});

describe("fresh-bot bootstrap documentation", () => {
  it("the manual test sends one prompt with only the repository URL and attaches nothing", () => {
    const doc = read("docs/grok-manual-test.md");
    const section = doc.slice(doc.indexOf("## B."), doc.indexOf("## Connection and operator demo"));
    expect(section).toMatch(/Do \*\*not\*\* attach\s+`bot-profile\.md`, any `SKILL\.md`, `template\.json` or the `grok-template`\s+folder/);
    const prompt = section
      .split("\n")
      .filter((l) => l.startsWith(">"))
      .join("\n");
    expect(prompt).toContain("https://github.com/&lt;owner&gt;/&lt;repo&gt;");
    expect(prompt).toContain("GROK_BOOTSTRAP.md");
    expect(prompt).toContain("Never ask me to paste secrets");
    expect(prompt).not.toMatch(/attach/i);
    expect(section).toMatch(/Pass = no attached files/);
    expect(section).toMatch(/final template experience/i);
  });

  it("the Install skill doesn't require attachments", () => {
    const skill = read(".grok/skills/install-tour-core/SKILL.md");
    expect(skill).toMatch(/No attached files/);
    expect(skill).toContain("GROK_BOOTSTRAP.md");
  });
});

describe("canonical repository", () => {
  it("normalizes https and ssh forms of the same repository", () => {
    expect(normalizeRepoUrl("https://github.com/Owner/Repo.git/")).toBe("github.com/owner/repo");
    expect(normalizeRepoUrl("git@github.com:Owner/Repo.git")).toBe("github.com/owner/repo");
    expect(normalizeRepoUrl("")).toBeUndefined();
    expect(normalizeRepoUrl("not a url")).toBeUndefined();
  });

  it("refuses a clone from another repository; accepts a match or an unrecorded canonical", () => {
    expect(checkRepositorySource({ canonical: "https://github.com/owner/repo", actual: "git@github.com:Owner/Repo.git" }).ok).toBe(true);
    expect(checkRepositorySource({ canonical: undefined, actual: "https://github.com/else/where" }).ok).toBe(true);
    const mismatch = checkRepositorySource({ canonical: "https://github.com/owner/repo", actual: "https://github.com/else/where" });
    expect(mismatch.ok).toBe(false);
    expect(mismatch.message).toContain("Not starting an unexpected repository");
  });

  it("is recorded in the template manifest, with GROK_BOOTSTRAP.md as its entry point", () => {
    const manifest = JSON.parse(read("grok-template/template.json"));
    expect(manifest.repository.bootstrap).toBe("GROK_BOOTSTRAP.md");
    const url = canonicalRepoUrl(new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
    expect(url).toBe(manifest.repository.url || undefined);
    if (url) expect(normalizeRepoUrl(url)).toMatch(/^github\.com\/[^/]+\/[^/]+$/);
  });
});
