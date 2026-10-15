import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NoopOperatorNotificationSink } from "../src/alerts/operatorEvents";
import { OperatorEventOutbox } from "../src/alerts/outbox";
import { cleanerOptOutHold, groupTimeLine } from "../src/cleaner-core/cleanerTexts";
import type { CleanerCore } from "../src/cleaner-core/core";
import { liveDeskFor, resetLiveDesks, setCleanerAlertFetch, setCleanerCalendarFetch, type LiveDesk, type ToolReply } from "../src/cleaner-core/liveDesk";
import { setCleanerGroupFetch, setCleanerTwilioClient } from "../src/cleaner-core/liveSms";
import { handleCleanerMcpMessage } from "../src/cleaner-core/mcp";
import type { GoogleEventList } from "../src/cleaner-core/sources";
import { FileRuntimeStore } from "../src/storage/runtimeStore";
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
const SCHEDULE_NEXT =
  "When should the cleaner get texts? The first cleaning text goes when you confirm the times, or a set number of days after check-in. The reminder goes the morning of checkout, or a set number of days before at a set time. Any quiet hours, and who should hear about problems? If the defaults are fine, save an empty schedule.";
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
  setCleanerAlertFetch(undefined);
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

/** Intl may put a narrow no-break space before AM or PM. */
function plain(text: string): string {
  return text.replace(/[\u202f\u00a0]/g, " ");
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

const SCHEDULE = {
  firstText: "days-after-check-in",
  firstTextDays: 2,
  reminder: "days-before-checkout",
  reminderDays: 1,
  reminderTime: "6:00 PM",
  quietFrom: "9:00 PM",
  quietUntil: "8:00 AM",
  escalateTo: "Sam",
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
    expect(people.structured?.next).toBe(SCHEDULE_NEXT);
    expect((await state(wired)).next).toBe(SCHEDULE_NEXT);

    const schedule = await call(wired, "save_schedule", SCHEDULE);
    expect(schedule.isError).toBe(false);
    expect(schedule.structured?.next).toBe(DOOR_NEXT);
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
      schedule: {
        firstText: "days-after-check-in",
        firstTextDays: 2,
        reminder: "days-before-checkout",
        reminderDays: 1,
        reminderTime: "6:00 PM",
        quietFrom: "9:00 PM",
        quietUntil: "8:00 AM",
        escalateTo: "Sam",
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
    expect((await call(wired, "save_schedule", {})).isError).toBe(false);
    expect((await call(wired, "save_door_code", { code: DOOR_CODE })).isError).toBe(false);
    expect((await state(wired)).next).toBe(PREFERENCES_NEXT);
    expect((await call(wired, "save_preferences", {})).isError).toBe(false);
    const review = await state(wired);
    expect(review.next).toBe(REVIEW_NEXT);
    const setup = review.setup as Record<string, unknown>;
    expect(setup.preferences).toEqual({ checklist: [], photosRequired: false, supplyNotes: false });
    expect(setup.access).toEqual({});
    expect(setup.schedule).toEqual({ firstText: "when-confirmed", reminder: "morning-of", reminderTime: "8:00 AM", escalateTo: "host" });
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
      "save_schedule",
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
    expect((await call(wired, "save_schedule", {})).isError).toBe(false);
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
    expect(plain(alerts[0] ?? "")).toBe("New booking at Lake House: check-in Wednesday, Oct 14, checkout Thursday, Oct 15. Use the usual 10:30 AM checkout and 3:00 PM check-in?");
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

function openDesk(phones: string[], groupChat: "0" | "1", now: () => Date = () => new Date(FROZEN), extraEnv: NodeJS.ProcessEnv = {}) {
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
    ...extraEnv,
  };
  const desk = liveDeskFor(root, () => env, now);
  return { desk, sms, groups, root };
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

/** A clock the test moves by hand. */
function testClock(start: string) {
  let at = new Date(start);
  return {
    now: () => at,
    set(iso: string) {
      at = new Date(iso);
    },
  };
}

type ScheduleInput = Parameters<LiveDesk["saveSchedule"]>[0];

/**
 * Sets up Lake House with a schedule and confirms the first stay's times. The calendar has a stay
 * from Wed Oct 14 to Sun Oct 18 and the next one from Oct 18. The clock starts Oct 14 at 11:00 AM.
 */
/** With no schedule, the engine keeps its defaults (the 8:00 AM morning-of reminder). */
async function withSchedule(schedule: ScheduleInput | undefined, groupChat: "0" | "1") {
  const time = testClock(FROZEN);
  const opened = openDesk([HOST, CLEANER], groupChat, time.now);
  const { desk } = opened;
  ok(desk.getState("2"));
  ok(desk.saveProperty({ business: BUSINESS, nickname: "Lake House", address: ADDRESS, timeZone: ZONE, checkoutTime: "11:00 AM", checkInTime: "4:00 PM" }));
  ok(desk.saveSources({ calendars: [{ name: "Airbnb", url: CALENDAR_URL }] }));
  ok(desk.savePeople({ host: HOST, cleaner: CLEANER, cleanerName: "Ana" }));
  if (schedule) ok(desk.saveSchedule(schedule));
  ok(desk.saveDoorCode({ code: DOOR_CODE, lockLocation: LOCK }, PIN_KEY));
  ok(desk.savePreferences({}));
  ok(await desk.activate());
  ok(await desk.confirmTimes({ checkout: "11:00 AM", checkIn: "4:00 PM" }));
  return { ...opened, time };
}

/** The cleaner (and in a group, the host) opts in. */
async function optIn(desk: LiveDesk, groupChat: "0" | "1") {
  if (groupChat === "1") await desk.inbound({ id: "yes-host", from: HOST, text: "YES" });
  await desk.inbound({ id: "yes-opt-in", from: CLEANER, text: "YES" });
}

function offers(sent: SentSms[]): SentSms[] {
  return sent.filter((item) => item.to === CLEANER && item.body.startsWith("Turnover at"));
}

function reminders(sent: SentSms[]): SentSms[] {
  return sent.filter((item) => item.to === CLEANER && item.body.startsWith("Reminder:"));
}

async function alertsAt(desk: LiveDesk, time: ReturnType<typeof testClock>, iso: string): Promise<string[]> {
  time.set(iso);
  return ((ok(await desk.checkNow()).alerts as string[] | undefined) ?? []).map(plain);
}

const REMINDER_ARRIVAL = `Reminder: cleaning at ${ADDRESS} on Sunday, Oct 18. Checkout is 11:00 AM. What time do you plan to arrive?`;
const NUDGE = "Checkout time at Lake House. Have the guests left?";

describe("Cleaner Core schedule: the first cleaning text", () => {
  for (const groupChat of ["0", "1"] as const) {
    it(`days-after-check-in 2 holds the offer until check-in + 2 days at 9:00 AM, then sends it once (group ${groupChat})`, async () => {
      const { desk, sms, time } = await withSchedule({ firstText: "days-after-check-in", firstTextDays: 2 }, groupChat);
      await optIn(desk, groupChat);
      expect(offers(sms.sent)).toEqual([]);
      await alertsAt(desk, time, "2026-10-16T12:59:00.000Z");
      expect(offers(sms.sent)).toEqual([]);
      await alertsAt(desk, time, "2026-10-16T13:00:00.000Z");
      expect(offers(sms.sent)).toHaveLength(1);
      await alertsAt(desk, time, "2026-10-16T13:05:00.000Z");
      expect(offers(sms.sent)).toHaveLength(1);
      expect(codeRecipients(sms.sent)).toEqual([]);
    });
  }

  it("sends a timed offer no later than 9:00 AM the day before checkout", async () => {
    const { desk, sms, time } = await withSchedule({ firstText: "days-after-check-in", firstTextDays: 14 }, "0");
    await optIn(desk, "0");
    await alertsAt(desk, time, "2026-10-17T12:59:00.000Z");
    expect(offers(sms.sent)).toEqual([]);
    await alertsAt(desk, time, "2026-10-17T13:00:00.000Z");
    expect(offers(sms.sent)).toHaveLength(1);
  });

  it("when-confirmed sends the offer right after the cleaner opts in", async () => {
    const { desk, sms } = await withSchedule({ firstText: "when-confirmed" }, "0");
    await optIn(desk, "0");
    expect(offers(sms.sent)).toHaveLength(1);
  });

  it("never sends a timed offer before the host confirmed the times", async () => {
    const time = testClock(FROZEN);
    const { desk, sms } = openDesk([HOST, CLEANER], "0", time.now);
    ok(desk.getState("2"));
    ok(desk.saveProperty({ business: BUSINESS, nickname: "Lake House", address: ADDRESS, timeZone: ZONE, checkoutTime: "11:00 AM", checkInTime: "4:00 PM" }));
    ok(desk.saveSources({ calendars: [{ name: "Airbnb", url: CALENDAR_URL }] }));
    ok(desk.savePeople({ host: HOST, cleaner: CLEANER }));
    ok(desk.saveSchedule({ firstText: "days-after-check-in", firstTextDays: 1 }));
    ok(desk.saveDoorCode({ code: DOOR_CODE }, PIN_KEY));
    ok(desk.savePreferences({}));
    ok(await desk.activate());
    await alertsAt(desk, time, "2026-10-16T13:00:00.000Z");
    expect(sms.sent.filter((item) => item.to === CLEANER)).toEqual([]);
  });
});

describe("Cleaner Core schedule: the reminder", () => {
  it("days-before-checkout 1 at 6:00 PM sends one reminder that asks for an arrival time", async () => {
    const { desk, sms, time } = await withSchedule({ reminder: "days-before-checkout", reminderDays: 1, reminderTime: "6:00 PM" }, "0");
    await optIn(desk, "0");
    expect(offers(sms.sent)).toHaveLength(1);
    await desk.inbound({ id: "yes-offer", from: CLEANER, text: "YES" });
    await alertsAt(desk, time, "2026-10-17T21:59:00.000Z");
    expect(reminders(sms.sent)).toEqual([]);
    await alertsAt(desk, time, "2026-10-17T22:00:00.000Z");
    expect(reminders(sms.sent).map((item) => plain(item.body))).toEqual([REMINDER_ARRIVAL]);
    await alertsAt(desk, time, "2026-10-17T22:30:00.000Z");
    expect(reminders(sms.sent)).toHaveLength(1);
    expect(codeRecipients(sms.sent)).toEqual([]);
  });

  it("quiet hours hold both the timed offer and the reminder", async () => {
    const { desk, sms, time } = await withSchedule(
      {
        firstText: "days-after-check-in",
        firstTextDays: 2,
        reminder: "days-before-checkout",
        reminderDays: 1,
        reminderTime: "6:00 PM",
        quietFrom: "5:00 PM",
        quietUntil: "10:00 AM",
      },
      "0",
    );
    await optIn(desk, "0");
    await alertsAt(desk, time, "2026-10-16T13:00:00.000Z");
    expect(offers(sms.sent)).toEqual([]);
    await alertsAt(desk, time, "2026-10-16T14:00:00.000Z");
    expect(offers(sms.sent)).toHaveLength(1);
    await desk.inbound({ id: "yes-offer", from: CLEANER, text: "YES" });
    await alertsAt(desk, time, "2026-10-17T22:00:00.000Z");
    expect(reminders(sms.sent)).toEqual([]);
    await alertsAt(desk, time, "2026-10-18T13:59:00.000Z");
    expect(reminders(sms.sent)).toEqual([]);
    await alertsAt(desk, time, "2026-10-18T14:00:00.000Z");
    expect(reminders(sms.sent)).toHaveLength(1);
  });
});

describe("Cleaner Core schedule: changing the schedule", () => {
  it("clearing quiet hours takes effect, so a reminder inside the old window is sent", async () => {
    const { desk, sms, time } = await withSchedule(
      { reminder: "days-before-checkout", reminderDays: 1, reminderTime: "6:00 PM", quietFrom: "5:00 PM", quietUntil: "10:00 AM" },
      "0",
    );
    await optIn(desk, "0");
    await desk.inbound({ id: "yes-offer", from: CLEANER, text: "YES" });
    await alertsAt(desk, time, "2026-10-17T21:30:00.000Z");
    expect(reminders(sms.sent)).toEqual([]);
    ok(desk.saveSchedule({ quietFrom: "", quietUntil: "" }));
    const reviewed = ok(desk.getState());
    expect(JSON.stringify(reviewed).includes("quietFrom")).toBe(false);
    await alertsAt(desk, time, "2026-10-17T22:00:00.000Z");
    expect(reminders(sms.sent)).toHaveLength(1);
  });

  it("a reminder already sent is not sent again when the schedule is saved or its kind changes", async () => {
    const { desk, sms, time } = await withSchedule(undefined, "0");
    await optIn(desk, "0");
    await desk.inbound({ id: "yes-offer", from: CLEANER, text: "YES" });
    await alertsAt(desk, time, "2026-10-18T12:00:00.000Z");
    expect(reminders(sms.sent)).toHaveLength(1);
    ok(desk.saveSchedule({}));
    await alertsAt(desk, time, "2026-10-18T12:10:00.000Z");
    expect(reminders(sms.sent)).toHaveLength(1);
    ok(desk.saveSchedule({ reminder: "days-before-checkout", reminderDays: 1, reminderTime: "6:00 PM" }));
    await alertsAt(desk, time, "2026-10-18T12:20:00.000Z");
    expect(reminders(sms.sent)).toHaveLength(1);
  });

  it("changing the saved reminder's kind after it went out does not send a second one", async () => {
    const { desk, sms, time } = await withSchedule({ reminder: "days-before-checkout", reminderDays: 1, reminderTime: "6:00 PM" }, "0");
    await optIn(desk, "0");
    await desk.inbound({ id: "yes-offer", from: CLEANER, text: "YES" });
    await alertsAt(desk, time, "2026-10-17T22:00:00.000Z");
    expect(reminders(sms.sent)).toHaveLength(1);
    ok(desk.saveSchedule({ reminder: "morning-of", reminderTime: "8:00 AM" }));
    await alertsAt(desk, time, "2026-10-18T12:00:00.000Z");
    expect(reminders(sms.sent)).toHaveLength(1);
  });
});

describe("Cleaner Core schedule: the new-booking alert", () => {
  async function bookingAlert(groupChat: "0" | "1", usual: boolean): Promise<string[]> {
    const { desk } = openDesk([HOST, CLEANER], groupChat);
    ok(desk.getState("2"));
    ok(
      desk.saveProperty({
        business: BUSINESS,
        nickname: "Lake House",
        address: ADDRESS,
        timeZone: ZONE,
        ...(usual ? { checkoutTime: "10:30 AM", checkInTime: "3:00 PM" } : {}),
      }),
    );
    ok(desk.saveSources({ google: true }));
    ok(desk.savePeople({ host: HOST, cleaner: CLEANER }));
    ok(desk.saveSchedule({}));
    ok(desk.saveDoorCode({ code: DOOR_CODE }, PIN_KEY));
    ok(desk.savePreferences({}));
    ok(await desk.activate({ googleEvents: googleList([]) }));
    const checked = ok(await desk.checkNow({ googleEvents: googleList([{ id: "g1", start: "2026-10-14", end: "2026-10-18" }]) }));
    return ((checked.alerts as string[] | undefined) ?? []).map(plain);
  }

  for (const groupChat of ["0", "1"] as const) {
    it(`names the usual times when they are saved (group ${groupChat})`, async () => {
      expect(await bookingAlert(groupChat, true)).toEqual([
        "New booking at Lake House: check-in Wednesday, Oct 14, checkout Sunday, Oct 18. Use the usual 10:30 AM checkout and 3:00 PM check-in?",
      ]);
    });
  }

  it("keeps the existing copy without usual times", async () => {
    expect(await bookingAlert("1", false)).toEqual([`New booking at ${ADDRESS}, checking out Sunday, Oct 18. What are the checkout time and the next check-in time?`]);
    resetLiveDesks();
    expect(await bookingAlert("0", false)).toEqual([`Is checkout at ${ADDRESS} on Sunday, Oct 18 still 11:00 AM? Reply YES or send the new time.`]);
  });
});

describe("Cleaner Core schedule: the checkout-time nudge", () => {
  for (const groupChat of ["0", "1"] as const) {
    it(`asks the host once after the confirmed checkout time, and the code still waits for "guests have left" (group ${groupChat})`, async () => {
      const { desk, sms, time } = await withSchedule({}, groupChat);
      await optIn(desk, groupChat);
      await desk.inbound({ id: "yes-offer", from: CLEANER, text: "YES" });
      expect((await alertsAt(desk, time, "2026-10-18T14:59:00.000Z")).includes(NUDGE)).toBe(false);
      expect((await alertsAt(desk, time, "2026-10-18T15:00:00.000Z")).filter((alert) => alert === NUDGE)).toHaveLength(1);
      expect((await alertsAt(desk, time, "2026-10-18T15:30:00.000Z")).includes(NUDGE)).toBe(false);
      expect(codeRecipients(sms.sent)).toEqual([]);
      ok(await desk.markGuestsLeft({ said: "The guests have left" }, PIN_KEY));
      expect(codeRecipients(sms.sent)).toEqual([CLEANER]);
      expect((await alertsAt(desk, time, "2026-10-18T16:00:00.000Z")).includes(NUDGE)).toBe(false);
    });
  }
});

describe("Cleaner Core schedule: save_schedule", () => {
  it("refuses days outside 1 to 14, a bad time, one-sided quiet hours, and a door code", async () => {
    const { desk } = openDesk([HOST, CLEANER], "0");
    ok(desk.getState("2"));
    ok(desk.saveProperty({ business: BUSINESS, address: ADDRESS, timeZone: ZONE }));
    expect(desk.saveSchedule({}).ok).toBe(false);
    ok(desk.saveSources({ calendars: [{ name: "Airbnb", url: CALENDAR_URL }] }));
    ok(desk.savePeople({ host: HOST, cleaner: CLEANER }));
    ok(desk.saveDoorCode({ code: DOOR_CODE }, PIN_KEY));
    expect(desk.saveSchedule({ firstText: "days-after-check-in" }).ok).toBe(false);
    expect(desk.saveSchedule({ firstText: "days-after-check-in", firstTextDays: 0 }).ok).toBe(false);
    expect(desk.saveSchedule({ firstText: "days-after-check-in", firstTextDays: 15 }).ok).toBe(false);
    expect(desk.saveSchedule({ firstText: "days-after-check-in", firstTextDays: 1.5 }).ok).toBe(false);
    expect(desk.saveSchedule({ reminder: "days-before-checkout", reminderTime: "6:00 PM" }).ok).toBe(false);
    expect(desk.saveSchedule({ reminderTime: "18" }).ok).toBe(false);
    expect(desk.saveSchedule({ quietFrom: "9:00 PM" }).ok).toBe(false);
    expect(desk.saveSchedule({ escalateTo: `Sam ${DOOR_CODE}` }).ok).toBe(false);
    expect(desk.saveSchedule({ firstText: "never" as never }).ok).toBe(false);
    expect(ok(desk.getState()).next).toBe(SCHEDULE_NEXT);
    expect(ok(desk.saveSchedule({ reminder: "days-before-checkout", reminderDays: 14, reminderTime: "7:30 AM" })).next).toBe(PREFERENCES_NEXT);
  });
});

interface Message {
  id: string;
  from: string;
  name: string;
  text: string;
  at: string;
  handled: string;
}

async function messagesNow(desk: LiveDesk): Promise<Message[]> {
  return (ok(await desk.checkNow()).messages as Message[] | undefined) ?? [];
}

function brief(messages: Message[]): { from: string; name: string; text: string; handled: string }[] {
  return messages.map(({ from, name, text, handled }) => ({ from, name, text, handled }));
}

function wakes(root: string) {
  const outbox = new OperatorEventOutbox(new FileRuntimeStore(join(root, "cleaner-alerts")), () => new NoopOperatorNotificationSink());
  return outbox.records().filter((record) => record.event.eventType === "cleaning.update");
}

async function mcp(desk: LiveDesk, method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>> {
  const reply = await handleCleanerMcpMessage(desk, { jsonrpc: "2.0", id: 1, method, ...(params ? { params } : {}) }, PIN_KEY);
  return (reply.body as { result: Record<string, unknown> }).result;
}

/** Cleaner-only Lake House with the cleaner opted in and the offer taken. */
async function confirmedCleaner(extraEnv: NodeJS.ProcessEnv = {}) {
  const opened = openDesk([HOST, CLEANER], "0", () => new Date(FROZEN), extraEnv);
  await setUp(opened.desk, { groupChat: "cleaner-only" });
  await opened.desk.inbound({ id: "yes-opt-in", from: CLEANER, text: "YES" });
  await opened.desk.inbound({ id: "yes-offer", from: CLEANER, text: "YES" });
  return opened;
}

const ARRIVAL_TEXT = "Yes I'll be there around 11:30";

describe("Cleaner Core messages: Grok reads every message", () => {
  it("records a non-keyword text with handled none and sends the cleaner no reply", async () => {
    const { desk, sms } = await confirmedCleaner();
    const before = sms.sent.filter((item) => item.to === CLEANER).length;
    await desk.inbound({ id: "arrival", from: CLEANER, text: ARRIVAL_TEXT });
    expect(sms.sent.filter((item) => item.to === CLEANER)).toHaveLength(before);
    expect(brief(await messagesNow(desk))).toEqual([
      { from: "cleaner", name: "Ana", text: "YES", handled: "opted-in" },
      { from: "cleaner", name: "Ana", text: "YES", handled: "confirmed" },
      { from: "cleaner", name: "Ana", text: ARRIVAL_TEXT, handled: "none" },
    ]);
  });

  it("records DONE as done", async () => {
    const { desk } = await confirmedCleaner();
    ok(await desk.markGuestsLeft({ said: "The guests have left" }, PIN_KEY));
    await desk.inbound({ id: "done", from: CLEANER, text: "DONE" });
    expect(brief(await messagesNow(desk)).at(-1)).toEqual({ from: "cleaner", name: "Ana", text: "DONE", handled: "done" });
  });

  it("still guides a near-miss YES on an offer to reply YES, and records it", async () => {
    const { desk, sms } = openDesk([HOST, CLEANER], "0");
    await setUp(desk, { groupChat: "cleaner-only" });
    await desk.inbound({ id: "yes-opt-in", from: CLEANER, text: "YES" });
    expect((ok(desk.getTurns()).turns as { status: string }[])[0]?.status).toBe("offered");
    await desk.inbound({ id: "near-yes", from: CLEANER, text: ARRIVAL_TEXT });
    expect(sms.sent.at(-1)).toEqual(expect.objectContaining({ to: CLEANER, body: "Reply YES to schedule the cleaning, or STOP to opt out." }));
    expect(brief(await messagesNow(desk)).at(-1)).toEqual({ from: "cleaner", name: "Ana", text: ARRIVAL_TEXT, handled: "none" });
  });

  it("still guides a near-miss DONE during the cleaning to reply DONE, and records it", async () => {
    const { desk, sms } = await confirmedCleaner();
    ok(await desk.markGuestsLeft({ said: "The guests have left" }, PIN_KEY));
    await desk.inbound({ id: "all-done", from: CLEANER, text: "All done!" });
    expect(sms.sent.at(-1)).toEqual(expect.objectContaining({ to: CLEANER, body: "Reply DONE when the cleaning is finished." }));
    expect(brief(await messagesNow(desk)).at(-1)).toEqual({ from: "cleaner", name: "Ana", text: "All done!", handled: "none" });
  });

  it("sends no reply to free text while the cleaner waits for the guests to leave", async () => {
    const { desk, sms } = await confirmedCleaner();
    const before = sms.sent.length;
    await desk.inbound({ id: "free", from: CLEANER, text: "Do you want me to bring extra towels?" });
    expect(sms.sent).toHaveLength(before);
    expect(brief(await messagesNow(desk)).at(-1)?.handled).toBe("none");
  });

  it("labels a DONE none when its acknowledgement didn't go out, and the job stays open", async () => {
    const { desk, sms } = await confirmedCleaner();
    ok(await desk.markGuestsLeft({ said: "The guests have left" }, PIN_KEY));
    setCleanerTwilioClient({
      ...sms,
      async sendSms(input) {
        if (input.body === "Thanks, cleaning marked done.") throw new Error("carrier down");
        return sms.sendSms(input);
      },
    });
    await desk.inbound({ id: "done-failed", from: CLEANER, text: "DONE" });
    expect(brief(await messagesNow(desk)).at(-1)).toEqual({ from: "cleaner", name: "Ana", text: "DONE", handled: "none" });
    expect((ok(desk.getTurns()).turns as { status: string }[]).map((turn) => turn.status)).not.toContain("done");
  });

  it("records STOP as stop and still sends the host the existing note", async () => {
    const { desk, sms } = await confirmedCleaner();
    await desk.inbound({ id: "stop", from: CLEANER, text: "STOP" });
    expect(sms.sent.filter((item) => item.to === HOST).map((item) => item.body)).toContain(cleanerOptOutHold(ADDRESS));
    expect(brief(await messagesNow(desk)).at(-1)).toEqual({ from: "cleaner", name: "Ana", text: "STOP", handled: "stop" });
  });

  it("records an injury and still sends the host the direct injury text", async () => {
    const { desk, sms } = await confirmedCleaner();
    await desk.inbound({ id: "hurt", from: CLEANER, text: "I fell and I'm hurt" });
    expect(sms.sent.filter((item) => item.to === HOST).map((item) => item.body)).toContain(`The cleaner at ${ADDRESS} says someone is hurt. They've been told to call 911.`);
    expect(brief(await messagesNow(desk)).at(-1)).toEqual({ from: "cleaner", name: "Ana", text: "I fell and I'm hurt", handled: "injury" });
  });

  it("redacts the door code from a message, and holds a code-only text", async () => {
    const { desk, root } = await confirmedCleaner();
    await desk.inbound({ id: "code-only", from: CLEANER, text: DOOR_CODE });
    await desk.inbound({ id: "code-in", from: CLEANER, text: `Is the code ${DOOR_CODE}?` });
    const reply = ok(await desk.checkNow());
    const messages = brief((reply.messages as Message[] | undefined) ?? []).slice(-2);
    expect(messages[0]).toEqual({ from: "cleaner", name: "Ana", text: "[redacted]", handled: "code-held" });
    expect(messages[1]?.text).toBe("Is the code [redacted]?");
    expect(JSON.stringify(reply).includes(DOOR_CODE)).toBe(false);
    expect(readFileSync(join(root, "cleaner-live.json"), "utf8").includes(DOOR_CODE)).toBe(false);
  });

  it("keeps a message to 300 characters", async () => {
    const { desk } = await confirmedCleaner();
    await desk.inbound({ id: "long", from: CLEANER, text: `  ${"a".repeat(400)}  ` });
    expect((await messagesNow(desk)).at(-1)?.text).toBe("a".repeat(300));
  });

  it("records group messages from the cleaner and a saved contact", async () => {
    const { desk } = openDesk([HOST, CLEANER, OBSERVER], "1");
    await setUp(desk, { contacts: [{ name: "Sam", role: "co-host", phone: OBSERVER }], groupChat: "everyone" });
    await desk.inbound({ id: "yes-host", from: HOST, text: "YES" });
    await desk.inbound({ id: "yes-cleaner", from: CLEANER, text: "YES" });
    await desk.inbound({ id: "yes-sam", from: OBSERVER, text: "YES" });
    await desk.inbound({ id: "g-cleaner", from: CLEANER, text: "Running a little behind today", channel: "group" });
    await desk.inbound({ id: "g-sam", from: OBSERVER, text: "See you all tomorrow", channel: "group" });
    const messages = brief(await messagesNow(desk));
    expect(messages).toEqual(
      expect.arrayContaining([
        { from: "cleaner", name: "Ana", text: "Running a little behind today", handled: "none" },
        { from: "contact", name: "Sam", text: "See you all tomorrow", handled: "none" },
      ]),
    );
  });

  it("wakes the routine for each new message, with one pending wake", async () => {
    const posts: string[] = [];
    let status = 200;
    setCleanerAlertFetch(async (_url, init) => {
      posts.push(init.body);
      return { status };
    });
    const { desk, root } = await confirmedCleaner({ CLEANER_CORE_ROUTINE_URL: "https://routine.example/hook", CLEANER_CORE_ROUTINE_KEY: "k-test-routine-key" });
    await desk.drainAlerts();
    const started = posts.length;
    await desk.inbound({ id: "m1", from: CLEANER, text: "On my way" });
    await desk.drainAlerts();
    expect(posts).toHaveLength(started + 1);
    await desk.inbound({ id: "m2", from: CLEANER, text: ARRIVAL_TEXT });
    await desk.drainAlerts();
    expect(posts).toHaveLength(started + 2);
    status = 503;
    await desk.inbound({ id: "m3", from: CLEANER, text: "Out of paper towels" });
    await desk.inbound({ id: "m4", from: CLEANER, text: "Never mind, found some" });
    expect(wakes(root).filter((record) => record.status === "pending")).toHaveLength(1);
  });

  it("does not repeat messages on a second check_now", async () => {
    const { desk } = await confirmedCleaner();
    await desk.inbound({ id: "arrival", from: CLEANER, text: ARRIVAL_TEXT });
    expect(await messagesNow(desk)).toHaveLength(3);
    expect(await messagesNow(desk)).toEqual([]);
    await desk.inbound({ id: "late", from: CLEANER, text: "Running late" });
    expect(brief(await messagesNow(desk))).toEqual([{ from: "cleaner", name: "Ana", text: "Running late", handled: "none" }]);
  });
});

describe("Cleaner Core messages: save_arrival", () => {
  it("saves an AM or PM arrival time on the open job and shows it in turns", async () => {
    const { desk } = await confirmedCleaner();
    expect(desk.saveArrival({ time: "11:30" }).ok).toBe(false);
    const saved = ok(desk.saveArrival({ time: "11:30 AM" }));
    const turns = (saved.turns as { arrivalTime?: string }[] | undefined) ?? [];
    expect(plain(turns[0]?.arrivalTime ?? "")).toBe("11:30 AM");
    const listed = (ok(desk.getTurns()).turns as { arrivalTime?: string }[] | undefined) ?? [];
    expect(plain(listed[0]?.arrivalTime ?? "")).toBe("11:30 AM");
  });

  it("fails with no open cleaning", async () => {
    const { desk } = openDesk([HOST, CLEANER], "0");
    ok(desk.getState("2"));
    ok(desk.saveProperty({ business: BUSINESS, address: ADDRESS, timeZone: ZONE }));
    ok(desk.saveSources({ google: true }));
    ok(desk.savePeople({ host: HOST, cleaner: CLEANER }));
    ok(desk.saveDoorCode({ code: DOOR_CODE }, PIN_KEY));
    ok(desk.savePreferences({}));
    ok(await desk.activate({ googleEvents: googleList([]) }));
    expect(desk.saveArrival({ time: "11:30 AM" })).toEqual({ ok: false, error: "There's no open cleaning to save an arrival time for." });
  });

  it("lists save_arrival and tells Grok to read every message", async () => {
    const { desk } = await confirmedCleaner();
    const tools = ((await mcp(desk, "tools/list")).tools as { name: string; description: string }[]) ?? [];
    expect(tools.find((tool) => tool.name === "save_arrival")?.description).toBe("Saves the cleaner's arrival time after you read it in their message. Use AM or PM.");
    const text = String((await mcp(desk, "initialize")).instructions);
    expect(text).toContain(
      "Read every message check_now returns. Tell the host in your own words when a message needs them: running late, a question, a problem, supplies, an arrival time, a decline, STOP, or an injury. Stay quiet on routine replies. If a message gives an arrival time, call save_arrival.",
    );
    const called = await mcp(desk, "tools/call", { name: "save_arrival", arguments: { time: "1:15 PM" } });
    expect(called.isError).toBe(false);
  });
});
