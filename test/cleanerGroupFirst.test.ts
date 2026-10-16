import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { groupIntroBody, groupInviteBody, groupUnconfirmedLine, namedAsk, nameList } from "../src/cleaner-core/cleanerTexts";
import { GroupNotConfirmed } from "../src/cleaner-core/groupThread";
import { openCleanerCore, type CleanerText } from "../src/cleaner-core/core";
import { outboxLabel } from "../src/cleaner-core/scratchQa";
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

describe("group-first: intro", () => {
  const FEED = readFileSync(join("src/cleaner-core/fixtures", "guesty-lite-scratch.ics"), "utf8");
  const EMPTY = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//scratch//EN\r\nEND:VCALENDAR\r\n";
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
  const intros = (sent: CleanerText[]) => sent.filter((text) => text.kind === "intro");
  const yes = (job: ReturnType<typeof engine>, from: string) => job.receive({ id: `yes-${from}`, from, text: "YES" });

  it("posts one intro when Mike joins the seated landlord, with no job booked", async () => {
    const sent: CleanerText[] = [];
    const job = engine(sent);
    await job.pollFeed(EMPTY);
    expect(intros(sent)).toEqual([]);
    await yes(job, MIKE);
    expect(intros(sent)).toEqual([
      { to: MIKE, kind: "intro", channel: "group", audience: [OWNER, MIKE], body: groupIntroBody(["Saad", "Mike"], "Saad", LANE) },
    ]);
  });

  it("comes before the first offer", async () => {
    const sent: CleanerText[] = [];
    const job = engine(sent);
    await job.pollFeed(FEED);
    await job.confirmHostTimes({ checkout: "11:00 AM", checkIn: "4:00 PM" });
    await yes(job, MIKE);
    const kinds = sent.filter((text) => text.channel === "group").map((text) => text.kind);
    expect(kinds[0]).toBe("intro");
    expect(kinds).toContain("offer");
    expect(kinds.indexOf("intro")).toBeLessThan(kinds.indexOf("offer"));
    expect(intros(sent)).toHaveLength(1);
  });

  it("posts a second intro naming all three when Ana joins after Mike", async () => {
    const sent: CleanerText[] = [];
    const job = engine(sent);
    await job.pollFeed(EMPTY);
    await yes(job, MIKE);
    await yes(job, ANA);
    expect(intros(sent).map(({ audience, body }) => ({ audience, body }))).toEqual([
      { audience: [OWNER, MIKE], body: groupIntroBody(["Saad", "Mike"], "Saad", LANE) },
      { audience: [OWNER, MIKE, ANA], body: groupIntroBody(["Saad", "Mike", "Ana"], "Saad", LANE) },
    ]);
    expect(intros(sent)[1]?.to).toBe(MIKE);
  });

  it("waits for Mike when Ana says yes first", async () => {
    const sent: CleanerText[] = [];
    const job = engine(sent);
    await job.pollFeed(EMPTY);
    await yes(job, ANA);
    expect(intros(sent)).toEqual([]);
    await yes(job, MIKE);
    expect(intros(sent).map(({ audience }) => audience)).toEqual([[OWNER, MIKE, ANA]]);
    expect(intros(sent)[0]?.body).toBe(groupIntroBody(["Saad", "Mike", "Ana"], "Saad", LANE));
  });

  it("sends nothing to the group after Mike says STOP, and Mike gets only the stop text", async () => {
    const sent: CleanerText[] = [];
    const job = engine(sent);
    await job.pollFeed(EMPTY);
    await job.receive({ id: "stop-mike", from: MIKE, text: "STOP" });
    expect(sent.filter((text) => text.channel === "group")).toEqual([]);
    expect(intros(sent)).toEqual([]);
    expect(sent.filter((text) => text.to === MIKE && text.kind !== "opt-in").map((text) => text.kind)).toEqual(["stop"]);
    await job.pollFeed(EMPTY);
    expect(sent.filter((text) => text.channel === "group")).toEqual([]);
  });

  it("does not repeat the intro for the same members after a reopen", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cleaner-intro-"));
    const sent: CleanerText[] = [];
    const first = engine(sent, { dataDir: dir });
    await first.pollFeed(EMPTY);
    await yes(first, MIKE);
    expect(intros(sent)).toHaveLength(1);
    const again = engine(sent, { dataDir: dir });
    await again.pollFeed(EMPTY);
    expect(intros(sent)).toHaveLength(1);
  });

  it("sends nothing on open when both are already in, then one intro on the first step", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cleaner-intro-"));
    const sent: CleanerText[] = [];
    const job = engine(sent, { dataDir: dir, cleanerConsent: "in" });
    expect(sent).toEqual([]);
    await job.pollFeed(EMPTY);
    await job.pollFeed(EMPTY);
    expect(intros(sent).map(({ audience }) => audience)).toEqual([[OWNER, MIKE]]);
    const reopened = engine(sent, { dataDir: dir, cleanerConsent: "in" });
    expect(intros(sent)).toHaveLength(1);
    await reopened.receive({ id: "noise", from: MIKE, text: "hello" });
    expect(intros(sent)).toHaveLength(1);
  });

  it("labels the intro in the outbox", () => {
    expect(outboxLabel("intro", "the cleaner")).toBe("Group intro to the cleaner");
  });

  it("still sends the offer and tells the host when the intro fails with a plain error", async () => {
    const sent: CleanerText[] = [];
    let failIntro = true;
    const job = engine(sent, {
      sink: {
        send: async (text) => {
          if (text.kind === "intro" && failIntro) throw new Error("boom");
          sent.push(text);
        },
      },
    });
    await job.pollFeed(FEED);
    await job.confirmHostTimes({ checkout: "11:00 AM", checkIn: "4:00 PM" });
    await yes(job, MIKE);
    expect(sent.some((text) => text.kind === "offer" && text.to === MIKE)).toBe(true);
    // The failed intro is kept for review, and it is not posted again.
    expect(job.reviews().filter((item) => item.kind === "failed-sms" && item.status === "open")).toHaveLength(1);
    failIntro = false;
    await job.pollFeed(FEED);
    expect(intros(sent)).toEqual([]);
  });

  it("retries an intro the group couldn't confirm at the next step", async () => {
    const sent: CleanerText[] = [];
    let confirmed = false;
    const job = engine(sent, {
      sink: {
        send: async (text) => {
          if (text.channel === "group" && !confirmed) throw new GroupNotConfirmed();
          sent.push(text);
        },
      },
    });
    await job.pollFeed(EMPTY);
    await yes(job, MIKE);
    expect(intros(sent)).toEqual([]);
    confirmed = true;
    await job.pollFeed(EMPTY);
    expect(intros(sent)).toHaveLength(1);
  });
});

