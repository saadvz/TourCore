import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/tourCoreConfig";
import { zonedTimeToUtc } from "../src/core/timezone";
import { handleProviderWebhook } from "../src/messaging/pipeline";
import { MessagingLedger } from "../src/messaging/ledger";
import { LocalMessagingProvider } from "../src/messaging/local/provider";
import { PhotonMessagingProvider } from "../src/messaging/photon/provider";
import { parseSendblueInbound } from "../src/messaging/sendblue/webhook";
import { TwilioMessagingProvider } from "../src/messaging/twilio/provider";
import { DemoMessagingAdapter } from "../src/messaging/Messenger";
import { handleVisitorText, PHOTO_ALONE_REPLY, PHOTO_WITH_TEXT_REPLY } from "../src/visitor/conversation";
import { VisitorDemoSession } from "../src/visitor";
import { inbound, LINE } from "./fakeSendblue";
import { FALLBACK, liveApp, PHONE } from "./liveApp";

const MONDAY_7AM = zonedTimeToUtc({ year: 2026, month: 9, day: 28, hour: 7, minute: 0 }, "America/New_York").getTime();
const PHOTO = { media_url: "https://cdn.example.invalid/photo.jpg" };

const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).forEach((c) => c()));

function form(fields: Record<string, string>): Buffer {
  return Buffer.from(new URLSearchParams(fields).toString());
}

function phoneSession(now = MONDAY_7AM) {
  const transport = new DemoMessagingAdapter(() => {}, "MESSAGING");
  const session = new VisitorDemoSession("prop_100_alfred_way", loadConfig(), "t", { realNow: () => now, transport, kind: "messaging" });
  let n = 0;
  const say = (text: string, hasMedia = false) =>
    handleVisitorText(session, PHONE, text, { provider: "test", providerMessageId: `m_${++n}`, ...(hasMedia ? { hasMedia: true } : {}) });
  const replies = () => session.conversation.filter((m) => m.from === "tourcore").map((m) => m.text);
  return { session, say, replies };
}

async function bookAndArrive(p: ReturnType<typeof phoneSession>) {
  await p.say("TOUR");
  await p.say("YES");
  await p.say("1");
  await p.say("1");
  await p.say("1");
  await p.say("yes");
  await p.session.act("submitIdentity", { firstName: "Pat", lastName: "Smith", email: "pat@example.com", phone: PHONE });
  await p.say("I'm here");
}

describe("inbound media parsing", () => {
  it("Sendblue reads media_url and ignores a blank one", () => {
    expect(parseSendblueInbound({ ...inbound("+15550102000", "", "h-photo"), media_url: "https://cdn.example.invalid/p.jpg" })).toMatchObject({
      message: { text: "", media: [{ url: "https://cdn.example.invalid/p.jpg" }] },
    });
    const empty = parseSendblueInbound({ ...inbound("+15550102000", "Hi", "h-empty"), media_url: "" });
    expect(empty).toMatchObject({ message: { text: "Hi" } });
    expect("message" in empty && empty.message.media).toBeUndefined();
  });

  it("Twilio reads NumMedia / MediaUrl fields", () => {
    const provider = new TwilioMessagingProvider({
      env: () => ({ fromNumber: "+15555550123", fromNumberRaw: "+15555550123" }),
    });
    const parsed = provider.parseInbound(
      form({
        MessageSid: "SMphoto",
        From: "+15555550100",
        To: "+15555550123",
        Body: "",
        SmsStatus: "received",
        NumMedia: "1",
        MediaUrl0: "https://api.twilio.com/photo.jpg",
        MediaContentType0: "image/jpeg",
      }),
    );
    expect(parsed).toMatchObject({
      message: { provider: "twilio", text: "", media: [{ url: "https://api.twilio.com/photo.jpg", contentType: "image/jpeg" }] },
    });
  });

  it("Photon accepts an attachment instead of ignoring it", () => {
    const provider = new PhotonMessagingProvider({
      env: () => ({ projectId: "11111111-1111-4111-8111-111111111111", projectSecret: "secret" }),
    });
    const parsed = provider.parseInbound(
      Buffer.from(
        JSON.stringify({
          event: "messages",
          space: { id: "any;-;+15555550100", platform: "iMessage", type: "dm", phone: "+15555550123" },
          message: {
            id: "spc-img-1",
            timestamp: "2026-10-02T12:00:00.000Z",
            sender: { id: "+15555550100", platform: "iMessage" },
            content: { type: "attachment", mimeType: "image/heic", name: "IMG_1.HEIC" },
          },
        }),
      ),
    );
    expect(parsed).toMatchObject({
      message: { provider: "photon", providerMessageId: "spc-img-1", text: "", media: [{ contentType: "image/heic" }] },
    });
    expect(provider.parseInbound(Buffer.from(JSON.stringify({
      event: "messages",
      space: { type: "dm", phone: "+15555550123" },
      message: { id: "spc-react", sender: { id: "+15555550100" }, content: { type: "reaction" } },
    })))).toEqual({ ignored: "unsupported message" });
  });

  it("local loopback accepts hasMedia or a media array", () => {
    const provider = new LocalMessagingProvider();
    expect(provider.parseInbound(Buffer.from(JSON.stringify({ id: "m1", from: "+15555550100", to: "+15555550123", text: "", hasMedia: true })))).toMatchObject({
      message: { text: "", media: [{ contentType: "image/jpeg" }] },
    });
    expect(provider.parseInbound(Buffer.from(JSON.stringify({
      id: "m2",
      from: "+15555550100",
      to: "+15555550123",
      text: "What's this stain?",
      media: [{ url: "https://example.invalid/p.jpg", contentType: "image/jpeg" }],
    })))).toMatchObject({
      message: { text: "What's this stain?", media: [{ url: "https://example.invalid/p.jpg", contentType: "image/jpeg" }] },
    });
  });
});

