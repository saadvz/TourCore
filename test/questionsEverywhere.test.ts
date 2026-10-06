import { afterEach, describe, expect, it } from "vitest";
import { resolveQuestion, unitsNamedIn } from "../src/core/questions";
import { TOUR_ENDED_REPLY, UNKNOWN_ANSWER_ENDED } from "../src/core/TourCore";
import { at, FALLBACK, hillsideConfig, liveApp } from "./liveApp";

/**
 * A visitor can ask about the property at any point in the text
 * conversation, from before they pick a unit to after the tour. Answers come
 * only from approved facts; the question interrupts the step and the visitor
 * lands back exactly where they were (same menu, same times, same pending
 * confirmation). Unknowns go to the team, and the team's answer resumes the step.
 */

const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).forEach((c) => c()));
const app = () => liveApp({ cleanups });

const UNIT_MENU = "Reply 1 for Unit 1A or 2 for Unit 2B.";
const TIMES = "I have these times available Monday, Sep 28:\nReply 1 for 2:00 PM or 2 for 3:30 PM.";
const DATE_MENU = "I have tours available. Which day works for you?\n1) Monday, Sep 28\n2) Tuesday, Sep 29\n3) Wednesday, Sep 30\n4) Thursday, Oct 1\n5) Friday, Oct 2\nReply with the number.";
const CONSENT = "Is it OK if I text you about this tour and keep a record of your visit?\nReply YES or NO.";

describe("approved-fact resolution", () => {
  const config = hillsideConfig();

  it("names units from the visitor's own words, without mistaking numbers for units", () => {
    const names = (q: string) => unitsNamedIn(q, config.units).map((u) => u.name);
    expect(names("How much is 1A?")).toEqual(["Unit 1A"]);
    expect(names("does unit 2b have laundry")).toEqual(["Unit 2B"]);
    expect(names("is 1A or 2B bigger?")).toEqual(["Unit 1A", "Unit 2B"]);
    expect(names("I'd like 1 please")).toEqual([]);
  });

  it("prefers structured unit details, never the description, and asks which unit when it can't tell", () => {
    expect(resolveQuestion(config, "How much is 1A?")).toMatchObject({ kind: "answer", unitId: "apt_101", facts: [{ text: "Unit 1A rents for $2,300 a month.", profileField: "monthlyRent" }] });
    expect(resolveQuestion(config, "How much is it?")).toEqual({ kind: "which-unit", units: ["Unit 1A", "Unit 2B"] });
    expect(resolveQuestion(config, "How much is it?", { selectedUnitId: "apt_102" })).toMatchObject({ kind: "answer", facts: [{ text: "Unit 2B rents for $1,950 a month." }] });
    expect(resolveQuestion(config, "How many bedrooms?", { selectedUnitId: "apt_101" })).toMatchObject({ facts: [{ text: "Unit 1A has 2 bedrooms." }] });
    // Building-wide facts need no unit.
    expect(resolveQuestion(config, "Is there parking?")).toMatchObject({ kind: "answer", facts: [{ scope: "property", text: "Street parking only." }] });
    // The operator explicitly didn't list bedrooms: the "Two-bedroom" description is not a second source.
    const withheld = hillsideConfig();
    withheld.units[0]!.profile!.bedrooms = { status: "NOT_PROVIDED" };
    expect(withheld.units[0]!.summary).toMatch(/Two-bedroom/);
    expect(resolveQuestion(withheld, "How many bedrooms does 1A have?")).toEqual({ kind: "unknown", unitId: "apt_101" });
    expect(resolveQuestion(config, "Is there a gym?")).toEqual({ kind: "unknown" });
  });
});

