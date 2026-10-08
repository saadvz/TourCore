import { afterEach, describe, expect, it } from "vitest";
import { formatPhone } from "../src/core/phone";
import { UNKNOWN_ANSWER } from "../src/core/TourCore";
import { approvedFacts, findApprovedAnswer } from "../src/core/facts";
import { isFairHousingQuestion } from "../src/core/fairHousing";
import { FAIR_HOUSING_REFUSAL } from "../src/operator/exceptions";
import { hillsideConfig, liveApp, PHONE, type LiveApp } from "./liveApp";

/**
 * Fair-housing questions are caught before rent, keywords, and saved answers.
 * After the no-draft flag is saved, the visitor gets the held reply. No draft is proposed.
 */

const HELD = "Good question for the property team. I've passed it along, and they'll text you back here.";

const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).forEach((c) => c()));

const RENT = "Unit 1A rents for $2,300 a month.";
const HOLDING = [
  "Do you rent to families with kids?",
  "Would you rent to a single mom with a Section 8 voucher?",
  "Are kids allowed to live there?",
] as const;

describe("fair-housing detection", () => {
  it.each([
    "Do you rent to families with kids?",
    "Would you rent to a single mom with a Section 8 voucher?",
    "Are kids allowed to live there?",
    "Do you accept Section 8?",
    "Do you take Section 8?",
    "Are disabilities allowed?",
    "Would you rent to seniors?",
    "Are you okay with a voucher?",
    "Is it fine with a single dad?",
    "Do you welcome children?",
    "Would you rent to someone because of their religion?",
    "Is national origin allowed?",
    "Do you allow service animals?",
    "Can I bring a service animal?",
    "Do you allow assistance animals?",
    "Can I bring a support animal?",
    "Can I bring my emotional support dog?",
    "Do you allow emotional support animals?",
    "Can I bring my emotional support cat?",
    "Do you allow an ESA?",
    "Can I bring my ESA?",
    "Are you okay with a newborn?",
    "Do you rent to someone who is pregnant?",
    "Is pregnancy allowed?",
    "Is a baby on the way okay?",
    "Are you adults only?",
    "Do you rent to immigrants?",
    "Do you ask about immigration status?",
    "Is there a minimum age?",
    "Do you have age limits?",
    "Do you discriminate?",
    "Can I bring my service dog?",
    "Do you allow service dogs?",
    "Is a guide dog ok?",
    "My support dog comes with me, ok?",
    "Can I bring my emotional support bird?",
    "Do you allow a seeing-eye dog?",
    "Can I bring an assistance cat?",
    "SERVICE DOG",
    "Is this 55+?",
    "Is this 55 and over?",
    "Is this a senior community?",
    "Do you have age restrictions?",
    "Do you accept housing assistance?",
    "Do you take a housing voucher?",
    "Do you accept HUD?",
    "Are undocumented applicants allowed?",
    "What is your policy on sexual orientation?",
    "Do you ask about gender identity?",
    "Do you rent to gay tenants?",
    "Do you rent to lesbians?",
    "Is this LGBTQ friendly?",
    "Do you rent to a same-sex couple?",
    "Do you rent to transgender people?",
    "What religion are most neighbors?",
    "Is this a Christian building?",
    "Do you rent to Christians?",
    "Is this a Catholic building?",
    "Is this a Protestant building?",
    "Is this a Jewish building?",
    "Do you rent to a Jew?",
    "Do you rent to Jews?",
    "Is this a Muslim building?",
    "Is this an Islamic building?",
    "Is this a Hindu building?",
    "Is this a Buddhist building?",
    "Is this a Sikh building?",
    "Is this a Mormon building?",
    "Are atheists allowed?",
    "I have a therapy dog, is that ok?",
    "Can I bring a therapy animal?",
    "Do you need a social security number?",
    "Do you ask for an SSN?",
    "Is the gym adults only after 9?",
    "Is there a religious school nearby?",
    "What's in Section 8 of the lease?",
    "When is the HUD inspection?",
    "Is there a service dog area?",
    "Is the building 55+ years old?",
    "are there many families with kids nearby?",
    "what kind of people live in the building?",
    "is the neighborhood safe?",
    "are there a lot of Hispanic families around here?",
    "who lives nearby?",
    "what's the crime rate like?",
    "How many people can live in the unit?",
    "do many tenants have cars?",
  ])("matches %s", (text) => {
    expect(isFairHousingQuestion(text)).toBe(true);
  });

  it.each([
    "How much is rent?",
    "Is rent due monthly?",
    "What color are the walls?",
    "Do you allow pets?",
    "Do you allow dogs?",
    "Is there a dog park?",
    "Can I take a tour?",
    "Is there a minimum lease?",
    "Is there a church nearby?",
    "Is there a temple nearby?",
    "Is there a mosque nearby?",
    "Is there a dog run?",
    "Do you offer senior discounts?",
    "What is the age of the building?",
    "What is the roof age?",
    "Is there a support beam?",
    "What are the customer service hours?",
    "Is there a service elevator?",
    "Do you offer assistance with moving?",
    "is there room for my kids' bikes?",
    "is there a playground nearby?",
    "is there parking nearby?",
    "how many units are in the building?",
    "how many bedrooms?",
    "is the building quiet?",
    "are the walls white? lots of light?",
    "lots of color in the kitchen?",
  ])("does not match %s", (text) => {
    expect(isFairHousingQuestion(text)).toBe(false);
  });
});

