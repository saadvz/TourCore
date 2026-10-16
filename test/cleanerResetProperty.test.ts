import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { setCleanerGroupFetch, setCleanerTwilioClient } from "../src/cleaner-core/liveSms";
import { setCleanerPhotoFetch } from "../src/cleaner-core/photos";
import { fakeConversations, type FakeConversations } from "./fakeConversations";
import { ADDRESS, BUSINESS, CALENDAR_URL, CLEANER, CLEANER_AUTH, CLEANER_LINE, CLEANER_TOKEN, DOOR_CODE, FIRST_QUESTION, HOST, startWiredApp, type WiredApp } from "./wiringProof";

const MCP = "/mcp/cleaner-core";
const SMS_PATH = "/webhooks/twilio/cleaner-core";
const ROUTINE_URL = "https://routine.example/hook";
const ROUTINE_KEY = "routine-key-made-up";

const PREVIEW = (address: string) =>
  `This resets Cleaner Core for ${address}. It deletes the setup, jobs, messages, everyone's YES and STOP replies, the saved door code, the alert routine connection, and the group text on Twilio. Your Twilio settings and Grok logins stay. Reply yes to reset.`;
const DONE = (address: string) => `Cleaner Core is reset for ${address}. Start setup again whenever you're ready.`;
const TWILIO_REFUSED = "I couldn't remove the group text on Twilio, so nothing was reset. Try again in a few minutes.";

const open: WiredApp[] = [];

afterEach(async () => {
  setCleanerGroupFetch(undefined);
  setCleanerTwilioClient(undefined);
  setCleanerPhotoFetch(undefined);
  while (open.length > 0) await open.pop()?.close();
});

function call(wired: WiredApp, name: string, args: Record<string, unknown> = {}) {
  return wired.tool(MCP, CLEANER_TOKEN, name, args);
}

async function must(wired: WiredApp, name: string, args: Record<string, unknown> = {}) {
  const reply = await call(wired, name, args);
  expect(reply.isError, `${name}: ${reply.text}`).toBe(false);
  return reply.structured ?? {};
}

let smsSid = 0;
function sms(wired: WiredApp, from: string, body: string) {
  return wired.postTwilio(SMS_PATH, { from, to: CLEANER_LINE, body, sid: `SMreset${++smsSid}`, token: CLEANER_AUTH });
}

/** The routine secrets are saved the way Grok's upload does, so the store holds them. */
function secretsOf(wired: WiredApp) {
  const env = wired.env();
  return { url: env.CLEANER_CORE_ROUTINE_URL, key: env.CLEANER_CORE_ROUTINE_KEY, sid: env.CLEANER_CORE_TWILIO_ACCOUNT_SID, auth: env.CLEANER_CORE_TWILIO_AUTH_TOKEN, number: env.CLEANER_CORE_TWILIO_PHONE_NUMBER };
}

async function setup(options: { failDeletes?: boolean; block?: boolean; texted?: boolean } = {}) {
  const fake = fakeConversations(options.failDeletes ? { failConversationDeletes: true } : {});
  setCleanerGroupFetch(fake.impl);
  const wired = await startWiredApp({ groupChat: true });
  open.push(wired);
  await must(wired, "get_state", { said: "2" });
  await must(wired, "save_property", { business: BUSINESS, address: ADDRESS, timeZone: "America/New_York" });
  await must(wired, "save_people", { host: HOST, cleaner: CLEANER, cleanerName: "Mike", groupChat: "cleaner-and-host", hostName: "Dana" });
  await must(wired, "save_calendar_link", { url: CALENDAR_URL });
  await must(wired, "save_door_code", { code: DOOR_CODE });
  await must(wired, "set_up_texting");
  await must(wired, "run_checks");
  await must(wired, "confirm_times", { checkout: "11:00 AM", checkIn: "4:00 PM" });
  if (options.texted !== false) {
    expect((await sms(wired, HOST, "YES")).status).toBe(200);
    expect((await sms(wired, CLEANER, "YES")).status).toBe(200);
  }
  if (options.block) fake.blockMembership();
  return { fake, wired };
}

