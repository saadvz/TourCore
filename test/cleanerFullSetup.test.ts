import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NoopOperatorNotificationSink } from "../src/alerts/operatorEvents";
import { OperatorEventOutbox } from "../src/alerts/outbox";
import { cleanerOptOutHold, groupTimeLine, offerForOthers } from "../src/cleaner-core/cleanerTexts";
import type { CleanerCore } from "../src/cleaner-core/core";
import { DOOR_CODE_IN_CHAT, drainCleanerAlerts, liveDeskFor, resetLiveDesks, setCleanerAlertFetch, setCleanerCalendarFetch, type LiveDesk, type ToolReply } from "../src/cleaner-core/liveDesk";
import { isScratchTestNumber } from "../src/cleaner-core/scratch";
import { setCleanerGroupFetch, setCleanerTwilioClient } from "../src/cleaner-core/liveSms";
import { handleCleanerMcpMessage } from "../src/cleaner-core/mcp";
import { photoKey, servePhoto, setCleanerPhotoFetch } from "../src/cleaner-core/photos";
import type { GoogleEventList } from "../src/cleaner-core/sources";
import { SCRATCH_TENANTS } from "../src/cleaner-core/tenants";
import { CLEANER_SCOPE } from "../src/mcp/oauth/provider";
import { twilioSignature } from "../src/messaging/twilio/signature";
import { FileRuntimeStore } from "../src/storage/runtimeStore";
import { BASE, CLEANER_RESOURCE, closeHostedApps, hostedApp } from "./cleanerOauthHarness";
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
  OFF_LIST,
  PIN_KEY_HEADER,
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
  setCleanerPhotoFetch(undefined);
  resetLiveDesks();
  closeHostedApps();
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
  return { desk, sms, groups, root, env };
}

function ok(reply: ToolReply): Record<string, unknown> {
  if (!reply.ok) throw new Error(reply.error);
  return reply.result;
}

type PeopleInput = Parameters<LiveDesk["savePeople"]>[0];

async function setUp(desk: LiveDesk, people: Partial<PeopleInput>) {
  ok(await desk.getState("2"));
  ok(await desk.saveProperty({ business: BUSINESS, address: ADDRESS, timeZone: ZONE, checkoutTime: "10:30 AM", checkInTime: "3:00 PM" }));
  ok(await desk.saveSources({ calendars: [{ name: "Airbnb", url: CALENDAR_URL }] }));
  ok(await desk.savePeople({ host: HOST, cleaner: CLEANER, cleanerName: "Ana", ...people }));
  ok(await desk.saveDoorCode({ code: DOOR_CODE, lockLocation: LOCK }, PIN_KEY));
  ok(await desk.savePreferences({}));
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
    expect((ok(await desk.getState()).done as string[]).some((line) => line.startsWith("Group chat set up"))).toBe(false);
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
    const notes = JSON.stringify(ok(await desk.getState()));
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
    ok(await desk.getState("2"));
    ok(await desk.saveProperty({ business: BUSINESS, address: ADDRESS, timeZone: ZONE }));
    ok(await desk.saveSources({ calendars: [{ name: "Airbnb", url: CALENDAR_URL }] }));
    ok(await desk.savePeople({ host: HOST, cleaner: CLEANER }));
    ok(await desk.saveDoorCode({ code: DOOR_CODE }, PIN_KEY));
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

describe("Cleaner Core door-code check: every host free text", () => {
  const REFUSED = { ok: false, error: DOOR_CODE_IN_CHAT };

  /** Lake House up to the door code, saved as `code` (made up) when one is given. */
  async function atDoorCode(code?: string) {
    const opened = openDesk([HOST, CLEANER], "0");
    const { desk } = opened;
    ok(await desk.getState("2"));
    ok(await desk.saveProperty({ business: BUSINESS, address: ADDRESS, timeZone: ZONE }));
    ok(await desk.saveSources({ calendars: [{ name: "Airbnb", url: CALENDAR_URL }] }));
    ok(await desk.savePeople({ host: HOST, cleaner: CLEANER }));
    if (code) ok(await desk.saveDoorCode({ code }, PIN_KEY));
    return opened;
  }

  const savedFile = (root: string) => readFileSync(join(root, "cleaner-live.json"), "utf8");

  it("refuses instructions that hold the code after a restart, with the code sealed and with it opened", async () => {
    const { root, env } = await atDoorCode("4827");
    resetLiveDesks();
    const restarted = liveDeskFor(root, () => env, () => new Date(FROZEN));
    const instructions = "Lockbox opens with 4827";
    // No key opens the seal, so any run of 4 digits might be the code.
    expect(await restarted.savePreferences({ instructions })).toEqual(REFUSED);
    const viaChat = await handleCleanerMcpMessage(restarted, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "save_preferences", arguments: { instructions } } });
    expect((viaChat.body as { result: { isError: boolean; content: { text: string }[] } }).result).toEqual(
      expect.objectContaining({ isError: true, content: [{ type: "text", text: DOOR_CODE_IN_CHAT }] }),
    );
    // With the key, save_preferences opens the seal and finds the code itself.
    expect(await restarted.savePreferences({ instructions }, PIN_KEY)).toEqual(REFUSED);
    expect(savedFile(root).includes("4827")).toBe(false);
    ok(await restarted.savePreferences({ instructions: "Leave the porch light on." }, PIN_KEY));
  });

  it("refuses a split code in instructions or a checklist item with the code in memory", async () => {
    const { desk, root } = await atDoorCode("4827");
    for (const text of ["Lockbox opens with 48 27", "Code 4-8-2-7 at the back", "It's 4.8.2.7 today"]) {
      expect(await desk.savePreferences({ instructions: text }), text).toEqual(REFUSED);
      expect(await desk.savePreferences({ checklist: ["Strip the beds", text] }), text).toEqual(REFUSED);
    }
    expect(JSON.parse(savedFile(root)).preferences).toBeUndefined();
    ok(await desk.savePreferences({ checklist: ["Unit 12 towels"], instructions: "Gate 3 sticks." }));
  });

  it("refuses a lock location like 80 88 on the first save", async () => {
    const { desk, root } = await atDoorCode();
    for (const lockLocation of ["80 88", "lockbox 8-0-8-8", "box 4 4 1 7"]) {
      expect((await desk.saveDoorCode({ code: DOOR_CODE, lockLocation }, PIN_KEY)).ok, lockLocation).toBe(false);
    }
    expect(savedFile(root)).not.toContain("pinSeal");
    expect(savedFile(root)).not.toContain("80 88");
    ok(await desk.saveDoorCode({ code: DOOR_CODE, lockLocation: "Unit 12 side gate" }, PIN_KEY));
  });

  it("refuses the code in a cleaner, contact, or calendar name, a calendar link, or who hears about problems", async () => {
    const { desk, root, env } = await atDoorCode(DOOR_CODE);
    const split = "80 88";
    expect(await desk.savePeople({ host: HOST, cleaner: CLEANER, cleanerName: `Ana ${split}` })).toEqual(REFUSED);
    expect(await desk.savePeople({ host: HOST, cleaner: CLEANER, contacts: [{ name: `Sam ${split}`, role: "co-host", phone: OBSERVER }] })).toEqual(REFUSED);
    expect(await desk.saveSchedule({ escalateTo: `Sam ${split}` })).toEqual(REFUSED);
    expect(await desk.saveSources({ calendars: [{ name: `Airbnb ${split}`, url: CALENDAR_URL }] })).toEqual(REFUSED);
    expect(await desk.saveSources({ calendars: [{ name: "Airbnb", url: `${CALENDAR_URL}?k=${DOOR_CODE}` }] })).toEqual(REFUSED);
    expect(await desk.saveCalendarLink({ url: `${CALENDAR_URL}?k=${split}` })).toEqual(REFUSED);
    // Sealed after a restart with no key: a run of 4 digits is refused, a name without one is kept.
    resetLiveDesks();
    const restarted = liveDeskFor(root, () => env, () => new Date(FROZEN));
    expect(await restarted.saveSchedule({ escalateTo: "Sam 4417" })).toEqual(REFUSED);
    ok(await restarted.saveSchedule({ escalateTo: "Sam" }));
    for (const form of [split, DOOR_CODE, "4417"]) expect(savedFile(root).includes(form), form).toBe(false);
  });

  it("stores and returns a cleaner's split door code redacted", async () => {
    const { desk, root } = await confirmedCleaner();
    await desk.inbound({ id: "split-code", from: CLEANER, text: "the code 80-88 isn't working" });
    await desk.inbound({ id: "spaced-code", from: CLEANER, text: "is it 8 0 8 8?" });
    const reply = ok(await desk.checkNow());
    expect(brief((reply.messages as Message[] | undefined) ?? []).slice(-2).map((message) => message.text)).toEqual([
      "the code [redacted] isn't working",
      "is it [redacted]?",
    ]);
    for (const form of ["80-88", "8 0 8 8", DOOR_CODE]) {
      expect(JSON.stringify(reply).includes(form), form).toBe(false);
      expect(savedFile(root).includes(form), form).toBe(false);
    }
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
  ok(await desk.getState("2"));
  ok(await desk.saveProperty({ business: BUSINESS, nickname: "Lake House", address: ADDRESS, timeZone: ZONE, checkoutTime: "11:00 AM", checkInTime: "4:00 PM" }));
  ok(await desk.saveSources({ calendars: [{ name: "Airbnb", url: CALENDAR_URL }] }));
  ok(await desk.savePeople({ host: HOST, cleaner: CLEANER, cleanerName: "Ana" }));
  if (schedule) ok(await desk.saveSchedule(schedule));
  ok(await desk.saveDoorCode({ code: DOOR_CODE, lockLocation: LOCK }, PIN_KEY));
  ok(await desk.savePreferences({}));
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
    ok(await desk.getState("2"));
    ok(await desk.saveProperty({ business: BUSINESS, nickname: "Lake House", address: ADDRESS, timeZone: ZONE, checkoutTime: "11:00 AM", checkInTime: "4:00 PM" }));
    ok(await desk.saveSources({ calendars: [{ name: "Airbnb", url: CALENDAR_URL }] }));
    ok(await desk.savePeople({ host: HOST, cleaner: CLEANER }));
    ok(await desk.saveSchedule({ firstText: "days-after-check-in", firstTextDays: 1 }));
    ok(await desk.saveDoorCode({ code: DOOR_CODE }, PIN_KEY));
    ok(await desk.savePreferences({}));
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
    ok(await desk.saveSchedule({ quietFrom: "", quietUntil: "" }));
    const reviewed = ok(await desk.getState());
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
    ok(await desk.saveSchedule({}));
    await alertsAt(desk, time, "2026-10-18T12:10:00.000Z");
    expect(reminders(sms.sent)).toHaveLength(1);
    ok(await desk.saveSchedule({ reminder: "days-before-checkout", reminderDays: 1, reminderTime: "6:00 PM" }));
    await alertsAt(desk, time, "2026-10-18T12:20:00.000Z");
    expect(reminders(sms.sent)).toHaveLength(1);
  });

  it("changing the saved reminder's kind after it went out does not send a second one", async () => {
    const { desk, sms, time } = await withSchedule({ reminder: "days-before-checkout", reminderDays: 1, reminderTime: "6:00 PM" }, "0");
    await optIn(desk, "0");
    await desk.inbound({ id: "yes-offer", from: CLEANER, text: "YES" });
    await alertsAt(desk, time, "2026-10-17T22:00:00.000Z");
    expect(reminders(sms.sent)).toHaveLength(1);
    ok(await desk.saveSchedule({ reminder: "morning-of", reminderTime: "8:00 AM" }));
    await alertsAt(desk, time, "2026-10-18T12:00:00.000Z");
    expect(reminders(sms.sent)).toHaveLength(1);
  });
});

