import { afterEach, describe, expect, it } from "vitest";
import { UNKNOWN_ANSWER } from "../src/core/TourCore";
import { liveApp, type LiveApp } from "./liveApp";

/**
 * While the day menu is open, a question that only mentions a weekday is a
 * question. It uses the same pass-along as any other off-menu question at
 * that step. A real day pick still opens that day's times.
 */

const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).forEach((c) => c()));

const FRIDAY_TIMES = "I have these times available Friday, Oct 2:\nReply 1 for 2:00 PM or 2 for 3:30 PM.";
const PARKING = "Here's what the property team shared: Street parking only.";

async function openDayMenu(a: LiveApp, phone: string): Promise<string[]> {
  await a.textFrom(phone, "TOUR");
  await a.textFrom(phone, "YES");
  return a.textFrom(phone, "1");
}

describe("a weekday inside a question at the open day menu", () => {
  it("passes Black Friday sale nearby? to the team instead of opening Friday", async () => {
    const a = await liveApp({ cleanups });
    const phone = "+15550103001";
    const opened = await openDayMenu(a, phone);
    expect(opened.join("\n")).toContain("Which day works for you?");
    expect(opened.join("\n")).toContain("5) Friday, Oct 2");

    const replies = await a.textFrom(phone, "Black Friday sale nearby?");

    expect(replies).toEqual([UNKNOWN_ANSWER]);
    expect(replies.join("\n")).not.toContain("I have these times available");
    const issues = (await a.grok("list_exceptions")).exceptions as Array<{ exceptionId: string; summary: string }>;
    const flagged = issues.find((issue) => issue.summary === 'Asked "Black Friday sale nearby?". There\'s no approved answer yet.');
    expect(flagged).toBeTruthy();
    const woken = a.routineEvents().filter((event) => event.eventType === "exception.created");
    expect(woken.map((event) => event.exceptionId)).toContain(flagged!.exceptionId);

    const stillOnDays = await a.textFrom(phone, "1");
    expect(stillOnDays.join("\n")).toContain("I have these times available Monday, Sep 28:");
    expect(stillOnDays.join("\n")).not.toContain("you're booked");
  });

  it("treats is Friday busy? and is Friday parking free? as questions", async () => {
    const a = await liveApp({ cleanups });
    const phone = "+15550103002";
    await openDayMenu(a, phone);

    const busy = await a.textFrom(phone, "is Friday busy?");
    expect(busy).toEqual([UNKNOWN_ANSWER]);
    expect(busy.join("\n")).not.toContain("I have these times available");

    const parking = await a.textFrom(phone, "is Friday parking free?");
    expect(parking).toEqual([PARKING]);
    expect(parking.join("\n")).not.toContain("I have these times available");

    const issues = (await a.grok("list_exceptions")).exceptions as Array<{ exceptionId: string; summary: string }>;
    const summaries = issues.map((issue) => issue.summary);
    expect(summaries).toEqual(['Asked "is Friday busy?". There\'s no approved answer yet.']);
    const woken = a.routineEvents().filter((event) => event.eventType === "exception.created");
    expect(woken.map((event) => event.exceptionId)).toContain(issues[0]!.exceptionId);
  });

  it("answers a day-word parking question with the same texts as the question without the day", async () => {
    const a = await liveApp({ cleanups });
    const withDayPhone = "+15550103003";
    const plainPhone = "+15550103004";
    await openDayMenu(a, withDayPhone);
    await openDayMenu(a, plainPhone);

    const withDay = await a.textFrom(withDayPhone, "what about Sunday parking?");
    const plain = await a.textFrom(plainPhone, "where do I park?");

    expect(withDay).toEqual(plain);
    expect(withDay).toEqual([PARKING]);
    expect((await a.grok("list_exceptions")).exceptions).toEqual([]);
  });

  it("still opens the named day's times for a real pick", async () => {
    const a = await liveApp({ cleanups });
    const picks = [
      "Friday",
      "friday please",
      "fri",
      "Fri?",
      "how about Friday?",
      "can I do Friday",
      "Friday works",
      "5",
      "Oct 2",
      "10/2",
      "Friday at 2",
      "Friday 2pm",
      "Fri 3:30",
      "Friday afternoon",
      "Friday Oct 2",
      "Friday the 2nd",
      "Friday!",
      "Friday is good",
      "Friday works for me",
      "this Friday",
      "yes Friday",
    ];
    for (const [i, text] of picks.entries()) {
      const phone = `+155501031${String(i).padStart(2, "0")}`;
      await openDayMenu(a, phone);
      const replies = await a.textFrom(phone, text);
      expect(replies.join("\n"), text).toBe(FRIDAY_TIMES);
    }
    expect((await a.grok("list_exceptions")).exceptions).toEqual([]);
  });
});