describe("neighborhood composition", () => {
  it("uses race words only together with a composition phrase", () => {
    for (const word of ["hispanic", "latino", "latina", "asian", "black", "white", "arab"]) {
      expect(isFairHousingQuestion(word)).toBe(false);
      expect(isFairHousingQuestion(`are there ${word} residents nearby?`)).toBe(true);
    }
  });
});

describe("fair-housing questions on a live tour", () => {
  it("holds the question, opens a flag with no draft, and still answers rent", async () => {
    const a = await liveApp({ cleanups });
    await a.optInSms();
    await a.text("1");
    await a.text("1");
    await a.grok("update_property_details", {
      property: "100 Alfred Way",
      facts: ["Street parking only.", "Kids are allowed to live in the unit."],
    });
    expect(a.ws.load("prop_100_alfred_way").config.property.facts).toContain("Kids are allowed to live in the unit.");

    const sent: string[] = [];
    for (const text of HOLDING) {
      const replies = await a.text(text);
      sent.push(replies.join("\n"));
      expect(replies[0]).toBe(HELD);
      expect(replies.join("\n")).not.toContain("rents for");
      expect(replies.join("\n")).not.toContain("Kids are allowed to live in the unit.");
    }

    const flags = (await a.grok("list_exceptions")).exceptions as Array<{
      exceptionId: string;
      summary: string;
      proposeDraft?: boolean;
      nextSteps: string[];
    }>;
    expect(flags).toHaveLength(3);
    for (const text of HOLDING) {
      const flag = flags.find((item) => item.summary.includes(text));
      expect(flag, text).toBeTruthy();
      expect(flag!.proposeDraft).toBe(false);
      expect(flag!.nextSteps).toEqual([
        "This one touches on fair housing, so I won't draft an answer. Reply to them yourself.",
        "Mark it handled once you've replied.",
      ]);
      expect(sent.join("\n")).not.toMatch(/fair housing/i);
      expect(flag!.summary).toContain("There's no approved answer yet.");
      const before = a.fake.sent.length;
      await expect(a.grok("answer_flagged_question", { exceptionId: flag!.exceptionId, approvedFact: "Yes, that's fine." })).rejects.toThrow(
        "This one touches on fair housing, so I won't draft an answer. Reply to them yourself, then mark it handled.",
      );
      expect(a.fake.sent).toHaveLength(before);
    }

    const rent = await a.text("How much is rent?");
    const monthly = await a.text("Is rent due monthly?");
    expect(rent.join("\n")).toContain(RENT);
    expect(rent.join("\n")).not.toContain(UNKNOWN_ANSWER);
    expect(monthly.join("\n")).toContain(RENT);
    expect(monthly.join("\n")).not.toContain(UNKNOWN_ANSWER);
    expect((await a.grok("list_exceptions")).exceptions).toHaveLength(3);
    expect(sent).toEqual([HELD, HELD, HELD]);
  });

  it("quotes the exact visitor text in the approve question", async () => {
    const a = await liveApp({ cleanups });
    await a.optInSms();
    await a.text("1");
    await a.text("1");
    expect(await a.text("Is there a dishwasher?")).toEqual([UNKNOWN_ANSWER]);
    const [issue] = (await a.grok("list_exceptions")).exceptions as Array<{ exceptionId: string; proposeDraft?: boolean }>;
    expect(issue).toBeTruthy();
    expect(issue!.proposeDraft).toBeUndefined();
    const asked = await a.grok("answer_flagged_question", { exceptionId: issue!.exceptionId, approvedFact: "Yes, there's a dishwasher." });
    const receive = "Yes, there's a dishwasher. Let me know if you have any other questions.";
    const question = `Send this to ${formatPhone(PHONE)} and save it for anyone who asks the same thing later? "${receive}"`;
    expect(asked.visitorWillReceive).toBe(receive);
    expect(asked.summary).toBe(question);
    expect(asked.confirmation.question).toBe(question);
    const quoted = String(asked.summary).slice(String(asked.summary).indexOf('"') + 1, String(asked.summary).lastIndexOf('"'));
    expect(quoted).toBe(asked.visitorWillReceive);
    expect(Buffer.from(quoted, "utf8").equals(Buffer.from(asked.visitorWillReceive, "utf8"))).toBe(true);
  });

  it("flags service animals, support animals, and a newborn before a saved pets answer", async () => {
    const a = await liveApp({ cleanups });
    await a.optInSms();
    await a.text("1");
    await a.text("1");
    await a.grok("update_property_details", {
      property: "100 Alfred Way",
      facts: ["No pets allowed."],
    });
    expect(a.ws.load("prop_100_alfred_way").config.property.facts).toContain("No pets allowed.");

    const flagged = [
      "Do you allow service animals?",
      "Can I bring my emotional support dog?",
      "Do you allow assistance animals?",
      "Can I bring a support animal?",
      "Do you allow emotional support animals?",
      "Can I bring my emotional support cat?",
      "Do you allow an ESA?",
      "Are you okay with a newborn?",
      "Do you rent to someone who is pregnant?",
      "Is a baby on the way okay?",
      "Are you adults only?",
      "Do you rent to immigrants?",
      "Do you ask about immigration status?",
      "Is there a minimum age?",
      "Do you have age limits?",
      "Do you discriminate?",
      "Can I bring my service dog?",
      "Is a guide dog ok?",
      "My support dog comes with me, ok?",
      "Can I bring my emotional support bird?",
      "Do you allow a seeing-eye dog?",
      "Is this 55+?",
      "Is this 55 and over?",
      "Is this a senior community?",
      "Do you have age restrictions?",
      "Do you accept housing assistance?",
      "Do you take a housing voucher?",
      "Do you accept HUD?",
      "Do you take Section 8?",
      "Are undocumented applicants allowed?",
      "What is your policy on sexual orientation?",
      "Do you ask about gender identity?",
      "Do you rent to gay tenants?",
      "Do you rent to lesbians?",
      "Is this LGBTQ friendly?",
      "Do you rent to a same-sex couple?",
      "Do you rent to transgender people?",
      "What religion are most neighbors?",
    ] as const;
    const sent: string[] = [];
    for (const text of flagged) {
      const replies = await a.text(text);
      sent.push(replies.join("\n"));
      expect(replies[0], text).toBe(HELD);
      expect(replies.join("\n"), text).not.toContain("No pets allowed.");
      expect(replies.join("\n"), text).not.toMatch(/fair housing/i);
    }

    const flags = (await a.grok("list_exceptions")).exceptions as Array<{
      summary: string;
      proposeDraft?: boolean;
    }>;
    expect(flags).toHaveLength(flagged.length);
    for (const text of flagged) {
      const flag = flags.find((item) => item.summary.includes(text));
      expect(flag, text).toBeTruthy();
      expect(flag!.proposeDraft, text).toBe(false);
    }
    expect(sent).toEqual(flagged.map(() => HELD));

    const pets = await a.text("Do you allow pets?");
    const dogs = await a.text("Do you allow dogs?");
    const park = await a.text("Is there a dog park?");
    expect(pets.join("\n")).toBe("Here's what the property team shared: No pets allowed.");
    expect(dogs.join("\n")).toBe("Here's what the property team shared: No pets allowed.");
    expect(park.join("\n")).toBe("Here's what the property team shared: No pets allowed.");
    const rent = await a.text("How much is rent?");
    const monthly = await a.text("Is rent due monthly?");
    expect(rent.join("\n")).toContain(RENT);
    expect(rent.join("\n")).not.toContain(UNKNOWN_ANSWER);
    expect(monthly.join("\n")).toContain(RENT);
    expect(monthly.join("\n")).not.toContain(UNKNOWN_ANSWER);
    const lease = await a.text("Is there a minimum lease?");
    expect(lease[0]).toBe(UNKNOWN_ANSWER);
    expect(lease.join("\n")).not.toMatch(/fair housing/i);

    const after = (await a.grok("list_exceptions")).exceptions as Array<{
      summary: string;
      proposeDraft?: boolean;
    }>;
    expect(after).toHaveLength(flagged.length + 1);
    const leaseFlag = after.find((item) => item.summary.includes("Is there a minimum lease?"));
    expect(leaseFlag).toBeTruthy();
    expect(leaseFlag!.proposeDraft).toBeUndefined();
    for (const text of ["Do you allow pets?", "Do you allow dogs?", "Is there a dog park?", "How much is rent?", "Is rent due monthly?"]) {
      expect(after.some((item) => item.summary.includes(text))).toBe(false);
    }
  });
});