describe("Cleaner Core: one step at a time", () => {
  it("check_now with a slow calendar read beside save_schedule and save_arrival loses nothing, sends nothing twice, and doesn't crash", async () => {
    const { desk, sms, time, root, env } = await withSchedule({ reminder: "days-before-checkout", reminderDays: 1, reminderTime: "6:00 PM" }, "0");
    await optIn(desk, "0");
    await desk.inbound({ id: "yes-offer", from: CLEANER, text: "YES" });
    let started = (): void => undefined;
    const reading = new Promise<void>((resolve) => {
      started = resolve;
    });
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    // The calendar read hangs until the test lets it go.
    setCleanerCalendarFetch(async (url) => {
      started();
      await held;
      return { status: url === CALENDAR_URL ? 200 : 404, url, text: async () => (url === CALENDAR_URL ? CALENDAR_ICS : "") };
    });
    time.set("2026-10-17T22:00:00.000Z");
    const checking = desk.checkNow();
    await reading;
    const schedule = desk.saveSchedule({ quietFrom: "9:00 PM", quietUntil: "8:00 AM" });
    const arrival = desk.saveArrival({ time: "11:30 AM" });
    const state = desk.getState();
    const turns = desk.getTurns();
    release();
    const replies = await Promise.all([checking, schedule, arrival, state, turns]);
    for (const reply of replies) ok(reply);
    expect(reminders(sms.sent).map((item) => plain(item.body))).toEqual([REMINDER_ARRIVAL]);

    // Every later step, and a restart, sees the reminder as sent, the arrival time, and the schedule.
    const arrived = (reply: ToolReply) => (ok(reply).turns as { arrivalTime?: string }[]).map((turn) => turn.arrivalTime);
    await alertsAt(desk, time, "2026-10-17T22:30:00.000Z");
    expect(reminders(sms.sent)).toHaveLength(1);
    expect(arrived(await desk.getTurns())[0]).toBe("11:30 AM");
    resetLiveDesks();
    const restarted = liveDeskFor(root, () => env, time.now);
    await alertsAt(restarted, time, "2026-10-17T23:00:00.000Z");
    expect(reminders(sms.sent)).toHaveLength(1);
    expect(arrived(await restarted.getTurns())[0]).toBe("11:30 AM");
    const saved = JSON.parse(readFileSync(join(root, "cleaner-live.json"), "utf8")) as { schedule?: { quietFrom?: string; reminderTime?: string } };
    expect(saved.schedule).toEqual(expect.objectContaining({ quietFrom: "21:00", reminderTime: "18:00" }));
    expect(codeRecipients(sms.sent)).toEqual([]);
  });
});

