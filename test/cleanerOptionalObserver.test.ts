import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { groupTimeLine } from "../src/cleaner-core/cleanerTexts";
import { liveDeskFor, resetLiveDesks, setCleanerCalendarFetch } from "../src/cleaner-core/liveDesk";
import { setCleanerGroupFetch, setCleanerTwilioClient } from "../src/cleaner-core/liveSms";
import { handleCleanerMcpMessage } from "../src/cleaner-core/mcp";
import {
  ADDRESS,
  CALENDAR_ICS,
  CALENDAR_URL,
  CLEANER,
  CLEANER_LINE,
  DOOR_CODE,
  FROZEN,
  HOST,
  TEST_PIN_KEY,
  fakeSms,
  type SentSms,
} from "./wiringProof";

const OLD = "+15555550103";
const TIME = groupTimeLine("Cory");
const PIN_KEY = Buffer.from(TEST_PIN_KEY, "base64");

interface GroupPost {
  to: string[];
  body: string;
}

const roots: string[] = [];

afterEach(() => {
  setCleanerTwilioClient(undefined);
  setCleanerGroupFetch(undefined);
  setCleanerCalendarFetch(undefined);
  resetLiveDesks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function groupFetch() {
  const conversations = new Map<string, { sid: string; address: string }[]>();
  const posts: GroupPost[] = [];
  let sequence = 0;
  const impl: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const reply = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => body }) as Response;
    const root = "https://conversations.twilio.com/v1/Conversations";
    if (url === root && method === "POST") {
      const sid = `CH${++sequence}`;
      conversations.set(sid, []);
      return reply(201, { sid });
    }
    if (!url.startsWith(`${root}/`)) return reply(404, {});
    const path = url.slice(root.length + 1);
    const [rawSid, ...rest] = path.split("/");
    const sid = decodeURIComponent(rawSid ?? "");
    const tail = rest.join("/").split("?")[0] ?? "";
    const people = conversations.get(sid);
    if (!people) return reply(404, {});
    if (tail === "Messages" && method === "POST") {
      const params = new URLSearchParams(String(init?.body ?? ""));
      posts.push({ to: people.map((person) => person.address).sort(), body: params.get("Body") ?? "" });
      return reply(201, { sid: `IM${posts.length}` });
    }
    if (tail === "Participants" && method === "GET") {
      return reply(200, {
        participants: people.map((person) => ({ sid: person.sid, messaging_binding: { address: person.address } })),
        meta: { next_page_url: null },
      });
    }
    if (tail === "Participants" && method === "POST") {
      const params = new URLSearchParams(String(init?.body ?? ""));
      const address = params.get("MessagingBinding.Address") ?? "";
      if (people.some((person) => person.address === address)) return reply(409, {});
      const person = { sid: `MB${++sequence}`, address };
      people.push(person);
      return reply(201, { sid: person.sid });
    }
    if (method === "DELETE" && tail.startsWith("Participants/")) {
      const party = decodeURIComponent(tail.slice("Participants/".length));
      const index = people.findIndex((person) => person.sid === party);
      if (index >= 0) people.splice(index, 1);
      return reply(index >= 0 ? 204 : 404, {});
    }
    return reply(404, {});
  };
  return { impl, posts };
}

function open(phones: string[]) {
  const root = mkdtempSync(join(tmpdir(), "cleaner-optional-observer-"));
  roots.push(root);
  const sms = fakeSms();
  const groups = groupFetch();
  setCleanerTwilioClient(sms);
  setCleanerGroupFetch(groups.impl);
  setCleanerCalendarFetch(async (url) => ({
    status: url === CALENDAR_URL ? 200 : 404,
    url,
    async text() {
      return url === CALENDAR_URL ? CALENDAR_ICS : "";
    },
  }));
  const env: NodeJS.ProcessEnv = {
    CLEANER_CORE_ENABLED: "1",
    CLEANER_CORE_LIVE_SMS: "1",
    CLEANER_CORE_GROUP_CHAT: "1",
    CLEANER_CORE_SMS_ALLOWLIST: phones.join(","),
    CLEANER_CORE_TWILIO_ACCOUNT_SID: "ACfake",
    CLEANER_CORE_TWILIO_AUTH_TOKEN: "token",
    CLEANER_CORE_TWILIO_PHONE_NUMBER: CLEANER_LINE,
  };
  const desk = liveDeskFor(root, () => env, () => new Date(FROZEN));
  return { root, sms, posts: groups.posts, desk };
}

