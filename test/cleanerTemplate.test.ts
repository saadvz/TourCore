import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { liveDeskFor, resetLiveDesks, type LiveDesk } from "../src/cleaner-core/liveDesk";
import { handleCleanerMcpMessage } from "../src/cleaner-core/mcp";
import { DOOR_CODE } from "./wiringProof";

/** The Cleaner Core paste-in prompt, setup guide, and Grok Bot template: pinned, consistent with the tools, and free of secrets. */

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const TEMPLATE = join(ROOT, "cleaner-template");
const BOOTSTRAP = join(ROOT, "CLEANER_CORE_BOOTSTRAP.md");
const HOSTED = "https://tourcore-production-8b80.up.railway.app";
const REPO = "https://github.com/saadvz/TourCore";
const ROUTINES = ["Cleaner Core Check", "Cleaner Core Alerts"];
/** The setup order get_state asks for: the diagram's 8 steps, the checks once numbers are approved, then the routines and the first times. */
const SETUP_TOOLS = ["get_state", "save_property", "save_sources", "save_people", "save_schedule", "save_door_code", "save_preferences", "activate", "run_checks", "save_alert_routine", "confirm_times"];
/** Tools that need the host's yes in chat. A routine runs unattended, so it never holds them. */
const NEEDS_HOST_YES = ["send_message", "mark_guests_left", "save_door_code", "save_sources", "activate", "resume_job"];

/** LF bytes, so the pin matches on a Windows (CRLF) checkout and on CI. */
const read = (path: string) => readFileSync(path, "utf8").replace(/\r\n/g, "\n");

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? files(p) : [p];
  });
}

async function rpc(method: string): Promise<Record<string, unknown>> {
  // initialize and tools/list never touch the desk.
  const reply = await handleCleanerMcpMessage({} as LiveDesk, { jsonrpc: "2.0", id: 1, method }, undefined, true);
  return (reply.body as { result: Record<string, unknown> }).result;
}

async function toolNames(): Promise<string[]> {
  return ((await rpc("tools/list")).tools as { name: string }[]).map((tool) => tool.name);
}

interface Manifest {
  name: string;
  profile: string;
  setupPrompt: string;
  readme: string;
  hostedCleanerCoreUrl: string;
  repository: { url: string; bootstrap: string };
  integrations: { name: string; type: string; url?: string; auth: string; travelsWithTemplate: boolean }[];
  routines: { name: string; doc: string; trigger: string; allowedTools: string[]; credentialsTravelWithTemplate: boolean }[];
  suggestedPrompts: string[];
  neverIncluded: string[];
}

const manifest = (): Manifest => JSON.parse(read(join(TEMPLATE, "template.json"))) as Manifest;

/** SHA-256 of cleaner-template/SETUP_PROMPT.md with LF line endings. Change the prompt only on purpose. */
const SETUP_PROMPT_SHA256 = "fa5b5908e4715bff9c57ea138aa3a25fa2c67360c1af1367283e11fb4674a869";

describe("Cleaner Core paste-in prompt", () => {
  it("is pinned, names the repository and the bootstrap, and uses the secure card", () => {
    const prompt = read(join(TEMPLATE, "SETUP_PROMPT.md"));
    expect(createHash("sha256").update(prompt).digest("hex")).toBe(SETUP_PROMPT_SHA256);
    expect(prompt).toContain(REPO);
    expect(prompt).toContain("CLEANER_CORE_BOOTSTRAP.md");
    expect(prompt).toContain("secure");
    expect(prompt).toMatch(/hosted Cleaner Core service/);
    expect(prompt).toMatch(/Never ask me to paste API keys, passwords, tokens, or door codes into chat/);
    expect(prompt).toMatch(/Allow/);
    expect(prompt).toContain("get_state");
    expect(prompt).toMatch(/Start now\./);
  });
});