describe("Cleaner Core schedule: the new-booking alert", () => {
  async function bookingAlert(groupChat: "0" | "1", usual: boolean): Promise<string[]> {
    const { desk } = openDesk([HOST, CLEANER], groupChat);
    ok(await desk.getState("2"));
    ok(
      await desk.saveProperty({
        business: BUSINESS,
        nickname: "Lake House",
        address: ADDRESS,
        timeZone: ZONE,
        ...(usual ? { checkoutTime: "10:30 AM", checkInTime: "3:00 PM" } : {}),
      }),
    );
    ok(await desk.saveSources({ google: true }));
    ok(await desk.savePeople({ host: HOST, cleaner: CLEANER }));
    ok(await desk.saveSchedule({}));
    ok(await desk.saveDoorCode({ code: DOOR_CODE }, PIN_KEY));
    ok(await desk.savePreferences({}));
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
    ok(await desk.getState("2"));
    ok(await desk.saveProperty({ business: BUSINESS, address: ADDRESS, timeZone: ZONE }));
    expect((await desk.saveSchedule({})).ok).toBe(false);
    ok(await desk.saveSources({ calendars: [{ name: "Airbnb", url: CALENDAR_URL }] }));
    ok(await desk.savePeople({ host: HOST, cleaner: CLEANER }));
    ok(await desk.saveDoorCode({ code: DOOR_CODE }, PIN_KEY));
    expect((await desk.saveSchedule({ firstText: "days-after-check-in" })).ok).toBe(false);
    expect((await desk.saveSchedule({ firstText: "days-after-check-in", firstTextDays: 0 })).ok).toBe(false);
    expect((await desk.saveSchedule({ firstText: "days-after-check-in", firstTextDays: 15 })).ok).toBe(false);
    expect((await desk.saveSchedule({ firstText: "days-after-check-in", firstTextDays: 1.5 })).ok).toBe(false);
    expect((await desk.saveSchedule({ reminder: "days-before-checkout", reminderTime: "6:00 PM" })).ok).toBe(false);
    expect((await desk.saveSchedule({ reminderTime: "18" })).ok).toBe(false);
    expect((await desk.saveSchedule({ quietFrom: "9:00 PM" })).ok).toBe(false);
    expect((await desk.saveSchedule({ escalateTo: `Sam ${DOOR_CODE}` })).ok).toBe(false);
    expect((await desk.saveSchedule({ firstText: "never" as never })).ok).toBe(false);
    expect(ok(await desk.getState()).next).toBe(SCHEDULE_NEXT);
    expect(ok(await desk.saveSchedule({ reminder: "days-before-checkout", reminderDays: 14, reminderTime: "7:30 AM" })).next).toBe(PREFERENCES_NEXT);
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
    expect((ok(await desk.getTurns()).turns as { status: string }[])[0]?.status).toBe("offered");
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
    expect((ok(await desk.getTurns()).turns as { status: string }[]).map((turn) => turn.status)).not.toContain("done");
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
    expect((await desk.saveArrival({ time: "11:30" })).ok).toBe(false);
    const saved = ok(await desk.saveArrival({ time: "11:30 AM" }));
    const turns = (saved.turns as { arrivalTime?: string }[] | undefined) ?? [];
    expect(plain(turns[0]?.arrivalTime ?? "")).toBe("11:30 AM");
    const listed = (ok(await desk.getTurns()).turns as { arrivalTime?: string }[] | undefined) ?? [];
    expect(plain(listed[0]?.arrivalTime ?? "")).toBe("11:30 AM");
  });

  it("fails with no open cleaning", async () => {
    const { desk } = openDesk([HOST, CLEANER], "0");
    ok(await desk.getState("2"));
    ok(await desk.saveProperty({ business: BUSINESS, address: ADDRESS, timeZone: ZONE }));
    ok(await desk.saveSources({ google: true }));
    ok(await desk.savePeople({ host: HOST, cleaner: CLEANER }));
    ok(await desk.saveDoorCode({ code: DOOR_CODE }, PIN_KEY));
    ok(await desk.savePreferences({}));
    ok(await desk.activate({ googleEvents: googleList([]) }));
    expect(await desk.saveArrival({ time: "11:30 AM" })).toEqual({ ok: false, error: "There's no open cleaning to save an arrival time for." });
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

const LATE = "Guests are running late today. Please start at 12:30 PM instead.";
const APPROVAL_STALE = "That approval has expired or doesn't match. Ask the host again.";

interface Approval {
  code: string;
  question: string;
  expiresInMinutes: number;
}

async function preview(desk: LiveDesk, to: string, text: string): Promise<Approval> {
  const reply = ok(await desk.sendMessage({ to, text }));
  return reply.confirmation as Approval;
}

function hostOutbox(desk: LiveDesk) {
  const engine = (desk as unknown as { engine: CleanerCore }).engine;
  return engine.outbox().filter((item) => item.kind === "host-message");
}

/** Group chat everyone with the host, the cleaner, and Sam in the group. */
async function groupEveryone() {
  const opened = openDesk([HOST, CLEANER, OBSERVER], "1");
  await setUp(opened.desk, { contacts: [{ name: "Sam", role: "co-host", phone: OBSERVER }], groupChat: "everyone" });
  await opened.desk.inbound({ id: "yes-host", from: HOST, text: "YES" });
  await opened.desk.inbound({ id: "yes-cleaner", from: CLEANER, text: "YES" });
  await opened.desk.inbound({ id: "yes-sam", from: OBSERVER, text: "YES" });
  return opened;
}

describe("Cleaner Core send_message: the host approves first", () => {
  it("a preview returns a code and the exact question, and sends nothing", async () => {
    const { desk, sms } = await confirmedCleaner();
    const before = sms.sent.length;
    const reply = ok(await desk.sendMessage({ to: "cleaner", text: LATE }));
    expect(reply.preview).toEqual({ to: "Ana", text: LATE });
    const approval = reply.confirmation as Approval;
    expect(approval.code).toMatch(/^[A-Z2-9]{6}$/);
    expect(approval.question).toBe(`Send to Ana: "${LATE}"?`);
    expect(approval.expiresInMinutes).toBe(10);
    expect(sms.sent).toHaveLength(before);
    expect(hostOutbox(desk)).toEqual([]);
  });

  it("redeeming with the same to and text sends exactly one text to the cleaner, and records it", async () => {
    const { desk, sms, root } = await confirmedCleaner();
    const approval = await preview(desk, "cleaner", LATE);
    await messagesNow(desk);
    const before = sms.sent.length;
    expect(ok(await desk.sendMessage({ to: "cleaner", text: LATE, confirmation: approval.code }))).toEqual({ next: "Sent to Ana." });
    expect(sms.sent.slice(before)).toEqual([expect.objectContaining({ to: CLEANER, body: LATE })]);
    expect(hostOutbox(desk)).toEqual([expect.objectContaining({ to: CLEANER, body: LATE, kind: "host-message", status: "sent" })]);
    const file = JSON.parse(readFileSync(join(root, "cleaner-live.json"), "utf8")) as { messages: Message[] };
    expect(file.messages.at(-1)).toEqual(expect.objectContaining({ from: "host", name: "Host", to: "Ana", text: LATE, handled: "sent" }));
    // Grok sent it, so check_now doesn't hand it back as new.
    expect(await messagesNow(desk)).toEqual([]);
  });

  it("refuses the same code with a changed text or recipient, and sends nothing", async () => {
    const { desk, sms, groups } = await groupEveryone();
    const sentBefore = sms.sent.length;
    const postsBefore = groups.posts.length;
    const changedText = await preview(desk, "cleaner", LATE);
    expect(await desk.sendMessage({ to: "cleaner", text: `${LATE} Thanks!`, confirmation: changedText.code })).toEqual({ ok: false, error: APPROVAL_STALE });
    const changedTo = await preview(desk, "cleaner", LATE);
    expect(await desk.sendMessage({ to: "Sam", text: LATE, confirmation: changedTo.code })).toEqual({ ok: false, error: APPROVAL_STALE });
    // A refused code is used up, so the original text can't go with it either.
    expect(await desk.sendMessage({ to: "cleaner", text: LATE, confirmation: changedText.code })).toEqual({ ok: false, error: APPROVAL_STALE });
    expect(sms.sent).toHaveLength(sentBefore);
    expect(groups.posts).toHaveLength(postsBefore);
    expect(hostOutbox(desk)).toEqual([]);
  });

  it("refuses a reused code", async () => {
    const { desk, sms } = await confirmedCleaner();
    const approval = await preview(desk, "cleaner", LATE);
    ok(await desk.sendMessage({ to: "cleaner", text: LATE, confirmation: approval.code }));
    const after = sms.sent.length;
    expect(await desk.sendMessage({ to: "cleaner", text: LATE, confirmation: approval.code })).toEqual({ ok: false, error: APPROVAL_STALE });
    expect(sms.sent).toHaveLength(after);
    expect(hostOutbox(desk)).toHaveLength(1);
  });

  it("refuses an expired code", async () => {
    let clock = new Date(FROZEN);
    const { desk } = openDesk([HOST, CLEANER], "0", () => clock);
    await setUp(desk, { groupChat: "cleaner-only" });
    await desk.inbound({ id: "yes-opt-in", from: CLEANER, text: "YES" });
    const approval = await preview(desk, "cleaner", LATE);
    clock = new Date(clock.getTime() + 11 * 60_000);
    expect(await desk.sendMessage({ to: "cleaner", text: LATE, confirmation: approval.code })).toEqual({ ok: false, error: APPROVAL_STALE });
    expect(hostOutbox(desk)).toEqual([]);
  });

  it("refuses a text holding the door code at preview, also after a restart with the code sealed", async () => {
    const { desk, root } = await confirmedCleaner();
    expect(await desk.sendMessage({ to: "cleaner", text: `The code is ${DOOR_CODE}` })).toEqual({ ok: false, error: DOOR_CODE_IN_CHAT });
    resetLiveDesks();
    const env: NodeJS.ProcessEnv = {
      CLEANER_CORE_ENABLED: "1",
      CLEANER_CORE_LIVE_SMS: "1",
      CLEANER_CORE_SMS_ALLOWLIST: [HOST, CLEANER].join(","),
      CLEANER_CORE_TWILIO_ACCOUNT_SID: "ACfake",
      CLEANER_CORE_TWILIO_AUTH_TOKEN: "token",
      CLEANER_CORE_TWILIO_PHONE_NUMBER: CLEANER_LINE,
    };
    const restarted = liveDeskFor(root, () => env, () => new Date(FROZEN));
    expect(await restarted.sendMessage({ to: "cleaner", text: `Use ${DOOR_CODE} at the back` })).toEqual({ ok: false, error: DOOR_CODE_IN_CHAT });
    expect(await restarted.sendMessage({ to: "cleaner", text: `Use ${DOOR_CODE} at the back` }, PIN_KEY)).toEqual({ ok: false, error: DOOR_CODE_IN_CHAT });
    const res = await handleCleanerMcpMessage(
      restarted,
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "send_message", arguments: { to: "cleaner", text: `Use ${DOOR_CODE} at the back` } } },
      PIN_KEY,
    );
    const body = res.body as { result: { isError: boolean; content: { text: string }[] } };
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0]?.text).toBe(DOOR_CODE_IN_CHAT);
  });

  it("refuses a door code split by spaces, dashes, or dots, with the code known and with it sealed", async () => {
    const split = (code: string) => [
      `Code ${code.split("").join(" ")}`,
      `Use ${code.slice(0, 2)}-${code.slice(2)} at the back`,
      `It's ${code.split("").join(".")} today`,
    ];
    const { desk, root, sms } = await confirmedCleaner();
    const before = sms.sent.length;
    for (const text of split(DOOR_CODE)) {
      expect(await desk.sendMessage({ to: "cleaner", text }), text).toEqual({ ok: false, error: DOOR_CODE_IN_CHAT });
    }
    // The engine's host-message path refuses it too, even if a caller skipped the desk.
    const engine = (desk as unknown as { engine: CleanerCore }).engine;
    for (const body of split(DOOR_CODE)) await expect(engine.sendHostMessage({ to: CLEANER, body })).rejects.toThrow();
    expect(sms.sent).toHaveLength(before);
    expect(hostOutbox(desk)).toEqual([]);
    resetLiveDesks();
    const env: NodeJS.ProcessEnv = {
      CLEANER_CORE_ENABLED: "1",
      CLEANER_CORE_LIVE_SMS: "1",
      CLEANER_CORE_SMS_ALLOWLIST: [HOST, CLEANER].join(","),
      CLEANER_CORE_TWILIO_ACCOUNT_SID: "ACfake",
      CLEANER_CORE_TWILIO_AUTH_TOKEN: "token",
      CLEANER_CORE_TWILIO_PHONE_NUMBER: CLEANER_LINE,
    };
    const restarted = liveDeskFor(root, () => env, () => new Date(FROZEN));
    for (const text of split(DOOR_CODE)) {
      expect(await restarted.sendMessage({ to: "cleaner", text }), `sealed: ${text}`).toEqual({ ok: false, error: DOOR_CODE_IN_CHAT });
      expect(await restarted.sendMessage({ to: "cleaner", text }, PIN_KEY), `opened: ${text}`).toEqual({ ok: false, error: DOOR_CODE_IN_CHAT });
    }
    expect(sms.sent).toHaveLength(before);
  });

  it("voids a group approval when someone joins or leaves the group before the yes", async () => {
    const { desk, groups } = openDesk([HOST, CLEANER, OBSERVER], "1");
    await setUp(desk, { contacts: [{ name: "Sam", role: "co-host", phone: OBSERVER }], groupChat: "everyone" });
    await desk.inbound({ id: "yes-host", from: HOST, text: "YES" });
    await desk.inbound({ id: "yes-cleaner", from: CLEANER, text: "YES" });
    const beforeJoin = await preview(desk, "group", LATE);
    await desk.inbound({ id: "yes-sam", from: OBSERVER, text: "YES" });
    expect(await desk.sendMessage({ to: "group", text: LATE, confirmation: beforeJoin.code })).toEqual({ ok: false, error: APPROVAL_STALE });
    const beforeLeave = await preview(desk, "group", LATE);
    await desk.inbound({ id: "stop-sam", from: OBSERVER, text: "STOP" });
    expect(await desk.sendMessage({ to: "group", text: LATE, confirmation: beforeLeave.code })).toEqual({ ok: false, error: APPROVAL_STALE });
    expect(groups.posts.filter((post) => post.body === LATE)).toEqual([]);
    expect(hostOutbox(desk)).toEqual([]);
    // Asked again with the group as it is now, it goes to the people still in it.
    const now = await preview(desk, "group", LATE);
    ok(await desk.sendMessage({ to: "group", text: LATE, confirmation: now.code }));
    expect(groups.posts.filter((post) => post.body === LATE)).toEqual([{ to: [HOST, CLEANER].sort(), body: LATE }]);
  });

  it("refuses an empty or too long text, and an unknown recipient", async () => {
    const { desk } = await confirmedCleaner();
    expect((await desk.sendMessage({ to: "cleaner", text: "  " })).ok).toBe(false);
    expect((await desk.sendMessage({ to: "cleaner", text: "a".repeat(601) })).ok).toBe(false);
    expect((await desk.sendMessage({ to: "cleaner", text: "a".repeat(600) })).ok).toBe(true);
    expect(await desk.sendMessage({ to: "Jordan", text: LATE })).toEqual({ ok: false, error: "I can't text Jordan right now." });
  });

  it("refuses group with group chat off or set to cleaner-only", async () => {
    const off = openDesk([HOST, CLEANER], "0");
    await setUp(off.desk, {});
    expect(await off.desk.sendMessage({ to: "group", text: LATE })).toEqual({ ok: false, error: "There's no group chat for this property." });
    const only = openDesk([HOST, CLEANER], "1");
    await setUp(only.desk, { groupChat: "cleaner-only" });
    expect(await only.desk.sendMessage({ to: "group", text: LATE })).toEqual({ ok: false, error: "There's no group chat for this property." });
  });

  it("refuses an opted-out cleaner, even with a code issued before the STOP", async () => {
    const { desk, sms } = await confirmedCleaner();
    const approval = await preview(desk, "cleaner", LATE);
    await desk.inbound({ id: "stop", from: CLEANER, text: "STOP" });
    const before = sms.sent.length;
    expect(await desk.sendMessage({ to: "cleaner", text: LATE })).toEqual({ ok: false, error: "I can't text Ana right now." });
    expect(await desk.sendMessage({ to: "cleaner", text: LATE, confirmation: approval.code })).toEqual({ ok: false, error: "I can't text Ana right now." });
    expect(sms.sent).toHaveLength(before);
    expect(hostOutbox(desk)).toEqual([]);
  });

  it("refuses a cleaner who hasn't opted in yet", async () => {
    const { desk } = openDesk([HOST, CLEANER], "0");
    await setUp(desk, { groupChat: "cleaner-only" });
    expect(await desk.sendMessage({ to: "cleaner", text: LATE })).toEqual({ ok: false, error: "I can't text Ana right now." });
  });

  it("refuses the 11th message in an hour, and allows one after the hour", async () => {
    let clock = new Date(FROZEN);
    const { desk, sms } = openDesk([HOST, CLEANER], "0", () => clock);
    await setUp(desk, { groupChat: "cleaner-only" });
    await desk.inbound({ id: "yes-opt-in", from: CLEANER, text: "YES" });
    for (let count = 1; count <= 10; count++) {
      const text = `Note number ${count}`;
      const approval = await preview(desk, "cleaner", text);
      ok(await desk.sendMessage({ to: "cleaner", text, confirmation: approval.code }));
      clock = new Date(clock.getTime() + 60_000);
    }
    const tooMany = "That's a lot of messages this hour. Try again later.";
    expect(await desk.sendMessage({ to: "cleaner", text: "Note number 11" })).toEqual({ ok: false, error: tooMany });
    expect(hostOutbox(desk)).toHaveLength(10);
    const before = sms.sent.length;
    clock = new Date(new Date(FROZEN).getTime() + 61 * 60_000);
    const approval = await preview(desk, "cleaner", "Note number 11");
    ok(await desk.sendMessage({ to: "cleaner", text: "Note number 11", confirmation: approval.code }));
    expect(sms.sent).toHaveLength(before + 1);
  });

  it("sends a host message that says ready, and the job's status doesn't change", async () => {
    const { desk, sms } = await confirmedCleaner();
    const statuses = async () => (ok(await desk.getTurns()).turns as { status: string }[]).map((turn) => turn.status);
    const before = await statuses();
    const text = "The unit is ready for you whenever you arrive.";
    const approval = await preview(desk, "Ana", text);
    ok(await desk.sendMessage({ to: "cleaner", text, confirmation: approval.code }));
    expect(sms.sent.at(-1)).toEqual(expect.objectContaining({ to: CLEANER, body: text }));
    expect(await statuses()).toEqual(before);
  });

  it("is not held by quiet hours", async () => {
    let clock = new Date(FROZEN);
    const { desk, sms } = openDesk([HOST, CLEANER], "0", () => clock);
    await setUp(desk, { groupChat: "cleaner-only" });
    ok(await desk.saveSchedule({ quietFrom: "9:00 PM", quietUntil: "8:00 AM" }));
    await desk.inbound({ id: "yes-opt-in", from: CLEANER, text: "YES" });
    // 10:00 PM in New York.
    clock = new Date("2026-10-15T02:00:00.000Z");
    const approval = await preview(desk, "cleaner", LATE);
    const before = sms.sent.length;
    ok(await desk.sendMessage({ to: "cleaner", text: LATE, confirmation: approval.code }));
    expect(sms.sent.slice(before)).toEqual([expect.objectContaining({ to: CLEANER, body: LATE })]);
  });

  it("sends to the group thread and to a saved contact who opted in", async () => {
    const { desk, sms, groups } = await groupEveryone();
    const group = await preview(desk, "group", LATE);
    expect(group.question).toBe(`Send to the group: "${LATE}"?`);
    expect(ok(await desk.sendMessage({ to: "group", text: LATE, confirmation: group.code }))).toEqual({ next: "Sent to the group." });
    expect(groups.posts.filter((post) => post.body === LATE)).toEqual([{ to: [HOST, CLEANER, OBSERVER].sort(), body: LATE }]);
    const note = "Sam, the spare towels are in the hall closet.";
    const contact = await preview(desk, "sam", note);
    expect(contact.question).toBe(`Send to Sam: "${note}"?`);
    expect(ok(await desk.sendMessage({ to: "Sam", text: note, confirmation: contact.code }))).toEqual({ next: "Sent to Sam." });
    expect(sms.sent.filter((item) => item.body === note)).toEqual([expect.objectContaining({ to: OBSERVER })]);
    expect(hostOutbox(desk).map((item) => item.kind)).toEqual(["host-message", "host-message"]);
  });

  it("sends only to Scratch numbers on the allowlist, and refuses a contact who isn't on it", async () => {
    const { desk, sms, groups } = openDesk([HOST, CLEANER, OBSERVER], "1");
    await setUp(desk, {
      contacts: [
        { name: "Sam", role: "co-host", phone: OBSERVER },
        { name: "Lee", role: "assistant", phone: OFF_LIST },
      ],
      groupChat: "cleaner-and-host",
    });
    await desk.inbound({ id: "yes-host", from: HOST, text: "YES" });
    await desk.inbound({ id: "yes-cleaner", from: CLEANER, text: "YES" });
    await desk.inbound({ id: "yes-lee", from: OFF_LIST, text: "YES" });
    expect(await desk.sendMessage({ to: "Lee", text: LATE })).toEqual({ ok: false, error: "I can't text Lee right now." });
    for (const to of ["cleaner", "group"]) {
      const approval = await preview(desk, to, LATE);
      ok(await desk.sendMessage({ to, text: LATE, confirmation: approval.code }));
    }
    const recipients = [...sms.sent.map((item) => item.to), ...groups.posts.flatMap((post) => post.to)];
    expect(recipients.length).toBeGreaterThan(0);
    expect(recipients.every((phone) => isScratchTestNumber(phone))).toBe(true);
    expect(recipients).not.toContain(OFF_LIST);
    expect(hostOutbox(desk).every((item) => isScratchTestNumber(item.to))).toBe(true);
  });

  it("lists send_message and tells Grok to draft replies for the host to approve", async () => {
    const { desk, sms } = await confirmedCleaner();
    const tools = ((await mcp(desk, "tools/list")).tools as { name: string; description: string }[]) ?? [];
    expect(tools.find((tool) => tool.name === "send_message")?.description).toBe(
      "Sends the host's own message to the cleaner, the group, or a saved contact. Call once without confirmation to get a preview and code, show the host the exact text, and call again with the code only after the host says yes.",
    );
    const text = String((await mcp(desk, "initialize")).instructions);
    expect(text).toContain(
      "When a message needs a reply Cleaner Core doesn't send itself, draft one short reply and offer it to the host. Send it only with send_message after the host says yes.",
    );
    const first = await mcp(desk, "tools/call", { name: "send_message", arguments: { to: "cleaner", text: LATE } });
    expect(first.isError).toBe(false);
    const code = (first.structuredContent as { confirmation: Approval }).confirmation.code;
    const before = sms.sent.length;
    const second = await mcp(desk, "tools/call", { name: "send_message", arguments: { to: "cleaner", text: LATE, confirmation: code } });
    expect(second.isError).toBe(false);
    expect(second.structuredContent).toEqual({ next: "Sent to Ana." });
    expect(sms.sent).toHaveLength(before + 1);
  });
});

