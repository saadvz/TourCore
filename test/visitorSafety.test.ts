import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { OutgoingMessage } from "../src/messaging/Messenger";
import type { InboundMessage } from "../src/messaging/inbound";
import { MessagingEndpoints } from "../src/messaging/endpoints";
import { isFairHousingQuestion } from "../src/core/fairHousing";
import { resolveQuestion } from "../src/core/questions";
import { UNKNOWN_ANSWER } from "../src/core/TourCore";
import { toursUnavailableText } from "../src/sms/templates";
import { createPropertySetup } from "../src/setup/setupActions";
import { PropertyWorkspace } from "../src/setup/workspace";
import { MemoryRuntimeStore } from "../src/storage/runtimeStore";
import { MessagingConversations } from "../src/visitor/messagingRouter";
import { VerificationLinks } from "../src/visitor/verificationLinks";
import { VisitorDemoRegistry } from "../src/visitor/session";
import { smsDisclosure, smsHelpBody, smsStopAck } from "../src/visitor/smsConsent";
import { MATRIX_CLIENTS } from "../src/eval/clientMatrix";
import { FAIR_HOUSING_REFUSAL } from "../src/operator/exceptions";
import { hillsideConfig, liveApp } from "./liveApp";

/**
 * Visitor-safety fixes. Each case is wrong on 73dcf35:
 * a draft with no saved config drops STOP, suitability questions are not
 * fair-housing holds, a fact keyword answers a paint question, and START on
 * a line of drafts shows the property picker.
 */

const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).forEach((fn) => fn()));

const LINE = "+15555550100";
const PUBLIC = "https://tour.example";
const STOP = smsStopAck();
const HELP = smsHelpBody();
const START = smsDisclosure(PUBLIC);
const HELD = "Good question for the property team. I've passed it along, and they'll text you back here.";
const PASS_ALONG = UNKNOWN_ANSWER;
const FAIR_LINE =
  "This is a fair-housing question, so there's no draft. Only you can answer this one. They were told you'd text them back here.";

const SUITABILITY = [
  "Is it good for families?",
  "Is it suitable for kids?",
  "Is it right for seniors?",
  "Is it OK for children?",
  "Is it safe for elderly?",
  "Is the area good for families?",
  "Is the area for families?",
  "Is the building a fit for seniors?",
  "Is the building for seniors?",
  "Is it safe for a wheelchair?",
] as const;

function consent(root: string, propertyId: string, phone: string) {
  const file = join(root, "properties", propertyId, "sms-campaign-consent.json");
  if (!existsSync(file)) return undefined;
  return JSON.parse(readFileSync(file, "utf8")).senders[phone];
}

function optedOut(root: string, propertyId: string, phone: string): string | undefined {
  const file = join(root, "properties", propertyId, "messaging-opt-outs.json");
  if (!existsSync(file)) return undefined;
  return JSON.parse(readFileSync(file, "utf8"))[phone];
}

function uncheckedDraft(ws: PropertyWorkspace, address: string) {
  const draft = createPropertySetup({
    address,
    propertyType: "SINGLE_FAMILY",
    existingPropertyIds: ws.propertyIds(),
  });
  ws.saveDraft(draft);
  expect(ws.has(draft.property.id)).toBe(false);
  expect(ws.loadDraft(draft.property.id)?.property.name).toBeTruthy();
  return draft.property.id;
}

function savedUnchecked(ws: PropertyWorkspace, id: string, address: string, name: string) {
  const base = hillsideConfig();
  const saved = ws.save({
    ...base,
    property: { ...base.property, id, address, name, displayName: name },
  });
  expect(saved.state.status).toBe("DRAFT");
  expect(saved.state.readiness?.passed).not.toBe(true);
  return id;
}

