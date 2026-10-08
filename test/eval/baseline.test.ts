import { describe, expect, it } from "vitest";
import { baselineDrift, buildBaseline, loadBaseline, saveBaseline } from "../../src/eval/baseline";

describe("phase 0 baseline", () => {
  it("matches the checked-in duplex baseline", async () => {
    const report = await buildBaseline();
    expect(report.configDiff.runs).toBe(10);
    expect(report.configDiff.differingFieldCount).toBe(0);
    expect(report.milestoneDiff.runs).toBe(10);
    expect(report.milestoneDiff.differingFieldCount).toBe(0);
    expect(report.milestoneMatchesOld).toBe(true);
    expect(report.milestonePath.some((step) => step.tool === "run_checks" && step.status === "blocked" && step.code === "ROUTES_MISSING")).toBe(true);
    expect(report.milestonePath.some((step) => step.tool === "publish" && step.status === "done")).toBe(true);
    expect(report.golden).toHaveLength(5);
    expect(report.golden.every((task) => task.passed)).toBe(true);
    expect(report.clickPath[0]?.tool).toBe("get_next_installation_step");
    expect(report.clickPath.some((step) => step.tool === "publish_demo_property" && step.outcome.published === true)).toBe(true);
    const serialized = JSON.stringify(report);
    expect(serialized).not.toMatch(/145\s+Tenafly/i);
    expect(serialized).not.toMatch(/\b914B\b/);
    expect(JSON.stringify(report.exits)).not.toMatch(/https?:\/\/|#s=/);
    if (process.env.EVAL_REBASELINE === "1") {
      saveBaseline(report);
      return;
    }
    expect(baselineDrift(report, loadBaseline())).toBeUndefined();
  }, 300_000);
});
