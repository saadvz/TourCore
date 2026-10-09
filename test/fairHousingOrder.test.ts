import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/tourCoreConfig";
import { isFairHousingQuestion } from "../src/core/fairHousing";
import { UNKNOWN_ANSWER, VISITOR_CANCEL_DONE } from "../src/core/TourCore";
import { interpretByRules } from "../src/intent/ruleBased";
import { smsStopAck } from "../src/visitor/smsConsent";
import { at, liveApp, PHONE, type LiveApp } from "./liveApp";

/**
 * Help, doors, cancel, and menu answers run before a fair-housing hold.
 * A plain-language stop opts out like STOP. A hold at a live day or time
 * menu sends that menu again.
 */

const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).forEach((fn) => fn()));

const HELD = "Good question for the property team. I've passed it along, and they'll text you back here.";
const STOP = smsStopAck();
const DAY = {
  message: "",
  step: "choose-date" as const,
  units: [{ name: "Unit 101" }],
  timeChoices: ["Monday, Sep 28", "Tuesday, Sep 29"],
  remainingStops: [],
  doors: [],
  today: { year: 2026, month: 9, day: 28 },
  timezone: "America/New_York",
};
const TIME = {
  ...DAY,
  step: "choose-time" as const,
  timeChoices: ["2:00 PM", "3:30 PM"],
};

function unit101() {
  const config = loadConfig();
  return { ...config, messagingMode: "live" as const, property: { ...config.property, facts: ["Street parking only."] } };
}

function consent(app: LiveApp, phone: string) {
  const file = join(app.root, "properties", "prop_100_alfred_way", "sms-campaign-consent.json");
  return JSON.parse(readFileSync(file, "utf8")).senders[phone] as { status: string; method: string; keyword: string };
}

function exceptions(app: LiveApp) {
  return app.grok("list_exceptions").then(
    (body) => body.exceptions as Array<{ summary: string; proposeDraft?: boolean; what?: string }>,
  );
}

