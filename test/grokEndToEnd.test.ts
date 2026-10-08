import { mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/tourCoreConfig";
import { VisitorDenialCopy } from "../src/core/TourCore";
import { setSendblueRuntime } from "../src/messaging/sendblue/runtime";
import { PropertyWorkspace, runReadinessCheck } from "../src/setup";
import { createSetupServer } from "../src/web/server";
import { fakeSendblue, inbound, SECRET, sendblueEnv } from "./fakeSendblue";
import { at } from "./grokHarness";

/**
 * The P0 operator demo without a browser: a visitor texts from a real phone
 * (Sendblue replaced by a fake at the SDK boundary) while the operator works
 * through the Tour Core tools over HTTP /mcp, exactly as Grok Bot would.
 */

const PHONE = "+15550102000";
const TOKEN = "test-operator-token-abcdef";
const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).forEach((c) => c()));

async function liveDemo() {
  const root = mkdtempSync(join(tmpdir(), "tourcore-grok-e2e-"));
  const fake = fakeSendblue();
  cleanups.push(setSendblueRuntime({ env: () => sendblueEnv(), client: () => fake.client }));
  let clock = at(7);
  const ws = new PropertyWorkspace(root);
  const { config } = ws.save({ ...loadConfig(), messagingMode: "live" });
  ws.recordReadiness(config.property.id, await runReadinessCheck(config, { now: new Date(clock) }));

  const server: Server = createSetupServer({ workspace: new PropertyWorkspace(root), now: () => new Date(clock), realNow: () => clock, operatorToken: () => TOKEN, log: () => {} });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  cleanups.push(() => {
    server.close();
    rmSync(root, { recursive: true, force: true });
  });

  let n = 0;
  const text = async (content: string) => {
    const before = fake.sent.length;
    await fetch(`http://127.0.0.1:${port}/webhooks/sendblue`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "sb-signing-secret": SECRET },
      body: JSON.stringify(inbound(PHONE, content, `in_${++n}`)),
    });
    return fake.sent.slice(before).filter((s) => s.number === PHONE).map((s) => s.content).join("\n");
  };
  let id = 0;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const grok = async (name: string, args: Record<string, unknown> = {}): Promise<any> => {
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name, arguments: args } }),
    });
    const body = (await res.json()) as { result: { isError: boolean; structuredContent: unknown; content: Array<{ text: string }> } };
    if (body.result.isError) throw new Error(body.result.content[0]!.text);
    return body.result.structuredContent;
  };
  const approve = async (name: string, args: Record<string, unknown>) => {
    const asked = await grok(name, args);
    expect(asked.status).toBe("needs-confirmation");
    return grok(name, { ...args, confirmationCode: asked.confirmation.code });
  };
  return { ws, text, grok, approve, setClock: (t: number) => (clock = t), port, fake };
}

describe("P0 operator demo through Grok tools, with a real-phone visitor", () => {
  it("monitors the tour, answers a flagged question, pauses and resumes, and exports the audit", async () => {
    const demo = await liveDemo();
    await demo.text("TOUR");
    await demo.text("YES");
    await demo.text("1");
    await demo.text("1");
    await demo.text("1");
    const consent = await demo.text("YES");
    const token = /\/verify\/([A-Za-z0-9_-]+)/.exec(consent)![1]!;
    await fetch(`http://127.0.0.1:${demo.port}/api/verify/${token}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ firstName: "Pat", lastName: "Smith", email: "pat@example.com", phone: PHONE }),
    });
    demo.setClock(at(14));
    expect(await demo.text("I'm here")).toContain("Entrance is open for you now.");
    expect(await demo.text("I'm at unit 101")).toContain("Unit 101 Door is open for you now.");

    // Operator: "Show active tours."
    const [tour] = (await demo.grok("list_active_tours")).tours;
    expect(tour).toMatchObject({ visitorName: "Pat Smith", unitName: "Unit 101", status: "Touring", source: "Real phone", currentStep: "At Unit 101" });

    // Visitor asks something the approved facts don't cover.
    expect(await demo.text("is there a gym?")).toContain("I'll pass your question to the property team, and they'll reply here as soon as they can.");
    // Operator: "What needs attention?" -> "Open Pat's issue. Yes, there's a gym on the roof." -> "Yes."
    const [issue] = (await demo.grok("list_exceptions")).exceptions;
    expect(issue).toMatchObject({ visitorName: "Pat Smith", summary: 'Asked "is there a gym?". There\'s no approved answer yet.' });
    const sentBefore = demo.fake.sent.length;
    const answered = await demo.approve("answer_flagged_question", { exceptionId: issue.exceptionId, approvedFact: "There's a gym on the roof." });
    expect(answered.visitorAnswered).toBe(true);
    expect(demo.fake.sent.slice(sentBefore).map((s) => s.content)).toEqual(["There's a gym on the roof. Let me know if you have any other questions."]);

    // Operator: "Pause Pat's tour." -> "Yes." The visitor is told it's paused, not ended, and HI doesn't start a second tour.
    await demo.approve("place_operator_hold", { tourRef: tour.tourRef, reason: "Checking the lobby camera" });
    expect(await demo.text("I'm at unit 101")).toBe(VisitorDenialCopy.operatorHold("property team"));
    expect(await demo.text("hi")).toBe(VisitorDenialCopy.operatorHold("property team"));
    expect(demo.ws.listTours("prop_100_alfred_way").filter((t) => t.kind === "messaging")).toHaveLength(1);
    expect((await demo.grok("list_active_tours")).tours[0]).toMatchObject({ status: "Paused", paused: true });

    // Operator: "Resume it." -> "Yes."
    await demo.approve("clear_operator_hold", { tourRef: tour.tourRef });
    expect(await demo.text("I'm done")).toContain("Thanks for touring Unit 101");
    await demo.text("yes");
    expect((await demo.grok("list_active_tours")).tours).toEqual([]);

    // Operator: "Export today's audit."
    const out = await demo.grok("export_audit");
    expect(out.totals).toMatchObject({ tours: 1, completed: 1, active: 0, questionsNeedingAttention: 1, resolvedIssues: 1 });
  });
});
