import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { TourCoreConfig } from "../src/config/tourCoreConfig";
import {
  TOUR_AGAIN_SUFFIX,
  TOUR_ENDED_REPLY,
  UNKNOWN_ANSWER,
  UNKNOWN_ANSWER_ENDED,
  UNKNOWN_ANSWER_ENDED_WITH_PHOTO,
  UNKNOWN_ANSWER_WITH_PHOTO,
  unknownAnswerReply,
  withAnswerSuffix,
} from "../src/core/TourCore";
import { Installation } from "../src/install/installation";
import { bindMessagingInstallation } from "../src/messaging/registry";
import { sendblueRuntime } from "../src/messaging/sendblue/runtime";
import { resetLocalSmsOutbox } from "../src/messaging/local/outbox";
import { PropertyWorkspace, runReadinessCheck } from "../src/setup";
import { FileRuntimeStore } from "../src/storage/runtimeStore";
import { PHOTO_ALONE_REPLY, PHOTO_WITH_TEXT_REPLY } from "../src/visitor/conversation";
import { createSetupServer } from "../src/web/server";
import { PUBLIC } from "./fakeSendblue";
import { at, hillsideConfig, liveApp, PHONE } from "./liveApp";

const PHOTO = { media_url: "https://cdn.example.invalid/photo.jpg" };
const LOCAL_VISITOR = "+15555550100";
const TOKEN = "test-operator-token-abcdef";
const cleanups: Array<() => void> = [];
afterEach(() => {
  cleanups.splice(0).forEach((c) => c());
  resetLocalSmsOutbox();
});

type Provider = "sendblue" | "local";

interface QuestionApp {
  text: (body: string, options?: { id?: string; photo?: boolean }) => Promise<string[]>;
  optIn: () => Promise<void>;
  book: () => Promise<void>;
  finishTour: () => Promise<void>;
  cancelTour: () => Promise<void>;
  beginCancel: () => Promise<string[]>;
  exceptions: () => Promise<Array<{ summary: string; unitName?: string }>>;
  operatorAlerts: () => string[];
}

async function sendblueApp(config?: TourCoreConfig): Promise<QuestionApp> {
  const a = await liveApp({ cleanups, ...(config ? { config } : {}) });
  return {
    text: (body, options) => a.text(body, options?.id, options?.photo ? PHOTO : undefined),
    optIn: async () => {
      await a.optInSms();
    },
    book: async () => {
      await a.book();
    },
    finishTour: async () => {
      a.clock.t = at(13, 58);
      await a.text("I'm here");
      await a.text("at unit 1A");
      await a.text("done");
      await a.text("no");
    },
    cancelTour: async () => {
      await a.text("please cancel my tour");
      await a.text("YES");
    },
    beginCancel: () => a.text("please cancel my tour"),
    exceptions: async () => (await a.grok("list_exceptions")).exceptions,
    operatorAlerts: () => a.fake.sent.filter((s) => s.number !== PHONE).map((s) => s.content),
  };
}

