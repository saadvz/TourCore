import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { setCleanerAlertFetch } from "../src/cleaner-core/liveDesk";
import { setCleanerPhotoFetch } from "../src/cleaner-core/photos";
import { ADDRESS, BUSINESS, CALENDAR_URL, CLEANER, CLEANER_AUTH, CLEANER_LINE, CLEANER_TOKEN, DOOR_CODE, FROZEN, HOST, startWiredApp, type WiredApp } from "./wiringProof";

const PATH = "/mcp/cleaner-core";
const HOOK = "/webhooks/twilio/cleaner-core";
/** Made-up bytes that start and end like a JPEG. */
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from("made-up photo for a test"), Buffer.from([0xff, 0xd9])]);
const BASIC = `Basic ${Buffer.from(`ACcleanerwiring:${CLEANER_AUTH}`).toString("base64")}`;

function media(name: string): string {
  return `https://api.twilio.com/2010-04-01/Accounts/ACcleanerwiring/Messages/MM${name}/Media/ME${name}`;
}

interface Fetched {
  url: string;
  auth: string | undefined;
}

/** A fake Twilio media download. It never leaves the machine. */
function stubMedia(answer: (url: string) => Response = () => new Response(JPEG, { status: 200, headers: { "content-type": "image/jpeg" } })): Fetched[] {
  const calls: Fetched[] = [];
  setCleanerPhotoFetch(async (url, init) => {
    const headers = (init.headers ?? {}) as Record<string, string>;
    calls.push({ url, auth: headers.Authorization ?? headers.authorization });
    return answer(url);
  });
  return calls;
}

const open: WiredApp[] = [];

afterEach(async () => {
  setCleanerPhotoFetch(undefined);
  setCleanerAlertFetch(undefined);
  while (open.length > 0) await open.pop()?.close();
});

async function app(clock: { now: () => Date }): Promise<WiredApp> {
  const wired = await startWiredApp({ now: clock.now });
  open.push(wired);
  return wired;
}

function testClock() {
  let at = new Date(FROZEN);
  return {
    now: () => at,
    later(minutes: number) {
      at = new Date(Date.parse(FROZEN) + minutes * 60_000);
    },
  };
}

async function call(wired: WiredApp, name: string, args: Record<string, unknown> = {}) {
  const result = await wired.tool(PATH, CLEANER_TOKEN, name, args);
  if (result.isError) throw new Error(`${name}: ${result.text}`);
  return result;
}

/** Sets up Lake House, takes the offer, and sends the private code, so the cleaning is in progress. */
async function cleaning(clock = testClock()): Promise<WiredApp> {
  const wired = await app(clock);
  await call(wired, "get_state", { choice: "cleaners" });
  await call(wired, "save_property", { business: BUSINESS, nickname: "Lake House", address: ADDRESS, timeZone: "America/New_York" });
  await call(wired, "save_sources", { calendars: [{ name: "Airbnb", url: CALENDAR_URL }] });
  await call(wired, "save_people", { host: HOST, cleaner: CLEANER, cleanerName: "Ana", groupChat: "cleaner-only" });
  await call(wired, "save_door_code", { code: DOOR_CODE, lockLocation: "back door lockbox" });
  await call(wired, "save_preferences", { checklist: ["Strip the beds"], photosRequired: true });
  // The alert routine comes before Activate. Its wake-ups go to a stub.
  setCleanerAlertFetch(async () => ({ status: 200 }));
  await call(wired, "save_alert_routine", { url: "https://routine.example/hook", token: "k-test-routine-key" });
  await call(wired, "activate");
  await call(wired, "confirm_times", { checkout: "11:00", checkIn: "16:00" });
  await wired.postTwilio(HOOK, { from: CLEANER, to: CLEANER_LINE, body: "YES", sid: "SM-opt-in", token: CLEANER_AUTH });
  await wired.postTwilio(HOOK, { from: CLEANER, to: CLEANER_LINE, body: "YES", sid: "SM-offer", token: CLEANER_AUTH });
  await call(wired, "mark_guests_left", { confirmed: true });
  expect(wired.cleanerSent.some((item) => item.to === CLEANER && item.body.includes(DOOR_CODE))).toBe(true);
  return wired;
}

