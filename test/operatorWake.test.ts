import { afterEach, describe, expect, it } from "vitest";
import { timeRequestedEvent } from "../src/alerts/operatorEvents";
import { GROK_ALERTS_SAY, GROK_WAKE_NO_PLACE, GROK_WAKE_WITH_PLACE } from "../src/playbooks/grok";
import { renderPlaybook } from "../src/playbooks/compose";
import { installHarness } from "./installHarness";
import { liveApp } from "./liveApp";

const cleanups: Array<() => void> = [];
const grokClientCaps = { elicitation: { form: {} }, sampling: {}, roots: { listChanged: true } };
afterEach(() => cleanups.splice(0).forEach((c) => c()));

describe("operator wake alert", () => {
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

  it("inspect_tour_time_request includes the place name for the spoken question", async () => {
    const a = await liveApp({ cleanups });
    await a.book();
    await a.text("Can I change it to 3:15?");
    const id = (await a.grok("list_tour_time_requests")).requests[0].tourTimeRequestId as string;
    const inspected = await a.grok("inspect_tour_time_request", { tourTimeRequestId: id });
    expect(inspected.place).toBe("Unit 1A");
    expect(JSON.stringify(inspected)).not.toContain("Main Home");
    // The wake copy that reads this place out loud is checked in "Grok wake copy" below.
  });
});

describe("Grok wake copy", () => {
  it("is in the Grok playbook only, with one spoken offer and a yes before any action", () => {
    const full = renderPlaybook({ name: "Grok", capabilities: grokClientCaps }, "alerts");
    const bare = renderPlaybook({ name: "grok" }, "alerts");
    const partial = renderPlaybook({ name: "Grok", capabilities: { elicitation: {}, sampling: {} } }, "alerts");
    const offer = GROK_ALERTS_SAY;
    for (const text of [full.text, bare.text, partial.text]) {
      expect(text).toContain(`Ask only this: ${offer}`);
      expect(text).toContain(GROK_WAKE_WITH_PLACE);
      expect(text).toContain(GROK_WAKE_NO_PLACE);
      expect(text).toContain("Fill {name} from the visitor's name on that read, {place} from the place on that read");
      expect(text).toContain(`If that read has no place, say this instead: "${GROK_WAKE_NO_PLACE}"`);
      expect(text).toContain("Only after a clear yes");
      expect(text).toContain("You never text a visitor.");
      expect(full.mode).toBe("full");
      expect(bare.mode).toBe("full");
    }
    const spoken = full.text.split("For you, not out loud:")[0] ?? "";
    expect(spoken).not.toMatch(/webhook|routine|event id|secure link/i);
    for (const client of [{ name: "claude", capabilities: { prompts: {}, resources: {} } }, { name: "chatgpt", capabilities: { prompts: {}, resources: {} } }, { name: "unknown" }, { name: "grok", capabilities: { tools: {} } }, undefined]) {
      const other = renderPlaybook(client, "alerts").text;
      expect(other).not.toContain(offer);
      expect(other).not.toContain("approve_tour_time_request");
      expect(other).toContain("Want me to tell you when someone books, starts, or finishes a tour");
    }
  });
});
