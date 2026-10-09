import { afterEach, describe, expect, it } from "vitest";
import { loadConfig, type TourCoreConfig } from "../src/config/tourCoreConfig";
import { DAY_TO_DAY_TOOLS } from "../src/operator/dayToDay";
import { PHONE, liveApp } from "./liveApp";

/**
 * An unnamed visitor's get_inbox alert summary must use the full formatted
 * number. The operator-updates ping stays ids only.
 */

const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).forEach((fn) => fn()));

const QUESTION = "Is there a pool?";
const NAMED_QUESTION = "Is there a gym?";

function scratchLaneConfig(): TourCoreConfig {
  const c = loadConfig();
  const entrance = c.doors.find((door) => door.kind === "ENTRANCE")!;
  const unit = c.units[0]!;
  return {
    ...c,
    messagingMode: "live",
    property: {
      ...c.property,
      id: "prop_1_qa_scratch_lane",
      name: "1 QA Scratch Lane",
      displayName: "1 QA Scratch Lane",
      address: "1 QA Scratch Lane, Tenafly, NJ 07670",
      propertyType: "SINGLE_FAMILY",
      timezone: "America/New_York",
      canonicalAddress: {
        street: "1 QA Scratch Lane",
        city: "Tenafly",
        state: "NJ",
        postalCode: "07670",
        formatted: "1 QA Scratch Lane, Tenafly, NJ 07670",
      },
      facts: ["Street parking only."],
    },
    doors: [{ ...entrance, id: "entrance", name: "Front Door", kind: "ENTRANCE" }],
    units: [{ ...unit, id: "home", name: "Main Home", doorId: "entrance" }],
    routes: [
      {
        id: "route_home",
        unitId: "home",
        stops: [{ doorId: "entrance", guidance: "Come in through the front door. Text me when you're there." }],
      },
    ],
  };
}