/** One MMS from the cleaner to the cleaning number, signed like Twilio signs it. */
function mms(wired: WiredApp, sid: string, items: { url: string; type: string }[], body = "") {
  const extra: Record<string, string> = { NumMedia: String(items.length) };
  items.forEach((item, index) => {
    extra[`MediaUrl${index}`] = item.url;
    extra[`MediaContentType${index}`] = item.type;
  });
  return wired.postTwilio(HOOK, { from: CLEANER, to: CLEANER_LINE, body, sid, token: CLEANER_AUTH, extra });
}

function jpegs(count: number, prefix: string): { url: string; type: string }[] {
  return Array.from({ length: count }, (_, index) => ({ url: media(`${prefix}${index}`), type: "image/jpeg" }));
}

function photoFiles(root: string): string[] {
  const dir = join(root, "cleaner-job", "photos");
  if (!existsSync(dir)) return [];
  const found: string[] = [];
  const walk = (path: string) => {
    for (const name of readdirSync(path)) {
      const full = join(path, name);
      if (statSync(full).isDirectory()) walk(full);
      else found.push(full);
    }
  };
  walk(dir);
  return found;
}

async function links(wired: WiredApp, args: Record<string, unknown> = {}): Promise<{ url: string; expiresAt: string }[]> {
  const result = await call(wired, "get_job_photos", args);
  return (result.structured?.photos as { url: string; expiresAt: string }[] | undefined) ?? [];
}

/** Fetches a photo link's path from the local server. */
async function get(wired: WiredApp, link: string) {
  const res = await fetch(`http://127.0.0.1:${wired.port}${new URL(link).pathname}`);
  return { status: res.status, headers: res.headers, bytes: Buffer.from(await res.arrayBuffer()) };
}

describe("Cleaner Core photos: saving an MMS", () => {
  it("saves a photo from the cleaner hook with the Cleaner Core login, and its link serves the image bytes", async () => {
    const calls = stubMedia();
    const wired = await cleaning();
    const posted = await mms(wired, "MM-one", [{ url: media("one"), type: "image/jpeg" }]);
    expect(posted.status).toBe(200);
    expect(calls).toEqual([{ url: media("one"), auth: BASIC }]);
    const files = photoFiles(wired.root);
    expect(files).toHaveLength(1);
    expect(readFileSync(files[0] ?? "").equals(JPEG)).toBe(true);

    const listed = await links(wired);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.url).toMatch(/^https:\/\/tour\.example\/cleaner-core\/photos\/[a-p]+$/);
    expect(listed[0]?.expiresAt).toBe("2026-10-14T16:00:00.000Z");
    const served = await get(wired, listed[0]?.url ?? "");
    expect(served.status).toBe(200);
    expect(served.bytes.equals(JPEG)).toBe(true);
    expect(served.headers.get("content-type")).toBe("image/jpeg");
    expect(served.headers.get("cache-control")).toBe("no-store");
  });

  it("skips a media type that is not a photo", async () => {
    const calls = stubMedia();
    const wired = await cleaning();
    await mms(wired, "MM-card", [
      { url: media("card"), type: "text/vcard" },
      { url: media("svg"), type: "image/svg+xml" },
    ]);
    expect(calls).toEqual([]);
    expect(photoFiles(wired.root)).toEqual([]);
    expect(await links(wired)).toEqual([]);
  });

  it("keeps at most 10 photos for a job", async () => {
    stubMedia();
    const wired = await cleaning();
    await mms(wired, "MM-ten", jpegs(10, "ten"));
    await mms(wired, "MM-more", jpegs(2, "more"));
    expect(photoFiles(wired.root)).toHaveLength(10);
    expect(await links(wired)).toHaveLength(10);
  });

  it("refuses a media host that isn't Twilio, and never sends the Twilio login past twilio.com", async () => {
    const calls = stubMedia((url) =>
      url.startsWith("https://api.twilio.com/")
        ? new Response(null, { status: 307, headers: { location: "https://media.cdn.example/photo" } })
        : new Response(JPEG, { status: 200, headers: { "content-type": "image/jpeg" } }),
    );
    const wired = await cleaning();
    await mms(wired, "MM-evil", [{ url: "https://evil.example/photo.jpg", type: "image/jpeg" }]);
    await mms(wired, "MM-http", [{ url: "http://api.twilio.com/2010-04-01/Accounts/AC/Messages/MM/Media/ME", type: "image/jpeg" }]);
    expect(calls).toEqual([]);
    expect(photoFiles(wired.root)).toEqual([]);

    await mms(wired, "MM-cdn", [{ url: media("cdn"), type: "image/jpeg" }]);
    expect(calls).toEqual([
      { url: media("cdn"), auth: BASIC },
      { url: "https://media.cdn.example/photo", auth: undefined },
    ]);
    expect(photoFiles(wired.root)).toHaveLength(1);
  });

  it("follows a redirect only to https", async () => {
    const calls = stubMedia((url) =>
      url.startsWith("https://api.twilio.com/") ? new Response(null, { status: 302, headers: { location: "http://media.cdn.example/photo" } }) : new Response(JPEG, { status: 200 }),
    );
    const wired = await cleaning();
    await mms(wired, "MM-plain", [{ url: media("plain"), type: "image/jpeg" }]);
    expect(calls.map((item) => item.url)).toEqual([media("plain")]);
    expect(photoFiles(wired.root)).toEqual([]);
  });
});