/** Made-up bytes that start and end like a JPEG. */
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from("made-up photo for a test"), Buffer.from([0xff, 0xd9])]);
const PHOTO_BASE = "https://cleaner.example";
const CHECKLIST_TEXT = "Checklist for Lake House: Strip the beds; Restock coffee. Send photos, then reply DONE when finished.";
const PHOTO_FIRST = "Please send a photo of the finished rooms, then reply DONE.";
const OFFER = `Turnover at ${ADDRESS} on Sunday, Oct 18. Checkout 11:00 AM, next guest 4:00 PM. Reply YES to schedule it, or STOP to opt out.`;
const PHOTOS_TOOL = "Gets expiring links to the cleaner's photos for a job. Look at them, compare with the checklist, and show them to the host.";
const PHOTOS_INSTRUCTION =
  "When check_now returns completed, call get_job_photos, look at the photos, and give the host a short summary in your own words: arrival, start and done times, checklist, what the photos show, and any notes.";

let mediaCount = 0;

/** A fake Twilio media download. It never leaves the machine. */
function stubPhotos(): string[] {
  const calls: string[] = [];
  setCleanerPhotoFetch(async (url) => {
    calls.push(url);
    return new Response(JPEG, { status: 200, headers: { "content-type": "image/jpeg" } });
  });
  return calls;
}

