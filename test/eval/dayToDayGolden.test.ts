import { describe, expect, it } from "vitest";
import { OLD_DAY_TO_DAY_TOOLS, goldenDayToDayCall, runDayToDayGolden } from "../../src/eval/dayToDayGolden";
import { LANDLORD_CORE_TOOLS } from "../../src/mcp/scopes";
import { EvalSession } from "../../src/eval/session";

describe("day-to-day golden tasks", () => {
  it("passes the five landlord tasks without an old day-to-day tool", async () => {
    const session = await EvalSession.open();
    try {
      const report = await runDayToDayGolden(session);
      expect(report.tasks.map((task) => task.id)).toEqual(["full-setup", "one-off", "flagged-question", "pause-unit", "export-audit"]);
      for (const task of report.tasks) {
        expect(task.passed, `${task.title}: ${task.detail}`).toBe(true);
        for (const tool of task.tools) {
          expect(OLD_DAY_TO_DAY_TOOLS).not.toContain(tool);
          if (tool !== "inject_local_sms") expect(LANDLORD_CORE_TOOLS).toContain(tool);
        }
      }
      expect(report.traces.find((trace) => trace.id === "one-off")?.tools).toEqual(["schedule_tour", "schedule_tour"]);
      expect(report.traces.find((trace) => trace.id === "pause-unit")?.tools).toEqual(["pause_tours", "pause_tours"]);
      expect(report.traces.find((trace) => trace.id === "export-audit")?.tools).toEqual(["export_records"]);
      expect(report.traces.find((trace) => trace.id === "flagged-question")?.tools).toContain("resolve_issue");
      expect(report.traces.find((trace) => trace.id === "flagged-question")?.tools).toContain("get_inbox");
      const serialized = JSON.stringify(report);
      expect(serialized).not.toMatch(/145\s+Tenafly/i);
      expect(serialized).not.toMatch(/\b914B\b/);
    } finally {
      await session.close();
    }
  }, 120_000);

  it("throws when the golden wrapper is asked to call an old day-to-day tool", async () => {
    const session = {
      call: async () => {
        throw new Error("session should not run");
      },
    };
    for (const name of OLD_DAY_TO_DAY_TOOLS) {
      const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
      const call = goldenDayToDayCall(session, calls);
      await expect(call(name)).rejects.toThrow(`old day-to-day tool ${name} is forbidden`);
      expect(calls).toEqual([]);
    }
  });
});