async function setup(desk: ReturnType<typeof open>["desk"], observer?: string) {
  expect((await desk.getState("2")).ok).toBe(true);
  expect((await desk.saveProperty({ business: "Harbor", address: ADDRESS, timeZone: "America/New_York" })).ok).toBe(true);
  const saved = await desk.savePeople(observer === undefined ? { host: HOST, cleaner: CLEANER } : { host: HOST, cleaner: CLEANER, observer });
  expect(saved.ok).toBe(true);
  expect((await desk.saveCalendarLink({ url: CALENDAR_URL })).ok).toBe(true);
  expect((await desk.saveDoorCode({ code: DOOR_CODE }, PIN_KEY)).ok).toBe(true);
  expect((await desk.setUpTexting()).ok).toBe(true);
  expect((await desk.runChecks()).ok).toBe(true);
  expect((await desk.confirmTimes({ checkout: "11:00 AM", checkIn: "4:00 PM" })).ok).toBe(true);
}

function asksForThird(text: string): boolean {
  return /three different|third number|third phone/i.test(text);
}

function codeRecipients(sent: SentSms[]): string[] {
  return sent.filter((item) => item.body.includes(DOOR_CODE)).map((item) => item.to);
}

function bodyHasCode(body: string): boolean {
  return body.includes(DOOR_CODE);
}

