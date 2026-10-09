import { describe, expect, it } from "vitest";
import { joinAlertDetail } from "../src/alerts/describeUpdate";

describe("alert summary punctuation", () => {
  it("joins a finished sentence with a space, and adds a period only when the summary has none", () => {
    expect(joinAlertDetail("There's no approved answer yet.", "Choosing a time")).toBe("There's no approved answer yet. Choosing a time.");
    expect(joinAlertDetail('They asked: "Pool?"', "Choosing a time")).toBe('They asked: "Pool?" Choosing a time.');
    expect(joinAlertDetail("They need help!", "Choosing a time")).toBe("They need help! Choosing a time.");
    expect(joinAlertDetail("There's no approved answer yet", "Choosing a time")).toBe("There's no approved answer yet. Choosing a time.");
  });

  it("does not add a second period when the tour status already ends with one", () => {
    expect(joinAlertDetail("Yet.", "Door system problem. Access is blocked.")).toBe("Yet. Door system problem. Access is blocked.");
    expect(joinAlertDetail("There's no approved answer yet.", "Choosing a time.")).toBe("There's no approved answer yet. Choosing a time.");
    expect(joinAlertDetail("There's no approved answer yet.", "Choosing a time.")).not.toContain("..");
  });
});