describe("fair housing runs after help, doors, cancel, and menus", () => {
  it("reads help, doors, cancel, finish, and a works-for booking before a hold", () => {
    expect(isFairHousingQuestion("2 pm works for my family")).toBe(false);
    expect(isFairHousingQuestion("Hi, I'm Kim Single")).toBe(false);
    expect(isFairHousingQuestion("Can my mom come, she uses a wheelchair")).toBe(true);
    expect(isFairHousingQuestion("Is my partner allowed on the tour?")).toBe(false);
    expect(isFairHousingQuestion("Can my kids come to the showing?")).toBe(false);
    const works = interpretByRules({ ...TIME, message: "2 pm works for my family" });
    expect(works.intent).toMatchObject({ type: "SELECT_TIME", timeLabel: "2:00 PM" });
    const finish = interpretByRules({
      ...TIME,
      step: "touring",
      message: "Done, my family loved it",
    });
    expect(finish.intent.type).toBe("FINISH_TOUR");
    const yes = interpretByRules({
      ...TIME,
      step: "touring",
      awaiting: { kind: "confirm-finish" },
      message: "yes, me and my partner",
    });
    expect(yes.intent.type).toBe("FINISH_TOUR");
    const cancel = interpretByRules({
      ...TIME,
      step: "ready",
      awaiting: { kind: "confirm-cancel-tour", day: "Monday, Sep 28", time: "2:00 PM" },
      hasCancelableTour: true,
      message: "yes cancel, family emergency",
    });
    expect(cancel.intent.type).toBe("CONFIRM_CANCEL_TOUR");
  });

  it("on a running tour, help with a group word alerts and flags, and the unit door still opens", async () => {
    const clock = { t: at(7) };
    const a = await liveApp({ cleanups, clock, config: unit101() });
    await a.book();
    clock.t = at(13, 58);

    const here = await a.text("I'm here");
    expect(here.join("\n")).toContain("Entrance is open for you now.");
    expect(here.join("\n")).not.toContain(HELD);

    const child = await a.text("my child is locked inside, help");
    expect(child.join("\n")).toContain("I've let the property team know.");
    expect(child.join("\n")).not.toContain(HELD);
    const stuck = await a.text("the door is stuck and my kids are inside");
    expect(stuck.join("\n")).toContain("already knows");
    expect(stuck.join("\n")).not.toContain(HELD);

    const open = await a.text("I'm at unit 101 with my family");
    expect(open.join("\n")).toContain("Unit 101 Door is open for you now.");
    expect(open.join("\n")).toContain("Welcome to Unit 101!");
    expect(open.join("\n")).not.toContain(HELD);

    const done = await a.text("Done, my family loved it");
    expect(done.join("\n")).toContain("Are you finished with your tour?");
    expect(done.join("\n")).not.toContain(HELD);
    const partner = await a.text("yes, me and my partner");
    expect(partner.join("\n")).toContain("Would you like someone from the property team to follow up?");
    expect(partner.join("\n")).not.toContain(HELD);

    const flags = await exceptions(a);
    const fair = flags.filter((item) => item.summary.includes("This may touch on fair housing"));
    expect(fair.map((item) => item.summary).sort()).toEqual([
      'They asked: "my child is locked inside, help". This may touch on fair housing, so there\'s no draft. Only you can answer this one. They were told you\'d text them back here.',
      'They asked: "the door is stuck and my kids are inside". This may touch on fair housing, so there\'s no draft. Only you can answer this one. They were told you\'d text them back here.',
    ]);
    expect(fair.every((item) => item.proposeDraft === false)).toBe(true);
    expect(flags.some((item) => /asked for help/i.test(item.summary))).toBe(true);
    expect(flags.some((item) => /child is locked|kids are inside/.test(item.summary) && item.summary.includes("no approved answer"))).toBe(false);
  });

  it("sends a stuck gate to help and opens the white door", async () => {
    const clock = { t: at(7) };
    const a = await liveApp({ cleanups, clock, config: unit101() });
    await a.book();
    clock.t = at(13, 58);
    expect((await a.text("I'm here")).join("\n")).toContain("Entrance is open for you now.");

    const gate = await a.text("the black gate won't open");
    expect(gate.join("\n")).toContain("I've let the property team know.");
    expect(gate.join("\n")).not.toContain(HELD);
    const white = await a.text("I'm at the white door");
    expect(white.join("\n")).toContain("is open for you now.");
    expect(white.join("\n")).not.toContain(HELD);
    const flags = await exceptions(a);
    expect(flags.some((item) => item.summary.includes("black gate") || item.summary.includes("white door"))).toBe(false);
  });

  it("cancels at the confirm prompt when the reason names a family", async () => {
    const a = await liveApp({ cleanups, config: unit101() });
    await a.book();
    const ask = await a.text("cancel");
    expect(ask.join("\n")).toContain("Cancel your 2:00 PM tour on Monday, Sep 28? Reply YES or NO.");
    const done = await a.text("yes cancel, family emergency");
    expect(done).toEqual([VISITOR_CANCEL_DONE]);
    expect(done.join("\n")).not.toContain(HELD);
  });

  it("books 2 pm works for my family from the time menu", async () => {
    const a = await liveApp({ cleanups });
    await a.optInSms();
    await a.text("1");
    await a.text("1");
    const booked = await a.text("2 pm works for my family");
    expect(booked.join("\n")).toContain("Great, you're booked for 2:00 PM on Monday, Sep 28.");
    expect(booked.join("\n")).not.toContain(HELD);
  });

  it("does not hold a name, and sends the day or time menu again only after a hold", async () => {
    const a = await liveApp({ cleanups });
    await a.optInSms();
    const named = await a.text("Hi, I'm Kim Single");
    expect(named.join("\n")).toContain("Which unit would you like to see?");
    expect(named.join("\n")).not.toContain(HELD);

    await a.text("1");
    const ordinary = await a.text("is Friday busy?");
    expect(ordinary).toEqual([UNKNOWN_ANSWER]);
    expect(ordinary.join("\n")).not.toContain("Which day works for you?");
    const dayHold = await a.text("Is it good for families?");
    expect(dayHold[0]).toBe(HELD);
    expect(dayHold.join("\n")).toContain("Which day works for you?");

    await a.text("1");
    const timeHold = await a.text("Is the tour OK for kids?");
    expect(timeHold[0]).toBe(HELD);
    expect(timeHold.join("\n")).toContain("I have these times available");
    const gym = await a.text("is there a gym?");
    expect(gym).toEqual([UNKNOWN_ANSWER]);
    expect(gym.join("\n")).not.toContain("I have these times available");
  });
});

describe("plain-language stop", () => {
  it("opts out at the keyword gate and after opt-in with keyword STOP", async () => {
    const a = await liveApp({ cleanups });
    const gate = ["stop texting me", "stop texting us", "please stop texting my kids"] as const;
    for (const [index, phrase] of gate.entries()) {
      const phone = `+1555010220${index}`;
      expect(await a.textFrom(phone, phrase), phrase).toEqual([STOP]);
      expect(consent(a, phone), phrase).toMatchObject({ status: "opted_out", method: "keyword", keyword: "STOP" });
    }
    await a.optInSms();
    const family = await a.text("stop texting my family");
    expect(family).toEqual([STOP]);
    expect(consent(a, PHONE)).toMatchObject({ status: "opted_out", method: "keyword", keyword: "STOP" });
  });
});