describe("optional observer", () => {
  it("saves with the observer left empty and does not ask for a third number", async () => {
    const { desk, root } = open([HOST, CLEANER]);
    expect((await desk.getState("2")).ok).toBe(true);
    const asked = await desk.saveProperty({ business: "Harbor", address: ADDRESS, timeZone: "America/New_York" });
    expect(asked.ok).toBe(true);
    if (asked.ok) {
      // In the diagram order the booking sources come before the people.
      expect(String(asked.result.next)).toMatch(/Guesty Lite link/i);
      expect(asksForThird(String(asked.result.next))).toBe(false);
    }
    const omitted = await desk.savePeople({ host: HOST, cleaner: CLEANER });
    const blank = await desk.savePeople({ host: HOST, cleaner: CLEANER, observer: "" });
    const spaces = await desk.savePeople({ host: HOST, cleaner: CLEANER, observer: "   " });
    for (const saved of [omitted, blank, spaces]) {
      expect(saved.ok).toBe(true);
      if (!saved.ok) continue;
      expect(asksForThird(String(saved.result.next))).toBe(false);
      expect(String(saved.result.next)).toMatch(/Guesty Lite link/i);
    }
    const state = await desk.getState();
    expect(state.ok).toBe(true);
    if (state.ok) {
      expect(state.result.done).toContain("Cleaner saved.");
      expect(asksForThird(JSON.stringify(state.result))).toBe(false);
    }
    expect(JSON.parse(readFileSync(join(root, "cleaner-live.json"), "utf8")).observer).toBeUndefined();

    const listed = await handleCleanerMcpMessage(desk, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    const tools = (listed.body as { result?: { tools?: { name: string; description: string; inputSchema: { required?: string[] } }[] } }).result?.tools ?? [];
    const tool = tools.find((item) => item.name === "save_people");
    expect(tool?.description).toMatch(/observer is optional/i);
    expect(tool?.inputSchema.required ?? []).toEqual(["host", "cleaner"]);
    const called = await handleCleanerMcpMessage(desk, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "save_people", arguments: { host: HOST, cleaner: CLEANER } },
    });
    const result = called.body as { result?: { isError?: boolean; content?: { text?: string }[] } };
    expect(result.result?.isError).toBe(false);
    expect(asksForThird(result.result?.content?.[0]?.text ?? "")).toBe(false);
  });

  it("clears a saved observer so later group copies skip that number", async () => {
    const { desk, sms, posts, root } = open([HOST, CLEANER, OLD]);
    await setup(desk, OLD);
    await desk.inbound({ id: "yes-host", from: HOST, text: "YES" });
    await desk.inbound({ id: "yes-cleaner", from: CLEANER, text: "YES" });
    await desk.inbound({ id: "yes-observer", from: OLD, text: "YES" });
    await desk.inbound({ id: "yes-schedule", from: CLEANER, text: "YES" });
    await desk.inbound({ id: "time-with-observer", from: CLEANER, text: "Can we do 2:00 PM?", channel: "group" });
    const withObserver = posts.filter((post) => post.body === TIME);
    expect(withObserver.length).toBe(1);
    expect(withObserver[0]?.to).toEqual([OLD, HOST, CLEANER].sort());

    const left = await desk.markGuestsLeft({ said: "The guests have left" }, PIN_KEY);
    expect(left.ok).toBe(true);
    expect(codeRecipients(sms.sent)).toEqual([CLEANER]);
    expect(posts.some((post) => bodyHasCode(post.body))).toBe(false);
    expect(sms.sent.filter((item) => item.to === OLD).some((item) => bodyHasCode(item.body))).toBe(false);

    const cleared = await desk.savePeople({ host: HOST, cleaner: CLEANER });
    expect(cleared.ok).toBe(true);
    if (cleared.ok) expect(asksForThird(String(cleared.result.next))).toBe(false);
    const file = JSON.parse(readFileSync(join(root, "cleaner-live.json"), "utf8")) as { observer?: string };
    expect(file.observer).toBeUndefined();
    expect(JSON.stringify(file).includes(OLD)).toBe(false);

    const smsAt = sms.sent.length;
    const postsAt = posts.length;
    await desk.inbound({ id: "time-after-clear", from: CLEANER, text: "Can we do 3:00 PM?", channel: "group" });
    const laterPosts = posts.slice(postsAt);
    const laterCopy = laterPosts.find((post) => post.body === TIME);
    expect(laterCopy?.to).toEqual([HOST, CLEANER].sort());
    expect(laterPosts.some((post) => post.to.includes(OLD) || post.to.includes(""))).toBe(false);
    expect(sms.sent.slice(smsAt).some((item) => item.to === OLD || item.to === "")).toBe(false);
    expect(posts.some((post) => bodyHasCode(post.body))).toBe(false);
  });

  it("sends group texts only to the cleaner and Cory when no observer is saved", async () => {
    const { desk, sms, posts } = open([HOST, CLEANER, OLD]);
    await setup(desk);
    await desk.inbound({ id: "yes-host", from: HOST, text: "YES" });
    await desk.inbound({ id: "yes-cleaner", from: CLEANER, text: "YES" });
    await desk.inbound({ id: "yes-schedule", from: CLEANER, text: "YES" });
    await desk.inbound({ id: "time-two", from: CLEANER, text: "Can we do 2:00 PM?", channel: "group" });
    const left = await desk.markGuestsLeft({ said: "The guests have left" }, PIN_KEY);
    expect(left.ok).toBe(true);
    expect(posts.filter((post) => post.body === TIME).map((post) => post.to)).toEqual([[HOST, CLEANER].sort()]);
    expect(posts.some((post) => post.to.includes(OLD) || post.to.includes(""))).toBe(false);
    expect(sms.sent.some((item) => item.to === OLD || item.to === "")).toBe(false);
    expect(codeRecipients(sms.sent)).toEqual([CLEANER]);
    expect(posts.some((post) => bodyHasCode(post.body))).toBe(false);
  });

  it("keeps a three-number setup on group copies only, and never sends the code to the observer", async () => {
    const { desk, sms, posts } = open([HOST, CLEANER, OLD]);
    expect((await desk.getState("2")).ok).toBe(true);
    expect((await desk.saveProperty({ business: "Harbor", address: ADDRESS, timeZone: "America/New_York" })).ok).toBe(true);
    const people = await desk.savePeople({ host: HOST, cleaner: CLEANER, observer: OLD });
    expect(people.ok).toBe(true);
    const state = await desk.getState();
    expect(state.ok).toBe(true);
    if (state.ok) expect(state.result.done).toContain("Cleaner and observer saved.");
    await setup(desk, OLD);
    await desk.inbound({ id: "yes-host-3", from: HOST, text: "YES" });
    await desk.inbound({ id: "yes-cleaner-3", from: CLEANER, text: "YES" });
    await desk.inbound({ id: "yes-observer-3", from: OLD, text: "YES" });
    await desk.inbound({ id: "yes-schedule-3", from: CLEANER, text: "YES" });
    await desk.inbound({ id: "time-3", from: CLEANER, text: "Can we do 2:00 PM?", channel: "group" });
    expect(posts.find((post) => post.body === TIME)?.to).toEqual([OLD, HOST, CLEANER].sort());
    expect(sms.sent.filter((item) => item.to === OLD).length).toBeGreaterThan(0);
    expect(sms.sent.filter((item) => item.to === OLD).some((item) => bodyHasCode(item.body))).toBe(false);
    const left = await desk.markGuestsLeft({ said: "The guests have left" }, PIN_KEY);
    expect(left.ok).toBe(true);
    expect(codeRecipients(sms.sent)).toEqual([CLEANER]);
    expect(posts.some((post) => bodyHasCode(post.body) || post.to.includes(""))).toBe(false);
  });

  it("still answers STOP from both numbers, sends nothing for HELP, and skips an opted-out number", async () => {
    const early = open([HOST, CLEANER]);
    expect((await early.desk.getState("2")).ok).toBe(true);
    expect((await early.desk.saveProperty({ business: "Harbor", address: ADDRESS, timeZone: "America/New_York" })).ok).toBe(true);
    expect((await early.desk.savePeople({ host: HOST, cleaner: CLEANER })).ok).toBe(true);
    const helpBefore = early.sms.sent.length;
    await early.desk.inbound({ id: "help-host-early", from: HOST, text: "HELP" });
    await early.desk.inbound({ id: "help-cleaner-early", from: CLEANER, text: "HELP" });
    expect(early.sms.sent.slice(helpBefore).length).toBe(0);
    await early.desk.inbound({ id: "stop-host-early", from: HOST, text: "STOP" });
    await early.desk.inbound({ id: "stop-cleaner-early", from: CLEANER, text: "STOP" });
    expect(early.sms.sent.filter((item) => item.to === HOST).some((item) => /opted out/i.test(item.body))).toBe(true);
    expect(early.sms.sent.filter((item) => item.to === CLEANER).some((item) => /opted out/i.test(item.body))).toBe(true);

    const { desk, sms, posts } = open([HOST, CLEANER]);
    await setup(desk);
    await desk.inbound({ id: "yes-host-safety", from: HOST, text: "YES" });
    await desk.inbound({ id: "yes-cleaner-safety", from: CLEANER, text: "YES" });
    await desk.inbound({ id: "yes-schedule-safety", from: CLEANER, text: "YES" });
    const beforeHelp = sms.sent.length;
    const beforeHelpPosts = posts.length;
    await desk.inbound({ id: "help-host", from: HOST, text: "HELP" });
    await desk.inbound({ id: "help-cleaner", from: CLEANER, text: "HELP" });
    expect(sms.sent.slice(beforeHelp).length).toBe(0);
    expect(posts.slice(beforeHelpPosts).length).toBe(0);
    const held = await desk.getState();
    expect(held.ok).toBe(true);
    if (held.ok) {
      const turns = held.result.turns as { checkoutTime: string | null; status: string }[];
      expect(turns.find((turn) => turn.checkoutTime === "11:00 AM")?.status).toBe("confirmed");
    }

    await desk.inbound({ id: "stop-cleaner", from: CLEANER, text: "STOP" });
    expect(sms.sent.filter((item) => item.to === CLEANER).some((item) => /opted out/i.test(item.body))).toBe(true);
    const afterStop = posts.length;
    await desk.inbound({ id: "time-after-stop", from: CLEANER, text: "Can we do 2:00 PM?", channel: "group" });
    const afterOut = posts.slice(afterStop).filter((post) => post.body === TIME);
    expect(afterOut.length).toBe(1);
    expect(afterOut[0]?.to).toEqual([HOST]);
    expect(afterOut.some((post) => post.to.includes(CLEANER))).toBe(false);
    expect(codeRecipients(sms.sent.filter((item) => item.to === CLEANER))).toEqual([]);
    const left = await desk.markGuestsLeft({ said: "The guests have left" }, PIN_KEY);
    expect(left.ok).toBe(true);
    expect(codeRecipients(sms.sent)).toEqual([]);
  });
});