describe("Cleaner Core template manifest", () => {
  it("points at the hosted Cleaner Core and its one connector", () => {
    const m = manifest();
    expect(m.hostedCleanerCoreUrl).toBe(HOSTED);
    expect(m.repository).toEqual(expect.objectContaining({ url: REPO, bootstrap: "CLEANER_CORE_BOOTSTRAP.md" }));
    const connectors = m.integrations.filter((i) => i.type === "custom-mcp-server");
    expect(connectors).toEqual([
      expect.objectContaining({
        name: "Cleaner Core",
        url: "hostedCleanerCoreUrl/mcp/cleaner-core",
        auth: "OAuth 2.1 discovered from the Cleaner Core service. The owner clicks Allow. Grok cannot approve itself.",
        travelsWithTemplate: false,
      }),
    ]);
    expect(m.integrations).toContainEqual(expect.objectContaining({ name: "Google Calendar", type: "first-party-connector", travelsWithTemplate: false }));
  });

  it("lists only files that exist", () => {
    const m = manifest();
    for (const f of [m.profile, m.setupPrompt, m.readme, ...m.routines.map((r) => r.doc)]) expect(existsSync(join(TEMPLATE, f)), f).toBe(true);
    expect(existsSync(join(ROOT, m.repository.bootstrap))).toBe(true);
  });

  it("names both routines, with real tools and no credentials", async () => {
    const m = manifest();
    expect(m.routines.map((r) => r.name)).toEqual(ROUTINES);
    expect(m.routines.map((r) => r.trigger)).toEqual(["scheduled", "authenticated-webhook"]);
    const tools = await toolNames();
    for (const routine of m.routines) {
      expect(routine.credentialsTravelWithTemplate, routine.name).toBe(false);
      expect(routine.doc.startsWith("routines/"), routine.name).toBe(true);
      for (const tool of routine.allowedTools) {
        expect(tools, `${routine.name} lists ${tool}`).toContain(tool);
        expect(NEEDS_HOST_YES, `${routine.name} lists ${tool}`).not.toContain(tool);
      }
      expect(read(join(TEMPLATE, routine.doc))).toContain(`# Routine: ${routine.name}`);
    }
  });

  it("has the suggested prompts in the bot profile", () => {
    const m = manifest();
    const profile = read(join(TEMPLATE, m.profile));
    expect(m.suggestedPrompts.length).toBeGreaterThan(2);
    for (const prompt of m.suggestedPrompts) expect(profile).toContain(`- ${prompt}`);
    expect(profile).toMatch(/one question at a time/i);
    expect(profile).toMatch(/secure card/);
    expect(profile).toMatch(/only\s+the\s+calendar\s+the\s+host\s+named\s+for\s+bookings/);
    expect(profile).toMatch(/use\s+your\s+secure\s+card\s+for\s+the\s+door\s+code/i);
    expect(profile).toMatch(/only\s+to\s+the\s+one-time\s+upload\s+link,\s+from\s+your\s+own\s+computer/);
    expect(profile).not.toMatch(/webhook\s+addresses, or door codes\. Use your secure card\./);
  });

  it("leaves the Tour Core template alone", () => {
    const tour = read(join(ROOT, "grok-template", "template.json"));
    expect(tour).not.toMatch(/cleaner/i);
    expect(readdirSync(join(ROOT, "grok-template", "routines")).some((f) => f.startsWith("cleaner-core"))).toBe(false);
  });
});

