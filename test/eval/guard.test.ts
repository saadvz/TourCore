import { describe, expect, it, vi } from "vitest";
import { EvalGuardError, assertLiveCall, guardedCall, liveSkipReason, newGuardState, noteLiveResult } from "../../src/eval/guard";

function ownedState() {
  const state = newGuardState("run1");
  noteLiveResult(state, "create_property_setup", { address: "100 Eval run1 Lane, Teaneck, NJ 07666", name: "eval-run1" }, { status: "created", setup: { propertyId: "prop_eval_run1" } });
  return state;
}

describe("live eval guard", () => {
  it("refuses a foreign property id before the tool runs", async () => {
    const inner = vi.fn();
    await expect(guardedCall(ownedState(), inner, "review_property_setup", { property: "prop_145_tenafly" })).rejects.toBeInstanceOf(EvalGuardError);
    expect(inner).not.toHaveBeenCalled();
  });

  it("allows a property id this run created", async () => {
    const inner = vi.fn(async () => ({ summary: "ok" }));
    const result = await guardedCall(ownedState(), inner, "review_property_setup", { property: "prop_eval_run1" });
    expect(result).toEqual({ summary: "ok" });
    expect(inner).toHaveBeenCalledOnce();
  });

  it("refuses set_services live", () => {
    expect(() => assertLiveCall(ownedState(), "set_services", { property: "prop_eval_run1", messaging: "live" })).toThrow(/local test texting/i);
  });

  it("refuses choose_messaging_provider without a property", () => {
    expect(() => assertLiveCall(ownedState(), "choose_messaging_provider", { provider: "local" })).toThrow(/whole installation/i);
  });

  it("refuses reset_hosted_demo", () => {
    expect(() => assertLiveCall(ownedState(), "reset_hosted_demo", {})).toThrow(/whole installation/i);
  });

  it("refuses 145 Tenafly Road and 914B", () => {
    const state = newGuardState("run1");
    expect(() => assertLiveCall(state, "create_property_setup", { address: "145 Tenafly Road, Tenafly, NJ 07670", name: "eval-run1" })).toThrow(/protected property/i);
    expect(() => assertLiveCall(state, "add_unit", { property: "prop_eval_run1", name: "914B" })).toThrow(/protected property/i);
  });

  it("allows create with the eval prefix and records the new id", () => {
    const state = newGuardState("run1");
    const args = { address: "100 Eval run1 Lane, Teaneck, NJ 07666", name: "eval-run1" };
    expect(() => assertLiveCall(state, "create_property_setup", args)).not.toThrow();
    noteLiveResult(state, "create_property_setup", args, { status: "created", setup: { propertyId: "prop_eval_run1" } });
    expect(state.ownedPropertyIds.has("prop_eval_run1")).toBe(true);
  });

  it("does not adopt a property that already existed", () => {
    const state = newGuardState("run1");
    expect(() => noteLiveResult(state, "create_property_setup", { address: "100 Eval run1 Lane", name: "eval-run1" }, { status: "already-exists", setup: { propertyId: "prop_real" } })).toThrow(/adopt/i);
    expect(state.ownedPropertyIds.size).toBe(0);
  });

  it("refuses publish until local test texting is set, then allows it", () => {
    const state = ownedState();
    expect(() => assertLiveCall(state, "publish_demo_property", { property: "prop_eval_run1" })).toThrow(/local test texting/i);
    noteLiveResult(state, "set_services", { property: "prop_eval_run1", messaging: "local" }, { summary: "test mode" });
    expect(() => assertLiveCall(state, "publish_demo_property", { property: "prop_eval_run1" })).not.toThrow();
  });

  it("refuses a tool call that omits the property", () => {
    expect(() => assertLiveCall(ownedState(), "add_unit", { name: "Unit A" })).toThrow(/Omitting it could hit another building/i);
  });

  it("skips when the live URL or token is missing", () => {
    expect(liveSkipReason({})).toMatch(/skipped/i);
    expect(liveSkipReason({ TOURCORE_OPERATOR_TOKEN: "tok" })).toMatch(/skipped/i);
    expect(liveSkipReason({ TOURCORE_MCP_URL: "https://example.test/mcp" })).toMatch(/skipped/i);
    expect(liveSkipReason({ TOURCORE_MCP_URL: "https://example.test/mcp", TOURCORE_MCP_TOKEN: "tok" })).toBeUndefined();
  });
});
