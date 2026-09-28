import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/tourCoreConfig";
import { zonedTimeToUtc } from "../src/core/timezone";
import { MessagingLedger } from "../src/messaging/ledger";
import { SendblueMessagingAdapter, mapSendblueError } from "../src/messaging/sendblue/adapter";
import { checkSendblue } from "../src/messaging/sendblue/readiness";
import { setSendblueRuntime } from "../src/messaging/sendblue/runtime";
import { handleSendblueWebhook, parseSendblueInbound, verifySendblueWebhook } from "../src/messaging/sendblue/webhook";
import { runReadinessCheck } from "../src/setup";
import { apiError, fakeSendblue, inbound, LINE, SECRET, sendblueEnv } from "./fakeSendblue";

const MONDAY_7AM = zonedTimeToUtc({ year: 2026, month: 9, day: 28, hour: 7, minute: 0 }, "America/New_York");
const restores: Array<() => void> = [];
afterEach(() => restores.splice(0).forEach((r) => r()));

describe("Sendblue adapter", () => {
  it("sends through the SDK with E.164 numbers and returns a provider-neutral receipt", async () => {
    const fake = fakeSendblue();
    const adapter = new SendblueMessagingAdapter({ client: fake.client, fromNumber: "(555) 000-9999" });
    const receipt = await adapter.send({ to: "555-010-2000", audience: "PROSPECT", body: "Hello" });
    expect(fake.sent).toEqual([{ from_number: LINE, number: "+15550102000", content: "Hello" }]);
    expect(receipt).toMatchObject({ provider: "sendblue", providerMessageId: "out_1", status: "QUEUED", channel: "UNKNOWN" });

    adapter.noteChannel("+15550102000", "IMESSAGE");
    expect((await adapter.send({ to: "+15550102000", audience: "PROSPECT", body: "Again" })).channel).toBe("IMESSAGE");
  });

  it("never sends the same message twice for one idempotency key", async () => {
    const fake = fakeSendblue();
    const adapter = new SendblueMessagingAdapter({ client: fake.client, fromNumber: LINE, ledger: new MessagingLedger() });
    const a = await adapter.send({ to: "+15550102000", audience: "PROSPECT", body: "Once", idempotencyKey: "msg_1" });
    const b = await adapter.send({ to: "+15550102000", audience: "PROSPECT", body: "Once", idempotencyKey: "msg_1" });
    expect(fake.sent).toHaveLength(1);
    expect(b).toEqual(a);
  });

  it("maps Sendblue errors to provider-neutral codes without leaking secrets", async () => {
    expect(mapSendblueError(apiError(401, "AuthenticationError")).code).toBe("SENDBLUE_AUTH_FAILED");
    expect(mapSendblueError(apiError(422)).code).toBe("SENDBLUE_REJECTED");
    expect(mapSendblueError(apiError(503)).code).toBe("SENDBLUE_UNAVAILABLE");
    expect(mapSendblueError(Object.assign(new Error("fetch failed"), { name: "APIConnectionError" })).code).toBe("SENDBLUE_UNREACHABLE");

    const fake = fakeSendblue({ sendError: () => apiError(401, "AuthenticationError") });
    const adapter = new SendblueMessagingAdapter({ client: fake.client, fromNumber: LINE });
    const err = await adapter.send({ to: "+15550102000", audience: "PROSPECT", body: "x" }).catch((e) => e);
    expect(err).toMatchObject({ code: "SENDBLUE_AUTH_FAILED" });
    expect(String(err.message)).not.toMatch(/secret-key|key-id/);
  });

  it("doesn't text operator alerts over the visitor line", async () => {
    const fake = fakeSendblue();
    const adapter = new SendblueMessagingAdapter({ client: fake.client, fromNumber: LINE });
    expect((await adapter.send({ to: "Leasing team", audience: "OPERATOR", body: "alert" })).status).toBe("SKIPPED");
    expect(fake.sent).toHaveLength(0);
  });
});