async function localApp(config?: TourCoreConfig): Promise<QuestionApp> {
  const root = mkdtempSync(join(tmpdir(), "tourcore-unknown-q-"));
  cleanups.push(resetLocalSmsOutbox());
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  let clock = at(7);
  const ws = new PropertyWorkspace(root);
  const { config: saved } = ws.save(config ?? hillsideConfig());
  ws.recordReadiness(saved.property.id, await runReadinessCheck(saved, { now: new Date(clock) }));
  const runtime = new FileRuntimeStore(join(root, "runtime"));
  const env: NodeJS.ProcessEnv = {
    TOURCORE_MESSAGING_PROVIDER: "local",
    PUBLIC_BASE_URL: PUBLIC,
    TOURCORE_SMS_CONSENT_MODE: "keyword_confirm",
  };
  cleanups.push(
    bindMessagingInstallation(() => ({
      env,
      sendblue: sendblueRuntime.env(),
      choice: "local",
      manifestProvider: "LOCAL",
    })),
  );
  const installation = new Installation({ root, runtime, env: () => env, now: () => clock });
  installation.files.ensure({ deploymentMode: "LOCAL_DEVELOPER" });
  installation.files.setPublicBaseUrl(PUBLIC, "MANUAL");
  installation.files.writeState({
    ...installation.files.state(),
    messagingProviderChoice: "local",
    visitorMessaging: { ok: true, at: new Date(clock).toISOString(), message: "ok", problems: [], publicBaseUrl: PUBLIC, provider: "local" },
  });
  installation.files.update({ messagingProvider: "LOCAL" });
  const server = createSetupServer({ workspace: ws, installation, now: () => new Date(clock), realNow: () => clock, operatorToken: () => TOKEN, log: () => {} });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  cleanups.push(() => server.close());
  const port = (server.address() as { port: number }).port;
  let rpc = 0;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const grok = async (name: string, args: Record<string, unknown> = {}): Promise<any> => {
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++rpc, method: "tools/call", params: { name, arguments: args } }),
    });
    const body = (await res.json()) as { result: { isError: boolean; structuredContent: unknown; content: Array<{ text: string }> } };
    if (body.result.isError) throw new Error(body.result.content[0]!.text);
    return body.result.structuredContent;
  };
  await grok("run_readiness_check", { property: saved.property.id });
  let n = 0;
  const text = async (body: string, options?: { id?: string; photo?: boolean }) => {
    const out = await grok("inject_local_sms", {
      from: LOCAL_VISITOR,
      text: body,
      property: saved.property.id,
      id: options?.id ?? `local_${++n}`,
      ...(options?.photo ? { hasMedia: true } : {}),
    });
    if (out.duplicate) return [];
    return (out.bubbles as Array<{ body: string }>).map((b) => b.body);
  };
  const fillForm = async (replies: string[]) => {
    const token = /\/verify\/([A-Za-z0-9_-]+)/.exec(replies.join("\n"))?.[1];
    if (!token) throw new Error(`no verify link in ${replies.join(" | ")}`);
    const form = await fetch(`http://127.0.0.1:${port}/api/verify/${token}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ firstName: "Pat", lastName: "Smith", email: "pat@example.com", phone: LOCAL_VISITOR }),
    });
    expect(((await form.json()) as { ok: boolean }).ok).toBe(true);
  };
  return {
    text,
    optIn: async () => {
      await text("TOUR");
      await text("YES");
    },
    book: async () => {
      await text("TOUR");
      await text("YES");
      await text("1");
      await text("1");
      await text("1");
      await fillForm(await text("YES"));
    },
    finishTour: async () => {
      clock = at(13, 58);
      await text("I'm here");
      await text("at unit 1A");
      await text("done");
      await text("no");
    },
    cancelTour: async () => {
      await text("please cancel my tour");
      await text("YES");
    },
    beginCancel: () => text("please cancel my tour"),
    exceptions: async () => (await grok("list_exceptions")).exceptions,
    operatorAlerts: () => [],
  };
}

async function appFor(provider: Provider, config?: TourCoreConfig): Promise<QuestionApp> {
  return provider === "sendblue" ? sendblueApp(config) : localApp(config);
}

const PARKING = "Here's what the property team shared: Street parking only.";
const photoMentions = (replies: string[]) => (replies.join("\n").match(/can't take photos/gi) ?? []).length;

describe("unknownAnswerReply", () => {
  it("picks the locked visitor line for each case", () => {
    expect(unknownAnswerReply()).toBe(UNKNOWN_ANSWER);
    expect(unknownAnswerReply({ hasMedia: true })).toBe(UNKNOWN_ANSWER_WITH_PHOTO);
    expect(unknownAnswerReply({ ended: true })).toBe(UNKNOWN_ANSWER_ENDED);
    expect(unknownAnswerReply({ hasMedia: true, ended: true })).toBe(UNKNOWN_ANSWER_ENDED_WITH_PHOTO);
  });
});

describe("withAnswerSuffix", () => {
  it("adds a period when the approved answer has no terminal punctuation", () => {
    expect(withAnswerSuffix("Here's what the property team shared: In-unit laundry", TOUR_AGAIN_SUFFIX)).toBe(
      "Here's what the property team shared: In-unit laundry. If you'd like to tour again, just text HI.",
    );
  });

  it("leaves answers that already end in . ! or ? alone", () => {
    expect(withAnswerSuffix("Street parking only.", TOUR_AGAIN_SUFFIX)).toBe(`Street parking only.${TOUR_AGAIN_SUFFIX}`);
    expect(withAnswerSuffix("Come see it!", TOUR_AGAIN_SUFFIX)).toBe(`Come see it!${TOUR_AGAIN_SUFFIX}`);
    expect(withAnswerSuffix("Which one?", TOUR_AGAIN_SUFFIX)).toBe(`Which one?${TOUR_AGAIN_SUFFIX}`);
  });

  it("does not add the HI line twice", () => {
    expect(withAnswerSuffix(`In-unit laundry.${TOUR_AGAIN_SUFFIX}`, TOUR_AGAIN_SUFFIX)).toBe(`In-unit laundry.${TOUR_AGAIN_SUFFIX}`);
  });
});

describe.each(["sendblue", "local"] as const)("unanswered visitor questions (%s)", (provider) => {
  it("an unanswerable question with no photo is one text and is flagged", async () => {
    const a = await appFor(provider);
    await a.optIn();
    const replies = await a.text("Is there a gym?");
    expect(replies[0]).toBe(UNKNOWN_ANSWER);
    expect(replies.join("\n")).not.toMatch(/I don't have that information|flagged it for the property team|MMS/i);
    expect((await a.exceptions()).map((x) => x.summary)).toEqual(['Asked "Is there a gym?". There\'s no approved answer yet.']);
  });

  it("a photo plus an unanswerable question is one combined text, not the short photo line", async () => {
    const a = await appFor(provider);
    await a.optIn();
    const replies = await a.text("Is there a gym?", { photo: true });
    expect(replies[0]).toBe(UNKNOWN_ANSWER_WITH_PHOTO);
    expect(replies.filter((r) => r === PHOTO_WITH_TEXT_REPLY)).toHaveLength(0);
    expect(replies.join("\n")).not.toMatch(/I don't have that information|Text your question|MMS/i);
    expect((await a.exceptions()).map((x) => x.summary)).toEqual(['Asked "Is there a gym?". There\'s no approved answer yet.']);
  });

  it("a photo plus an approved-fact question keeps the short photo line and the answer", async () => {
    const a = await appFor(provider);
    await a.optIn();
    const replies = await a.text("Is there parking?", { photo: true });
    expect(replies[0]).toBe(PHOTO_WITH_TEXT_REPLY);
    expect(replies).toContain("Here's what the property team shared: Street parking only.");
    expect(replies.join("\n")).not.toContain(UNKNOWN_ANSWER_WITH_PHOTO);
    expect(await a.exceptions()).toEqual([]);
  });

  it("a photo plus a booking reply keeps the short photo line and books", async () => {
    const a = await appFor(provider);
    await a.optIn();
    const replies = await a.text("1", { photo: true });
    expect(replies[0]).toBe(PHOTO_WITH_TEXT_REPLY);
    expect(replies.filter((r) => r === PHOTO_WITH_TEXT_REPLY)).toHaveLength(1);
    expect(replies.join("\n")).toMatch(/Happy to set up a self-guided tour of Unit 1A|Which day works for you/i);
    expect(await a.exceptions()).toEqual([]);
  });

  it("a photo alone keeps the longer honesty reply and does not flag", async () => {
    const a = await appFor(provider);
    await a.optIn();
    expect(await a.text("", { photo: true })).toEqual([PHOTO_ALONE_REPLY]);
    expect(await a.exceptions()).toEqual([]);
  });

  it("an ended-tour question is flagged and gets the ended line; a non-question is not flagged", async () => {
    const a = await appFor(provider);
    await a.book();
    await a.finishTour();
    expect(await a.text("Is there a gym?")).toEqual([UNKNOWN_ANSWER_ENDED]);
    expect((await a.exceptions()).map((x) => x.summary)).toEqual(['Asked "Is there a gym?". There\'s no approved answer yet.']);
    expect(await a.text("ok")).toEqual([TOUR_ENDED_REPLY]);
    expect((await a.exceptions()).map((x) => x.summary)).toEqual(['Asked "Is there a gym?". There\'s no approved answer yet.']);
  });

  it("an ended-tour photo plus a non-question keeps the ended reply and does not flag", async () => {
    const a = await appFor(provider);
    await a.book();
    await a.finishTour();
    const replies = await a.text("ok", { photo: true });
    expect(replies[0]).toBe(PHOTO_WITH_TEXT_REPLY);
    expect(replies).toContain(TOUR_ENDED_REPLY);
    expect(replies.join("\n")).not.toContain(UNKNOWN_ANSWER_ENDED_WITH_PHOTO);
    expect(await a.exceptions()).toEqual([]);
  });

  it("an ended-tour approved-fact question is answered with the HI line and is not flagged", async () => {
    const a = await appFor(provider);
    await a.book();
    await a.finishTour();
    expect(await a.text("Is there parking?")).toEqual([`${PARKING}${TOUR_AGAIN_SUFFIX}`]);
    expect(await a.exceptions()).toEqual([]);
    expect(a.operatorAlerts().join("\n")).not.toMatch(/no approved answer/i);
  });

  it("an ended-tour photo plus an approved-fact question keeps the short photo line, then the answer with HI, and is not flagged", async () => {
    const a = await appFor(provider);
    await a.book();
    await a.cancelTour();
    const replies = await a.text("Is there parking?", { photo: true });
    expect(replies[0]).toBe(PHOTO_WITH_TEXT_REPLY);
    expect(replies).toContain(`${PARKING}${TOUR_AGAIN_SUFFIX}`);
    expect(photoMentions(replies)).toBe(1);
    expect(replies.join("\n")).not.toContain(UNKNOWN_ANSWER_ENDED_WITH_PHOTO);
    expect(await a.exceptions()).toEqual([]);
    expect(a.operatorAlerts().join("\n")).not.toMatch(/no approved answer/i);
  });

  it("a photo plus a question while cancel confirmation is pending mentions photos only once", async () => {
    const a = await appFor(provider);
    await a.book();
    await a.beginCancel();
    const replies = await a.text("Is there a gym?", { photo: true });
    expect(photoMentions(replies)).toBe(1);
    expect(replies.filter((r) => r === PHOTO_WITH_TEXT_REPLY).length + replies.filter((r) => r === UNKNOWN_ANSWER_WITH_PHOTO).length).toBe(1);
    expect(replies.join("\n")).not.toMatch(/MMS/i);
  });

  it("an ended-tour multi-unit question asks which unit without HI, then the pick gets HI once", async () => {
    const a = await appFor(provider);
    await a.book();
    await a.finishTour();
    const which = await a.text("How much is 1A or 2B?");
    expect(which).toEqual(["Which unit do you mean: Unit 1A or Unit 2B?\nReply 1 for Unit 1A or 2 for Unit 2B."]);
    expect(which.join("\n")).not.toContain("If you'd like to tour again");
    expect(await a.text("2")).toEqual([`Unit 2B rents for $1,950 a month.${TOUR_AGAIN_SUFFIX}`]);
    expect(await a.exceptions()).toEqual([]);
    const again = await a.text("Is there a gym in 1A or 2B?");
    expect(again).toEqual(["Which unit do you mean: Unit 1A or Unit 2B?\nReply 1 for Unit 1A or 2 for Unit 2B."]);
    expect(again.join("\n")).not.toContain("If you'd like to tour again");
    const flagged = await a.text("1");
    expect(flagged).toEqual([UNKNOWN_ANSWER_ENDED]);
    expect(flagged.join("\n").match(/If you'd like to tour again/g)).toEqual(["If you'd like to tour again"]);
    expect((await a.exceptions()).map((x) => x.summary)).toEqual(['Asked "Is there a gym in 1A or 2B?". There\'s no approved answer yet.']);
  });

  it("adds a period before the HI line when an approved answer has no terminal punctuation", async () => {
    const config = hillsideConfig();
    config.property.facts = ["Street parking only.", "Pets are welcome"];
    const a = await appFor(provider, config);
    await a.book();
    await a.finishTour();
    expect(await a.text("Are pets welcome?")).toEqual([
      "Here's what the property team shared: Pets are welcome. If you'd like to tour again, just text HI.",
    ]);
    expect(await a.exceptions()).toEqual([]);
  });

  it("an ended-tour photo question is one combined text and is flagged", async () => {
    const a = await appFor(provider);
    await a.book();
    await a.cancelTour();
    const replies = await a.text("Is there a pool?", { photo: true });
    expect(replies).toEqual([UNKNOWN_ANSWER_ENDED_WITH_PHOTO]);
    expect(replies.filter((r) => r === PHOTO_WITH_TEXT_REPLY)).toHaveLength(0);
    expect((await a.exceptions()).map((x) => x.summary)).toEqual(['Asked "Is there a pool?". There\'s no approved answer yet.']);
  });

  it("a retried inbound is not answered or flagged twice", async () => {
    const a = await appFor(provider);
    await a.optIn();
    const first = await a.text("Is there a gym?", { id: "same-unknown-q" });
    expect(first[0]).toBe(UNKNOWN_ANSWER);
    expect(await a.text("Is there a gym?", { id: "same-unknown-q" })).toEqual([]);
    expect((await a.exceptions()).map((x) => x.summary)).toEqual(['Asked "Is there a gym?". There\'s no approved answer yet.']);
  });

  it("STOP'd visitors get no texts but the flag still reaches the landlord", async () => {
    const a = await appFor(provider);
    await a.optIn();
    await a.text("STOP");
    const replies = await a.text("Is there a gym?");
    expect(replies.join("\n")).not.toContain(UNKNOWN_ANSWER);
    expect(replies.join("\n")).not.toMatch(/property team|MMS/i);
    expect((await a.exceptions()).map((x) => x.summary)).toEqual(['Asked "Is there a gym?". There\'s no approved answer yet.']);
  });
});

describe("landlord alert wording", () => {
  it("names the unit visitors hear, never Main Home", async () => {
    const a = await liveApp({ cleanups });
    await a.optInSms();
    await a.text("How big is 2B?");
    const [issue] = await (await a.grok("list_exceptions")).exceptions;
    expect(issue.unitName).toBe("Unit 2B");
    expect(JSON.stringify(issue)).not.toContain("Main Home");
    expect(a.fake.sent.filter((s) => s.number !== PHONE).map((s) => s.content).join("\n")).not.toContain("Main Home");
  });
});