function photo(): { url: string; contentType: string } {
  mediaCount += 1;
  return { url: `https://api.twilio.com/2010-04-01/Accounts/ACfake/Messages/MMfull${mediaCount}/Media/MEfull${mediaCount}`, contentType: "image/jpeg" };
}

type PreferencesInput = Parameters<LiveDesk["savePreferences"]>[0];

/**
 * Cleaner-only Lake House with these preferences, the cleaner opted in, and the offer taken. The
 * clock starts Wed Oct 14 at 11:00 AM. The cleaning's checkout day is Sun Oct 18.
 */
async function takenWith(preferences: PreferencesInput, extraEnv: NodeJS.ProcessEnv = { PUBLIC_BASE_URL: PHOTO_BASE, CLEANER_CORE_PHOTO_KEY: "made-up-photo-key-for-tests-abcd" }) {
  const time = testClock(FROZEN);
  const opened = openDesk([HOST, CLEANER], "0", time.now, extraEnv);
  const { desk } = opened;
  ok(await desk.getState("2"));
  ok(await desk.saveProperty({ business: BUSINESS, nickname: "Lake House", address: ADDRESS, timeZone: ZONE, checkoutTime: "11:00 AM", checkInTime: "4:00 PM" }));
  ok(await desk.saveSources({ calendars: [{ name: "Airbnb", url: CALENDAR_URL }] }));
  ok(await desk.savePeople({ host: HOST, cleaner: CLEANER, cleanerName: "Ana", groupChat: "cleaner-only" }));
  ok(await desk.saveDoorCode({ code: DOOR_CODE, lockLocation: LOCK }, PIN_KEY));
  ok(await desk.savePreferences(preferences));
  ok(await desk.activate());
  ok(await desk.confirmTimes({ checkout: "11:00 AM", checkIn: "4:00 PM" }));
  await desk.inbound({ id: "yes-opt-in", from: CLEANER, text: "YES" });
  await desk.inbound({ id: "yes-offer", from: CLEANER, text: "YES" });
  return { ...opened, time };
}

function toCleanerBodies(sent: SentSms[]): string[] {
  return sent.filter((item) => item.to === CLEANER).map((item) => item.body);
}

async function statuses(desk: LiveDesk): Promise<string[]> {
  return (ok(await desk.getTurns()).turns as { status: string }[]).map((turn) => turn.status);
}

describe("Cleaner Core cleaning: the checklist", () => {
  it("sends the saved checklist right after the private code, once", async () => {
    const { desk, sms } = await takenWith({ checklist: ["Strip the beds", "Restock coffee."] });
    expect(toCleanerBodies(sms.sent)).not.toContain(CHECKLIST_TEXT);
    ok(await desk.markGuestsLeft({ said: "The guests have left" }, PIN_KEY));
    const bodies = toCleanerBodies(sms.sent);
    expect(bodies.slice(-2)).toEqual([PRIVATE_PIN, CHECKLIST_TEXT]);
    await desk.markGuestsLeft({ said: "The guests have left" }, PIN_KEY);
    ok(await desk.checkNow());
    await desk.inbound({ id: "start", from: CLEANER, text: "START" });
    expect(toCleanerBodies(sms.sent).filter((body) => body === CHECKLIST_TEXT)).toHaveLength(1);
    expect(CHECKLIST_TEXT.includes(DOOR_CODE)).toBe(false);
  });

  it("sends no checklist when none is saved", async () => {
    const { desk, sms } = await takenWith({});
    ok(await desk.markGuestsLeft({ said: "The guests have left" }, PIN_KEY));
    expect(toCleanerBodies(sms.sent).at(-1)).toBe(PRIVATE_PIN);
    expect(toCleanerBodies(sms.sent).some((body) => body.startsWith("Checklist for"))).toBe(false);
  });

  it("sends a checklist that says ready, and the code still goes", async () => {
    const { desk, sms } = await takenWith({ checklist: ["Get the guest room ready"] });
    ok(await desk.markGuestsLeft({ said: "The guests have left" }, PIN_KEY));
    expect(toCleanerBodies(sms.sent).slice(-2)).toEqual([PRIVATE_PIN, "Checklist for Lake House: Get the guest room ready. Send photos, then reply DONE when finished."]);
  });
});

describe("Cleaner Core cleaning: photos and notes", () => {
  it("a photo-only MMS gets no guide reply and reaches Grok as [photo]", async () => {
    stubPhotos();
    const { desk, sms } = await takenWith({ checklist: ["Strip the beds"] });
    const waiting = sms.sent.length;
    await desk.inbound({ id: "mms-waiting", from: CLEANER, text: "", media: [photo()] });
    expect(sms.sent).toHaveLength(waiting);
    ok(await desk.markGuestsLeft({ said: "The guests have left" }, PIN_KEY));
    const before = sms.sent.length;
    await desk.inbound({ id: "mms-1", from: CLEANER, text: "", media: [photo()] });
    await desk.inbound({ id: "mms-2", from: CLEANER, text: "Kitchen", media: [photo()] });
    expect(sms.sent).toHaveLength(before);
    expect(brief(await messagesNow(desk)).slice(-3)).toEqual([
      { from: "cleaner", name: "Ana", text: "[photo]", handled: "none" },
      { from: "cleaner", name: "Ana", text: "[photo]", handled: "none" },
      { from: "cleaner", name: "Ana", text: "Kitchen [photo]", handled: "none" },
    ]);
  });

  it("DONE waits for a photo when photos are required", async () => {
    stubPhotos();
    const { desk, sms } = await takenWith({ photosRequired: true });
    ok(await desk.markGuestsLeft({ said: "The guests have left" }, PIN_KEY));
    await desk.inbound({ id: "done-early", from: CLEANER, text: "DONE" });
    expect(toCleanerBodies(sms.sent).at(-1)).toBe(PHOTO_FIRST);
    expect(await statuses(desk)).not.toContain("done");
    expect(brief(await messagesNow(desk)).at(-1)).toEqual({ from: "cleaner", name: "Ana", text: "DONE", handled: "none" });
    await desk.inbound({ id: "mms", from: CLEANER, text: "", media: [photo()] });
    await desk.inbound({ id: "done", from: CLEANER, text: "DONE" });
    expect(toCleanerBodies(sms.sent).at(-1)).toBe("Thanks, cleaning marked done.");
    expect((await statuses(desk))[0]).toBe("done");
  });

  it("DONE goes through without a photo when photos aren't required", async () => {
    const { desk, sms } = await takenWith({ photosRequired: false });
    ok(await desk.markGuestsLeft({ said: "The guests have left" }, PIN_KEY));
    await desk.inbound({ id: "done", from: CLEANER, text: "DONE" });
    expect(toCleanerBodies(sms.sent).at(-1)).toBe("Thanks, cleaning marked done.");
  });

  it("keeps at most 5 notes of 200 characters, and none with supply notes off", async () => {
    const on = await takenWith({ supplyNotes: true });
    ok(await on.desk.markGuestsLeft({ said: "The guests have left" }, PIN_KEY));
    for (let index = 1; index <= 6; index++) await on.desk.inbound({ id: `note-${index}`, from: CLEANER, text: `Note ${index} ${"x".repeat(250)}` });
    await on.desk.inbound({ id: "done", from: CLEANER, text: "DONE" });
    const completed = (ok(await on.desk.checkNow()).completed as { notes: string[] }[])[0];
    expect(completed?.notes).toHaveLength(5);
    expect(completed?.notes[0]?.startsWith("Note 2 ")).toBe(true);
    expect(completed?.notes.every((note) => note.length === 200)).toBe(true);

    resetLiveDesks();
    const off = await takenWith({ supplyNotes: false });
    ok(await off.desk.markGuestsLeft({ said: "The guests have left" }, PIN_KEY));
    await off.desk.inbound({ id: "note", from: CLEANER, text: "Need more paper towels" });
    await off.desk.inbound({ id: "done", from: CLEANER, text: "DONE" });
    expect((ok(await off.desk.checkNow()).completed as { notes: string[] }[])[0]?.notes).toEqual([]);
  });
});