describe("get_inbox unnamed visitor summary", () => {
  it("keeps the routine ping to ids and shows Visitor at the full number", async () => {
    const app = await liveApp({ cleanups, config: scratchLaneConfig() });
    await app.text("TOUR");
    await app.text("YES");
    await app.text(QUESTION);
    await app.server.tourCore.settled();

    const calls = app.net.routineCalls();
    const ping = calls.find((call) => call.body?.includes("exception.created"));
    expect(ping?.body).toBeTruthy();
    const body = ping!.body!;
    const event = JSON.parse(body) as { eventId: string; exceptionId: string; eventType: string };
    expect(Object.keys(event).sort()).toEqual(["eventId", "eventType", "exceptionId", "occurredAt", "propertyId", "schemaVersion"]);
    expect(event).toMatchObject({
      schemaVersion: 1,
      eventType: "exception.created",
      propertyId: "prop_1_qa_scratch_lane",
      occurredAt: "2026-09-28T11:00:00.000Z",
      eventId: expect.stringMatching(/^evt_[a-f0-9]{24}$/),
      exceptionId: expect.stringMatching(/^exc_[a-f0-9]{12}$/),
    });
    expect(Buffer.byteLength(body)).toBe(203);
    const readable = body.replace(/"eventId":"evt_[a-f0-9]+"/, "").replace(/"exceptionId":"exc_[a-f0-9]+"/, "");
    for (const leak of ["pool", "555", "010-2000", "0102000", "(555)", "Visitor", "Testy", "Pat", "Smith", QUESTION]) {
      expect(readable, leak).not.toContain(leak);
    }

    const inbox = await app.grok("get_inbox", { eventId: event.eventId });
    expect(inbox.summary).toBe(
      'Visitor at (555) 010-2000, 1 QA Scratch Lane: They asked: "Is there a pool?" There\'s no approved answer yet. Choosing a time.',
    );
    expect(inbox.eventId).toBe(event.eventId);
    expect(inbox.issue.eventId).toBe(event.eventId);

    const listed = await app.grok("get_inbox");
    const item = (listed.items as Array<{ exceptionId?: string; eventId?: string; summary?: string }>).find((row) => row.exceptionId === event.exceptionId);
    expect(item?.eventId).toBe(event.eventId);
    expect(item?.eventId).toBe(inbox.eventId);
  });

  it("leaves a named visitor's get_inbox summary on their first name", async () => {
    const app = await liveApp({ cleanups, config: scratchLaneConfig() });
    await app.text("TOUR");
    await app.text("YES");
    await app.text("1");
    await app.text("1");
    await app.fillForm(await app.text("YES"));
    await app.text(NAMED_QUESTION);
    await app.server.tourCore.settled();

    const ping = app.net.routineCalls().find((call) => {
      if (!call.body?.includes("exception.created")) return false;
      return JSON.parse(call.body).exceptionId && call.body.includes("exception.created");
    });
    const event = JSON.parse(ping!.body!) as { eventId: string };
    const inbox = await app.grok("get_inbox", { eventId: event.eventId });
    expect(inbox.summary).toBe(
      'Testy, 1 QA Scratch Lane: They asked: "Is there a gym?" There\'s no approved answer yet. Ready, waiting for arrival.',
    );
    expect(inbox.summary).not.toContain("Visitor at");
    expect(inbox.summary).not.toContain(PHONE);
    expect(inbox.eventId).toBe(event.eventId);
    expect(inbox.issue.eventId).toBe(event.eventId);
  });

  it("documents the unnamed summary and the item eventId on get_inbox", () => {
    const tool = DAY_TO_DAY_TOOLS.find((item) => item.name === "get_inbox");
    expect(tool?.description).toContain("When the visitor has no name, the summary starts Visitor at {number}, {place}:");
    expect(tool?.description).toContain("Each item that had an alert includes its eventId");
    expect(tool?.description).not.toContain("(555) 010-2000");
    expect(tool?.description).not.toContain("The alert itself still carries no visitor name");
  });

  it("leaves eventId off when that kind of update was never queued", async () => {
    const app = await liveApp({ cleanups, config: scratchLaneConfig() });
    await app.grok("save_settings", { updates: ["TOUR_BOOKED"] });
    await app.text("TOUR");
    await app.text("YES");
    await app.text(QUESTION);
    await app.server.tourCore.settled();

    expect(app.net.routineCalls().some((call) => call.body?.includes("exception.created"))).toBe(false);
    expect(app.outbox("exception.created")).toEqual([]);

    const listed = await app.grok("get_inbox");
    const item = (listed.items as Array<{ exceptionId?: string; eventId?: string; summary?: string }>).find((row) => row.summary?.includes("Is there a pool?"));
    expect(item?.exceptionId).toBeTruthy();
    expect(item).not.toHaveProperty("eventId");

    const one = await app.grok("get_inbox", { exceptionId: item!.exceptionId });
    expect(one.item).not.toHaveProperty("eventId");
    expect(one.summary).toBe(
      'Visitor at (555) 010-2000, 1 QA Scratch Lane: They asked: "Is there a pool?" There\'s no approved answer yet.',
    );
    expect(one.item.tourStatus).toBe("Choosing a time");
    await expectListedEventIdsResolve(app, listed.items);
  });

  it("uses the queued alert's eventId, and get_inbox reads that same update", async () => {
    const app = await liveApp({ cleanups, config: scratchLaneConfig() });
    await app.text("TOUR");
    await app.text("YES");
    await app.text(QUESTION);
    await app.server.tourCore.settled();

    const ping = app.net.routineCalls().find((call) => call.body?.includes("exception.created"));
    const event = JSON.parse(ping!.body!) as { eventId: string; exceptionId: string };
    const listed = await app.grok("get_inbox");
    const item = (listed.items as Array<{ exceptionId?: string; eventId?: string }>).find((row) => row.exceptionId === event.exceptionId);
    expect(item?.eventId).toBe(event.eventId);

    const inbox = await app.grok("get_inbox", { eventId: item!.eventId });
    expect(inbox.summary).toBe(
      'Visitor at (555) 010-2000, 1 QA Scratch Lane: They asked: "Is there a pool?" There\'s no approved answer yet. Choosing a time.',
    );
    const one = await app.grok("get_inbox", { exceptionId: event.exceptionId });
    expect(one.item.eventId).toBe(event.eventId);
    await expectListedEventIdsResolve(app, listed.items);
  });
});

async function expectListedEventIdsResolve(app: Awaited<ReturnType<typeof liveApp>>, items: Array<{ eventId?: string }>): Promise<void> {
  const ids = items.map((item) => item.eventId).filter((id): id is string => typeof id === "string");
  for (const eventId of ids) {
    const read = await app.grok("get_inbox", { eventId });
    expect(read.eventId).toBe(eventId);
    expect(String(read.summary)).not.toBe("I couldn't find that update.");
  }
}
