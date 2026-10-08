import { describe, expect, it } from "vitest";
import { EvalSession } from "../../src/eval/session";

describe("get_state on the eval install", () => {
  it("keeps milestones and gates identical across clients and is not on the click path", async () => {
    const session = await EvalSession.open();
    try {
      expect(session.steps.some((step) => step.tool === "get_state")).toBe(false);
      const grokInit = await session.initialize({ name: "grok", capabilities: { prompts: {}, resources: {} } });
      expect(String(grokInit.instructions)).toMatch(/^Call get_state first/);
      const grok = await session.call("get_state");
      await session.initialize({ omitClientInfo: true });
      const unknown = await session.call("get_state");
      expect(grok.milestones).toEqual(unknown.milestones);
      expect((grok.nextStep as { action?: string }).action).toBe((unknown.nextStep as { action?: string }).action);
      expect((grok.nextStep as { component?: string }).component).toBe((unknown.nextStep as { component?: string }).component);
      expect((grok.nextStep as { tool?: string }).tool).toBe("set_up_texting");
      expect((unknown.nextStep as { tool?: string }).tool).toBe("set_up_texting");
      expect(grok.playbook).toMatchObject({ id: "grok", mode: "full", version: "grok@2026-10-08" });
      expect(unknown.playbook).toMatchObject({ id: "baseline", mode: "tools", version: "baseline@2026-10-08.tools" });
      expect((grok.playbook as { text: string }).text).not.toBe((unknown.playbook as { text: string }).text);
      expect(session.steps.some((step) => step.tool === "get_state")).toBe(false);
    } finally {
      await session.close();
    }
  });
});