describe("Cleaner Core cleaning: the completed record", () => {
  it("check_now returns the finished cleaning once, with exact counts and times, and no door code", async () => {
    stubPhotos();
    const { desk, time, root } = await takenWith(PREFERENCES);
    ok(await desk.saveArrival({ time: "11:30 AM" }));
    ok(await desk.markGuestsLeft({ said: "The guests have left" }, PIN_KEY));
    time.set("2026-10-14T15:32:00.000Z");
    await desk.inbound({ id: "start", from: CLEANER, text: "START" });
    time.set("2026-10-14T16:00:00.000Z");
    await desk.inbound({ id: "towels", from: CLEANER, text: "Need more paper towels" });
    await desk.inbound({ id: "code", from: CLEANER, text: `The lockbox code ${DOOR_CODE} stuck` });
    await desk.inbound({ id: "spaced", from: CLEANER, text: "Is it 8 0 8 8 again?" });
    await desk.inbound({ id: "mms-1", from: CLEANER, text: "", media: [photo(), photo()] });
    await desk.inbound({ id: "mms-2", from: CLEANER, text: "", media: [photo()] });
    time.set("2026-10-14T18:10:00.000Z");
    await desk.inbound({ id: "done", from: CLEANER, text: "DONE" });

    const reply = ok(await desk.checkNow());
    expect(JSON.parse(plain(JSON.stringify(reply.completed)))).toEqual([
      {
        nickname: "Lake House",
        day: "Sunday, Oct 18",
        arrivalTime: "11:30 AM",
        startedAt: "Wednesday, Oct 14, 11:32 AM",
        doneAt: "Wednesday, Oct 14, 2:10 PM",
        checklist: ["Strip the beds", "Restock coffee"],
        photos: 3,
        notes: ["Need more paper towels", "The lockbox code [redacted] stuck", "Is it [redacted] again?"],
      },
    ]);
    expect(JSON.stringify(reply).includes(DOOR_CODE)).toBe(false);
    expect(readFileSync(join(root, "cleaner-live.json"), "utf8").includes(DOOR_CODE)).toBe(false);
    expect(readFileSync(join(root, "cleaner-job", "cleaner-core.json"), "utf8").includes(DOOR_CODE)).toBe(false);
    expect(ok(await desk.checkNow()).completed).toBeUndefined();
  });

  it("sets the start time from the first message during the cleaning when START never came", async () => {
    const { desk, time } = await takenWith({});
    ok(await desk.markGuestsLeft({ said: "The guests have left" }, PIN_KEY));
    time.set("2026-10-14T15:45:00.000Z");
    await desk.inbound({ id: "here", from: CLEANER, text: "Here now" });
    time.set("2026-10-14T16:45:00.000Z");
    await desk.inbound({ id: "later", from: CLEANER, text: "Halfway" });
    time.set("2026-10-14T17:00:00.000Z");
    await desk.inbound({ id: "done", from: CLEANER, text: "DONE" });
    const completed = (ok(await desk.checkNow()).completed as Record<string, unknown>[])[0] ?? {};
    expect(plain(String(completed.startedAt))).toBe("Wednesday, Oct 14, 11:45 AM");
    expect(plain(String(completed.doneAt))).toBe("Wednesday, Oct 14, 1:00 PM");
    expect(completed.arrivalTime).toBeNull();
    expect(completed.photos).toBe(0);
    expect(completed.checklist).toEqual([]);
  });
});

describe("Cleaner Core cleaning: get_job_photos", () => {
  it("returns working links, and makes its key once when none is set", async () => {
    stubPhotos();
    const { desk, env, root, time } = await takenWith({}, { PUBLIC_BASE_URL: PHOTO_BASE });
    ok(await desk.markGuestsLeft({ said: "The guests have left" }, PIN_KEY));
    await desk.inbound({ id: "mms", from: CLEANER, text: "", media: [photo(), photo()] });
    const saves: string[] = [];
    const save = (values: Record<string, string | undefined>) => {
      saves.push(Object.keys(values).join(","));
      Object.assign(env, values);
    };
    const request = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_job_photos", arguments: {} } };
    const first = ((await handleCleanerMcpMessage(desk, request, PIN_KEY, false, save)).body as { result: { structuredContent: { photos: { url: string; expiresAt: string }[] } } }).result;
    const photos = first.structuredContent.photos;
    expect(photos).toHaveLength(2);
    expect(saves).toEqual(["CLEANER_CORE_PHOTO_KEY"]);
    const key = photoKey(env);
    expect(key).toBeDefined();
    for (const link of photos) {
      expect(link.url).toMatch(/^https:\/\/cleaner\.example\/cleaner-core\/photos\/[a-p]+$/);
      const token = link.url.slice(`${PHOTO_BASE}/cleaner-core/photos/`.length);
      const served = servePhoto(root, token, key, time.now());
      expect(served.status).toBe(200);
      expect(served.status === 200 && served.body.equals(JPEG)).toBe(true);
    }
    await handleCleanerMcpMessage(desk, request, PIN_KEY, false, save);
    expect(saves).toEqual(["CLEANER_CORE_PHOTO_KEY"]);
    const byDay = ok(await desk.getJobPhotos({ job: "2026-10-18" }));
    expect((byDay.photos as unknown[]).length).toBe(2);
    expect((await desk.getJobPhotos({ job: "2026-12-25" })).ok).toBe(false);
  });

  it("lists get_job_photos and tells Grok to summarize a completed cleaning", async () => {
    const { desk } = await takenWith({});
    const tools = ((await mcp(desk, "tools/list")).tools as { name: string; description: string }[]) ?? [];
    expect(tools.find((tool) => tool.name === "get_job_photos")?.description).toBe(PHOTOS_TOOL);
    expect(String((await mcp(desk, "initialize")).instructions)).toContain(PHOTOS_INSTRUCTION);
  });
});

describe("Cleaner Core cleaning: the host's other instructions (Ruling 9)", () => {
  it("puts the saved instructions at the end of the first offer", async () => {
    const { sms } = await takenWith({ instructions: "Leave the porch light on." });
    expect(offers(sms.sent).map((item) => plain(item.body))).toEqual([`${OFFER} Note from the host: Leave the porch light on.`]);
  });

  it("keeps the offer copy without saved instructions", async () => {
    const { sms } = await takenWith({});
    expect(offers(sms.sent).map((item) => plain(item.body))).toEqual([OFFER]);
  });

  it("sends instructions that say ready, and copies for others drop only the YES ask", async () => {
    const { sms } = await takenWith({ instructions: "Get the guest room ready." });
    const body = `${OFFER} Note from the host: Get the guest room ready.`;
    expect(offers(sms.sent).map((item) => plain(item.body))).toEqual([body]);
    expect(offerForOthers(body)).toBe(
      `Turnover at ${ADDRESS} on Sunday, Oct 18. Checkout 11:00 AM, next guest 4:00 PM. The cleaner will reply to confirm. Note from the host: Get the guest room ready.`,
    );
  });
});

describe("Cleaner Core cleaning: a photo download can't crash or trap the cleaner", () => {
  it("takes, counts, and records an MMS whose download is still open while the host saves preferences", async () => {
    let started = (): void => undefined;
    const fetching = new Promise<void>((resolve) => {
      started = resolve;
    });
    let finish = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      finish = resolve;
    });
    setCleanerPhotoFetch(async () => {
      started();
      await held;
      return new Response(JPEG, { status: 200, headers: { "content-type": "image/jpeg" } });
    });
    const { desk, sms } = await takenWith({ photosRequired: true });
    ok(await desk.markGuestsLeft({ said: "The guests have left" }, PIN_KEY));
    const pending = desk.inbound({ id: "mms-held", from: CLEANER, text: "", media: [photo()] });
    await fetching;
    // The save waits its turn behind the text, so it can't drop the engine the text is using.
    const saved = desk.savePreferences({ photosRequired: true, supplyNotes: true });
    finish();
    await expect(pending).resolves.toEqual({ sent: [] });
    ok(await saved);
    expect(brief(await messagesNow(desk)).at(-1)).toEqual({ from: "cleaner", name: "Ana", text: "[photo]", handled: "none" });
    // The same text again is a duplicate: the id was seen.
    await desk.inbound({ id: "mms-held", from: CLEANER, text: "", media: [photo()] });
    expect(await messagesNow(desk)).toEqual([]);
    // The photo counted, so DONE goes through, and the new preferences apply.
    await desk.inbound({ id: "note", from: CLEANER, text: "Out of trash bags" });
    await desk.inbound({ id: "done", from: CLEANER, text: "DONE" });
    expect(toCleanerBodies(sms.sent).at(-1)).toBe("Thanks, cleaning marked done.");
    const completed = (ok(await desk.checkNow()).completed as Record<string, unknown>[])[0] ?? {};
    expect(completed.photos).toBe(1);
    expect(completed.photosMissing).toBeUndefined();
    expect(completed.notes).toEqual(["Out of trash bags"]);
  });

  it("a photo whose download failed still satisfies the photo rule, and completed reports it missing", async () => {
    setCleanerPhotoFetch(async () => new Response("nope", { status: 500 }));
    const { desk, sms } = await takenWith({ photosRequired: true });
    ok(await desk.markGuestsLeft({ said: "The guests have left" }, PIN_KEY));
    await desk.inbound({ id: "mms-failed", from: CLEANER, text: "", media: [photo(), photo()] });
    await desk.inbound({ id: "done", from: CLEANER, text: "DONE" });
    expect(toCleanerBodies(sms.sent).at(-1)).toBe("Thanks, cleaning marked done.");
    expect((await statuses(desk))[0]).toBe("done");
    const completed = (ok(await desk.checkNow()).completed as Record<string, unknown>[])[0] ?? {};
    expect(completed.photos).toBe(2);
    expect(completed.photosMissing).toBe(2);
    expect(ok(await desk.getJobPhotos({ job: "2026-10-18" })).photos).toEqual([]);
  });

  it("a photo sent without a Twilio login still counts", async () => {
    stubPhotos();
    const { desk, sms } = await takenWith({ photosRequired: true }, { PUBLIC_BASE_URL: PHOTO_BASE, CLEANER_CORE_TWILIO_ACCOUNT_SID: undefined });
    ok(await desk.markGuestsLeft({ said: "The guests have left" }, PIN_KEY));
    await desk.inbound({ id: "mms-nologin", from: CLEANER, text: "", media: [photo()] });
    await desk.inbound({ id: "done", from: CLEANER, text: "DONE" });
    expect(toCleanerBodies(sms.sent).at(-1)).toBe("Thanks, cleaning marked done.");
    expect((ok(await desk.checkNow()).completed as Record<string, unknown>[])[0]?.photosMissing).toBe(1);
  });
});

const LANE = SCRATCH_TENANTS[0]!;
const REHEARSAL_TWILIO_SID = "ACscratchrehearsal";
const REHEARSAL_TWILIO_AUTH = "cleaner-twilio-auth-token-rehearsal";
const REHEARSAL_ROUTINE = "https://routine.example/hook";
const PARKING = "Parking is on the street today.";
/** The plain door code as its own token, so a random id that happens to hold the digits doesn't count. */
const PLAIN_CODE = new RegExp(`(?<![0-9A-Za-z])${DOOR_CODE}(?![0-9A-Za-z])`);