function saveRoutine(wired: WiredApp) {
  // Same store the alert upload writes to.
  wired.saveSecret({ CLEANER_CORE_ROUTINE_URL: ROUTINE_URL, CLEANER_CORE_ROUTINE_KEY: ROUTINE_KEY });
}

const livePath = (wired: WiredApp) => join(wired.root, "cleaner-live.json");
const jobPath = (wired: WiredApp) => join(wired.root, "cleaner-job");

describe("reset_property", () => {
  it("previews without changing anything, and sends nothing", async () => {
    const { fake, wired } = await setup();
    saveRoutine(wired);
    const before = readFileSync(livePath(wired));
    const calls = fake.calls();
    const posts = fake.posts.length;
    const smsSent = wired.cleanerSent.length;
    const preview = await must(wired, "reset_property");
    expect(preview.next).toBe(PREVIEW(ADDRESS));
    expect(preview.confirmation).toBeDefined();
    expect(readFileSync(livePath(wired)).equals(before)).toBe(true);
    expect(existsSync(jobPath(wired))).toBe(true);
    expect(fake.calls()).toBe(calls);
    expect(fake.posts).toHaveLength(posts);
    expect(wired.cleanerSent).toHaveLength(smsSent);
    expect(secretsOf(wired).key).toBe(ROUTINE_KEY);
    expect(fake.removed).toEqual([]);
  });

  it("says this property when nothing is saved yet", async () => {
    const wired = await startWiredApp({ groupChat: true });
    open.push(wired);
    const preview = await must(wired, "reset_property");
    expect(preview.next).toBe(PREVIEW("this property"));
  });

  it("refuses a wrong code and a reused code, and changes nothing", async () => {
    const { fake, wired } = await setup();
    saveRoutine(wired);
    const before = readFileSync(livePath(wired));
    const preview = await must(wired, "reset_property");
    const code = preview.confirmation as { code?: string } | string;
    const text = typeof code === "string" ? code : (code.code ?? "");
    const wrong = await call(wired, "reset_property", { confirmation: "NOTACODE" });
    expect(wrong.isError).toBe(true);
    expect(wrong.text).toBe("That approval has expired or doesn't match. Ask the host again.");
    expect(readFileSync(livePath(wired)).equals(before)).toBe(true);
    expect(fake.removed).toEqual([]);
    expect(secretsOf(wired).key).toBe(ROUTINE_KEY);
    // The wrong code used nothing up: the real one still works once, and only once.
    expect((await call(wired, "reset_property", { confirmation: text })).isError).toBe(false);
    const reused = await call(wired, "reset_property", { confirmation: text });
    expect(reused.isError).toBe(true);
    expect(reused.text).toBe("That approval has expired or doesn't match. Ask the host again.");
  });

  it("refuses a send_message code", async () => {
    const { fake, wired } = await setup();
    const sendPreview = await must(wired, "send_message", { to: "group", text: "Hello all" });
    const sent = sendPreview.confirmation as { code?: string } | string;
    const code = typeof sent === "string" ? sent : (sent.code ?? "");
    const refused = await call(wired, "reset_property", { confirmation: code });
    expect(refused.isError).toBe(true);
    expect(fake.removed).toEqual([]);
    expect(existsSync(livePath(wired))).toBe(true);
  });

  it("wipes the property, the group, and the routine secrets, and sends nothing", async () => {
    const { fake, wired } = await setup();
    saveRoutine(wired);
    const sid = fake.posts[0]?.conversationSid ?? "";
    expect(sid).not.toBe("");
    const smsSent = wired.cleanerSent.length;
    const posts = fake.posts.length;
    const messages = fake.messages.length;
    const preview = await must(wired, "reset_property");
    const conf = preview.confirmation as { code?: string } | string;
    const code = typeof conf === "string" ? conf : (conf.code ?? "");
    const done = await must(wired, "reset_property", { confirmation: code });
    expect(done.next).toBe(DONE(ADDRESS));
    expect(fake.removed).toContain(sid);
    expect(existsSync(livePath(wired))).toBe(false);
    expect(existsSync(jobPath(wired))).toBe(false);
    const secrets = secretsOf(wired);
    expect(secrets.url).toBeUndefined();
    expect(secrets.key).toBeUndefined();
    expect(secrets.sid).toBe("ACcleanerwiring");
    expect(secrets.auth).toBe(CLEANER_AUTH);
    expect(secrets.number).toBe(CLEANER_LINE);
    expect(wired.cleanerSent).toHaveLength(smsSent);
    expect(fake.posts).toHaveLength(posts);
    expect(fake.messages).toHaveLength(messages);
    const state = await must(wired, "get_state");
    expect(state.next).toBe(FIRST_QUESTION);
  });

  it("drops a pending alert upload link", async () => {
    const { wired } = await setup();
    await call(wired, "save_alert_routine");
    expect(readFileSync(livePath(wired), "utf8")).toContain("alertUpload");
    const preview = await must(wired, "reset_property");
    const conf = preview.confirmation as { code?: string } | string;
    await must(wired, "reset_property", { confirmation: typeof conf === "string" ? conf : (conf.code ?? "") });
    expect(existsSync(livePath(wired))).toBe(false);
    const state = await must(wired, "get_state");
    expect(state.next).toBe(FIRST_QUESTION);
  });

  it("changes nothing when Twilio refuses to remove the group", async () => {
    const { fake, wired } = await setup({ failDeletes: true, block: true });
    saveRoutine(wired);
    const before = readFileSync(livePath(wired));
    const preview = await must(wired, "reset_property");
    const conf = preview.confirmation as { code?: string } | string;
    const refused = await call(wired, "reset_property", { confirmation: typeof conf === "string" ? conf : (conf.code ?? "") });
    expect(refused.isError).toBe(true);
    expect(refused.text).toBe(TWILIO_REFUSED);
    expect(fake.removed).toEqual([]);
    expect(readFileSync(livePath(wired)).equals(before)).toBe(true);
    expect(existsSync(jobPath(wired))).toBe(true);
    expect(secretsOf(wired).url).toBe(ROUTINE_URL);
    expect(secretsOf(wired).key).toBe(ROUTINE_KEY);
  });

  it("resets a property that never texted, with no Twilio calls", async () => {
    const { fake, wired } = await setup({ texted: false });
    saveRoutine(wired);
    const calls = fake.calls();
    const preview = await must(wired, "reset_property");
    const conf = preview.confirmation as { code?: string } | string;
    const done = await must(wired, "reset_property", { confirmation: typeof conf === "string" ? conf : (conf.code ?? "") });
    expect(done.next).toBe(DONE(ADDRESS));
    expect(fake.calls()).toBe(calls);
    expect(existsSync(livePath(wired))).toBe(false);
    expect(secretsOf(wired).key).toBeUndefined();
    expect((await must(wired, "get_state")).next).toBe(FIRST_QUESTION);
  });

  it("is listed in the tools", async () => {
    const wired = await startWiredApp({ groupChat: true });
    open.push(wired);
    const listed = await wired.listTools(MCP, CLEANER_TOKEN);
    expect(listed.names).toContain("reset_property");
    expect(listed.raw).toContain("Resets Cleaner Core for this property, as if it was never set up: setup, jobs, messages, consent, the saved door code, the alert routine connection, and the group text on Twilio. Call once without confirmation to get a preview and code, show the host the exact text, and call again with the code only after the host says yes. Twilio settings and Grok logins stay.");
  });
});
