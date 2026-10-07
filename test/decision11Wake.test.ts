import { afterEach, describe, expect, it } from "vitest";
import { timeRequestedEvent } from "../src/alerts/operatorEvents";
import { installHarness } from "./installHarness";

const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).forEach((c) => c()));

describe("decision 11 alert destination", () => {
  it("replaces the one saved webhook, and the wake body has no visitor name, number, or message", async () => {
    const h = installHarness();
    cleanups.push(h.cleanup);
    h.inst.secrets.set({ TOURCORE_GROK_ROUTINE_URL: "https://routines.example/old", TOURCORE_GROK_ROUTINE_KEY: "old-key-12345678" });
    h.inst.secrets.set({ TOURCORE_GROK_ROUTINE_URL: "https://routines.example/new", TOURCORE_GROK_ROUTINE_KEY: "new-key-12345678" });
    expect(h.inst.secrets.get("TOURCORE_GROK_ROUTINE_URL")).toBe("https://routines.example/new");
    expect(h.inst.secrets.get("TOURCORE_GROK_ROUTINE_KEY")).toBe("new-key-12345678");
    const event = timeRequestedEvent({ propertyId: "prop_demo", tourTimeRequestId: "ttr_aabbccddeeff", occurredAt: "2026-10-07T22:00:00.000Z" });
    await h.inst.sink().deliver(event);
    const posts = h.net.calls.filter((call) => call.url.startsWith("https://routines.example/"));
    expect(posts.map((call) => call.url)).toEqual(["https://routines.example/new"]);
    const body = JSON.parse(posts[0]!.body!);
    expect(Object.keys(body).sort()).toEqual(["eventId", "eventType", "occurredAt", "propertyId", "schemaVersion", "tourTimeRequestId"]);
    expect(body.eventId).toBe(event.eventId);
    expect(body.eventType).toBe("tour.time_requested");
    expect(posts[0]!.headers?.Authorization).toBe("Bearer new-key-12345678");
    expect(posts[0]!.body).not.toMatch(/visitor|phone|\+1|message|name/i);
  });
});