describe("Cleaner Core photos: the links", () => {
  it("a link works within one hour and is gone after", async () => {
    stubMedia();
    const clock = testClock();
    const wired = await cleaning(clock);
    await mms(wired, "MM-hour", [{ url: media("hour"), type: "image/jpeg" }]);
    const [link] = await links(wired);
    clock.later(59);
    expect((await get(wired, link?.url ?? "")).status).toBe(200);
    clock.later(61);
    expect((await get(wired, link?.url ?? "")).status).toBe(404);
  });

  it("a tampered or made-up token is not found", async () => {
    stubMedia();
    const wired = await cleaning();
    await mms(wired, "MM-tamper", [{ url: media("tamper"), type: "image/jpeg" }]);
    const [link] = await links(wired);
    const url = link?.url ?? "";
    const last = url.at(-1) === "a" ? "b" : "a";
    expect((await get(wired, `${url.slice(0, -1)}${last}`)).status).toBe(404);
    expect((await get(wired, `${url.slice(0, -10)}`)).status).toBe(404);
    expect((await get(wired, "https://tour.example/cleaner-core/photos/abcdef")).status).toBe(404);
    expect((await get(wired, "https://tour.example/cleaner-core/photos/..%2F..%2Fcleaner-live.json")).status).toBe(404);
  });

  it("keeps phone numbers, the door code, media URLs, and the Twilio login out of links, paths, files, and logs", async () => {
    stubMedia();
    const wired = await cleaning();
    await mms(wired, "MM-safe", jpegs(2, "safe"), "Kitchen and bath");
    const listed = await links(wired);
    expect(listed).toHaveLength(2);
    const paths = photoFiles(wired.root).map((file) => relative(wired.root, file));
    const check = await call(wired, "check_now");
    const saved = [
      readFileSync(join(wired.root, "cleaner-live.json"), "utf8"),
      readFileSync(join(wired.root, "cleaner-job", "cleaner-core.json"), "utf8"),
      ...wired.logs,
      check.raw,
    ].join("\n");
    for (const link of listed) {
      expect(link.url.includes(DOOR_CODE)).toBe(false);
      expect(/\d/.test(new URL(link.url).pathname)).toBe(false);
    }
    for (const path of paths) {
      expect(path.includes(DOOR_CODE)).toBe(false);
      expect(path.includes("5555550131")).toBe(false);
      expect(path.includes("MMsafe")).toBe(false);
    }
    for (const secret of ["api.twilio.com", "MMsafe", CLEANER_AUTH, "ACcleanerwiring", DOOR_CODE]) {
      expect(saved.includes(secret), secret).toBe(false);
    }
    const key = wired.env().CLEANER_CORE_PHOTO_KEY ?? "";
    expect(key.length).toBeGreaterThanOrEqual(32);
    expect(saved.includes(key)).toBe(false);
    expect(JSON.stringify(listed).includes(key)).toBe(false);
    expect((check.structured?.messages as { text: string }[]).at(-1)?.text).toBe("Kitchen and bath [photo]");
  });

  it("serves nothing with the flag off", async () => {
    stubMedia();
    const wired = await cleaning();
    await mms(wired, "MM-flag", [{ url: media("flag"), type: "image/jpeg" }]);
    const [link] = await links(wired);
    wired.setEnv({ CLEANER_CORE_ENABLED: undefined });
    expect((await get(wired, link?.url ?? "")).status).toBe(404);
    wired.setEnv({ CLEANER_CORE_ENABLED: "1" });
    expect((await get(wired, link?.url ?? "")).status).toBe(200);
  });
});
