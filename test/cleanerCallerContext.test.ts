import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { currentCaller, withCaller, type CleanerCaller } from "../src/cleaner-core/callerContext";
import { liveDeskFor, resetLiveDesks, type LiveDesk } from "../src/cleaner-core/liveDesk";

const NOW = new Date("2026-10-27T15:00:00.000Z");
const BASE = "https://cc.example/t/tnt_aaaaaaaaaa";

let root: string;
let env: NodeJS.ProcessEnv;
let desk: LiveDesk;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "cleaner-caller-"));
  env = { CLEANER_CORE_ENABLED: "1", CLEANER_CORE_ASSISTANT: "grok", CLEANER_CORE_PRIMARY_CONNECTION: "g1", PUBLIC_BASE_URL: BASE };
  desk = liveDeskFor(root, () => env, () => NOW);
});

afterEach(() => {
  resetLiveDesks();
  rmSync(root, { recursive: true, force: true });
});

const saved = () => JSON.parse(readFileSync(join(root, "cleaner-live.json"), "utf8")) as { routineConnections?: string[]; routineConnected?: boolean };

describe("withCaller", () => {
  it("carries the caller through awaits and nothing outside it", async () => {
    expect(currentCaller()).toBeUndefined();
    const seen = await withCaller({ assistant: "claude", connectionId: "g2" }, async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      return currentCaller();
    });
    expect(seen).toEqual({ assistant: "claude", connectionId: "g2" });
    expect(currentCaller()).toBeUndefined();
  });
});

describe("the desk's two assistants", () => {
  it("follows the caller for replies and the primary for everything else", () => {
    expect(desk.assistant()).toBe("grok");
    expect(withCaller({ assistant: "claude", connectionId: "g2" }, () => desk.assistant())).toBe("claude");
    expect(withCaller({ assistant: "claude", connectionId: "g2" }, () => desk.primaryAssistant())).toBe("grok");
  });

  it("with no caller, is exactly today's single-tenant behavior", () => {
    env.CLEANER_CORE_ASSISTANT = "claude";
    delete env.CLEANER_CORE_PRIMARY_CONNECTION;
    expect(desk.assistant()).toBe("claude");
    expect(desk.primaryAssistant()).toBe("claude");
  });
});

describe("routines per connection", () => {
  it("builds the upload link under the tenant's base and saves under the connection that made it", async () => {
    const link = await withCaller({ assistant: "grok", connectionId: "g1" }, () => desk.saveAlertRoutine({}, () => undefined));
    const uploadUrl = String((link.result as { uploadUrl?: string } | undefined)?.uploadUrl);
    expect(uploadUrl.startsWith(`${BASE}/cleaner-core/alert-routine/`)).toBe(true);
    const code = uploadUrl.split("/").pop()!;
    const seen: (CleanerCaller | undefined)[] = [];
    const reply = await desk.uploadAlertRoutine(code, { url: "https://grok.example/hook", token: "routine-key-1234" }, () => void seen.push(currentCaller()));
    expect(reply.status).toBe(200);
    expect(seen).toEqual([{ assistant: "grok", connectionId: "g1" }]);
    expect(saved().routineConnections).toEqual(["g1"]);
  });

  it("records which connection connected a ChatGPT task", async () => {
    env.CLEANER_CORE_ASSISTANT = "chatgpt";
    await withCaller({ assistant: "chatgpt", connectionId: "g3" }, () => desk.saveAlertRoutine({}, () => undefined));
    await withCaller({ assistant: "chatgpt", connectionId: "g3" }, () => desk.saveAlertRoutine({}, () => undefined));
    expect(saved().routineConnections).toEqual(["g3"]);
    expect(saved().routineConnected).toBe(true);
  });

  it("keeps an origin-only base's upload links exactly as before", async () => {
    env.PUBLIC_BASE_URL = "https://cc.example";
    delete env.CLEANER_CORE_PRIMARY_CONNECTION;
    const link = await desk.saveAlertRoutine({}, () => undefined);
    expect(String((link.result as { uploadUrl?: string }).uploadUrl)).toMatch(/^https:\/\/cc\.example\/cleaner-core\/alert-routine\/[A-Za-z0-9_-]+$/);
    expect(saved().routineConnections).toBeUndefined();
  });
});
