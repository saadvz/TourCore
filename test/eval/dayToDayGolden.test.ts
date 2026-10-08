import { describe, expect, it } from "vitest";
import { OLD_DAY_TO_DAY_TOOLS, runDayToDayGolden } from "../../src/eval/dayToDayGolden";
import { EvalSession } from "../../src/eval/session";

describe("day-to-day golden tasks", () => {
  it("passes the five landlord tasks without an old day-to-day tool", async () => {
    const session = await EvalSession.open();
    try {
      const report = await runDayToDayGolden(session);
      expect(report.tasks.map((task) => task.id)).toEqual(["full-setup", "one-off", "flagged-question", "pause-unit", "export-audit"]);
      for (const task of report.tasks) {
        expect(task.passed, `${task.title}: ${task.detail}`).toBe(true);
        for (const tool of task.tools) expect(OLD_DAY_TO_DAY_TOOLS).not.toContain(tool);
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
});
