import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { groupTimeLine } from "../src/cleaner-core/cleanerTexts";
import type { CleanerCore } from "../src/cleaner-core/core";
import { liveDeskFor, resetLiveDesks, setCleanerCalendarFetch, type LiveDesk, type ToolReply } from "../src/cleaner-core/liveDesk";
import { setCleanerGroupFetch, setCleanerTwilioClient } from "../src/cleaner-core/liveSms";
import { handleCleanerMcpMessage } from "../src/cleaner-core/mcp";
import type { GoogleEventList } from "../src/cleaner-core/sources";
import {
  ADDRESS,
  BUSINESS,
  CALENDAR_ICS,
  CALENDAR_URL,
  CLEANER,
  CLEANER_LINE,
  CLEANER_TOKEN,
  DOOR_CODE,
  FROZEN,
  HOST,
  OBSERVER,
  TEST_PIN_KEY,
  fakeSms,
  startWiredApp,
  type SentSms,
  type WiredApp,
} from "./wiringProof";

const PATH = "/mcp/cleaner-core";
const ZONE = "America/New_York";
const PIN_KEY = Buffer.from(TEST_PIN_KEY, "base64");
const SECOND = "+15555550133";
const LOCK = "back door lockbox";
const TIME = groupTimeLine("Cory");

const PROPERTY_NEXT = "What's the property address, what should I call the business, and what are the usual checkout and check-in times?";
const SOURCES_NEXT = "Where do bookings come from? Send the Guesty Lite link, and tell me if you also use Google Calendar.";
const PEOPLE_NEXT =
  "Who is the cleaner? Send their name and phone number, and the host's phone number. Extra contacts, like a co-host, an assistant, or an observer, are optional. Should texts go to the cleaner alone, to a group with the cleaner and you, or to a group with everyone?";
const DOOR_NEXT = "What's the door code, and where is the lock? I'll save the code and I won't repeat it.";
const PREFERENCES_NEXT =
  "Any cleaning preferences? A checklist, whether photos are required, whether the cleaner may send supply notes, and other instructions. If there are none, save empty preferences.";
const REVIEW_NEXT = "Summarize this setup for the host in your own words, then ask them to reply Activate.";
const PRIVATE_PIN = `Guests have left ${ADDRESS}. Door code for the ${LOCK}: ${DOOR_CODE}. This code is only for you. Reply DONE when the cleaning is finished.`;

const open: WiredApp[] = [];
const roots: string[] = [];