/** One sentence for each new fair-housing trigger. */
const NEW_TRIGGERS = [
  "Is this a Christian building?",
  "Is this a Catholic building?",
  "Is this a Protestant building?",
  "Is this a Jewish building?",
  "Do you rent to a Jew?",
  "Is this a Muslim building?",
  "Is this an Islamic building?",
  "Is this a Hindu building?",
  "Is this a Buddhist building?",
  "Is this a Sikh building?",
  "Is this a Mormon building?",
  "Are atheists allowed?",
  "I have a therapy dog, is that ok?",
  "Can I bring a therapy animal?",
  "Do you need a social security number?",
  "Do you ask for an SSN?",
] as const;

async function saveNoPets(a: LiveApp) {
  await a.grok("update_property_details", {
    property: "100 Alfred Way",
    facts: ["No pets allowed."],
  });
}

async function expectFairHousingHold(a: LiveApp, texts: readonly string[]) {
  for (const text of texts) {
    const replies = await a.text(text);
    expect(replies[0], text).toBe(HELD);
    expect(replies.join("\n"), text).not.toContain("No pets allowed.");
    expect(replies.join("\n"), text).not.toMatch(/fair housing/i);
  }
  const flags = (await a.grok("list_exceptions")).exceptions as Array<{
    exceptionId: string;
    summary: string;
    proposeDraft?: boolean;
  }>;
  for (const text of texts) {
    const flag = flags.find((item) => item.summary.includes(text));
    expect(flag, text).toBeTruthy();
    expect(flag!.proposeDraft, text).toBe(false);
    const before = a.fake.sent.length;
    await expect(a.grok("answer_flagged_question", { exceptionId: flag!.exceptionId, approvedFact: "Yes, that's fine." })).rejects.toThrow(FAIR_HOUSING_REFUSAL);
    expect(a.fake.sent).toHaveLength(before);
  }
}

