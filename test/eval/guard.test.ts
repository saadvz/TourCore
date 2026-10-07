import { describe, expect, it, vi } from "vitest";
import { EvalGuardError, LIVE_INSTALL_READS, assertLiveCall, guardedCall, liveSkipReason, newGuardState, noteLiveResult } from "../../src/eval/guard";
import { admitSweepRemovals, selectEvalSweepIds } from "../../src/eval/sweep";

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
    expect(liveSkipReason({ TOURCORE_MCP_URL: "https://example.test/mcp", TOURCORE_OPERATOR_TOKEN: "dev-static" })).toMatch(/TOURCORE_MCP_TOKEN/);
    expect(liveSkipReason({ TOURCORE_MCP_URL: "https://example.test/mcp", TOURCORE_MCP_TOKEN: "tok" })).toBeUndefined();
  });

  it("refuses get_next_installation_step because it can rewrite the texting choice", () => {
    expect(LIVE_INSTALL_READS).not.toContain("get_next_installation_step");
    const inner = vi.fn();
    expect(() => assertLiveCall(ownedState(), "get_next_installation_step", {})).toThrow(/texting-provider choice/);
    return guardedCall(ownedState(), inner, "get_next_installation_step", {}).then(
      () => {
        throw new Error("expected the guard to refuse");
      },
      () => {
        expect(inner).not.toHaveBeenCalled();
      },
    );
  });

  it("never selects a non-eval property for the cleanup sweep", () => {
    const listed = [
      { propertyId: "prop_145_tenafly_road", name: "145 Tenafly Road", address: "145 Tenafly Road, Tenafly, NJ 07670" },
      { propertyId: "prop_914b", name: "914B", address: "914B Summit Street, Fort Lee, NJ 07024" },
      { propertyId: "prop_18_maple", name: "18 Maple Street", address: "18 Maple Street, Teaneck, NJ 07666" },
      { propertyId: "prop_eval_inside_name", name: "Maple eval-r1234abcd Court", address: "18 Maple Street, Teaneck, NJ 07666" },
      { propertyId: "prop_eval_r1234abcd", name: "eval-r1234abcd", address: "100 Eval r1234abcd Lane, Teaneck, NJ 07666" },
    ];
    const selected = selectEvalSweepIds(listed, "r1234abcd");
    expect(selected).toEqual(["prop_eval_r1234abcd"]);
    for (const id of ["prop_145_tenafly_road", "prop_914b", "prop_18_maple", "prop_eval_inside_name"]) {
      expect(selected).not.toContain(id);
    }

    const state = newGuardState("r1234abcd");
    expect(admitSweepRemovals(state, { properties: listed })).toEqual(["prop_eval_r1234abcd"]);
    expect([...state.sweepPropertyIds]).toEqual(["prop_eval_r1234abcd"]);
    expect(() => assertLiveCall(state, "remove_property", { property: "prop_145_tenafly_road" })).toThrow(/not one this run created/);
    expect(() => assertLiveCall(state, "remove_property", { property: "prop_914b" })).toThrow(/not one this run created/);
    expect(() => assertLiveCall(state, "add_unit", { property: "prop_eval_r1234abcd", name: "Unit A" })).toThrow(/not one this run created/);
    expect(() => assertLiveCall(state, "remove_property", { property: "prop_eval_r1234abcd" })).not.toThrow();
  });

  it("aborts the sweep instead of touching an ambiguous eval-like name", () => {
    const listed = [
      { propertyId: "prop_145_tenafly_road", name: "145 Tenafly Road", address: "145 Tenafly Road, Tenafly, NJ 07670" },
      { propertyId: "prop_eval_r1234abcd", name: "eval-r1234abcd", address: "100 Eval r1234abcd Lane, Teaneck, NJ 07666" },
      { propertyId: "prop_ambiguous", name: "eval-office", address: "9 Office Way, Teaneck, NJ 07666" },
    ];
    expect(() => selectEvalSweepIds(listed, "r1234abcd")).toThrow(/Aborting the eval cleanup sweep/);
    const state = newGuardState("r1234abcd");
    expect(() => admitSweepRemovals(state, { properties: listed })).toThrow(/Aborting the eval cleanup sweep/);
    expect(state.sweepPropertyIds.size).toBe(0);
    expect(() => assertLiveCall(state, "remove_property", { property: "prop_145_tenafly_road" })).toThrow(/not one this run created/);
    expect(() => assertLiveCall(state, "remove_property", { property: "prop_eval_r1234abcd" })).toThrow(/not one this run created/);
  });

  it("aborts the sweep on a differently cased eval name", () => {
    const listed = [
      { propertyId: "prop_eval_r1234abcd", name: "EVAL-r1234abcd", address: "100 Eval r1234abcd Lane, Teaneck, NJ 07666" },
      { propertyId: "prop_145_tenafly_road", name: "145 Tenafly Road", address: "145 Tenafly Road, Tenafly, NJ 07670" },
    ];
    expect(() => selectEvalSweepIds(listed, "r1234abcd")).toThrow(/Aborting the eval cleanup sweep/);
    const state = newGuardState("r1234abcd");
    expect(() => admitSweepRemovals(state, { properties: listed })).toThrow(/Aborting the eval cleanup sweep/);
    expect(state.sweepPropertyIds.size).toBe(0);
    expect(() => assertLiveCall(state, "remove_property", { property: "prop_145_tenafly_road" })).toThrow(/not one this run created/);
    expect(() => assertLiveCall(state, "remove_property", { property: "prop_eval_r1234abcd" })).toThrow(/not one this run created/);
  });

  it("aborts the sweep when a harness-shaped name is on 145 Tenafly Road", () => {
    const listed = [
      { propertyId: "prop_145_tenafly_road", name: "eval-r1234abcd", address: "145 Tenafly Road, Tenafly, NJ 07670" },
      { propertyId: "prop_eval_own", name: "eval-r1234abcd", address: "100 Eval r1234abcd Lane, Teaneck, NJ 07666" },
    ];
    expect(() => selectEvalSweepIds(listed, "r1234abcd")).toThrow(/Aborting the eval cleanup sweep/);
    const state = newGuardState("r1234abcd");
    expect(() => admitSweepRemovals(state, { properties: listed })).toThrow(/Aborting the eval cleanup sweep/);
    expect(state.sweepPropertyIds.size).toBe(0);
    expect(() => assertLiveCall(state, "remove_property", { property: "prop_145_tenafly_road" })).toThrow(/not one this run created/);
    expect(() => assertLiveCall(state, "remove_property", { property: "prop_eval_own" })).toThrow(/not one this run created/);
  });

  it("aborts the sweep on a malformed property id", () => {
    const listed = [
      { propertyId: "prop_eval_r1234abcd!", name: "eval-r1234abcd", address: "100 Eval r1234abcd Lane, Teaneck, NJ 07666" },
    ];
    expect(() => selectEvalSweepIds(listed, "r1234abcd")).toThrow(/Aborting the eval cleanup sweep/);
    const state = newGuardState("r1234abcd");
    expect(() => admitSweepRemovals(state, { properties: listed })).toThrow(/Aborting the eval cleanup sweep/);
    expect(state.sweepPropertyIds.size).toBe(0);
    expect(() => assertLiveCall(state, "remove_property", { property: "prop_eval_r1234abcd!" })).toThrow(/not one this run created/);
  });

  it("end-of-run sweep ignores another run's eval property", () => {
    const listed = [
      { propertyId: "prop_145_tenafly_road", name: "145 Tenafly Road", address: "145 Tenafly Road, Tenafly, NJ 07670" },
      { propertyId: "prop_914b", name: "914B", address: "914B Summit Street, Fort Lee, NJ 07024" },
      { propertyId: "prop_other_run", name: "eval-rdeadbeef", address: "101 Eval rdeadbeef Lane, Teaneck, NJ 07666" },
      { propertyId: "prop_eval_r1234abcd", name: "eval-r1234abcd", address: "100 Eval r1234abcd Lane, Teaneck, NJ 07666" },
    ];
    const selected = selectEvalSweepIds(listed, "r1234abcd");
    expect(selected).toEqual(["prop_eval_r1234abcd"]);
    expect(selected).not.toContain("prop_other_run");
    expect(selected).not.toContain("prop_145_tenafly_road");
    expect(selected).not.toContain("prop_914b");
    const state = newGuardState("r1234abcd");
    expect(admitSweepRemovals(state, { properties: listed })).toEqual(["prop_eval_r1234abcd"]);
    expect([...state.sweepPropertyIds]).toEqual(["prop_eval_r1234abcd"]);
    expect(() => assertLiveCall(state, "remove_property", { property: "prop_other_run" })).toThrow(/not one this run created/);
    expect(() => assertLiveCall(state, "remove_property", { property: "prop_145_tenafly_road" })).toThrow(/not one this run created/);
    expect(() => assertLiveCall(state, "remove_property", { property: "prop_914b" })).toThrow(/not one this run created/);
    expect(() => assertLiveCall(state, "remove_property", { property: "prop_eval_r1234abcd" })).not.toThrow();
  });
});
