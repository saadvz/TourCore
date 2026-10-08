import { afterEach, describe, expect, it } from "vitest";
import { formatPhone } from "../src/core/phone";
import { UNKNOWN_ANSWER } from "../src/core/TourCore";
import { isFairHousingQuestion } from "../src/core/fairHousing";
import { liveApp, PHONE } from "./liveApp";

/**
 * Fair-housing questions are caught before rent, keywords, and saved answers.
 * The visitor still gets the ordinary holding reply. No draft is proposed.
 */

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
  ])("matches %s", (text) => {
    expect(isFairHousingQuestion(text)).toBe(true);
  });

  it.each(["How much is rent?", "Is rent due monthly?", "What color are the walls?", "Do you allow pets?", "Can I take a tour?"])("does not match %s", (text) => {
    expect(isFairHousingQuestion(text)).toBe(false);
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
      expect(replies[0]).toBe(UNKNOWN_ANSWER);
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
      expect(flag!.nextSteps).toEqual(["Leave this with the property team. Don't draft an answer.", "Mark it handled once they've replied."]);
      expect(flag!.summary).toContain("There's no approved answer yet.");
      const before = a.fake.sent.length;
      await expect(a.grok("answer_flagged_question", { exceptionId: flag!.exceptionId, approvedFact: "Yes, that's fine." })).rejects.toThrow(
        "Leave this with the property team. Don't draft an answer.",
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
    expect(sent).toEqual([UNKNOWN_ANSWER, UNKNOWN_ANSWER, UNKNOWN_ANSWER]);
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
    const question = `Send this to ${formatPhone(PHONE)}? "${receive}"`;
    expect(asked.visitorWillReceive).toBe(receive);
    expect(asked.summary).toBe(question);
    expect(asked.confirmation.question).toBe(question);
    const quoted = String(asked.summary).slice(String(asked.summary).indexOf('"') + 1, String(asked.summary).lastIndexOf('"'));
    expect(quoted).toBe(asked.visitorWillReceive);
    expect(Buffer.from(quoted, "utf8").equals(Buffer.from(asked.visitorWillReceive, "utf8"))).toBe(true);
  });
});
