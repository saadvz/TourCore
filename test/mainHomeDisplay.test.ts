import { afterEach, describe, expect, it } from "vitest";
import { describeOperatorUpdate } from "../src/alerts/describeUpdate";
import { TOUR_EVENT_TYPES, tourEvent } from "../src/alerts/operatorEvents";
import { persistSession } from "../src/operator/services";
import { tourRef, unitNameOf } from "../src/operator/tours";
import { visitorSubject } from "../src/visitor/identity";
import { VisitorDemoSession } from "../src/visitor/session";
import { grokHarness, type GrokHarness } from "./grokHarness";

const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).forEach((fn) => fn()));

function app(): GrokHarness {
  const h = grokHarness();
  cleanups.push(h.cleanup);
  return h;
}

function assertNoMainHome(label: string, text: string | undefined) {
  expect(text, label).toBeTruthy();
  expect(text, label).not.toContain("Main Home");
}

async function setupOakHome(h: GrokHarness) {
  const created = await h.ok("create_property_setup", { address: "12 Oak St, Teaneck, NJ 07666", propertyType: "SINGLE_FAMILY" });
  const id = created.setup.propertyId as string;
  const added = await h.ok("add_unit", {});
  expect(added.unit.name).toBe("Main Home");
  await h.ok("set_unit_details", { units: [{ unit: "Main Home", bedrooms: "3", bathrooms: "2", monthlyRent: "$3,400", availability: "now" }] });
  await h.ok("set_tour_hours", { days: "weekdays", start: "9am", end: "5pm" });
  await h.ok("set_verification_policy", { level: "basic-form" });
  await h.ok("update_property_details", { skipVisitorHelp: true });
  return { id, added };
}

async function bookOakVisitor(h: GrokHarness, id: string) {
  const { config } = h.workspace.load(id);
  const session = h.visitors.add(new VisitorDemoSession(id, config, h.workspace.newVisitorTourId(id, new Date(h.now())), { realNow: () => h.now() }));
  const act = async (action: string, input: unknown = {}) => {
    await session.act(action, input);
    await persistSession(h.services, session);
  };
  await act("begin", { name: "Pat Smith", phone: "(555) 010-2000" });
  const day = session.offeredDates[0];
  if (day) await act("chooseDate", { date: day.date });
  await act("chooseTime", { slotStart: session.offeredSlots[0]!.start.toISOString() });
  await act("consent", { agree: true });
  await act("submitIdentity", { firstName: "Pat", lastName: "Smith", email: "pat@example.com", phone: "555-010-2000" });
  return session;
}

describe("single-family alerts and operator replies never say Main Home", () => {
  it("routes every landlord alert and operator reply through the street line", async () => {
    const h = app();
    const { id, added } = await setupOakHome(h);
    const draft = h.workspace.openDraft(id).draft;
    expect(visitorSubject(draft.property, "Main Home")).toBe("12 Oak Street");

    const replies: Array<[string, string]> = [
      ["add_unit", added.summary],
      ["list_units", (await h.ok("list_units", { property: id })).summary],
      ["get_route", (await h.ok("get_route", { property: id, unit: "Main Home" })).summary],
      ["get_unit_details", (await h.ok("get_unit_details", { property: id })).summary],
      ["list_properties", (await h.ok("list_properties")).properties.map((p: { name: string }) => p.name).join(", ")],
    ];
    replies.push(["run_readiness_check", JSON.stringify(await h.ok("run_readiness_check"))]);
    replies.push(["set_unit_details", (await h.ok("set_unit_details", { units: [{ unit: "Main Home", bedrooms: "3" }] })).summary]);

    await h.ok("run_dry_tour");
    await h.approve("publish_demo_property", {});
    const session = await bookOakVisitor(h, id);
    const ref = tourRef(id, session.tourId);
    const reservation = (await session.reservation())!;
    const now = new Date(h.now());

    for (const eventType of TOUR_EVENT_TYPES) {
      const update = await describeOperatorUpdate(
        h.services,
        tourEvent({ eventType, propertyId: id, tourRef: ref, reservationId: reservation.id, occurredAt: now.toISOString() }),
        now,
      );
      replies.push([eventType, String(update.summary)]);
      expect("tour" in update && update.tour ? update.tour.unitName : undefined, eventType).toBe("12 Oak Street");
    }

    const inspected = await h.ok("inspect_tour", { tourRef: ref });
    replies.push(["inspect_tour", inspected.summary]);
    replies.push(["inspect_tour.unitName", inspected.tour.unitName]);
    replies.push(["inspect_tour.currentStep", inspected.tour.currentStep]);
    replies.push(["accessGrants", JSON.stringify(inspected.tour.accessGrants ?? [])]);

    await session.operatorChange((core, reservationId) => core.answerQuestion(reservationId, "Is there a pool?"));
    await persistSession(h.services, session);
    const issues = await h.ok("list_exceptions", { property: id });
    replies.push(["list_exceptions", JSON.stringify(issues)]);
    const exceptionId = issues.exceptions?.[0]?.exceptionId as string | undefined;
    if (exceptionId) {
      const open = await h.ok("inspect_exception", { exceptionId });
      replies.push(["inspect_exception", open.summary]);
      replies.push(["inspect_exception.unitName", open.issue.unitName]);
    }

    const hold = await h.approve("place_operator_hold", { tourRef: ref, reason: "Checking the lock" });
    replies.push(["place_operator_hold.ask", hold.asked.summary]);
    replies.push(["place_operator_hold.done", hold.done.summary]);
    const resumed = await h.approve("clear_operator_hold", { tourRef: ref });
    replies.push(["clear_operator_hold.ask", resumed.asked.summary]);
    replies.push(["clear_operator_hold.done", resumed.done.summary]);

    const pause = await h.ok("pause_tours", { property: id, unit: "Main Home" });
    replies.push(["pause_tours", pause.summary]);

    const notified = (await session.store.list("messages")).filter((m) => m.audience === "OPERATOR").map((m) => m.body);
    for (const [i, body] of notified.entries()) replies.push([`notifyOperator.${i}`, body]);

    replies.push(["unitNameOf", unitNameOf({ config: h.workspace.load(id).config, bundle: { reservations: [reservation] } } as never) ?? ""]);

    for (const [label, text] of replies) {
      assertNoMainHome(label, text);
    }
    for (const type of TOUR_EVENT_TYPES) {
      const text = replies.find(([label]) => label === type)?.[1];
      expect(text, type).toContain("12 Oak Street");
    }
    expect(added.summary).toContain("12 Oak Street");
    expect(replies.find(([label]) => label === "list_units")?.[1]).toContain("12 Oak Street");
    expect(replies.find(([label]) => label === "inspect_tour.unitName")?.[1]).toBe("12 Oak Street");
  });
});
