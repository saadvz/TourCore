import { DUPLEX_VARIANTS, type DuplexVariant } from "./duplex";
import { confirmationCode, type EvalSession, type ToolResult } from "./session";

function fail(step: string, result: ToolResult): never {
  throw new Error(`click path ${step}: ${JSON.stringify(result.summary ?? result.status ?? result).slice(0, 800)}`);
}

/**
 * The hosted demo click path for the canonical duplex, including get_next
 * at each milestone. This is the sequence later phases diff step by step.
 */
export async function runClickPath(session: EvalSession, variant: DuplexVariant = DUPLEX_VARIANTS[0]!): Promise<{ propertyId: string; nameA: string; nameB: string }> {
  const was = session.recording;
  session.recording = true;
  const call = session.call.bind(session);
  try {
    let next = await call("get_next_installation_step");
    if (next.action !== "CHOOSE_MESSAGING_PROVIDER") fail("get_next before texting", next);
    await call("choose_messaging_provider", { provider: "local" });
    next = await call("get_next_installation_step");
    if (next.action !== "TEST_VISITOR_MESSAGING") fail("get_next after choose", next);
    const tested = await call("test_visitor_messaging");
    if (tested.ok !== true) fail("test_visitor_messaging", tested);
    next = await call("get_next_installation_step");
    if (next.action !== "CONFIRM_BACKUP_DESTINATION") fail("get_next after texting test", next);
    await call("decline_portable_backup");
    next = await call("get_next_installation_step");
    if (next.action !== "SET_UP_PROPERTY") fail("get_next after backups", next);

    const created = await call("create_property_setup", {
      address: variant.address,
      ...(variant.timezone ? { timezone: variant.timezone } : {}),
    });
    if (created.status !== "created") fail("create_property_setup", created);
    const propertyId = (created.setup as { propertyId?: string }).propertyId;
    if (!propertyId) fail("create_property_setup", created);
    await call("get_next_installation_step");
    await call("update_property_details", { property: propertyId, confirmAddress: true });
    await call("get_next_installation_step");
    await call("update_property_details", { property: propertyId, propertyType: "MULTIFAMILY_HOME" });
    await call("get_next_installation_step");

    const addedA = await call("add_unit", { property: propertyId, name: variant.nameA });
    const addedB = await call("add_unit", { property: propertyId, name: variant.nameB });
    const unitA = addedA.unit as { name?: string; door?: string };
    const unitB = addedB.unit as { name?: string; door?: string };
    if (!unitA.name || !unitA.door || !unitB.name || !unitB.door) fail("add_unit", addedA);
    const bulk = `${unitA.name} is 2 bed 1 bath for $2,200, available now. ${unitB.name} is 1 bed 1 bath for $1,950, available October 15.`;
    await call("set_unit_details", { property: propertyId, details: bulk });
    const entrance = await call("add_door", { property: propertyId, name: variant.entrance, kind: "entrance" });
    const entranceName = (entrance.door as { name?: string } | undefined)?.name ?? variant.entrance;

    const previewA = await call("preview_route", { property: propertyId, unit: unitA.name, doors: [entranceName, unitA.door] });
    if (previewA.status !== "ok") fail("preview_route A", previewA);
    await call("set_route", { property: propertyId, unit: unitA.name, doors: previewA.route });
    const previewB = await call("preview_route", { property: propertyId, unit: unitB.name, doors: [entranceName, unitB.door] });
    if (previewB.status !== "ok") fail("preview_route B", previewB);
    await call("set_route", { property: propertyId, unit: unitB.name, doors: previewB.route });

    await call("set_tour_hours", { property: propertyId, days: variant.days, start: variant.start, end: variant.end });
    await call("set_verification_policy", { property: propertyId, level: "basic-form" });
    await call("update_property_details", { property: propertyId, skipVisitorHelp: true });
    await call("review_property_setup", { property: propertyId });

    next = await call("get_next_installation_step");
    if (next.action !== "OFFER_OPERATOR_ALERTS") fail("get_next after property", next);
    await call("skip_optional_setup", { component: "OPERATOR_ALERTS" });
    next = await call("get_next_installation_step");
    if (next.action !== "RUN_READINESS") fail("get_next after alerts", next);
    const readiness = await call("run_readiness_check", { property: propertyId });
    if (readiness.passed !== true) fail("run_readiness_check", readiness);
    next = await call("get_next_installation_step");
    if (next.action !== "RUN_PRACTICE_TOUR") fail("get_next after readiness", next);
    const dry = await call("run_dry_tour", { property: propertyId });
    if (dry.passed !== true) fail("run_dry_tour", dry);
    next = await call("get_next_installation_step");
    if (next.action !== "PUBLISH") fail("get_next after practice", next);
    const asked = await call("publish_demo_property", { property: propertyId });
    if (asked.status !== "needs-confirmation") fail("publish ask", asked);
    const published = await call("publish_demo_property", { property: propertyId, confirmationCode: confirmationCode(asked) });
    if (published.published !== true) fail("publish", published);
    const status = await call("get_installation_status");
    const statusNext = status.nextStep as { action?: string } | undefined;
    if (statusNext?.action !== "ADD_ANOTHER_PROPERTY") fail("status after publish", { summary: status.summary, nextStep: status.nextStep });
    return { propertyId, nameA: unitA.name, nameB: unitB.name };
  } finally {
    session.recording = was;
  }
}
