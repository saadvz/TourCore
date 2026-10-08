import { describe, expect, it } from "vitest";
import { annotationsFor } from "../src/mcp/annotations";
import { OPERATOR_TOOLS } from "../src/operator/tools";

const MILESTONE_TOOLS = ["set_up_texting", "save_property", "save_units", "save_doors_and_routes", "save_hours", "save_settings", "run_checks", "publish"] as const;

describe("milestone tool annotations", () => {
  it("marks publish as consequential and the other milestone writes as ordinary non-destructive writes", () => {
    for (const name of MILESTONE_TOOLS) {
      const tool = OPERATOR_TOOLS.find((item) => item.name === name);
      expect(tool, name).toBeTruthy();
      expect(tool!.kind, name).toBe(name === "publish" ? "consequential" : "change");
      expect(tool!.description, name).not.toMatch(/\n/);
      expect(annotationsFor(tool!)).toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false });
    }
  });
});
