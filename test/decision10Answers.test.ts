import { afterEach, describe, expect, it } from "vitest";
import { formatPhone } from "../src/core/phone";
import { UNKNOWN_ANSWER } from "../src/core/TourCore";
import { liveApp, PHONE } from "./liveApp";

/**
 * Decision 10 checks against today's engine. A fair-housing question is flagged
 * with no draft. An ordinary unanswered question still offers a draft.
 */

const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).forEach((c) => c()));
const app = () => liveApp({ cleanups });
const OTHER = "+15550102001";
const COMPOSED = "There's a gym on the roof. Let me know if you have any other questions.";

describe("decision 10 flagged answers", () => {
  it("sends nothing until yes, then the composed reply rather than the bare fact", async () => {
    const a = await app();
    await a.optInSms();
    await a.text("1");
    await a.text("1");
    expect(await a.text("Is there a gym?")).toEqual([UNKNOWN_ANSWER]);
    const [issue] = (await a.grok("list_exceptions")).exceptions;
    const before = a.fake.sent.length;
    const asked = await a.grok("answer_flagged_question", { exceptionId: issue.exceptionId, approvedFact: "There's a gym on the roof." });
    expect(asked.status).toBe("needs-confirmation");
    expect(asked.visitorWillReceive).toBe(COMPOSED);
    expect(asked.summary).toBe(`Send this to ${formatPhone(PHONE)} and save it for anyone who asks the same thing later? "${COMPOSED}"`);
    expect(String(asked.summary).slice(String(asked.summary).indexOf('"') + 1, String(asked.summary).lastIndexOf('"'))).toBe(asked.visitorWillReceive);
    expect(a.fake.sent).toHaveLength(before);
    const done = await a.grok("answer_flagged_question", { exceptionId: issue.exceptionId, approvedFact: "There's a gym on the roof.", confirmationCode: asked.confirmation.code });
    expect(done.visitorAnswered).toBe(true);
    const sent = a.fake.sent.slice(before).map((item) => item.content);
    expect(sent).toEqual([asked.visitorWillReceive]);
    expect(done.visitorMessage).toBe(asked.visitorWillReceive);
    expect(Buffer.from(asked.visitorWillReceive, "utf8").equals(Buffer.from(sent[0]!, "utf8"))).toBe(true);
  });

  it("reuses the saved fact for a second visitor and does not open another flag", async () => {
    const a = await app();
    await a.optInSms();
    await a.text("1");
    await a.text("1");
    await a.text("Is there a gym?");
    const [issue] = (await a.grok("list_exceptions")).exceptions;
    await a.approve("answer_flagged_question", { exceptionId: issue.exceptionId, approvedFact: "There's a gym on the roof." });
    await a.textFrom(OTHER, "TOUR");
    await a.textFrom(OTHER, "YES");
    const replies = await a.textFrom(OTHER, "Is there a gym?");
    expect(replies[0]).toBe("Here's what the property team shared: There's a gym on the roof.");
    const open = (await a.grok("list_exceptions")).exceptions as Array<{ summary: string }>;
    expect(open.filter((item) => /gym/i.test(item.summary))).toEqual([]);
  });

  it("sends nothing when the landlord has not said yes, including after an edit", async () => {
    const a = await app();
    await a.optInSms();
    await a.text("1");
    await a.text("1");
    await a.text("Is there a gym?");
    const [issue] = (await a.grok("list_exceptions")).exceptions;
    const before = a.fake.sent.length;
    const asked = await a.grok("answer_flagged_question", { exceptionId: issue.exceptionId, approvedFact: "There's a gym on the roof." });
    expect(asked.status).toBe("needs-confirmation");
    expect(a.fake.sent).toHaveLength(before);
    await expect(a.grok("answer_flagged_question", { exceptionId: issue.exceptionId, approvedFact: "There's a pool.", confirmationCode: asked.confirmation.code })).rejects.toThrow(/Something changed/);
    expect(a.fake.sent).toHaveLength(before);
    const edited = await a.grok("answer_flagged_question", { exceptionId: issue.exceptionId, approvedFact: "There's a pool." });
    expect(edited.status).toBe("needs-confirmation");
    expect(a.fake.sent).toHaveLength(before);
    const still = (await a.grok("list_exceptions")).exceptions as Array<{ summary: string }>;
    expect(still.some((item) => /gym/i.test(item.summary))).toBe(true);
  });

  it("gives an unanswered question the same holding reply and an open flag, with no draft", async () => {
    const a = await app();
    await a.optInSms();
    await a.text("1");
    await a.text("1");
    const fairReplies = await a.text("Are families with children allowed to live here?");
    const other = await a.text("Is there a gym?");
    expect(fairReplies).toEqual(["Good question for the property team. I've passed it along, and they'll text you back here."]);
    expect(other).toEqual([UNKNOWN_ANSWER]);
    expect(fairReplies.join("\n")).not.toContain("I'll check with the property team and get back to you");
    const issues = (await a.grok("list_exceptions")).exceptions as Array<{ exceptionId: string; summary: string; proposeDraft?: boolean }>;
    expect(issues.map((item) => item.summary).sort()).toEqual([
      'They asked: "Are families with children allowed to live here?" This is a fair-housing question, so there\'s no draft. Only you can answer this one. They were told you\'d text them back here.',
      'They asked: "Is there a gym?" There\'s no approved answer yet.',
    ]);
    const fair = issues.find((item) => item.summary.includes("families"))!;
    const gym = issues.find((item) => item.summary.includes("gym"))!;
    expect(fair.proposeDraft).toBe(false);
    expect(gym.proposeDraft).toBeUndefined();
    await expect(a.grok("answer_flagged_question", { exceptionId: fair.exceptionId, approvedFact: "Yes." })).rejects.toThrow(
      "This one touches on fair housing, so I won't draft an answer. Reply to them yourself, then mark it handled.",
    );
    const asked = await a.grok("answer_flagged_question", { exceptionId: gym.exceptionId, approvedFact: "There's a gym on the roof." });
    expect(asked.status).toBe("needs-confirmation");
    expect(asked.visitorWillReceive).toBe(COMPOSED);
  });

  it("send-only preview equals the text that is sent, byte for byte", async () => {
    const a = await app();
    await a.book();
    const session = a.visitors.latestForPhone("prop_100_alfred_way", PHONE, "messaging")!;
    session.bookOffered = async () => {
      throw new Error("No reservation res_preview");
    };
    await a.text("Can I move it to 3:30?");
    const issue = (await a.grok("list_exceptions")).exceptions.find((item: { what: string }) => item.what === "Couldn't handle their text");
    const fact = "The lobby door is on the left.";
    const before = a.fake.sent.length;
    const asked = await a.grok("answer_flagged_question", { exceptionId: issue.exceptionId, approvedFact: fact });
    expect(asked.status).toBe("needs-confirmation");
    expect(asked.visitorWillReceive).toBe(fact);
    expect(a.fake.sent).toHaveLength(before);
    const done = await a.grok("answer_flagged_question", { exceptionId: issue.exceptionId, approvedFact: fact, confirmationCode: asked.confirmation.code });
    const sent = a.fake.sent.slice(before).map((item) => item.content);
    expect(sent).toEqual([asked.visitorWillReceive]);
    expect(done.visitorMessage).toBe(asked.visitorWillReceive);
    expect(Buffer.from(asked.visitorWillReceive, "utf8").equals(Buffer.from(sent[0]!, "utf8"))).toBe(true);
  });
});
