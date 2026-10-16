import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { groupIntroBody, groupInviteBody, namedAsk, nameList } from "../src/cleaner-core/cleanerTexts";
import { openCleanerCore, type CleanerText } from "../src/cleaner-core/core";
import { SCRATCH_TENANTS } from "../src/cleaner-core/tenants";

describe("group-first: copy", () => {
  it("builds the group invite", () => {
    expect(groupInviteBody("Saad", "145 Tenafly Road")).toBe(
      "Saad wants to set up a group chat with you for cleaner services at 145 Tenafly Road. Reply YES to join, or STOP to opt out.",
    );
  });

  it("joins names as A and B, or A, B and C", () => {
    expect(nameList(["Saad", "Mike"])).toBe("Saad and Mike");
    expect(nameList(["Saad", "Mike", "Ana"])).toBe("Saad, Mike and Ana");
    expect(nameList(["Saad"])).toBe("Saad");
  });

  it("builds the group intro", () => {
    expect(groupIntroBody(["Saad", "Mike"], "Saad", "145 Tenafly Road")).toBe(
      "Hi Saad and Mike! This is the cleaning group for 145 Tenafly Road. I'm Saad's cleaning assistant, and I'll post cleaning times and updates here. Reply STOP anytime to leave.",
    );
  });

  it("names the cleaner in a Reply ask", () => {
    expect(
      namedAsk("Mike", "Update: checkout at X moved to Sunday at 10:00 AM. Reply YES to keep the cleaning, or STOP to opt out."),
    ).toBe("Update: checkout at X moved to Sunday at 10:00 AM. Mike, reply YES to keep the cleaning, or STOP to opt out.");
  });

  it("names the cleaner before a closing question", () => {
    expect(namedAsk("Mike", "Reminder: cleaning at X on Sunday. Checkout is 11:00 AM. What time do you plan to arrive?")).toBe(
      "Reminder: cleaning at X on Sunday. Checkout is 11:00 AM. Mike, what time do you plan to arrive?",
    );
  });

  it("keeps the pronoun I when it starts a closing question", () => {
    expect(namedAsk("Mike", "Checkout is 11:00 AM. I can arrive by 10:30, right?")).toBe(
      "Checkout is 11:00 AM. Mike, I can arrive by 10:30, right?",
    );
  });

  it("leaves a body without an ask unchanged", () => {
    expect(namedAsk("Mike", "Thanks, cleaning marked done.")).toBe("Thanks, cleaning marked done.");
  });

  it("keeps the host note at the end, untouched", () => {
    const body = "Turnover at 145 Tenafly Road on Sunday. Reply YES to schedule it, or STOP to opt out. Note from the host: Reply STOP to skip the lamp.";
    expect(namedAsk("Mike", body)).toBe(
      "Turnover at 145 Tenafly Road on Sunday. Mike, reply YES to schedule it, or STOP to opt out. Note from the host: Reply STOP to skip the lamp.",
    );
  });

  it("keeps the door code and the ready wording out of the copy", () => {
    const copy = [
      groupInviteBody("Saad", "145 Tenafly Road"),
      groupIntroBody(["Saad", "Mike", "Ana"], "Saad", "145 Tenafly Road"),
      namedAsk("Mike", "Reminder: cleaning at X on Sunday. What time do you plan to arrive?"),
    ];
    for (const text of copy) {
      expect(text).not.toContain("door code");
      expect(text).not.toContain("ready");
    }
  });
});

describe("group-first: invites", () => {
  const FEED = readFileSync(join("src/cleaner-core/fixtures", "guesty-lite-scratch.ics"), "utf8");
  const LANE = "12 Scratch Lane, Teaneck, NJ 07666";
  const OWNER = "+15555550100";
  const MIKE = "+15555550101";
  const ANA = "+15555550122";
  const PIN = SCRATCH_TENANTS[0]!.pin;

  function engine(sent: CleanerText[], extra: Partial<Parameters<typeof openCleanerCore>[0]> = {}) {
    return openCleanerCore({
      enabled: true,
      property: { id: "prop_12_scratch_lane", address: LANE, timeZone: "America/New_York" },
      ownerPhone: OWNER,
      cleaner: { phone: MIKE, approved: true },
      pin: PIN,
      hostName: "Scratch",
      consented: true,
      sink: { send: async (text) => void sent.push(text) },
      now: () => new Date("2026-10-14T15:00:00.000Z"),
      groupChat: { hostName: "Saad", cleanerName: "Mike", extra: [{ phone: ANA, name: "Ana" }] },
      ...extra,
    });
  }
  const optIns = (sent: CleanerText[]) => sent.filter((text) => text.kind === "opt-in").map(({ to, kind, body }) => ({ to, kind, body }));

  it("invites the cleaner and each contact, and never the landlord", async () => {
    const sent: CleanerText[] = [];
    const job = engine(sent);
    await job.pollFeed(FEED);
    await job.confirmHostTimes({ checkout: "11:00 AM", checkIn: "4:00 PM" });
    expect(optIns(sent)).toEqual([
      { to: MIKE, kind: "opt-in", body: groupInviteBody("Saad", LANE) },
      { to: ANA, kind: "opt-in", body: groupInviteBody("Saad", LANE) },
    ]);
    expect(sent.some((text) => text.to === OWNER && text.kind === "opt-in")).toBe(false);
  });

  it("does not re-invite a cleaner who already said yes", async () => {
    const sent: CleanerText[] = [];
    const job = engine(sent, { cleanerConsent: "in" });
    await job.pollFeed(FEED);
    await job.confirmHostTimes({ checkout: "11:00 AM", checkIn: "4:00 PM" });
    expect(optIns(sent).some((text) => text.to === MIKE)).toBe(false);
  });

  it("test turn texts the owner nothing and keeps the owner seated", async () => {
    const sent: CleanerText[] = [];
    const job = engine(sent);
    await job.addTestTurn({ checkout: "11:00 AM", checkIn: "4:00 PM" });
    expect(sent.some((text) => text.to === OWNER)).toBe(false);
    expect(optIns(sent).map((text) => text.to)).toEqual([MIKE]);
    expect(sent.find((text) => text.to === MIKE)?.body).toBe(groupInviteBody("Saad", LANE));
  });
});