function wire(ws: PropertyWorkspace, ids: string[]) {
  const root = ws.root;
  const runtime = new MemoryRuntimeStore();
  const endpoints = new MessagingEndpoints(runtime);
  for (const id of ids) endpoints.attach({ address: LINE, provider: "demo", propertyId: id });
  const sent: string[] = [];
  const transport = {
    provider: "demo",
    presentation: "MESSAGING" as const,
    async send(message: OutgoingMessage) {
      sent.push(message.body);
      return { provider: "demo", channel: "DEMO" as const, status: "SENT" as const, sentAt: new Date().toISOString() };
    },
  };
  const router = new MessagingConversations({
    workspace: ws,
    registry: new VisitorDemoRegistry(),
    runtime,
    endpoints,
    transport: () => transport,
    links: new VerificationLinks({ baseUrl: () => PUBLIC }),
    publicBaseUrl: () => PUBLIC,
    defaultLine: () => LINE,
    consentMode: () => "keyword_confirm",
  });
  let n = 0;
  const text = async (from: string, body: string) => {
    const before = sent.length;
    await router.receive({
      provider: "demo",
      providerMessageId: `m_${++n}`,
      from,
      to: LINE,
      text: body,
      channel: "SMS",
      receivedAt: new Date().toISOString(),
    } satisfies InboundMessage);
    return sent.slice(before);
  };
  return { root, text };
}

