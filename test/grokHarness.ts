import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zonedTimeToUtc } from "../src/core/timezone";
import { handleMcpMessage } from "../src/mcp/mcpBridge";
import { ConfirmationBook } from "../src/operator/confirmations";
import { persistSession, type OperatorServices } from "../src/operator/services";
import { callOperatorTool, type ToolContext } from "../src/operator/tools";
import { PropertyWorkspace } from "../src/setup";
import { VisitorDemoRegistry, VisitorDemoSession } from "../src/visitor";

/** Monday 28 Sep 2026 at the property (America/New_York). */
export const at = (hour: number, minute = 0) => zonedTimeToUtc({ year: 2026, month: 9, day: 28, hour, minute }, "America/New_York").getTime();

/**
 * Tour Core as an agent host sees it: the operator tool contract over a real
 * workspace and live conversations, with a movable clock. Provider-neutral:
 * no Grok account, network or model involved.
 */
export function grokHarness(root = mkdtempSync(join(tmpdir(), "tourcore-grok-"))) {
  let clock = at(7);
  const workspace = new PropertyWorkspace(root);
  const visitors = new VisitorDemoRegistry();
  visitors.useApprovedContent((id) => (workspace.has(id) ? workspace.load(id).config : undefined));
  const services: OperatorServices = { workspace, visitors, now: () => new Date(clock) };
  const ctx: ToolContext = { services, confirmations: new ConfirmationBook(10 * 60_000, () => clock), now: () => new Date(clock), localUrl: () => "http://localhost:4321" };

  const call = (name: string, args: unknown = {}) => callOperatorTool(ctx, name, args);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ok = async (name: string, args: unknown = {}): Promise<any> => {
    const out = await call(name, args);
    if (!out.ok) throw new Error(`${name} failed: ${out.error}`);
    return out.result;
  };
  const fails = async (name: string, args: unknown = {}): Promise<string> => {
    const out = await call(name, args);
    if (out.ok) throw new Error(`${name} should have failed but returned ${JSON.stringify(out.result)}`);
    return out.error;
  };
  /** Consequential tools: ask, then approve with the returned code (what the operator's "yes" does). */
  const approve = async (name: string, args: Record<string, unknown>) => {
    const asked = await ok(name, args);
    if (asked.status !== "needs-confirmation") throw new Error(`${name} didn't ask first: ${JSON.stringify(asked)}`);
    return { asked, done: await ok(name, { ...args, confirmationCode: asked.confirmation.code }) };
  };
  let rpcId = 0;
  const mcp = (method: string, params?: Record<string, unknown>) => handleMcpMessage(ctx, { jsonrpc: "2.0", id: ++rpcId, method, ...(params ? { params } : {}) });

  /** The operator's first-run conversation, as the tool calls Grok makes. */
  const setUpAlfredWay = async () => {
    const created = await ok("create_property_setup", { address: "100 Alfred Way, Brooklyn, NY", name: "100 Alfred Way", propertyType: "APARTMENT_BUILDING" });
    await ok("add_door", { name: "Lobby Entrance", kind: "entrance" });
    await ok("add_unit", { name: "Unit 101", description: "One-bedroom apartment" });
    await ok("add_unit", { name: "Unit 102", description: "Two-bedroom apartment" });
    await ok("set_unit_details", { details: "101 is 1 bed 1 bath for $1,950, available now. 102 is 2 bed 1 bath for $2,400, available now." });
    await ok("set_route", { unit: "Unit 101", doors: ["Lobby Entrance", "Unit 101 Door"] });
    await ok("set_route", { unit: "Unit 102", doors: ["Lobby Entrance", "Unit 102 Door"] });
    await ok("set_tour_hours", { days: "weekdays", start: "9am", end: "5pm" });
    await ok("set_verification_policy", { level: "basic-form" });
    return created.setup.propertyId as string;
  };

  const publish = async () => {
    const id = await setUpAlfredWay();
    await ok("run_readiness_check");
    await ok("run_dry_tour");
    await approve("publish_demo_property", {});
    return id;
  };

  /** A visitor on the browser phone, driven through the real engine, saved after every step like the server does. */
  const visitor = async (propertyId: string, options: { name?: string; phone?: string; unitId?: string } = {}) => {
    const { config } = workspace.load(propertyId);
    const session = visitors.add(new VisitorDemoSession(propertyId, config, workspace.newVisitorTourId(propertyId, new Date(clock)), { realNow: () => clock }));
    const act = async (action: string, input: unknown = {}) => {
      await session.act(action, input);
      await persistSession(services, session);
    };
    await act("begin", { name: options.name ?? "Pat Smith", phone: options.phone ?? "(555) 010-2000" });
    await act("chooseUnit", { unitId: options.unitId ?? "unit_101" });
    const day = session.offeredDates[0];
    if (day) await act("chooseDate", { date: day.date });
    return { session, act, slot: () => session.offeredSlots[0]!.start };
  };

  /** Books, verifies and brings the visitor inside Unit 101 at 9:00 AM. */
  const touringVisitor = async (propertyId: string, options: { name?: string; phone?: string } = {}) => {
    const v = await visitor(propertyId, options);
    const [first, last] = (options.name ?? "Pat Smith").split(" ");
    await v.act("chooseTime", { slotStart: v.slot().toISOString() });
    await v.act("consent", { agree: true });
    await v.act("submitIdentity", { firstName: first, lastName: last, email: "pat@example.com", phone: options.phone ?? "555-010-2000" });
    clock = v.slot().getTime();
    await v.act("arrive");
    await v.act("atStop", { doorId: "unit_101_door" });
    return v;
  };

  return {
    root,
    workspace,
    visitors,
    services,
    ctx,
    call,
    ok,
    fails,
    approve,
    mcp,
    setUpAlfredWay,
    publish,
    visitor,
    touringVisitor,
    setClock: (t: number) => (clock = t),
    now: () => clock,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
export type GrokHarness = ReturnType<typeof grokHarness>;