describe("new fair-housing triggers in every conversation state", () => {
  it("menu: the opening unit menu", async () => {
    const a = await liveApp({ cleanups });
    await a.optInSms();
    await saveNoPets(a);
    await expectFairHousingHold(a, NEW_TRIGGERS);
  });

  it("unit: a unit is chosen and the day menu is showing", async () => {
    const a = await liveApp({ cleanups });
    await a.optInSms();
    await a.text("1");
    await saveNoPets(a);
    await expectFairHousingHold(a, NEW_TRIGGERS);
  });

  it("day: a day is chosen and the time menu is showing", async () => {
    const a = await liveApp({ cleanups });
    await a.optInSms();
    await a.text("1");
    await a.text("1");
    await saveNoPets(a);
    await expectFairHousingHold(a, NEW_TRIGGERS);
  });

  it("booked: the tour is booked", async () => {
    const a = await liveApp({ cleanups });
    await a.book();
    await saveNoPets(a);
    await expectFairHousingHold(a, NEW_TRIGGERS);
  });

  it("custom-pending: a custom time is waiting on the property team", async () => {
    const a = await liveApp({ cleanups });
    await a.optInSms();
    await a.text("1");
    await a.text("1");
    const asked = await a.text("Can I come at 3:20?");
    expect(asked.join("\n")).toContain("property team");
    await saveNoPets(a);
    await expectFairHousingHold(a, NEW_TRIGGERS);
  });
});