describe("STOP, HELP, and START on an unchecked draft", () => {
  it("handles each keyword on a single-property line before any not-ready reply", async () => {
    const root = mkdtempSync(join(tmpdir(), "tourcore-draft-stop-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const ws = new PropertyWorkspace(root);
    const id = uncheckedDraft(ws, "1 QA Scratch Lane, Teaneck, NJ 07666");
    const { text } = wire(ws, [id]);
    const name = ws.loadDraft(id)!.property.name;

    const stop = await text("+15555551001", "STOP");
    expect(stop).toEqual([STOP]);
    expect(stop.join("\n")).not.toContain("aren't available");
    expect(consent(root, id, "+15555551001")).toMatchObject({ status: "opted_out", method: "keyword", keyword: "STOP" });
    expect(optedOut(root, id, "+15555551001")).toBeTruthy();
    expect(await text("+15555551001", "TOUR")).toEqual([]);
    expect(await text("+15555551001", "Hi")).toEqual([]);

    const help = await text("+15555551002", "HELP");
    expect(help).toEqual([HELP]);
    expect(help.join("\n")).not.toContain("aren't available");

    const start = await text("+15555551003", "START");
    expect(start).toEqual([START]);
    expect(start.join("\n")).not.toContain("aren't available");
    expect(start.join("\n")).not.toContain("Which place");
    expect(consent(root, id, "+15555551003")).toMatchObject({ status: "pending", method: "keyword", keyword: "START" });
    expect(await text("+15555551003", "Hi")).toEqual([toursUnavailableText(name, "property team")]);
  });

  it("handles each keyword on a shared line of drafts that have no saved config", async () => {
    const root = mkdtempSync(join(tmpdir(), "tourcore-draft-shared-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const ws = new PropertyWorkspace(root);
    const first = uncheckedDraft(ws, "2 QA Scratch Lane, Teaneck, NJ 07666");
    const second = uncheckedDraft(ws, "4 QA Scratch Lane, Teaneck, NJ 07666");
    const { text } = wire(ws, [first, second]);

    const stop = await text("+15555551011", "STOP");
    expect(stop).toEqual([STOP]);
    expect(stop.join("\n")).not.toContain("aren't available");
    expect(stop.join("\n")).not.toContain("Which place");
    for (const id of [first, second]) {
      expect(consent(root, id, "+15555551011")).toMatchObject({ status: "opted_out", keyword: "STOP" });
      expect(optedOut(root, id, "+15555551011")).toBeTruthy();
    }
    expect(await text("+15555551011", "Hello")).toEqual([]);

    expect(await text("+15555551012", "HELP")).toEqual([HELP]);
    const start = await text("+15555551013", "START");
    expect(start).toEqual([START]);
    expect(start.join("\n")).not.toContain("Which place");
    expect(start.join("\n")).not.toContain("aren't available");
  });
});

describe("drafts stay out of the property picker", () => {
  it("uses the not-ready line when every open property is a draft, and lists only published places otherwise", async () => {
    const root = mkdtempSync(join(tmpdir(), "tourcore-picker-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const ws = new PropertyWorkspace(root);
    const only = uncheckedDraft(ws, "6 QA Scratch Lane, Teaneck, NJ 07666");
    const alone = wire(ws, [only]);
    const name = ws.loadDraft(only)!.property.name;
    const hi = await alone.text("+15555551021", "Hi");
    expect(hi).toEqual([toursUnavailableText(name, "property team")]);
    expect(hi.join("\n")).not.toContain("Which place");
    expect(await alone.text("+15555551022", "START")).toEqual([START]);

    const sharedRoot = mkdtempSync(join(tmpdir(), "tourcore-picker-shared-"));
    cleanups.push(() => rmSync(sharedRoot, { recursive: true, force: true }));
    const shared = new PropertyWorkspace(sharedRoot);
    const pine = savedUnchecked(shared, "prop_88_pine", "88 Pine St, Teaneck, NJ 07666", "88 Pine St");
    const oak = savedUnchecked(shared, "prop_4_oak", "4 Oak Ave, Teaneck, NJ 07666", "4 Oak Ave");
    const drafts = wire(shared, [pine, oak]);
    const started = await drafts.text("+15555551023", "START");
    expect(started).toEqual([START]);
    expect(started.join("\n")).not.toContain("Which place");
    expect(started.join("\n")).not.toContain("aren't available");
    const tour = await drafts.text("+15555551024", "Tour");
    expect(tour.join("\n")).not.toContain("Which place");
    expect(tour.join("\n")).toContain("aren't available right now");

    shared.patchState(pine, { status: "PUBLISHED_FOR_DEMO", publishedAt: "2026-10-02T00:00:00.000Z" });
    shared.patchState(oak, { status: "PUBLISHED_FOR_DEMO", publishedAt: "2026-10-03T00:00:00.000Z" });
    const scratch = savedUnchecked(shared, "prop_scratch_draft", "9 Birch Rd, Teaneck, NJ 07666", "9 Birch Rd");
    const mixed = wire(shared, [pine, oak, scratch]);
    const asked = await mixed.text("+15555551025", "Tour");
    expect(asked[0]).toContain("Which place are you touring?");
    expect(asked[0]).toContain("88 Pine St");
    expect(asked[0]).toContain("4 Oak Ave");
    expect(asked[0]).not.toContain("9 Birch Rd");
  });
});

describe("suitability questions are fair-housing holds", () => {
  it.each(SUITABILITY)("matches %s", (text) => {
    expect(isFairHousingQuestion(text)).toBe(true);
  });

  it.each(["Is it good for parking?", "pets ok?", "Is it good for a home office?", "Is the building good for parking?"])(
    "does not match %s",
    (text) => {
      expect(isFairHousingQuestion(text)).toBe(false);
    },
  );

  it("sends the held line, files a no-draft inbox item, and refuses a drafted answer", async () => {
    const a = await liveApp({ cleanups });
    await a.optInSms();
    await a.text("1");
    await a.text("1");
    const replies = await a.text("Is it good for families?");
    expect(replies).toEqual([HELD]);
    expect(replies.join("\n")).not.toMatch(/fair housing/i);

    const inbox = await a.grok("get_inbox");
    const item = (inbox.items as Array<Record<string, unknown>>).find((row) => String(row.summary).includes("Is it good for families?"));
    expect(item).toBeTruthy();
    const shown = [item!.what, item!.summary, ...((item!.nextSteps as string[]) ?? [])].join("\n");
    expect(shown).toBe(
      ["Fair-housing question", `They asked: "Is it good for families?" ${FAIR_LINE}`, "Mark it handled once you've replied."].join("\n"),
    );
    expect(shown.split(FAIR_LINE)).toHaveLength(2);
    expect(item!.proposeDraft).toBe(false);
    expect(item).not.toHaveProperty("draft");
    expect(item).not.toHaveProperty("suggestedAnswer");
    expect(shown).not.toMatch(/\b(?:resolve_issue|get_inbox|answer_flagged_question)\b/);

    const refused = await a.grok("resolve_issue", {
      action: "answer",
      exceptionId: item!.exceptionId,
      approvedFact: "Yes, it is a great place for families.",
    });
    expect(refused).toMatchObject({ status: "blocked", code: "NO_DRAFT", message: FAIR_HOUSING_REFUSAL });

    const office = await a.text("Is it good for a home office?");
    expect(office[0]).toBe(PASS_ALONG);
    expect(office.join("\n")).not.toContain(HELD);
    expect(office.join("\n")).not.toContain("2 bedrooms");
    const after = await a.grok("get_inbox");
    const held = (after.items as Array<{ summary?: string; proposeDraft?: boolean; status?: string }>).find((row) =>
      row.summary?.includes("home office"),
    );
    expect(held).toMatchObject({
      status: "open",
      summary: 'Asked "Is it good for a home office?". There\'s no approved answer yet.',
    });
    expect(held!.proposeDraft).toBeUndefined();
  });
});

describe("a fact keyword is not an answer", () => {
  it("holds paint, smoke, and pets questions and still answers a bedroom-count question", async () => {
    const config = hillsideConfig();
    expect(resolveQuestion(config, "Can I paint the bedroom walls?", { selectedUnitId: "apt_101" }).kind).toBe("unknown");
    expect(resolveQuestion(config, "Can I smoke in the bedroom?", { selectedUnitId: "apt_101" }).kind).toBe("unknown");
    expect(resolveQuestion(config, "Can my pets stay in the bedroom?", { selectedUnitId: "apt_101" }).kind).toBe("unknown");
    expect(resolveQuestion(config, "How many bedrooms?", { selectedUnitId: "apt_101" })).toMatchObject({
      kind: "answer",
      facts: [{ text: "Unit 1A has 2 bedrooms." }],
    });

    const a = await liveApp({ cleanups });
    await a.optInSms();
    await a.text("1");
    await a.text("1");

    const paint = await a.text("Can I paint the bedroom walls?");
    const smoke = await a.text("Can I smoke in the bedroom?");
    const pets = await a.text("Can my pets stay in the bedroom?");
    expect(paint[0]).toBe(PASS_ALONG);
    expect(smoke[0]).toBe(PASS_ALONG);
    expect(pets[0]).toBe(PASS_ALONG);
    for (const replies of [paint, smoke, pets]) {
      expect(replies.join("\n")).not.toContain("2 bedrooms");
      expect(replies.join("\n")).not.toContain(HELD);
    }
    expect(await a.text("How many bedrooms?")).toEqual(["Unit 1A has 2 bedrooms."]);

    const inbox = await a.grok("get_inbox");
    const item = (inbox.items as Array<Record<string, unknown>>).find((row) => String(row.summary).includes("paint the bedroom"));
    expect(item).toBeTruthy();
    const shown = [item!.what, item!.summary, ...((item!.nextSteps as string[]) ?? [])].join("\n");
    expect(shown).toBe(
      [
        "Question with no approved answer",
        'Asked "Can I paint the bedroom walls?". There\'s no approved answer yet.',
        "If you know the answer, tell me and I can add it to the approved facts and text the visitor (with your OK).",
        "Or mark it handled if you've already answered them another way.",
      ].join("\n"),
    );
    expect(shown).not.toContain("2 bedrooms");
  });
});

describe("playbook gate", () => {
  it("asserts the hard-coded playbook version on each client", () => {
    const src = readFileSync(new URL("../src/eval/clientMatrix.ts", import.meta.url), "utf8");
    expect(src).toContain("playbook.version === expected.version");
    expect(MATRIX_CLIENTS.map((row) => [row.key, row.expected.version])).toEqual([
      ["grok", "grok@2026-10-08"],
      ["chatgpt", "chatgpt@2026-10-08.tools"],
      ["claude", "claude@2026-10-08"],
      ["unknown", "baseline@2026-10-08.tools"],
      ["spoofed-grok", "baseline@2026-10-08.tools"],
    ]);
  });
});