function filesUnder(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...filesUnder(path));
    else if (entry.isFile()) found.push(path);
  }
  return found;
}

describe("Cleaner Core full diagram", () => {
  it("diagram rehearsal", async () => {
    const address = LANE.property.address;
    const host = LANE.ownerPhone;
    const cleaner = LANE.cleanerPhone;
    const scratch = new Set([host, cleaner]);
    let at = new Date("2026-10-14T14:00:00.000Z");
    const clock = () => at;
    const sms = fakeSms();
    setCleanerTwilioClient(sms);
    const groups = groupFetch();
    setCleanerGroupFetch(groups.impl);
    const routine: { url: string; body: string }[] = [];
    setCleanerAlertFetch(async (url, init) => {
      routine.push({ url, body: init.body });
      return { status: 200 };
    });
    const mediaFetched = stubPhotos();
    const hosted = await hostedApp(
      {
        PUBLIC_BASE_URL: BASE,
        CLEANER_CORE_LIVE_SMS: "1",
        CLEANER_CORE_GROUP_CHAT: "1",
        CLEANER_CORE_SMS_ALLOWLIST: `${host},${cleaner}`,
        CLEANER_CORE_TWILIO_ACCOUNT_SID: REHEARSAL_TWILIO_SID,
        CLEANER_CORE_TWILIO_AUTH_TOKEN: REHEARSAL_TWILIO_AUTH,
        CLEANER_CORE_TWILIO_PHONE_NUMBER: CLEANER_LINE,
      },
      undefined,
      undefined,
      clock,
    );
    const replies: string[] = [];
    const stay = googleList([{ id: "g-scratch", start: "2026-10-14", end: "2026-10-17" }]);

    // 1. Grok connects through OAuth with one Allow.
    expect((await hosted.rpc(PATH, "tools/list")).status).toBe(401);
    const clientId = await hosted.register("Grok");
    const { access, scope } = await hosted.connect(clientId, CLEANER_RESOURCE, CLEANER_SCOPE);
    expect(scope).toBe(CLEANER_SCOPE);
    const listed = await hosted.rpc(PATH, "tools/list", access);
    expect(listed.status).toBe(200);
    expect(await listed.text()).toContain("send_message");

    let rpcId = 0;
    // Like a real Grok Bot connected by OAuth: the bearer token only, no door-code key header.
    const tool = async (name: string, args: Record<string, unknown> = {}) => {
      const res = await hosted.http(PATH, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${access}` },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name, arguments: args } }),
      });
      const raw = await res.text();
      replies.push(raw);
      expect(res.status, `${name}: ${raw}`).toBe(200);
      const result = (JSON.parse(raw) as { result: { isError?: boolean; structuredContent?: Record<string, unknown>; content?: { text?: string }[] } }).result;
      return { isError: result.isError === true, text: result.content?.[0]?.text ?? "", structured: result.structuredContent ?? {} };
    };
    const say = async (name: string, args: Record<string, unknown> = {}) => {
      const reply = await tool(name, args);
      expect(reply.isError, `${name}: ${reply.text}`).toBe(false);
      return reply.structured;
    };
    let smsId = 0;
    const fromCleaner = async (body: string, extra: Record<string, string> = {}) => {
      const path = "/webhooks/twilio/cleaner-core";
      const fields: Record<string, string> = { MessageSid: `SMrehearsal${++smsId}`, From: cleaner, To: CLEANER_LINE, Body: body, SmsStatus: "received", ...extra };
      const res = await hosted.http(path, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": twilioSignature(REHEARSAL_TWILIO_AUTH, `${BASE}${path}`, fields) },
        body: new URLSearchParams(fields).toString(),
      });
      expect(res.status, body).toBe(200);
    };
    const checkAt = async (iso: string): Promise<Record<string, unknown> & { alerts: string[] }> => {
      at = new Date(iso);
      const reply = await say("check_now", { googleEvents: stay });
      return { ...reply, alerts: ((reply.alerts as string[] | undefined) ?? []).map(plain) };
    };
    const toCleaner = () => sms.sent.filter((item) => item.to === cleaner).map((item) => plain(item.body));
    const offersSent = () => toCleaner().filter((body) => body.startsWith("Turnover at"));
    const remindersSent = () => toCleaner().filter((body) => body.startsWith("Reminder:"));

    /** The checks after every step: Scratch numbers only, and the door code nowhere but the cleaner's private text. */
    const safe = async (step: string) => {
      await drainCleanerAlerts(hosted.root, () => hosted.inst.env(), clock);
      for (const item of sms.sent) {
        expect(scratch.has(item.to), `${step}: text to ${item.to}`).toBe(true);
        expect(isScratchTestNumber(item.to), step).toBe(true);
        if (PLAIN_CODE.test(item.body)) expect(item.to, `${step}: door code`).toBe(cleaner);
      }
      for (const post of groups.posts) {
        for (const to of post.to) expect(scratch.has(to), `${step}: group post to ${to}`).toBe(true);
        expect(PLAIN_CODE.test(post.body), `${step}: group post`).toBe(false);
      }
      for (const post of routine) {
        expect(post.url, step).toBe(REHEARSAL_ROUTINE);
        expect(post.body, step).not.toContain("+1");
        expect(PLAIN_CODE.test(post.body), `${step}: routine`).toBe(false);
      }
      for (const path of filesUnder(hosted.root)) expect(PLAIN_CODE.test(readFileSync(path, "latin1")), `${step}: ${path}`).toBe(false);
      expect(PLAIN_CODE.test(replies.join("\n")), `${step}: replies`).toBe(false);
      expect(PLAIN_CODE.test(hosted.logs.join("\n")), `${step}: logs`).toBe(false);
      expect(hosted.logs.join("\n").includes(access), `${step}: token in logs`).toBe(false);
      // The server's door-code key stays in the secret store: never in a reply, a log, or the desk's file.
      const serverKey = hosted.inst.env().CLEANER_CORE_PIN_KEY;
      if (serverKey) {
        expect(replies.join("\n").includes(serverKey), `${step}: key in replies`).toBe(false);
        expect(hosted.logs.join("\n").includes(serverKey), `${step}: key in logs`).toBe(false);
        const live = join(hosted.root, "cleaner-live.json");
        if (existsSync(live)) expect(readFileSync(live, "utf8").includes(serverKey), `${step}: key in cleaner-live.json`).toBe(false);
      }
    };
    await safe("1 connect");

    // 2. Setup steps 2 to 8 through the new tools, then activate.
    await say("get_state", { said: "2" });
    await say("save_property", { business: LANE.hostName, nickname: "Scratch Lane", address, propertyType: "House", timeZone: ZONE, checkoutTime: "11:00 AM", checkInTime: "4:00 PM" });
    await say("save_sources", { google: true });
    await say("save_people", { host, cleaner, cleanerName: "Ana", groupChat: "cleaner-and-host" });
    await say("save_schedule", { firstText: "days-after-check-in", firstTextDays: 1, reminder: "days-before-checkout", reminderDays: 1, reminderTime: "6:00 PM" });
    await say("save_door_code", { code: DOOR_CODE, lockLocation: LOCK });
    await say("save_preferences", PREFERENCES);
    expect((await say("get_state")).next).toBe(REVIEW_NEXT);
    await say("activate", { googleEvents: googleList([]) });
    expect((await say("get_state")).done).toContain("Checks finished.");
    expect(sms.sent).toEqual([]);
    expect(Buffer.from(hosted.inst.env().CLEANER_CORE_PIN_KEY ?? "", "base64")).toHaveLength(32);
    await safe("2 setup");

    // 3. The alert routine, with a stubbed webhook.
    await say("save_alert_routine", { url: REHEARSAL_ROUTINE, token: "k-test-rehearsal-key" });
    await safe("3 alert routine");
    expect(routine.length).toBeGreaterThan(0);

    // 4. A booking appears in Google. The alert names the usual times, and the host says yes.
    const booked = await checkAt("2026-10-14T14:05:00.000Z");
    expect(booked.alerts).toContain("New booking at Scratch Lane: check-in Wednesday, Oct 14, checkout Saturday, Oct 17. Use the usual 11:00 AM checkout and 4:00 PM check-in?");
    await say("confirm_times", { checkout: "11:00 AM", checkIn: "4:00 PM" });
    expect(toCleaner().filter((body) => body.includes("you're invited to the cleaning group"))).toHaveLength(1);
    await safe("4 booking and times");

    // 5 and 6. The cleaner's first YES takes the invite. The offer waits for check-in + 1 day at 9:00 AM, then the second YES takes it.
    await fromCleaner("YES");
    expect(offersSent()).toEqual([]);
    await checkAt("2026-10-15T12:59:00.000Z");
    expect(offersSent()).toEqual([]);
    await checkAt("2026-10-15T13:00:00.000Z");
    expect(offersSent()).toHaveLength(1);
    await checkAt("2026-10-15T13:05:00.000Z");
    expect(offersSent()).toHaveLength(1);
    await fromCleaner("YES");
    expect((await say("get_turns")).turns).toEqual([expect.objectContaining({ checkoutDate: "2026-10-17", status: "confirmed" })]);
    await safe("5-6 offer and YES");

    // 7. The reminder 1 day before asks for an arrival time. Grok reads the reply, saves it, and the host approves a message.
    await checkAt("2026-10-16T21:59:00.000Z");
    expect(remindersSent()).toEqual([]);
    await checkAt("2026-10-16T22:00:00.000Z");
    expect(remindersSent()).toEqual([`Reminder: cleaning at ${address} on Saturday, Oct 17. Checkout is 11:00 AM. What time do you plan to arrive?`]);
    at = new Date("2026-10-16T22:10:00.000Z");
    const quietBefore = sms.sent.length;
    await fromCleaner("I'll be there around 11:30");
    expect(sms.sent).toHaveLength(quietBefore);
    const read = await checkAt("2026-10-16T22:11:00.000Z");
    expect((read.messages as { from: string; text: string; handled: string }[]).at(-1)).toEqual(
      expect.objectContaining({ from: "cleaner", text: "I'll be there around 11:30", handled: "none" }),
    );
    await say("save_arrival", { time: "11:30 AM" });
    const asked = await say("send_message", { to: "cleaner", text: PARKING });
    expect(asked.preview).toEqual({ to: "Ana", text: PARKING });
    const code = (asked.confirmation as { code: string }).code;
    expect(sms.sent.filter((item) => item.body === PARKING)).toEqual([]);
    expect(await say("send_message", { to: "cleaner", text: PARKING, confirmation: code })).toEqual({ next: "Sent to Ana." });
    expect(sms.sent.filter((item) => item.body.includes(PARKING))).toEqual([expect.objectContaining({ to: cleaner, body: PARKING })]);
    expect(groups.posts.filter((post) => post.body.includes(PARKING))).toEqual([]);
    const again = await tool("send_message", { to: "cleaner", text: PARKING, confirmation: code });
    expect(again.isError).toBe(true);
    expect(again.text).toBe("That approval has expired or doesn't match. Ask the host again.");
    expect(sms.sent.filter((item) => item.body.includes(PARKING))).toHaveLength(1);
    await safe("7 reminder, arrival, and message");

    // 8. The checkout nudge, then "guests have left", and the private code with the lock to the cleaner only.
    const nudge = "Checkout time at Scratch Lane. Have the guests left?";
    expect((await checkAt("2026-10-17T14:59:00.000Z")).alerts).not.toContain(nudge);
    expect((await checkAt("2026-10-17T15:00:00.000Z")).alerts.filter((alert) => alert === nudge)).toHaveLength(1);
    expect((await checkAt("2026-10-17T15:05:00.000Z")).alerts).not.toContain(nudge);
    expect(sms.sent.filter((item) => PLAIN_CODE.test(item.body))).toEqual([]);
    at = new Date("2026-10-17T15:10:00.000Z");
    await say("mark_guests_left", { said: "guests have left" });
    const privateCode = `Guests have left ${address}. Door code for the ${LOCK}: ${DOOR_CODE}. This code is only for you. Reply DONE when the cleaning is finished.`;
    expect(sms.sent.filter((item) => PLAIN_CODE.test(item.body))).toEqual([expect.objectContaining({ to: cleaner, body: privateCode })]);
    await safe("8 nudge and guests left");

    // 9. The checklist, one photo, a note, and DONE.
    expect(toCleaner().at(-1)).toBe("Checklist for Scratch Lane: Strip the beds; Restock coffee. Send photos, then reply DONE when finished.");
    at = new Date("2026-10-17T15:30:00.000Z");
    const mediaUrl = `https://api.twilio.com/2010-04-01/Accounts/${REHEARSAL_TWILIO_SID}/Messages/MMrehearsal/Media/MErehearsal`;
    await fromCleaner("", { NumMedia: "1", MediaUrl0: mediaUrl, MediaContentType0: "image/jpeg" });
    expect(mediaFetched).toEqual([mediaUrl]);
    await fromCleaner("need paper towels");
    at = new Date("2026-10-17T17:00:00.000Z");
    await fromCleaner("DONE");
    expect(toCleaner().at(-1)).toBe("Thanks, cleaning marked done.");
    await safe("9 checklist, photo, note, DONE");

    // 10. check_now returns the finished cleaning, and get_job_photos returns a link that works.
    const finished = await checkAt("2026-10-17T17:05:00.000Z");
    const completed = JSON.parse(plain(JSON.stringify(finished.completed))) as Record<string, unknown>[];
    expect(completed).toEqual([
      expect.objectContaining({
        nickname: "Scratch Lane",
        day: "Saturday, Oct 17",
        arrivalTime: "11:30 AM",
        checklist: PREFERENCES.checklist,
        photos: 1,
        notes: ["need paper towels"],
      }),
    ]);
    const photos = (await say("get_job_photos", { job: completed[0]?.day })).photos as { url: string }[];
    expect(photos).toHaveLength(1);
    const link = new URL(photos[0]?.url ?? "");
    expect(link.origin).toBe(BASE);
    const served = await hosted.http(link.pathname);
    expect(served.status).toBe(200);
    expect(served.headers["content-type"]).toBe("image/jpeg");
    expect(served.bytes().equals(JPEG)).toBe(true);
    expect((await checkAt("2026-10-17T17:10:00.000Z")).completed).toBeUndefined();
    await safe("10 completed and photos");
  }, 60_000);

  it("an OAuth Grok Bot with no key header saves and sends the door code, and a restart doesn't ask for it again", async () => {
    const address = LANE.property.address;
    const host = LANE.ownerPhone;
    const cleaner = LANE.cleanerPhone;
    let at = new Date("2026-10-14T14:00:00.000Z");
    const sms = fakeSms();
    setCleanerTwilioClient(sms);
    const hosted = await hostedApp(
      {
        PUBLIC_BASE_URL: BASE,
        CLEANER_CORE_LIVE_SMS: "1",
        CLEANER_CORE_GROUP_CHAT: "0",
        CLEANER_CORE_SMS_ALLOWLIST: `${host},${cleaner}`,
        CLEANER_CORE_TWILIO_ACCOUNT_SID: REHEARSAL_TWILIO_SID,
        CLEANER_CORE_TWILIO_AUTH_TOKEN: REHEARSAL_TWILIO_AUTH,
        CLEANER_CORE_TWILIO_PHONE_NUMBER: CLEANER_LINE,
      },
      undefined,
      undefined,
      () => at,
    );
    const { access } = await hosted.connect(await hosted.register("Grok"), CLEANER_RESOURCE, CLEANER_SCOPE);
    const replies: string[] = [];
    let rpcId = 0;
    // The bearer token only: no door-code key header.
    const tool = async (name: string, args: Record<string, unknown> = {}) => {
      const res = await hosted.http(PATH, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${access}` },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name, arguments: args } }),
      });
      const raw = await res.text();
      replies.push(raw);
      const result = (JSON.parse(raw) as { result: { isError?: boolean; structuredContent?: Record<string, unknown>; content?: { text?: string }[] } }).result;
      return { isError: result.isError === true, text: result.content?.[0]?.text ?? "", structured: result.structuredContent ?? {} };
    };
    const say = async (name: string, args: Record<string, unknown> = {}) => {
      const reply = await tool(name, args);
      expect(reply.isError, `${name}: ${reply.text}`).toBe(false);
      return reply.structured;
    };
    let smsId = 0;
    const fromCleaner = async (body: string) => {
      const path = "/webhooks/twilio/cleaner-core";
      const fields: Record<string, string> = { MessageSid: `SMoauthkey${++smsId}`, From: cleaner, To: CLEANER_LINE, Body: body, SmsStatus: "received" };
      const res = await hosted.http(path, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": twilioSignature(REHEARSAL_TWILIO_AUTH, `${BASE}${path}`, fields) },
        body: new URLSearchParams(fields).toString(),
      });
      expect(res.status, body).toBe(200);
    };
    const codeTexts = () => sms.sent.filter((item) => PLAIN_CODE.test(item.body));

    await say("get_state", { said: "2" });
    await say("save_property", { business: LANE.hostName, address, timeZone: ZONE });
    await say("save_sources", { google: true });
    await say("save_people", { host, cleaner, cleanerName: "Ana", groupChat: "cleaner-only" });
    await say("save_schedule", {});
    expect(String((await say("save_door_code", { code: DOOR_CODE, lockLocation: LOCK })).next)).toContain("Saved the door code.");
    expect((await say("get_state")).next).toBe(PREFERENCES_NEXT);
    await say("save_preferences", {});
    await say("activate", { googleEvents: googleList([{ id: "g-oauth", start: "2026-10-14", end: "2026-10-17" }]) });
    await say("confirm_times", { checkout: "11:00 AM", checkIn: "4:00 PM" });
    await fromCleaner("YES");
    await fromCleaner("YES");
    expect((await say("get_turns")).turns).toEqual([expect.objectContaining({ checkoutDate: "2026-10-17", status: "confirmed" })]);
    expect(codeTexts()).toEqual([]);

    at = new Date("2026-10-17T15:10:00.000Z");
    expect(await say("mark_guests_left", { said: "guests have left" })).toEqual({ next: "I sent the door code to the cleaner. I'll tell you if it doesn't go through." });
    const privateCode = `Guests have left ${address}. Door code for the ${LOCK}: ${DOOR_CODE}. This code is only for you. Reply DONE when the cleaning is finished.`;
    expect(codeTexts()).toEqual([expect.objectContaining({ to: cleaner, body: privateCode })]);

    // A redeploy: the desk opens the seal with the server's key, so it doesn't ask for the code again.
    resetLiveDesks();
    const after = await say("get_state");
    expect(after.next).not.toBe(DOOR_NEXT);
    expect(after.done).toContain("Door code saved.");
    const again = await tool("mark_guests_left", { said: "guests have left" });
    expect(again.text).toContain("I already sent the door code to the cleaner.");
    expect(codeTexts()).toHaveLength(1);

    const serverKey = hosted.inst.env().CLEANER_CORE_PIN_KEY ?? "";
    expect(Buffer.from(serverKey, "base64")).toHaveLength(32);
    const live = readFileSync(join(hosted.root, "cleaner-live.json"), "utf8");
    expect(live.includes(serverKey)).toBe(false);
    expect(PLAIN_CODE.test(live)).toBe(false);
    expect(replies.join("\n").includes(serverKey)).toBe(false);
    expect(PLAIN_CODE.test(replies.join("\n"))).toBe(false);
    expect(hosted.logs.join("\n").includes(serverKey)).toBe(false);
  }, 60_000);
});