describe("CLEANER_CORE_BOOTSTRAP.md", () => {
  it("stays a short entry point that connects to the hosted service", () => {
    const text = read(BOOTSTRAP);
    expect(text.split("\n").length).toBeLessThan(80);
    expect(text).toMatch(/No attachments are needed/);
    expect(text).toContain("`cleaner-template/template.json`");
    expect(text).toContain("`hostedCleanerCoreUrl`");
    expect(text).toContain("/mcp/cleaner-core");
    expect(text).toMatch(/Do not run Cleaner Core on your computer/);
    expect(text).toMatch(/tunnel/);
    expect(text).toMatch(/clicks Allow/);
  });

  it("names every setup tool in the order get_state asks for them", () => {
    const text = read(BOOTSTRAP);
    const positions = SETUP_TOOLS.map((tool) => text.indexOf(`\`${tool}\``));
    for (const [i, p] of positions.entries()) expect(p, SETUP_TOOLS[i]).toBeGreaterThan(-1);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it("links both routine docs and covers every booking", () => {
    const text = read(BOOTSTRAP);
    for (const name of ROUTINES) expect(text).toContain(name);
    for (const doc of manifest().routines.map((r) => r.doc)) expect(text).toContain(`(cleaner-template/${doc})`);
    for (const field of ["check_now", "messages", "needsTimes", "completed", "wouldCancel", "save_arrival", "send_message", "mark_guests_left", "get_job_photos"]) {
      expect(text, field).toContain(`\`${field}\``);
    }
    expect(text).toMatch(/Have the guests left\?/);
    expect(text).toMatch(/7 days ago to 60 days ahead/);
    expect(text).toMatch(/timed event/);
  });

  it("picks cleaning with the said value it names", async () => {
    const said = /`said: "([^"]+)"`/.exec(read(BOOTSTRAP))?.[1];
    expect(said).toBeTruthy();
    const root = mkdtempSync(join(tmpdir(), "cleaner-template-"));
    try {
      const desk = liveDeskFor(root, () => ({}), () => new Date());
      const reply = await desk.getState(said);
      expect(reply.ok).toBe(true);
      expect((reply.result as { done: string[] }).done).toContain("You chose cleaning.");
    } finally {
      resetLiveDesks();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("stops at unapproved numbers, then runs the checks", () => {
    const text = read(BOOTSTRAP);
    expect(text).toMatch(/If `activate` says the numbers aren't approved for texts/);
    expect(text).toMatch(/Cleaner Core operator has to approve/);
    expect(text).toMatch(/stop there/);
    expect(text).toMatch(/call `run_checks`, with `googleEvents`/);
    expect(read(join(ROOT, "src", "cleaner-core", "liveDesk.ts"))).toContain("only after those numbers are approved for texts.");
  });

  it("names who send_message can reach, and that YES comes twice in every mode", () => {
    const text = read(BOOTSTRAP);
    expect(text).toContain("With a group, `send_message` posts to the group: `to` is `group`. Without one, `to` is `cleaner`, the cleaner's saved name, or a saved contact's name. Never a phone number.");
    expect(text).toContain("The cleaner replies YES twice: once to get texts (or join the group), then once to schedule the cleaning.");
  });

  it("connects alerts with the one-time upload link, never the secure card or chat", () => {
    const text = read(BOOTSTRAP);
    for (const doc of [text, read(join(TEMPLATE, "routines", "cleaner-core-alerts.md"))]) {
      expect(doc).toMatch(/`save_alert_routine` with no arguments/);
      expect(doc).toMatch(/one-time upload link/);
      expect(doc).toMatch(/from (your|Grok's) own cloud\s+computer/i);
      expect(doc).toContain("Content-Type: application/json");
      expect(doc).not.toMatch(/secure card into `save_alert_routine`|secure card, and pass them to `save_alert_routine`/);
    }
  });

  it("asks which Google calendar holds the bookings and reads only that one", () => {
    for (const doc of [read(BOOTSTRAP), read(join(TEMPLATE, "routines", "cleaner-core-check.md"))]) {
      expect(doc).toMatch(/which\s+Google\s+calendar\s+holds\s+the\s+bookings/);
      expect(doc).toMatch(/only\s+that\s+calendar/);
      expect(doc).toMatch(/never\s+the\s+primary\s+calendar\s+unless\s+the\s+host\s+says/i);
    }
  });

  it("keeps the safety rules", () => {
    const text = read(BOOTSTRAP);
    for (const doc of [text, read(join(TEMPLATE, "bot-profile.md"))]) {
      expect(doc).toMatch(/Live texts go only to numbers the Cleaner Core operator approved\.\s+Saving a\s+number doesn't approve it\./);
    }
    expect(text).toMatch(/Never ask for a secret in chat/);
    expect(text).toMatch(/door code goes only on your secure card/);
    expect(text).toMatch(/after the host says the guests have left/);
    expect(text).toMatch(/only after the host's yes/);
  });
});

describe("Cleaner Core initialize instructions", () => {
  it("point at the setup order", async () => {
    const text = String((await rpc("initialize")).instructions);
    const order = SETUP_TOOLS.slice(1, 8);
    const positions = order.map((tool) => text.indexOf(tool));
    for (const [i, p] of positions.entries()) expect(p, order[i]).toBeGreaterThan(-1);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(text.startsWith("Call get_state first and follow its next step.")).toBe(true);
  });
});

describe("Cleaner Core template docs", () => {
  const docs = () => [BOOTSTRAP, ...files(TEMPLATE)].map((f) => ({ f, text: read(f) }));

  it("name only real Cleaner Core tools", async () => {
    const tools = await toolNames();
    for (const { f, text } of docs()) {
      for (const m of text.matchAll(/`([a-z]+(?:_[a-z]+)+)`/g)) expect(tools, `${f}: ${m[1]}`).toContain(m[1]);
    }
  });

  it("contain no secrets, real phone numbers, or door-code-like digits", () => {
    const envValues = existsSync(join(ROOT, ".env"))
      ? read(join(ROOT, ".env"))
          .split("\n")
          .map((l) => /^[A-Z_]+=(.+)$/.exec(l.trim())?.[1]?.trim())
          .filter((v): v is string => !!v && v.length >= 8)
      : [];
    for (const { f, text } of docs()) {
      expect(text, f).not.toMatch(/Bearer [A-Za-z0-9_-]{20,}/);
      expect(text, f).not.toMatch(/\b(sk|xai|sb)[-_][A-Za-z0-9]{16,}/);
      expect(text, f).not.toMatch(/\b(AC|SK)[0-9a-f]{32}\b/);
      expect(text, f).not.toMatch(/[A-Z_]+(KEY|SECRET|TOKEN)\s*=\s*\S/);
      expect(text, f).not.toMatch(/[A-Za-z0-9._%+-]+@(?!example\.com)[A-Za-z0-9.-]+\.[a-z]{2,}/);
      for (const m of text.matchAll(/\+?1?[\s.-]?\(?(\d{3})\)?[\s.-]?(\d{3})[\s.-]?(\d{2})(\d{2}|xx)/g)) {
        expect(`${m[1]}-${m[2]}-${m[3]}`, `${f}: ${m[0]}`).toMatch(/^\d{3}-555-01$|^555-01\d-\d{2}$/);
      }
      // A bare run of 4 to 8 digits reads like a door code. Years, clock times, and 555 numbers are fine.
      for (const m of text.matchAll(/(?<![\d:.-])\d{4,8}(?![\d:-])/g)) expect(m[0], `${f}: ${m[0]}`).toMatch(/^20\d\d$/);
      expect(text.includes(DOOR_CODE), f).toBe(false);
      for (const v of envValues) expect(text.includes(v), `${f} contains a value from .env`).toBe(false);
    }
  });
});