describe("honest photo reply", () => {
  it("a photo alone before any booking text gets the honesty reply, not silence or the keyword prompt", async () => {
    const a = await liveApp({ cleanups });
    const replies = await a.text("", undefined, PHOTO);
    expect(replies).toEqual([PHOTO_ALONE_REPLY]);
    expect(replies.join("\n")).not.toMatch(/Text TOUR|didn't catch that|MMS/i);
  });

  it("a photo alone before booking gets the honesty reply once, not a greeting or a silent drop", async () => {
    const a = await liveApp({ cleanups });
    await a.optInSms();
    const handle = "same-photo-handle";
    const replies = await a.text("", handle, PHOTO);
    expect(replies).toEqual([PHOTO_ALONE_REPLY]);
    expect(replies.join("\n")).not.toMatch(/MMS|inject_local_sms|Sendblue|Twilio|Photon/i);
    const again = await a.text("", handle, PHOTO);
    expect(again).toEqual([]);
    expect((await a.grok("list_exceptions")).exceptions).toEqual([]);
  });

  it("a photo with a question before booking replies once and flags the text for the landlord", async () => {
    const a = await liveApp({ cleanups });
    await a.optInSms();
    const replies = await a.text("Is there a gym?", undefined, PHOTO);
    expect(replies[0]).toBe(PHOTO_WITH_TEXT_REPLY);
    expect(replies.join("\n")).not.toContain("Text your question");
    expect(replies).toContain(FALLBACK);
    expect(replies.filter((r) => r === PHOTO_WITH_TEXT_REPLY)).toHaveLength(1);
    const issues = (await a.grok("list_exceptions")).exceptions;
    expect(issues.map((x: { summary: string }) => x.summary)).toEqual(['Asked "Is there a gym?". There\'s no approved answer yet.']);
  });

  it("a photo during a tour gets the honesty reply and does not say it didn't catch that", async () => {
    const p = phoneSession(zonedTimeToUtc({ year: 2026, month: 9, day: 28, hour: 13, minute: 58 }, "America/New_York").getTime());
    await bookAndArrive(p);
    const before = p.replies();
    await p.say("", true);
    const added = p.replies().slice(before.length);
    expect(added).toEqual([PHOTO_ALONE_REPLY]);
    expect(added.join("\n")).not.toMatch(/didn't catch that|MMS/i);
  });

  it("a photo plus a booking reply uses the short honesty line and continues the text path", async () => {
    const a = await liveApp({ cleanups });
    await a.optInSms();
    const replies = await a.text("1", undefined, PHOTO);
    expect(replies[0]).toBe(PHOTO_WITH_TEXT_REPLY);
    expect(replies.join("\n")).not.toContain("Text your question");
    expect(replies.filter((r) => r === PHOTO_WITH_TEXT_REPLY)).toHaveLength(1);
    expect(replies.join("\n")).toMatch(/Happy to set up a self-guided tour of Unit 1A|Which day works for you/i);
  });

  it("a photo plus a question during a tour replies once and flags the text", async () => {
    const p = phoneSession(zonedTimeToUtc({ year: 2026, month: 9, day: 28, hour: 13, minute: 58 }, "America/New_York").getTime());
    await bookAndArrive(p);
    const before = p.replies();
    await p.say("Is there a pool?", true);
    const added = p.replies().slice(before.length);
    expect(added[0]).toBe(PHOTO_WITH_TEXT_REPLY);
    expect(added.join("\n")).not.toContain("Text your question");
    expect(added).toContain("I don't have that information for this property. I've flagged it for the property team so they can get back to you.");
    expect(added.filter((r) => r === PHOTO_WITH_TEXT_REPLY)).toHaveLength(1);
    expect((await p.session.store.listAudit()).some((e) => e.type === "QUESTION_UNANSWERED" && e.detail === "Is there a pool?")).toBe(true);
  });

  it("a retried local photo webhook does not send a second honesty reply", async () => {
    const ledger = new MessagingLedger();
    const sent: string[] = [];
    const provider = new LocalMessagingProvider({ ledger, now: () => new Date("2026-09-28T12:00:00.000Z") });
    const raw = Buffer.from(JSON.stringify({ id: "photo-1", from: "+15555550100", to: LINE, text: "", hasMedia: true }));
    const receive = async () => {
      sent.push("received");
    };
    const request = { rawBody: raw, headers: { "content-type": "application/json" } };
    expect((await handleProviderWebhook(provider, request, { ledger, receive })).body).toEqual({ ok: true });
    expect((await handleProviderWebhook(provider, request, { ledger, receive })).body).toEqual({ duplicate: true });
    expect(sent).toEqual(["received"]);
  });
});
