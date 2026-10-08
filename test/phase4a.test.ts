import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/tourCoreConfig";
import { isFairHousingQuestion } from "../src/core/fairHousing";
import { dayReference } from "../src/core/spokenTime";
import { UNKNOWN_ANSWER, unknownAnswerReply } from "../src/core/TourCore";
import { claimVisitorSms, listVisitorTemplates, renderSms, visitorTeamName } from "../src/sms/templates";
import { handleVisitorText } from "../src/visitor/conversation";
import { entryReply } from "../src/visitor/entry";
import { pickerMiss } from "../src/visitor/portfolioPick";
import { VisitorDemoSession, visitorView } from "../src/visitor";
import { at, hillsideConfig, liveApp } from "./liveApp";

const cleanups: Array<() => void> = [];
afterEach(() => {
  cleanups.splice(0).forEach((run) => run());
});

const MUST_MATCH = [
  "Would you rent to someone based on their color?",
  "Do you accept tenants of any color?",
  "Is color a factor in who you rent to?",
  "is it mostly white around here?",
  "is it mostly Black around here?",
  "is the area mostly Asian?",
  "are there many families with kids nearby?",
  "are there asian residents nearby?",
];

const NOW_ORDINARY = [
  "any Asian restaurants nearby?",
  "white picket fence in the neighborhood?",
  "what color are the doors in the building?",
  "Black Friday sale nearby?",
];

describe("phase 4a visitor copy", () => {
  it("uses the team name in every team template, and property team when the name does not end in team", () => {
    expect(visitorTeamName("Acme Realty")).toBe("property team");
    expect(visitorTeamName("leasing team")).toBe("leasing team");
    const teamTemplates = listVisitorTemplates().filter((template) => template.text.includes("{team}"));
    expect(teamTemplates.length).toBeGreaterThan(20);
    for (const template of teamTemplates) {
      const slots = Object.fromEntries(
        [...template.text.matchAll(/\{([A-Za-z][A-Za-z0-9]*)\??\}/g)].map((match) => [
          match[1]!,
          match[1] === "team" ? "leasing team" : match[1] === "rest" ? "Text me anytime to book another." : "X",
        ]),
      );
      const body = renderSms(template.id, slots).body;
      expect(body, template.id).toContain("leasing team");
      expect(body, template.id).not.toContain("property team");
    }
    expect(unknownAnswerReply()).toBe(UNKNOWN_ANSWER);
    expect(unknownAnswerReply({ team: "Acme Realty" })).toBe(UNKNOWN_ANSWER);
    expect(unknownAnswerReply({ team: "leasing team" })).toBe(
      "I'll pass your question to the leasing team, and they'll reply here as soon as they can.",
    );
  });

  it("rejects a rest that is not a registered visitor template", () => {
    expect(claimVisitorSms("Sorry, I didn't catch that. Which day works for you?")).toBe("sorry-rest");
    expect(claimVisitorSms("Sorry, I didn't catch that. Text DONE when you're finished.")).toBe("sorry-rest");
    expect(() => claimVisitorSms("Sorry, I didn't catch that. purple monkey dishwasher")).toThrow(/not in the template registry/);
    expect(() => claimVisitorSms("Someone just grabbed that time. Not a real follow up.")).toThrow(/not in the template registry/);
  });

  it("keeps the must-match fair-housing lines and lets the four ordinary questions through", () => {
    for (const line of MUST_MATCH) expect(isFairHousingQuestion(line), line).toBe(true);
    for (const line of NOW_ORDINARY) expect(isFairHousingQuestion(line), line).toBe(false);
  });

  it("accepts mon and tmrw as days and still misses a bare fragment", () => {
    expect(dayReference("mon")).toMatchObject({ weekday: "MON" });
    expect(dayReference("tmrw")).toMatchObject({ relative: "tomorrow" });
    expect(dayReference("monday")).toMatchObject({ weekday: "MON" });
    expect(dayReference("huh")).toBeUndefined();
  });

  it("skips the unit question for one unit and the reply-1 line for one place", () => {
    const config = hillsideConfig();
    const unit = config.units[0]!;
    const one = { ...config, units: [unit], routes: config.routes.filter((route) => route.unitId === unit.id) };
    const days = [{ label: "Monday, Sep 28" }];
    const reply = entryReply(one, days, one.units);
    expect(reply.body).toContain("Which day works for you?");
    expect(reply.body).not.toContain("Which unit");
    const pausedSibling = entryReply(config, days, [unit]);
    expect(pausedSibling.body).toContain("Which unit would you like to see?");
    expect(pickerMiss(1)).toBe("I didn't catch that. Which place are you touring?");
    expect(claimVisitorSms(pickerMiss(1))).toBe("portfolio-miss-1");
    expect(pickerMiss(1)).not.toContain("Reply 1");
    expect(pickerMiss(2)).toContain("Reply 1 or 2");
  });

  it("keeps leasing team on the tour-finished text and the follow-up re-ask", async () => {
    const config = loadConfig();
    config.operator = { ...config.operator, name: "leasing team" };
    const session = new VisitorDemoSession(config.property.id, config, "leasing_followup", { realNow: () => at(7) });
    await session.act("begin", { name: "Pat Smith", phone: "(555) 010-2000" });
    await session.act("chooseUnit", { unitId: "apt_101" });
    const day = (await visitorView(session)).choices[0]!;
    await session.act(day.action, day.input);
    const slot = (await visitorView(session)).choices[0]!;
    await session.act(slot.action, slot.input);
    await session.act("consent", { agree: true });
    await session.act("submitIdentity", { firstName: "Pat", lastName: "Smith", email: "pat@example.com", phone: "555-010-2000" });
    await session.act("demoSkipAhead", {});
    await session.act("arrive", {});
    await session.act("atStop", { doorId: "unit_101" });
    await session.act("finish", {});
    const finished = [...session.conversation].reverse().find((item) => item.from === "tourcore")!.text;
    expect(finished).toContain("Would you like someone from the leasing team to follow up?");
    expect(finished).not.toContain("property team");
    await handleVisitorText(session, "+15550102000", "huh");
    const again = [...session.conversation].reverse().find((item) => item.from === "tourcore")!.text;
    expect(again).toContain("Would you like someone from the leasing team to follow up?");
    expect(again).not.toContain("property team");
    expect(claimVisitorSms(again.split("\n")[0]!)).toBe("sorry-rest");
  });

  it("never mixes property team and leasing team in one conversation", async () => {
    const config = hillsideConfig();
    config.operator = { ...config.operator, name: "leasing team" };
    const app = await liveApp({ cleanups, config });
    const welcome = await app.optInSms();
    expect(welcome.join("\n")).not.toContain("property team");
    const gym = await app.text("is there a gym?");
    expect(gym.join("\n")).toContain("leasing team");
    expect(gym.join("\n")).not.toContain("property team");
    const restaurants = await app.text("any Asian restaurants nearby?");
    expect(restaurants.join("\n")).toContain("I'll pass your question to the leasing team");
    expect(restaurants.join("\n")).not.toContain("Good question for the");
    const steering = await app.text("is it mostly white around here?");
    expect(steering.join("\n")).toContain("Good question for the leasing team. I've passed it along, and they'll text you back here.");
    const all = [...welcome, ...gym, ...restaurants, ...steering].join("\n");
    expect(all).not.toContain("property team");
    expect(all).toContain("leasing team");
  });
});