describe("group-first: routing", () => {
  const FEED = readFileSync(join("src/cleaner-core/fixtures", "guesty-lite-scratch.ics"), "utf8");
  const MOVED = readFileSync(join("src/cleaner-core/fixtures", "guesty-lite-date-moved.ics"), "utf8");
  const LANE = "12 Scratch Lane, Teaneck, NJ 07666";
  const OWNER = "+15555550100";
  const MIKE = "+15555550101";
  const ANA = "+15555550122";
  const PIN = SCRATCH_TENANTS[0]!.pin;
  const DUE = "2026-10-18T12:00:00.000Z";
  const TIMES = { checkout: "11:00 AM", checkIn: "4:00 PM" };

  function engine(sent: CleanerText[], clock: { at: string }, extra: Partial<Parameters<typeof openCleanerCore>[0]> = {}) {
    return openCleanerCore({
      enabled: true,
      property: { id: "prop_12_scratch_lane", address: LANE, timeZone: "America/New_York" },
      ownerPhone: OWNER,
      cleaner: { phone: MIKE, approved: true },
      pin: PIN,
      hostName: "Scratch",
      consented: true,
      cleanerConsent: "in",
      sink: { send: async (text) => void sent.push(text) },
      now: () => new Date(clock.at),
      groupChat: { hostName: "Saad", cleanerName: "Mike" },
      reminderAsksArrival: true,
      ...extra,
    });
  }
  const say = (job: ReturnType<typeof engine>, id: string, from: string, text: string) => job.receive({ id, from, text });
  const slim = (text: CleanerText) => ({ to: text.to, kind: text.kind, channel: text.channel, audience: text.audience });

  async function fullRun(sent: CleanerText[], extra: Partial<Parameters<typeof openCleanerCore>[0]> = {}) {
    const clock = { at: "2026-10-14T15:00:00.000Z" };
    const job = engine(sent, clock, extra);
    await job.pollFeed(FEED);
    await job.confirmHostTimes(TIMES);
    await say(job, "yes", MIKE, "YES");
    clock.at = DUE;
    await job.runReminders();
    await job.pollFeed(MOVED);
    await job.confirmHostTimes(TIMES);
    await say(job, "yes-again", MIKE, "YES");
    await say(job, "left", OWNER, "guests have left");
    await say(job, "start", MIKE, "START");
    await say(job, "done", MIKE, "DONE");
    return job;
  }

  it("posts the offer, time change, reminder, confirmation, start and done into the group", async () => {
    const sent: CleanerText[] = [];
    await fullRun(sent);
    for (const kind of ["offer", "corrected", "reminder", "confirm", "started", "done"] as const) {
      const texts = sent.filter((text) => text.kind === kind && (kind !== "done" || text.to === MIKE || text.channel === "group"));
      expect(texts.length, kind).toBeGreaterThan(0);
      for (const text of texts) {
        expect(text.channel, `${kind} channel`).toBe("group");
        expect(text.audience, `${kind} audience`).toEqual([OWNER, MIKE]);
      }
    }
    expect(sent.filter((text) => text.kind === "pin").every((text) => text.channel === undefined && text.to === MIKE)).toBe(true);
    expect(sent.filter((text) => text.channel === "group").some((text) => text.body.includes(PIN))).toBe(false);
  });

  it("names Mike in the time change and the reminder", async () => {
    const sent: CleanerText[] = [];
    await fullRun(sent);
    expect(sent.find((text) => text.kind === "corrected")?.body).toContain("Mike, reply YES to keep the cleaning");
    expect(sent.find((text) => text.kind === "reminder")?.body.endsWith("Mike, what time do you plan to arrive?")).toBe(true);
  });

  it("posts the intro first, and each text only once", async () => {
    const sent: CleanerText[] = [];
    await fullRun(sent);
    const group = sent.filter((text) => text.channel === "group");
    expect(group[0]?.kind).toBe("intro");
    const bodies = group.map((text) => `${text.kind}|${text.body}`);
    expect(new Set(bodies).size).toBe(bodies.length);
    expect(sent.filter((text) => text.to === MIKE && text.channel === undefined && ["offer", "corrected", "reminder", "confirm", "started"].includes(text.kind))).toEqual([]);
  });

  it("keeps the host's questions out of the group", async () => {
    const sent: CleanerText[] = [];
    await fullRun(sent);
    for (const text of sent.filter((item) => item.channel === "group")) {
      expect(["host-checkout", "host-checkin", "review", "pin-notice", "pin-failed", "pin-held", "resume"]).not.toContain(text.kind);
    }
  });

  it("sends Mike's STOP reply to Mike alone", async () => {
    const sent: CleanerText[] = [];
    const job = engine(sent, { at: "2026-10-14T15:00:00.000Z" });
    await job.pollFeed(FEED);
    await job.confirmHostTimes(TIMES);
    const before = sent.length;
    await say(job, "stop", MIKE, "STOP");
    const after = sent.slice(before);
    expect(after.filter((text) => text.channel === "group")).toEqual([]);
    expect(after.filter((text) => text.kind === "stop").map(slim)).toEqual([{ to: MIKE, kind: "stop", channel: undefined, audience: undefined }]);
  });

  it("sends the HELP reply to Mike alone", async () => {
    const sent: CleanerText[] = [];
    const job = engine(sent, { at: "2026-10-14T15:00:00.000Z" });
    await job.pollFeed(FEED);
    const before = sent.length;
    await say(job, "help", MIKE, "HELP");
    const after = sent.slice(before);
    expect(after.filter((text) => text.channel === "group")).toEqual([]);
    for (const text of after.filter((item) => item.kind === "help")) expect(text.channel).toBeUndefined();
  });

  it("posts the 911 line to the group when Mike reports an injury", async () => {
    const sent: CleanerText[] = [];
    const job = engine(sent, { at: "2026-10-14T15:00:00.000Z" });
    await job.pollFeed(FEED);
    const before = sent.length;
    await say(job, "hurt", MIKE, "someone got hurt, I need an ambulance");
    const emergencies = sent.slice(before).filter((text) => text.kind === "emergency");
    expect(emergencies.length).toBeGreaterThan(0);
    expect(emergencies.some((text) => text.body.includes("911"))).toBe(true);
    for (const text of emergencies.filter((item) => item.body.includes("911"))) {
      expect(text.channel).toBe("group");
      expect(text.audience).toEqual([OWNER, MIKE]);
    }
    expect(emergencies.filter((text) => text.channel === "group").some((text) => text.body.includes("Grok Bot"))).toBe(false);
    expect(emergencies.filter((text) => text.body.includes("Grok Bot")).every((text) => text.to === OWNER && text.channel === undefined)).toBe(true);
  });

  it("falls back to Mike one-to-one when the group can't be confirmed, with a note for the host", async () => {
    const sent: CleanerText[] = [];
    const job = await fullRun(sent, {
      sink: {
        send: async (text) => {
          if (text.channel === "group") throw new GroupNotConfirmed();
          sent.push(text);
        },
      },
    });
    expect(sent.filter((text) => text.channel === "group")).toEqual([]);
    for (const kind of ["offer", "corrected", "reminder", "confirm", "started"] as const) {
      expect(sent.some((text) => text.kind === kind && text.to === MIKE && text.channel === undefined), kind).toBe(true);
    }
    expect(job.hostNotes()).toContain(groupUnconfirmedLine("offer"));
    expect(job.hostNotes()).toContain(groupUnconfirmedLine("corrected"));
    expect(job.hostNotes()).toContain(groupUnconfirmedLine("started"));
  });

  it("never sends one-to-one when a group post fails outright", async () => {
    const sent: CleanerText[] = [];
    const job = engine(sent, { at: "2026-10-14T15:00:00.000Z" }, {
      sink: {
        send: async (text) => {
          if (text.channel === "group" && text.kind === "offer") throw new Error("boom");
          sent.push(text);
        },
      },
    });
    await job.pollFeed(FEED);
    await job.confirmHostTimes(TIMES);
    await job.pollFeed(FEED);
    expect(sent.some((text) => text.kind === "offer")).toBe(false);
    expect(job.reviews().some((item) => item.kind === "failed-sms" && item.status === "open")).toBe(true);
  });

  it("posts the intro first when a reply is routed from a receive, with both already in", async () => {
    const sent: CleanerText[] = [];
    const job = engine(sent, { at: "2026-10-14T15:00:00.000Z" });
    expect(sent).toEqual([]);
    const result = await say(job, "hello", MIKE, "what do I do next?");
    const group = sent.filter((text) => text.channel === "group");
    expect(group.map((text) => text.kind)).toEqual(["intro", "next"]);
    expect(result.sent.map((text) => text.kind)).toEqual(["intro", "next"]);
    expect(group.every((text) => text.audience?.join() === [OWNER, MIKE].join())).toBe(true);
  });

  it("posts to whoever is in the group at the time, contacts included", async () => {
    const sent: CleanerText[] = [];
    const clock = { at: "2026-10-14T15:00:00.000Z" };
    const job = engine(sent, clock, { groupChat: { hostName: "Saad", cleanerName: "Mike", extra: [{ phone: ANA, name: "Ana" }] }, cleanerConsent: undefined });
    await job.pollFeed(FEED);
    await job.confirmHostTimes(TIMES);
    await say(job, "yes-mike", MIKE, "YES");
    await say(job, "yes-ana", ANA, "YES");
    await say(job, "yes-offer", MIKE, "YES");
    const jobTexts = sent.filter((text) => text.channel === "group" && text.kind !== "intro");
    expect(jobTexts.map((text) => text.kind)).toEqual(["offer", "confirm"]);
    // The offer went out when two were in. The confirmation goes to all three.
    expect(jobTexts.map((text) => text.audience)).toEqual([[OWNER, MIKE], [OWNER, MIKE, ANA]]);
    expect(sent.filter((text) => text.to === ANA && text.channel === undefined && text.kind !== "opt-in")).toEqual([]);
  });
});