describe("questions at every stage of a text conversation", () => {
  it("before choosing a unit: no property answer until YES, then the answer and the unit menu", async () => {
    const a = await app();
    const blocked = (await a.text("How much is 1A?")).join("\n");
    expect(blocked).toContain("Text TOUR");
    expect(blocked).not.toContain("2,300");
    expect(blocked).not.toContain("Which unit");
    await a.text("TOUR");
    expect((await a.text("YES")).join("\n")).toContain("Which unit would you like to see?");
    const replies = await a.text("How much is 1A?");
    expect(replies[0]).toBe("Unit 1A rents for $2,300 a month.");
    expect(replies.at(-1)).toContain("Which unit would you like to see?");
    expect(a.ws.listTours("prop_100_alfred_way")[0]).toMatchObject({ kind: "messaging", outcome: "in-progress" });
    const tour = (await a.grok("list_active_tours")).tours[0];
    expect(tour).toMatchObject({ status: "Browsing", currentStep: "Choosing a unit" });
    // Picking a unit carries on normally.
    expect((await a.text("1"))[0]).toContain("Happy to set up a self-guided tour of Unit 1A");
  });

  it('"How much is it?" with no unit chosen asks which unit, answers, and the unit menu still means what it did', async () => {
    const a = await app();
    await a.optInSms();
    expect(await a.text("How much is it?")).toEqual([`Which unit do you mean: Unit 1A or Unit 2B?\n${UNIT_MENU}`]);
    // "2" answers the question about 2B; it doesn't book 2B.
    expect(await a.text("2")).toEqual(["Unit 2B rents for $1,950 a month.", `Which unit would you like to see?\n${UNIT_MENU}`]);
    expect((await a.grok("list_active_tours")).tours[0].currentStep).toBe("Choosing a unit");
    // Now "1" picks Unit 1A, exactly as the menu says.
    expect((await a.text("1"))[0]).toContain("Happy to set up a self-guided tour of Unit 1A");
  });

  it("while choosing a time: answered from the chosen unit, then the same times, and the menu number still works", async () => {
    const a = await app();
    await a.optInSms();
    await a.text("1");
    await a.text("1");
    expect(await a.text("Does it have laundry?")).toEqual(["Here's what the property team shared: In-unit laundry.", TIMES]);
    expect(await a.text("Does 1A have laundry?")).toEqual(["Here's what the property team shared: In-unit laundry.", TIMES]);
    expect((await a.text("2"))[0]).toContain("Great, you're booked for 3:30 PM");
  });

  it("before consent and during the identity form: answered, then the same question or reminder; consent and the form link still work", async () => {
    const a = await app();
    await a.optInSms();
    await a.text("1");
    await a.text("1");
    await a.text("1");
    expect(await a.text("Is parking included?")).toEqual(["Here's what the property team shared: Street parking only.", CONSENT]);
    const consent = await a.text("YES");
    expect(consent.join("\n")).toMatch(/\/verify\//);
    expect(await a.text("How many bathrooms does it have?")).toEqual(["Unit 1A has 1 bathroom.", "Your identity form is in my earlier message. Once it's filled out, I'll confirm your tour."]);
    // Asking about the form itself still resends the link.
    expect((await a.text("where's the form?"))[0]).toContain("Here's your identity form link again.");
    await a.fillForm(await a.text("where's the form?"));
    expect((await a.grok("list_active_tours")).tours[0].status).not.toBe("Browsing");
  });

  it("after booking, before arrival, during and after the tour; a pending confirmation survives the question", async () => {
    const a = await app();
    await a.book();
    expect(await a.text("How many bedrooms?")).toEqual(["Unit 1A has 2 bedrooms."]);

    a.clock.t = at(13, 58);
    expect((await a.text("almost there"))[0]).toMatch(/^Are you at the property now\?/);
    expect(await a.text("Is there parking?")).toEqual(["Here's what the property team shared: Street parking only.", "Are you at the property now?\nReply YES or NO."]);
    expect((await a.text("yes"))[0]).toContain("Entrance is open for you now.");

    expect(await a.text("When is it available?")).toEqual(["Unit 1A is available now."]);
    await a.text("at unit 1A");
    expect((await a.text("I'm done"))[0]).toContain("Thanks for touring Unit 1A");
    expect(await a.text("What's the rent?")).toEqual(["Unit 1A rents for $2,300 a month.", "Would you like someone from the property team to follow up?\nReply YES or NO."]);
    await a.text("no");
    expect(await a.text("Does it have laundry?")).toEqual([UNKNOWN_ANSWER_ENDED]);
    expect((await a.grok("list_exceptions")).exceptions.map((x: { summary: string }) => x.summary)).toContain(
      'Asked "Does it have laundry?". There\'s no approved answer yet.',
    );
    expect(await a.text("ok")).toEqual([TOUR_ENDED_REPLY]);
  });

  it("an unknown question at any stage: safe fallback, an exception for the team, and the visitor's step is kept", async () => {
    const a = await app();
    await a.optInSms();
    expect(await a.text("Is there a gym?")).toEqual([FALLBACK, expect.stringContaining("Which unit would you like to see?")]);
    await a.text("1");
    expect(await a.text("Is there a pool?")).toEqual([FALLBACK, DATE_MENU]);
    await a.text("1");
    expect(await a.text("Can I bring my bike inside?")).toEqual([FALLBACK, TIMES]);
    await a.text("1");
    const issues = (await a.grok("list_exceptions")).exceptions;
    expect(issues.map((x: { summary: string }) => x.summary).sort()).toEqual(
      ['Asked "Can I bring my bike inside?". There\'s no approved answer yet.', 'Asked "Is there a gym?". There\'s no approved answer yet.', 'Asked "Is there a pool?". There\'s no approved answer yet.'],
    );
    expect(issues.find((x: { summary: string }) => x.summary.includes("gym"))).toMatchObject({ visitorName: "A visitor texting from +15550102000", what: "Question with no approved answer" });
    // Consent still works after the interruption.
    expect((await a.text("yes")).join("\n")).toMatch(/\/verify\//);
  });

  it("the operator's answer reaches the visitor and puts them back on the step they were on", async () => {
    const a = await app();
    await a.optInSms();
    await a.text("1");
    await a.text("1");
    expect(await a.text("Is there a gym?")).toEqual([FALLBACK, TIMES]);
    const [issue] = (await a.grok("list_exceptions")).exceptions;
    const before = a.fake.sent.length;
    const out = await a.approve("answer_flagged_question", { exceptionId: issue.exceptionId, approvedFact: "There's a gym on the roof." });
    expect(out.visitorAnswered).toBe(true);
    expect(a.fake.sent.slice(before).map((s) => s.content)).toEqual(["There's a gym on the roof. Let me know if you have any other questions.", TIMES]);
    expect((await a.text("2"))[0]).toContain("Great, you're booked for 3:30 PM");
    // The new fact is approved content from now on.
    expect(await a.text("is there a gym?")).toEqual(["Here's what the property team shared: There's a gym on the roof.", CONSENT]);
  });

  it("a question about one unit before booking is filed against that unit, and a detail answer is saved to it", async () => {
    const a = await app();
    await a.optInSms();
    expect(await a.text("How big is 2B?")).toEqual([FALLBACK, `Which unit would you like to see?\n${UNIT_MENU}`]);
    const [issue] = (await a.grok("list_exceptions")).exceptions;
    expect(issue.unitName).toBe("Unit 2B");
    await a.approve("answer_flagged_question", { exceptionId: issue.exceptionId, approvedFact: "About 850 square feet" });
    expect(a.ws.load("prop_100_alfred_way").config.units.find((u) => u.id === "apt_102")!.profile!.squareFeet).toMatchObject({ status: "PROVIDED", value: 850 });
    expect(a.ws.contentChanges("prop_100_alfred_way").flatMap((c) => c.changes)).toContain("Unit 2B: squareFeet");
  });
});
