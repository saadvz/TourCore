import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { liveDeskFor, resetLiveDesks, setCleanerCalendarFetch } from "../../../../src/cleaner-core/liveDesk";
import { sendLiveGroup, setCleanerGroupFetch, setCleanerTwilioClient } from "../../../../src/cleaner-core/liveSms";
import { CALENDAR_ICS, CALENDAR_URL, CLEANER, CLEANER_LINE, DOOR_CODE, fakeSms, FROZEN, HOST, OBSERVER, TEST_PIN_KEY } from "../../../../test/wiringProof";

const outPath = process.argv[2];
if (!outPath) throw new Error("prove-group-desk.ts needs an output path");

const calls: string[] = [];
setCleanerGroupFetch(async (url) => {
  calls.push(String(url));
  return { ok: false, status: 500, json: async () => ({}) } as Response;
});
setCleanerTwilioClient(fakeSms());
setCleanerCalendarFetch(async (url) => ({
  status: url === CALENDAR_URL ? 200 : 404,
  url,
  async text() {
    return url === CALENDAR_URL ? CALENDAR_ICS : "";
  },
}));

const root = mkdtempSync(join(tmpdir(), "cleaner-group-proof-"));
const env: NodeJS.ProcessEnv = {
  CLEANER_CORE_ENABLED: "1",
  CLEANER_CORE_LIVE_SMS: "1",
  CLEANER_CORE_GROUP_CHAT: "1",
  CLEANER_CORE_SMS_ALLOWLIST: `${HOST},${CLEANER}`,
  CLEANER_CORE_TWILIO_ACCOUNT_SID: "ACfake",
  CLEANER_CORE_TWILIO_AUTH_TOKEN: "token",
  CLEANER_CORE_TWILIO_PHONE_NUMBER: CLEANER_LINE,
};
const desk = liveDeskFor(root, () => env, () => new Date(FROZEN));
const pinKey = Buffer.from(TEST_PIN_KEY, "base64");
desk.getState("2");
desk.saveProperty({ business: "Harbor", address: "12 Practice Lane, Teaneck, NJ 07666", timeZone: "America/New_York" });
desk.savePeople({ host: HOST, cleaner: CLEANER, observer: OBSERVER });
desk.saveCalendarLink({ url: CALENDAR_URL });
desk.saveDoorCode({ code: DOOR_CODE }, pinKey);
desk.setUpTexting();
await desk.runChecks();
const missing = await desk.markGuestsLeft({ said: "The guests have left" }, undefined);
await desk.confirmTimes({ checkout: "11:00 AM", checkIn: "4:00 PM" });
await desk.inbound({ id: "yes-host", from: HOST, text: "YES" });
await desk.inbound({ id: "yes-cleaner", from: CLEANER, text: "YES" });
await desk.inbound({ id: "yes-schedule", from: CLEANER, text: "YES" });
const failed = await desk.markGuestsLeft({ said: "The guests have left" }, pinKey);
const again = await desk.markGuestsLeft({ said: "The guests have left" }, pinKey);
const fetchesAfterFailure = calls.length;

setCleanerGroupFetch(async () => {
  throw new Error("empty allowlist fetched");
});
const empty = await sendLiveGroup(
  { ...env, CLEANER_CORE_SMS_ALLOWLIST: "" },
  { audience: [HOST, CLEANER], body: "Hello the group" },
);

const nextOf = (reply: { ok: boolean; result?: Record<string, unknown>; error?: string }) =>
  reply.ok ? String(reply.result?.next ?? "") : String(reply.error ?? "");
const record = {
  missing: nextOf(missing),
  failed: nextOf(failed),
  again: nextOf(again),
  fetchesAfterFailure,
  emptyAllowlist: empty === undefined ? "no-fetch" : "fetched",
};
const json = JSON.stringify(record, null, 2);
if (json.includes(DOOR_CODE)) throw new Error("desk proof included the door code");
writeFileSync(outPath, `${json}\n`);
rmSync(root, { recursive: true, force: true });
setCleanerTwilioClient(undefined);
setCleanerGroupFetch(undefined);
setCleanerCalendarFetch(undefined);
resetLiveDesks();