describe("dog park is not a parking question", () => {
  it("matches parking, park my car, and where do I park, and not dog park", () => {
    const facts = approvedFacts(hillsideConfig());
    const texts = (q: string) => findApprovedAnswer(facts, q).map((fact) => fact.text);
    expect(texts("Is there a dog park?")).toEqual([]);
    expect(texts("Is there parking?")).toEqual(["Street parking only."]);
    expect(texts("Where do I park?")).toEqual(["Street parking only."]);
    expect(texts("Can I park my car?")).toEqual(["Street parking only."]);
    const both = hillsideConfig();
    both.property.facts = ["Street parking only.", "No pets allowed."];
    expect(findApprovedAnswer(approvedFacts(both), "Is there a dog park?").map((fact) => fact.text)).toEqual(["No pets allowed."]);
  });

  it("does not send the parking answer for a dog park when street parking is saved", async () => {
    const a = await liveApp({ cleanups });
    await a.optInSms();
    await a.text("1");
    await a.text("1");
    const park = await a.text("Is there a dog park?");
    expect(park[0]).toBe(UNKNOWN_ANSWER);
    expect(park.join("\n")).not.toContain("Street parking");
    expect(park.join("\n")).not.toMatch(/fair housing/i);
    const where = await a.text("Where do I park?");
    const mine = await a.text("Can I park my car?");
    const named = await a.text("Is there parking?");
    expect(where.join("\n")).toContain("Here's what the property team shared: Street parking only.");
    expect(mine.join("\n")).toContain("Here's what the property team shared: Street parking only.");
    expect(named.join("\n")).toContain("Here's what the property team shared: Street parking only.");
    const flags = (await a.grok("list_exceptions")).exceptions as Array<{ summary: string; proposeDraft?: boolean }>;
    const dogPark = flags.find((item) => item.summary.includes("Is there a dog park?"));
    expect(dogPark).toBeTruthy();
    expect(dogPark!.proposeDraft).toBeUndefined();
    expect(flags.some((item) => /where do i park|park my car|is there parking/i.test(item.summary))).toBe(false);
  });
});
