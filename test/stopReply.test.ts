import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { openCleanerCore, type CleanerText } from "../src/cleaner-core";
import { at, liveApp } from "./liveApp";

const STOP_REPLY = "You're opted out and won't receive more messages. Reply START to opt back in. Reply HELP for help.";
const HOST_STOP = "You're opted out of cleaning texts for 12 Scratch Lane, Teaneck, NJ 07666. Reply START to get texts again.";
const OWNER = "+15555550100";
const CLEANER = "+15555550101";

const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).forEach((fn) => fn()));

describe("STOP confirmation", () => {
  it("uses the exact unbranded reply for a Tour Core property and a Cleaner Core sender", async () => {
    const previous = process.env.TOURCORE_PUBLIC_BRAND_NAME;
    process.env.TOURCORE_PUBLIC_BRAND_NAME = "Tour Core";
    try {
      const app = await liveApp({ cleanups, clock: { t: at(7) } });
      await app.optInSms();
      expect(await app.text("STOP")).toEqual([STOP_REPLY]);

      process.env.TOURCORE_PUBLIC_BRAND_NAME = "Example Tours";
      const sent: CleanerText[] = [];
      const job = openCleanerCore({
        enabled: true,
        property: { id: "prop_12_scratch_lane", address: "12 Scratch Lane, Teaneck, NJ 07666", timeZone: "America/New_York" },
        ownerPhone: OWNER,
        cleaner: { phone: CLEANER, approved: true },
        consented: true,
        sink: { send(text: CleanerText) { sent.push(text); } },
        now: () => new Date("2026-10-14T15:00:00.000Z"),
      });
      await job.pollFeed(readFileSync("src/cleaner-core/fixtures/guesty-lite-scratch.ics", "utf8"));
      const stopped = await job.receive({ id: "stop-reply", from: OWNER, text: "STOP" });
      expect(stopped.sent).toEqual([{ to: OWNER, body: HOST_STOP, kind: "stop" }]);
      expect(sent.filter((text) => text.kind === "stop").map((text) => text.body)).toEqual([HOST_STOP]);
    } finally {
      if (previous === undefined) delete process.env.TOURCORE_PUBLIC_BRAND_NAME;
      else process.env.TOURCORE_PUBLIC_BRAND_NAME = previous;
    }
  });
});
