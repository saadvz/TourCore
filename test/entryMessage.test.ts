import { afterEach, describe, expect, it } from "vitest";
import { loadConfig, type TourCoreConfig } from "../src/config/tourCoreConfig";
import { DemoMessagingAdapter } from "../src/messaging/Messenger";
import { handleVisitorText } from "../src/visitor/conversation";
import { VisitorDemoSession } from "../src/visitor/session";
import { at } from "./grokHarness";

/**
 * The first text gets one introduction. Property type chooses the wording;
 * the next step is in that same message.
 */

const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).forEach((c) => c()));

function home(): TourCoreConfig {
  const config = loadConfig();
  return {
    ...config,
    property: {
      ...config.property,
      propertyType: "SINGLE_FAMILY",
      address: "144 Hillside Ave, Teaneck, NJ 07666",
      displayName: "Teaneck Home",
      name: "Teaneck Home",
    },
    units: [{ ...config.units[0]!, name: "Main Home" }],
  };
}

async function texts(config: TourCoreConfig, message: string) {
  const sent: string[] = [];
  const session = new VisitorDemoSession(config.property.id, config, "t", {
    realNow: () => at(7),
    kind: "messaging",
    transport: new DemoMessagingAdapter((line) => sent.push(line), "MESSAGING"),
  });
  await handleVisitorText(session, "+15550102000", message);
  return session.conversation.filter((item) => item.from === "tourcore").map((item) => item.text);
}

describe("the opening text", () => {
  it("a single-family home gets one message naming the home, the address, and a tour time", async () => {
    const replies = await texts(home(), "Hi");
    expect(replies).toHaveLength(1);
    expect(replies[0]).toContain("Hi! Welcome to the self-guided tour for Teaneck Home at 144 Hillside Ave, Teaneck, NJ 07666.");
    expect(replies[0]).toContain("questions about the home");
    expect(replies[0]).toContain("Which day works for you?");
    expect(replies[0]).not.toContain("Which unit");
    expect(replies[0]).not.toContain("Main Home");
    expect(replies[0]).not.toContain("Happy to set up");
  });

  it("an apartment gets one message with the address and the unit choice", async () => {
    const replies = await texts(loadConfig(), "Hi");
    expect(replies).toHaveLength(1);
    expect(replies[0]).toBe(
      "Hi! Welcome to the self-guided tours at 100 Alfred Way. I can answer questions about the property and help you book a tour.\n\nWhich unit would you like to see?\nReply 1 for Unit 101 or 2 for Unit 102.",
    );
  });

  it("a question in the first text is answered, and the welcome is not sent twice", async () => {
    const config = loadConfig();
    config.property.facts = ["Street parking only."];
    const replies = await texts(config, "Is there parking?");
    expect(replies.filter((reply) => reply.includes("Welcome"))).toHaveLength(1);
    expect(replies[0]).toContain("Street parking only.");
    expect(replies.at(-1)).toContain("Which unit would you like to see?");
    expect(replies.at(-1)).toContain("Reply 1 for Unit 101");
  });
});