afterEach(async () => {
  setCleanerTwilioClient(undefined);
  setCleanerGroupFetch(undefined);
  setCleanerCalendarFetch(undefined);
  resetLiveDesks();
  while (open.length > 0) await open.pop()?.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function app(options?: Parameters<typeof startWiredApp>[0]): Promise<WiredApp> {
  const started = await startWiredApp(options);
  open.push(started);
  return started;
}

function call(wired: WiredApp, name: string, args: Record<string, unknown> = {}) {
  return wired.tool(PATH, CLEANER_TOKEN, name, args);
}

async function state(wired: WiredApp): Promise<Record<string, unknown>> {
  return (await call(wired, "get_state")).structured ?? {};
}

function googleList(stays: { id: string; start: string; end: string }[]): GoogleEventList {
  return {
    timeZone: ZONE,
    items: stays.map((stay) => ({ id: stay.id, status: "confirmed", summary: "Guest", start: { date: stay.start }, end: { date: stay.end } })),
  };
}

const PROPERTY = {
  business: BUSINESS,
  nickname: "Lake House",
  address: ADDRESS,
  propertyType: "Condo",
  timeZone: ZONE,
  checkoutTime: "10:30 AM",
  checkInTime: "3:00 PM",
};

const PREFERENCES = {
  checklist: ["Strip the beds", "Restock coffee"],
  photosRequired: true,
  supplyNotes: true,
  instructions: "Leave the porch light on.",
};

describe("Cleaner Core full setup: the diagram order", () => {
  it("saves each step, advances in diagram order, and reviews every choice without the code or a full phone", async () => {
    const wired = await app();
    await call(wired, "get_state", { said: "2" });
    expect((await state(wired)).next).toBe(PROPERTY_NEXT);

    const property = await call(wired, "save_property", PROPERTY);
    expect(property.isError).toBe(false);
    expect(property.structured?.next).toBe(SOURCES_NEXT);
    expect((await state(wired)).next).toBe(SOURCES_NEXT);

    const sources = await call(wired, "save_sources", { calendars: [{ name: "Airbnb", url: CALENDAR_URL }] });
    expect(sources.isError).toBe(false);
    expect(sources.structured?.next).toBe(PEOPLE_NEXT);
    expect((await state(wired)).next).toBe(PEOPLE_NEXT);

    const people = await call(wired, "save_people", {
      host: HOST,
      cleaner: CLEANER,
      cleanerName: "Ana",
      contacts: [{ name: "Sam", role: "co-host", phone: OBSERVER }],
      groupChat: "everyone",
    });
    expect(people.isError).toBe(false);
    expect(people.structured?.next).toBe(DOOR_NEXT);
    expect((await state(wired)).next).toBe(DOOR_NEXT);

    const door = await call(wired, "save_door_code", { code: DOOR_CODE, lockLocation: LOCK });
    expect(door.isError).toBe(false);
    const atPreferences = await state(wired);
    expect(atPreferences.next).toBe(PREFERENCES_NEXT);
    expect(atPreferences.setup).toBeUndefined();

    const early = await call(wired, "activate");
    expect(early.isError).toBe(true);

    const preferences = await call(wired, "save_preferences", PREFERENCES);
    expect(preferences.isError).toBe(false);
    expect(preferences.structured?.next).toBe(REVIEW_NEXT);
    const review = await state(wired);
    expect(review.next).toBe(REVIEW_NEXT);
    expect(review.done).toContain("Preferences saved.");
    expect(review.setup).toEqual({
      property: {
        business: BUSINESS,
        nickname: "Lake House",
        address: ADDRESS,
        propertyType: "Condo",
        timeZone: ZONE,
        checkoutTime: "10:30 AM",
        checkInTime: "3:00 PM",
      },
      sources: { calendars: ["Airbnb"], google: false },
      people: {
        host: { phoneLast4: "0130" },
        cleaner: { name: "Ana", phoneLast4: "0131" },
        contacts: [{ name: "Sam", role: "co-host", phoneLast4: "0132" }],
        groupChat: "everyone",
        groupThread: false,
      },
      access: { lockLocation: LOCK },
      preferences: PREFERENCES,
    });
    const json = JSON.stringify(review);
    for (const secret of [DOOR_CODE, HOST, CLEANER, OBSERVER, "5555550130", "5555550131", "5555550132", CALENDAR_URL]) {
      expect(json.includes(secret), secret).toBe(false);
    }

    const activated = await call(wired, "activate");
    expect(activated.isError).toBe(false);
    expect((await state(wired)).done).toContain("Checks finished.");
    expect(wired.cleanerSent).toEqual([]);
  });

  it("takes save_preferences({}) as no preferences and moves to review", async () => {
    const wired = await app();
    await call(wired, "get_state", { said: "2" });
    expect((await call(wired, "save_property", { business: BUSINESS, address: ADDRESS, timeZone: ZONE })).isError).toBe(false);
    expect((await call(wired, "save_calendar_link", { url: CALENDAR_URL })).isError).toBe(false);
    expect((await call(wired, "save_people", { host: HOST, cleaner: CLEANER })).isError).toBe(false);
    expect((await call(wired, "save_door_code", { code: DOOR_CODE })).isError).toBe(false);
    expect((await state(wired)).next).toBe(PREFERENCES_NEXT);
    expect((await call(wired, "save_preferences", {})).isError).toBe(false);
    const review = await state(wired);
    expect(review.next).toBe(REVIEW_NEXT);
    const setup = review.setup as Record<string, unknown>;
    expect(setup.preferences).toEqual({ checklist: [], photosRequired: false, supplyNotes: false });
    expect(setup.access).toEqual({});
    expect((setup.people as Record<string, unknown>).cleaner).toEqual({ phoneLast4: "0131" });
    expect(JSON.stringify(review).includes(DOOR_CODE)).toBe(false);
    expect((await call(wired, "activate")).isError).toBe(false);
    expect((await state(wired)).done).toContain("Checks finished.");
  });

  it("lists the new tools beside the old ones", async () => {
    const wired = await app();
    const listed = await wired.listTools(PATH, CLEANER_TOKEN);
    for (const name of [
      "get_state",
      "save_property",
      "save_people",
      "save_calendar_link",
      "save_sources",
      "save_door_code",
      "save_preferences",
      "activate",
      "set_up_texting",
      "run_checks",
      "check_now",
      "confirm_times",
      "save_alert_routine",
    ]) {
      expect(listed.names, name).toContain(name);
    }
  });
});

describe("Cleaner Core full setup: refusals", () => {
  async function atDoor(wired: WiredApp) {
    await call(wired, "get_state", { said: "2" });
    expect((await call(wired, "save_property", { business: BUSINESS, address: ADDRESS, timeZone: ZONE })).isError).toBe(false);
    expect((await call(wired, "save_calendar_link", { url: CALENDAR_URL })).isError).toBe(false);
    expect((await call(wired, "save_people", { host: HOST, cleaner: CLEANER })).isError).toBe(false);
  }

  it("refuses a usual time that is not a clock time", async () => {
    const wired = await app();
    await call(wired, "get_state", { said: "2" });
    expect((await call(wired, "save_property", { ...PROPERTY, checkoutTime: "late morning" })).isError).toBe(true);
    expect((await call(wired, "save_property", { ...PROPERTY, checkInTime: "15" })).isError).toBe(true);
  });

  it("refuses more than four contacts, a repeated phone, and a bad group choice", async () => {
    const wired = await app();
    await call(wired, "get_state", { said: "2" });
    expect((await call(wired, "save_property", { business: BUSINESS, address: ADDRESS, timeZone: ZONE })).isError).toBe(false);
    const five = ["+15555550140", "+15555550141", "+15555550142", "+15555550143", "+15555550144"].map((phone, index) => ({ name: `C${index}`, role: "observer", phone }));
    expect((await call(wired, "save_people", { host: HOST, cleaner: CLEANER, contacts: five })).isError).toBe(true);
    expect((await call(wired, "save_people", { host: HOST, cleaner: CLEANER, contacts: [{ name: "Sam", role: "assistant", phone: CLEANER }] })).isError).toBe(true);
    expect((await call(wired, "save_people", { host: HOST, cleaner: CLEANER, contacts: [{ name: "", role: "assistant", phone: OBSERVER }] })).isError).toBe(true);
    expect((await call(wired, "save_people", { host: HOST, cleaner: CLEANER, groupChat: "nobody" })).isError).toBe(true);
    expect((await call(wired, "save_people", { host: HOST, cleaner: CLEANER, observer: OBSERVER, contacts: [{ name: "Sam", role: "co-host", phone: OBSERVER }] })).isError).toBe(true);
  });

  it("refuses a lock location with a number run or too long", async () => {
    const wired = await app();
    await atDoor(wired);
    expect((await call(wired, "save_door_code", { code: DOOR_CODE, lockLocation: "lockbox 4417" })).isError).toBe(true);
    expect((await call(wired, "save_door_code", { code: DOOR_CODE, lockLocation: "x".repeat(81) })).isError).toBe(true);
    expect((await call(wired, "save_door_code", { code: DOOR_CODE, lockLocation: "Unit 12 side gate" })).isError).toBe(false);
  });

  it("refuses preferences that are too long or carry the door code", async () => {
    const wired = await app();
    await atDoor(wired);
    expect((await call(wired, "save_door_code", { code: DOOR_CODE })).isError).toBe(false);
    const thirteen = Array.from({ length: 13 }, (_, index) => `Task ${index}`);
    expect((await call(wired, "save_preferences", { checklist: thirteen })).isError).toBe(true);
    expect((await call(wired, "save_preferences", { checklist: ["x".repeat(81)] })).isError).toBe(true);
    expect((await call(wired, "save_preferences", { instructions: "x".repeat(301) })).isError).toBe(true);
    const inItem = await call(wired, "save_preferences", { checklist: ["Strip the beds", `Door code is ${DOOR_CODE}`] });
    expect(inItem.isError).toBe(true);
    expect(inItem.raw.includes(DOOR_CODE)).toBe(false);
    expect((await call(wired, "save_preferences", { instructions: `Use ${DOOR_CODE} at the side door` })).isError).toBe(true);
    expect((await state(wired)).next).toBe(PREFERENCES_NEXT);
  });
});

describe("Cleaner Core full setup: usual times", () => {
  it("passes the usual times to the engine, so the new-booking alert names them", async () => {
    const wired = await app();
    await call(wired, "get_state", { said: "2" });
    expect((await call(wired, "save_property", PROPERTY)).isError).toBe(false);
    expect((await call(wired, "save_sources", { google: true })).isError).toBe(false);
    expect((await call(wired, "save_people", { host: HOST, cleaner: CLEANER })).isError).toBe(false);
    expect((await call(wired, "save_door_code", { code: DOOR_CODE })).isError).toBe(false);
    expect((await call(wired, "save_preferences", {})).isError).toBe(false);
    expect((await call(wired, "activate", { googleEvents: googleList([]) })).isError).toBe(false);
    const checked = await call(wired, "check_now", { googleEvents: googleList([{ id: "g1", start: "2026-10-14", end: "2026-10-15" }]) });
    const alerts = (checked.structured?.alerts as string[] | undefined) ?? [];
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatch(/still 10:30\sAM\?/u);
  });

  it("passes the usual check-in time to the engine", async () => {
    const { desk } = openDesk([HOST, CLEANER], "0");
    await setUp(desk, { groupChat: "cleaner-only" });
    const engine = (desk as unknown as { engine: CleanerCore & { defaultCheckout: number; defaultCheckIn: number } }).engine;
    expect(engine.defaultCheckout).toBe(10 * 60 + 30);
    expect(engine.defaultCheckIn).toBe(15 * 60);
  });
});

interface GroupPost {
  to: string[];
  body: string;
}

/** A fake Twilio Conversations API. It counts every call and never leaves the machine. */
function groupFetch() {
  const conversations = new Map<string, { sid: string; address: string }[]>();
  const posts: GroupPost[] = [];
  let calls = 0;
  let sequence = 0;
  const impl: typeof fetch = async (input, init) => {
    calls += 1;
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
    const [rawSid, ...rest] = url.slice(root.length + 1).split("/");
    const people = conversations.get(decodeURIComponent(rawSid ?? ""));
    if (!people) return reply(404, {});
    const tail = rest.join("/").split("?")[0] ?? "";
    if (tail === "Messages" && method === "POST") {
      const params = new URLSearchParams(String(init?.body ?? ""));
      posts.push({ to: people.map((person) => person.address).sort(), body: params.get("Body") ?? "" });
      return reply(201, { sid: `IM${posts.length}` });
    }
    if (tail === "Participants" && method === "GET") {
      return reply(200, { participants: people.map((person) => ({ sid: person.sid, messaging_binding: { address: person.address } })), meta: { next_page_url: null } });
    }
    if (tail === "Participants" && method === "POST") {
      const address = new URLSearchParams(String(init?.body ?? "")).get("MessagingBinding.Address") ?? "";
      if (people.some((person) => person.address === address)) return reply(409, {});
      const person = { sid: `MB${++sequence}`, address };
      people.push(person);
      return reply(201, { sid: person.sid });
    }
    if (method === "DELETE") {
      const index = people.findIndex((person) => person.sid === decodeURIComponent(tail.slice("Participants/".length)));
      if (index >= 0) people.splice(index, 1);
      return reply(204, {});
    }
    return reply(404, {});
  };
  return { impl, posts, calls: () => calls };
}

function openDesk(phones: string[], groupChat: "0" | "1") {
  const root = mkdtempSync(join(tmpdir(), "cleaner-full-setup-"));
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
    CLEANER_CORE_GROUP_CHAT: groupChat,
    CLEANER_CORE_SMS_ALLOWLIST: phones.join(","),
    CLEANER_CORE_TWILIO_ACCOUNT_SID: "ACfake",
    CLEANER_CORE_TWILIO_AUTH_TOKEN: "token",
    CLEANER_CORE_TWILIO_PHONE_NUMBER: CLEANER_LINE,
  };
  const desk = liveDeskFor(root, () => env, () => new Date(FROZEN));
  return { desk, sms, groups };
}

function ok(reply: ToolReply): Record<string, unknown> {
  if (!reply.ok) throw new Error(reply.error);
  return reply.result;
}

type PeopleInput = Parameters<LiveDesk["savePeople"]>[0];

async function setUp(desk: LiveDesk, people: Partial<PeopleInput>) {
  ok(desk.getState("2"));
  ok(desk.saveProperty({ business: BUSINESS, address: ADDRESS, timeZone: ZONE, checkoutTime: "10:30 AM", checkInTime: "3:00 PM" }));
  ok(desk.saveSources({ calendars: [{ name: "Airbnb", url: CALENDAR_URL }] }));
  ok(desk.savePeople({ host: HOST, cleaner: CLEANER, cleanerName: "Ana", ...people }));
  ok(desk.saveDoorCode({ code: DOOR_CODE, lockLocation: LOCK }, PIN_KEY));
  ok(desk.savePreferences({}));
  ok(await desk.activate());
  ok(await desk.confirmTimes({ checkout: "11:00 AM", checkIn: "4:00 PM" }));
}

function codeRecipients(sent: SentSms[]): string[] {
  return sent.filter((item) => item.body.includes(DOOR_CODE)).map((item) => item.to);
}

describe("Cleaner Core full setup: who gets the texts", () => {
  it("cleaner-only with group chat on sends one-to-one texts and makes no Conversations call", async () => {
    const { desk, sms, groups } = openDesk([HOST, CLEANER, OBSERVER], "1");
    await setUp(desk, { contacts: [{ name: "Sam", role: "co-host", phone: OBSERVER }], groupChat: "cleaner-only" });
    expect((ok(desk.getState()).done as string[]).some((line) => line.startsWith("Group chat set up"))).toBe(false);
    await desk.inbound({ id: "yes-1", from: CLEANER, text: "YES" });
    await desk.inbound({ id: "yes-2", from: CLEANER, text: "YES" });
    ok(await desk.markGuestsLeft({ said: "The guests have left" }, PIN_KEY));
    expect(groups.calls()).toBe(0);
    expect(sms.sent.some((item) => item.to === CLEANER)).toBe(true);
    expect(sms.sent.some((item) => item.to === OBSERVER)).toBe(false);
    expect(codeRecipients(sms.sent)).toEqual([CLEANER]);
    expect(sms.sent.find((item) => item.body.includes(DOOR_CODE))?.body).toBe(PRIVATE_PIN);
  });

  it("everyone puts the contacts in the group, uses the cleaner's name, and sends the code with the lock privately to the cleaner only", async () => {
    const { desk, sms, groups } = openDesk([HOST, CLEANER, OBSERVER, SECOND], "1");
    await setUp(desk, {
      contacts: [
        { name: "Sam", role: "co-host", phone: OBSERVER },
        { name: "Lee", role: "assistant", phone: SECOND },
      ],
      groupChat: "everyone",
    });
    expect(sms.sent.find((item) => item.to === OBSERVER)?.body).toContain("Sam, you're invited to the cleaning group");
    expect(sms.sent.find((item) => item.to === CLEANER)?.body).toContain("Ana, you're invited to the cleaning group");
    await desk.inbound({ id: "yes-host", from: HOST, text: "YES" });
    await desk.inbound({ id: "yes-cleaner", from: CLEANER, text: "YES" });
    await desk.inbound({ id: "yes-sam", from: OBSERVER, text: "YES" });
    await desk.inbound({ id: "yes-lee", from: SECOND, text: "YES" });
    await desk.inbound({ id: "yes-schedule", from: CLEANER, text: "YES" });
    await desk.inbound({ id: "time", from: CLEANER, text: "Can we do 2:00 PM?", channel: "group" });
    expect(groups.posts.find((post) => post.body === TIME)?.to).toEqual([HOST, CLEANER, OBSERVER, SECOND].sort());

    ok(await desk.markGuestsLeft({ said: "The guests have left" }, PIN_KEY));
    expect(codeRecipients(sms.sent)).toEqual([CLEANER]);
    expect(sms.sent.find((item) => item.body.includes(DOOR_CODE))?.body).toBe(PRIVATE_PIN);
    expect(groups.posts.some((post) => post.body.includes(DOOR_CODE))).toBe(false);
    const notes = JSON.stringify(ok(desk.getState()));
    expect(notes.includes(DOOR_CODE)).toBe(false);
  });

  it("cleaner-and-host leaves the contacts out of the group", async () => {
    const { desk, sms, groups } = openDesk([HOST, CLEANER, OBSERVER], "1");
    await setUp(desk, { contacts: [{ name: "Sam", role: "observer", phone: OBSERVER }], groupChat: "cleaner-and-host" });
    await desk.inbound({ id: "yes-host", from: HOST, text: "YES" });
    await desk.inbound({ id: "yes-cleaner", from: CLEANER, text: "YES" });
    await desk.inbound({ id: "yes-schedule", from: CLEANER, text: "YES" });
    await desk.inbound({ id: "time", from: CLEANER, text: "Can we do 2:00 PM?", channel: "group" });
    expect(groups.posts.find((post) => post.body === TIME)?.to).toEqual([HOST, CLEANER].sort());
    expect(sms.sent.some((item) => item.to === OBSERVER)).toBe(false);
    ok(await desk.markGuestsLeft({ said: "The guests have left" }, PIN_KEY));
    expect(codeRecipients(sms.sent)).toEqual([CLEANER]);
  });
});

describe("Cleaner Core full setup: the MCP door-code guard", () => {
  it("refuses a door code hidden in a checklist item or a contact name", async () => {
    const { desk } = openDesk([HOST, CLEANER], "0");
    ok(desk.getState("2"));
    ok(desk.saveProperty({ business: BUSINESS, address: ADDRESS, timeZone: ZONE }));
    ok(desk.saveSources({ calendars: [{ name: "Airbnb", url: CALENDAR_URL }] }));
    ok(desk.savePeople({ host: HOST, cleaner: CLEANER }));
    ok(desk.saveDoorCode({ code: DOOR_CODE }, PIN_KEY));
    const send = async (name: string, args: Record<string, unknown>) => {
      const res = await handleCleanerMcpMessage(desk, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, PIN_KEY);
      return res.body as { result?: { isError?: boolean; content?: { text?: string }[] } };
    };
    const item = await send("save_preferences", { checklist: [DOOR_CODE] });
    expect(item.result?.isError).toBe(true);
    expect(item.result?.content?.[0]?.text).toBe("Please don't send the door code in chat. Use the private box instead.");
    const contact = await send("save_people", { host: HOST, cleaner: CLEANER, contacts: [{ name: `Sam ${DOOR_CODE}`, role: "co-host", phone: OBSERVER }] });
    expect(contact.result?.isError).toBe(true);
    expect(contact.result?.content?.[0]?.text).toBe("Please don't send the door code in chat. Use the private box instead.");
  });
});
