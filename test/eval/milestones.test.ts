import { describe, expect, it } from "vitest";
import { runMilestoneTranscript } from "../../src/eval/milestonePath";
import { EvalSession } from "../../src/eval/session";

describe("milestone demo order", () => {
  it("walks 18 Maple Street from texting to publish and recovers from a missing route", async () => {
    const session = await EvalSession.open();
    try {
      const steps = await runMilestoneTranscript(session);
      expect(steps.map((step) => step.tool)).toEqual([
        "set_up_texting",
        "decline_portable_backup",
        "save_property",
        "save_settings",
        "save_units",
        "run_checks",
        "save_doors_and_routes",
        "save_doors_and_routes",
        "save_hours",
        "run_checks",
        "publish",
        "publish",
      ]);
      expect(steps[0]).toMatchObject({ status: "done" });
      expect(steps[5]).toMatchObject({ status: "blocked", code: "ROUTES_MISSING" });
      expect(steps[6]).toMatchObject({ status: "next" });
      expect(steps[6]?.message).toMatch(/Nothing was saved/);
      expect(steps[7]).toMatchObject({ status: "done" });
      expect(steps[9]).toMatchObject({ status: "done" });
      expect(steps[10]).toMatchObject({ status: "next" });
      expect(steps[11]).toMatchObject({ status: "done" });
      const published = session.workspace.propertyIds().map((id) => session.workspace.load(id));
      expect(published.some((item) => item.state.status === "PUBLISHED_FOR_DEMO")).toBe(true);
    } finally {
      await session.close();
    }
  }, 120_000);
});