describe("Sendblue readiness", () => {
  const sendblueProperty = () => ({ ...loadConfig(), messagingMode: "sendblue" as const });

  it("explains missing credentials in plain language", async () => {
    restores.push(setSendblueRuntime({ env: () => sendblueEnv({ apiKey: undefined, apiSecret: undefined }) }));
    const checks = await checkSendblue();
    expect(checks.find((c) => c.id === "account")).toMatchObject({ ok: false, code: "SENDBLUE_KEYS_MISSING" });

    const result = await runReadinessCheck(sendblueProperty(), { now: MONDAY_7AM });
    const messaging = result.checks.find((c) => c.id === "messaging")!;
    expect(messaging).toMatchObject({ ok: false, label: "Visitor messaging" });
    expect(messaging.problems[0]).toBe("Visitor messaging isn't connected yet: the Sendblue account details aren't set up on this computer.");
  });

  it("passes when the account, line, webhook and form links are all connected", async () => {
    const fake = fakeSendblue();
    restores.push(setSendblueRuntime({ env: () => sendblueEnv(), client: () => fake.client }));
    const checks = await checkSendblue();
    expect(checks.map((c) => [c.message, c.ok])).toEqual([
      ["Sendblue account connected", true],
      [`Messaging number connected (${LINE})`, true],
      ["Incoming messages connected", true],
      ["Visitors can open the identity form from their phone", true],
    ]);
    const result = await runReadinessCheck(sendblueProperty(), { now: MONDAY_7AM });
    expect(result.passed).toBe(true);
    expect(result.checks.find((c) => c.id === "messaging")!.label).toBe("Visitor messaging connected");
    expect(fake.sent).toHaveLength(0);
  });

  it("reports bad credentials, an unknown line and a missing webhook", async () => {
    restores.push(setSendblueRuntime({ env: () => sendblueEnv(), client: () => fakeSendblue({ listError: apiError(401, "AuthenticationError") }).client }));
    expect((await checkSendblue()).find((c) => c.id === "account")).toMatchObject({ ok: false, code: "SENDBLUE_AUTH_FAILED", message: "Visitor messaging couldn't sign in to Sendblue. Check the Sendblue account details." });

    restores.push(setSendblueRuntime({ env: () => sendblueEnv(), client: () => fakeSendblue({ lines: [{ sendblue_number: "+15550001111", status: "ONLINE" }], hooks: [] }).client }));
    const checks = await checkSendblue();
    expect(checks.find((c) => c.id === "line")?.code).toBe("SENDBLUE_LINE_NOT_FOUND");
    expect(checks.find((c) => c.id === "incoming")?.code).toBe("SENDBLUE_WEBHOOK_NOT_REGISTERED");

    restores.push(setSendblueRuntime({ env: () => sendblueEnv({ publicBaseUrl: undefined, publicBaseUrlRaw: undefined }), client: () => fakeSendblue().client }));
    const noUrl = await checkSendblue();
    expect(noUrl.find((c) => c.id === "verify-link")).toMatchObject({ ok: false, message: "Visitors can't open the identity form from their phone until a public https web address is set." });
  });
});

describe("Sendblue webhook", () => {
  const body = (payload: unknown) => Buffer.from(JSON.stringify(payload));

  it("parses an inbound message into Tour Core's provider-neutral form", () => {
    const parsed = parseSendblueInbound(inbound("+1 (555) 010-2000", " Hi ", "h1"));
    expect(parsed).toMatchObject({ message: { provider: "sendblue", providerMessageId: "h1", from: "+15550102000", to: LINE, text: "Hi", channel: "IMESSAGE" } });
    expect(parseSendblueInbound({ ...inbound("+15550102000", "x", "h2"), is_outbound: true })).toEqual({ ignored: "outbound status update" });
    expect(parseSendblueInbound({ ...inbound("+15550102000", "x", "h3"), group_id: "g1" })).toEqual({ ignored: "group message" });
  });

  it("rejects requests without the right secret before parsing them", () => {
    const raw = body(inbound("+15550102000", "Hi", "h1"));
    expect(verifySendblueWebhook(raw, {}, SECRET)).toEqual({ ok: false, code: "WEBHOOK_UNSIGNED" });
    expect(verifySendblueWebhook(raw, { "sb-signing-secret": "wrong" }, SECRET)).toEqual({ ok: false, code: "WEBHOOK_SIGNATURE_INVALID" });
    expect(verifySendblueWebhook(raw, { "sb-signing-secret": SECRET }, SECRET)).toEqual({ ok: true, signed: true });
  });

  it("accepts a valid timestamped signature and refuses replays", () => {
    const raw = body(inbound("+15550102000", "Hi", "h1"));
    const now = Date.now();
    const t = Math.floor(now / 1000);
    const sig = createHmac("sha256", SECRET).update(`${t}.${raw.toString()}`).digest("hex");
    expect(verifySendblueWebhook(raw, { "x-sendblue-signature": `t=${t},v1=${sig}` }, SECRET, now)).toEqual({ ok: true, signed: true });
    expect(verifySendblueWebhook(Buffer.from(raw.toString().replace("Hi", "Ho")), { "x-sendblue-signature": `t=${t},v1=${sig}` }, SECRET, now).ok).toBe(false);
    expect(verifySendblueWebhook(raw, { "x-sendblue-signature": `t=${t},v1=${sig}` }, SECRET, now + 10 * 60_000)).toEqual({ ok: false, code: "WEBHOOK_SIGNATURE_EXPIRED" });
  });

  it("processes a retried delivery only once", async () => {
    const received: string[] = [];
    const ledger = new MessagingLedger();
    const deliver = () =>
      handleSendblueWebhook(
        { rawBody: body(inbound("+15550102000", "Hi", "same-handle")), headers: { "sb-signing-secret": SECRET } },
        { secret: SECRET, ledger, receive: async (m) => void received.push(m.providerMessageId) },
      );
    expect((await deliver()).body).toEqual({ ok: true });
    expect((await deliver()).body).toEqual({ duplicate: true });
    expect((await deliver()).status).toBe(200);
    expect(received).toEqual(["same-handle"]);
    expect(ledger.duplicatesOf("sendblue:in:same-handle")).toBe(2);
  });

  it("returns 401 for a bad secret and never calls Tour Core", async () => {
    let called = false;
    const res = await handleSendblueWebhook(
      { rawBody: body(inbound("+15550102000", "Hi", "h9")), headers: { "sb-signing-secret": "nope" } },
      { secret: SECRET, ledger: new MessagingLedger(), receive: async () => void (called = true) },
    );
    expect(res.status).toBe(401);
    expect(called).toBe(false);
  });
});
