import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { afterEach, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { twilioSignature } from "../src/messaging/twilio/signature";
import { createDelegationTestService } from "../src/delegation/testService";
import { DelegationPrototype } from "../src/delegation/prototype";
import { SmsProof, SMS_PROOF_TEXT, SMS_PROOF_INBOUND, SMS_PROOF_STATUS, type SmsProofClient } from "../src/delegation/smsProof";

const cleanups: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const settings = { accountSid: `AC${"a".repeat(32)}`, authToken: "private_auth_token".repeat(3), fromNumber: "+12025550100", testNumber: "+12025550101", publicBaseUrl: "https://cleaner.example" };
const incoming = { AccountSid: settings.accountSid, MessageSid: `SM${"b".repeat(32)}`, From: settings.testNumber, To: settings.fromNumber, Body: SMS_PROOF_TEXT, NumMedia: "0" };
const outgoingSid = `SM${"c".repeat(32)}`;
const identity = { tenantId: "synthetic_host", agentId: "grok_test_agent" };
async function setup(client?: SmsProofClient, receiver?: (workId: string) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), "cleaner-sms-proof-")); cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const clock = { now: Date.parse("2026-10-11T18:00:00Z") };
  const sendSms = vi.fn(async (_input: Parameters<SmsProofClient["sendSms"]>[0]) => ({ sid: outgoingSid, status: "queued" }));
  const service = createDelegationTestService({ root, agentToken: "agent".repeat(10), adminToken: "admin".repeat(10), publicBaseUrl: settings.publicBaseUrl,
    sms: settings, smsClient: client ?? { sendSms }, now: () => clock.now, intervalMs: 10,
    webhook: { url: "https://hooks.example/receiver", authorization: "Bearer private_probe" },
    webhookFetch: async (_url, init) => { if (receiver) await receiver(JSON.parse(init.body as string).workId); return new Response(null, { status: 200 }); } });
  cleanups.push(() => service.stop());
  const server: Server = await new Promise((done) => { const s = service.app.listen(0, "127.0.0.1", () => done(s)); });
  cleanups.push(() => new Promise<void>((done) => { server.closeAllConnections(); server.close(() => done()); }));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const post = (path = SMS_PROOF_INBOUND, params: Record<string, string> = incoming, signature?: string) => fetch(`${url}${path}`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Twilio-Signature": signature ?? twilioSignature(settings.authToken, `${settings.publicBaseUrl}${path}`, params) }, body: new URLSearchParams(params).toString() });
  const evidence = async () => await (await fetch(`${url}/test/sms/evidence`, { headers: { Authorization: `Bearer ${"admin".repeat(10)}` } })).json() as { inbound: Array<{ workId: string; processed: boolean }>; outbound: Array<{ key: string; messageSid?: string; providerStatus?: string; status: string }> };
  return { root, clock, sendSms, service, url, post, evidence };
}

it("signed allowlisted SMS -> webhook -> real SDK claim/proposal -> provider acceptance -> signed delivered callback", async () => {
  let client: Client;
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: args }); expect(result.isError).not.toBe(true);
    return JSON.parse((result.content as Array<{ text: string }>)[0]!.text);
  };
  const h = await setup(undefined, async (id) => {
    const work = await call("claim_delegated_work", { id });
    await call("propose_cleaning_time", { id, leaseToken: work.leaseToken, actionKey: `grok_${id}`, expectedTurnVersion: work.turn.version, start: work.requestedStart });
  });
  client = new Client({ name: "scripted-sms-receiver", version: "1.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${h.url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${"agent".repeat(10)}` } } }));
  cleanups.push(() => client.close());
  expect(await (await fetch(`${h.url}/healthz`)).json()).toMatchObject({ mode: "sms-proof", ready: true });
  expect((await h.post()).status).toBe(200);
  await expect.poll(async () => (await h.evidence()).outbound[0]?.status).toBe("accepted");
  const evidence = await h.evidence(); const id = evidence.inbound[0]!.workId;
  expect((await call("read_delegated_work", { id }))).toMatchObject({ status: "completed", decisionSource: "agent", deliveryStatus: "sent" });
  expect(h.sendSms).toHaveBeenCalledTimes(1);
  expect(await (await fetch(`${h.url}/test/evidence/${id}`, { headers: { Authorization: `Bearer ${"admin".repeat(10)}` } })).json()).toMatchObject({ mode: "sms-proof", sms: { receiptMeaning: "provider_acceptance" } });
  expect(h.sendSms.mock.calls[0]![0]).toMatchObject({ from: settings.fromNumber, to: settings.testNumber, body: expect.stringContaining("Cleaner Core TEST: Cleaning scheduled"), statusCallback: `${settings.publicBaseUrl}${SMS_PROOF_STATUS}/reply_${id}` });
  expect(evidence.outbound[0]).toMatchObject({ messageSid: outgoingSid, providerStatus: "queued" });
  const callback = { AccountSid: settings.accountSid, MessageSid: outgoingSid, MessageStatus: "delivered" };
  expect((await h.post(`${SMS_PROOF_STATUS}/reply_${id}`, callback)).status).toBe(200);
  expect((await h.evidence()).outbound[0]!.providerStatus).toBe("delivered");
  expect((await h.post(`${SMS_PROOF_STATUS}/reply_${id}`, { ...callback, MessageStatus: "sent" })).status).toBe(200);
  expect((await h.evidence()).outbound[0]!.providerStatus).toBe("delivered");
  expect((await h.post()).status).toBe(200);
  expect((await h.evidence()).inbound).toHaveLength(1);
  expect(h.sendSms).toHaveBeenCalledTimes(1);
  const serialized = JSON.stringify(await h.evidence());
  for (const secret of [settings.authToken, settings.fromNumber, settings.testNumber]) expect(serialized).not.toContain(secret);
});

it("rejects unsigned, tampered, foreign account/phone, wrong phrase, and query-substituted requests without work or SMS", async () => {
  const h = await setup();
  expect((await h.post(SMS_PROOF_INBOUND, incoming, "invalid_signature")).status).toBe(403);
  for (const params of [{ ...incoming, AccountSid: `AC${"d".repeat(32)}` }, { ...incoming, From: "+12025550102" }, { ...incoming, To: "+12025550102" }]) expect((await h.post(SMS_PROOF_INBOUND, params)).status).toBe(403);
  expect((await h.post(SMS_PROOF_INBOUND, { ...incoming, Body: "schedule arbitrary text" })).status).toBe(400);
  expect((await h.post(`${SMS_PROOF_INBOUND}?unexpected=1`)).status).toBe(400);
  const oldSignature = twilioSignature(settings.authToken, settings.publicBaseUrl + SMS_PROOF_INBOUND, incoming);
  expect((await h.post(SMS_PROOF_INBOUND, { ...incoming, Body: "tampered" }, oldSignature)).status).toBe(403);
  expect((await h.evidence()).inbound).toHaveLength(0);
  expect(h.sendSms).not.toHaveBeenCalled();
  expect((await fetch(`${h.url}/test/sms/evidence`)).status).toBe(401);
});

it("deduplicates simultaneous provider retries and sends one independent fallback with the agent offline", async () => {
  const h = await setup();
  const responses = await Promise.all([h.post(), h.post()]); expect(responses.map((r) => r.status)).toEqual([200, 200]);
  expect((await h.evidence()).inbound).toHaveLength(1);
  h.clock.now += 120000;
  await expect.poll(async () => (await h.evidence()).outbound[0]?.status).toBe("accepted");
  const id = (await h.evidence()).inbound[0]!.workId;
  expect(await h.service.engine.get(identity, id)).toMatchObject({ status: "completed", decisionSource: "fallback", turn: { version: 1 } });
  expect(h.sendSms).toHaveBeenCalledTimes(1);
});

it("keeps synthetic fixtures local even while the optional SMS proof is enabled", async () => {
  const h = await setup();
  const response = await fetch(`${h.url}/test/events`, { method: "POST", headers: { Authorization: `Bearer ${"admin".repeat(10)}`, "Content-Type": "application/json" }, body: JSON.stringify({ eventId: "synthetic_only" }) });
  expect(response.status).toBe(200); h.clock.now += 120000;
  await expect.poll(() => h.service.sink.replies().length).toBe(1);
  expect(h.sendSms).not.toHaveBeenCalled();
});

it("cannot mark pending SMS sent through the simulated ledger after SMS is disabled", async () => {
  const h = await setup(); await h.post(); await h.service.stop();
  const id = (await h.evidence()).inbound[0]!.workId; h.clock.now += 120000;
  const disabled = createDelegationTestService({ root: h.root, agentToken: "agent".repeat(10), adminToken: "admin".repeat(10), now: () => h.clock.now, intervalMs: 60000 });
  await disabled.stop();
  for (let i = 0; i < 4; i++) { h.clock.now += 5000; await disabled.engine.tick(); }
  expect(await disabled.engine.get(identity, id)).toMatchObject({ status: "review_required", deliveryStatus: "review_required" });
  expect(disabled.sink.replies()).toHaveLength(0);
  expect(h.sendSms).not.toHaveBeenCalled();
});

it("does not resend after an uncertain provider outcome, even after restart", async () => {
  const sendSms = vi.fn(async () => { throw new Error(settings.authToken); });
  const h = await setup({ sendSms });
  expect((await h.post()).status).toBe(200); h.clock.now += 120000;
  await expect.poll(async () => (await h.evidence()).outbound[0]?.status).toBe("review_required");
  const id = (await h.evidence()).inbound[0]!.workId;
  await h.service.stop();
  const sms = new SmsProof(h.root, settings, { client: { sendSms }, now: () => h.clock.now });
  const restarted = new DelegationPrototype(h.root, sms, { now: () => h.clock.now });
  await restarted.tick(); h.clock.now += 100000; await restarted.tick();
  expect((await restarted.get(identity, id)).status).toBe("review_required");
  expect(sendSms).toHaveBeenCalledTimes(1);
  // A later delivery callback can establish carrier outcome without authorizing a retry.
  await sms.updateStatus(`reply_${id}`, { MessageSid: outgoingSid, MessageStatus: "delivered" });
  await restarted.tick();
  expect((await restarted.get(identity, id)).status).toBe("review_required");
  expect((await sms.evidence(id)).outbound[0]).toMatchObject({ status: "review_required", providerStatus: "delivered" });
  expect(sendSms).toHaveBeenCalledTimes(1);
  expect(readFileSync(join(h.root, "sms-proof.json"), "utf8")).not.toContain(settings.authToken);
});

it("recovers durable inbound input after an engine write failed", async () => {
  const h = await setup();
  await h.service.stop(); // Recover explicitly after the original deadline has passed.
  const receive = vi.spyOn(h.service.engine, "receive").mockRejectedValueOnce(new Error("storage temporarily unavailable"));
  await expect(h.service.sms!.receive(h.service.engine, incoming)).rejects.toThrow("storage temporarily unavailable");
  h.clock.now += 130000;
  await h.service.sms!.recover(h.service.engine);
  expect((await h.evidence()).inbound[0]?.processed).toBe(true);
  const id = (await h.evidence()).inbound[0]!.workId;
  expect(await h.service.engine.get(identity, id)).toMatchObject({ status: "reply_pending", decisionSource: "fallback", receivedAt: "2026-10-11T18:00:00.000Z", deadlineAt: "2026-10-11T18:02:00.000Z" });
  expect(receive).toHaveBeenCalledTimes(2);
  await h.service.engine.tick();
  expect(h.sendSms).toHaveBeenCalledTimes(1);
});

it("fails closed on corrupt storage and changed SMS routing", async () => {
  const h = await setup();
  expect(() => new SmsProof(h.root, { ...settings, testNumber: "+12025550102" })).toThrow("routing changed");
  writeFileSync(join(h.root, "sms-proof.json"), "{damaged");
  expect(() => new SmsProof(h.root, settings)).toThrow();
  expect(readFileSync(join(h.root, "sms-proof.json"), "utf8")).toBe("{damaged");
});

it("requires a matching provider message ID on status updates", async () => {
  const h = await setup();
  await h.post(); h.clock.now += 120000;
  await expect.poll(async () => (await h.evidence()).outbound[0]?.status).toBe("accepted");
  const id = (await h.evidence()).inbound[0]!.workId;
  const callback = { AccountSid: settings.accountSid, MessageSid: `SM${"d".repeat(32)}`, MessageStatus: "delivered" };
  expect((await h.post(`${SMS_PROOF_STATUS}/reply_${id}`, callback)).status).toBe(400);
  expect((await h.evidence()).outbound[0]!.providerStatus).toBe("queued");
});

it("uses the real Twilio client with fixed routing, account authentication, timeout and redirect refusal", async () => {
  const root = mkdtempSync(join(tmpdir(), "cleaner-sms-wire-")); cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  let now = Date.parse("2026-10-11T18:00:00Z");
  const wire = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ sid: outgoingSid, status: "queued" }), { status: 201 }));
  cleanups.push(() => wire.mockRestore());
  const sms = new SmsProof(root, settings, { now: () => now });
  const engine = new DelegationPrototype(root, sms, { now: () => now });
  const work = await sms.receive(engine, incoming); now += 120000; await engine.tick();
  expect(wire).toHaveBeenCalledTimes(1);
  const [url, init] = wire.mock.calls[0]!;
  expect(url).toBe(`https://api.twilio.com/2010-04-01/Accounts/${settings.accountSid}/Messages.json`);
  expect(init).toMatchObject({ method: "POST", redirect: "error", signal: expect.any(AbortSignal),
    headers: { Authorization: `Basic ${Buffer.from(`${settings.accountSid}:${settings.authToken}`).toString("base64")}` } });
  const params = new URLSearchParams(init!.body as string);
  expect(Object.fromEntries(params)).toEqual({ To: settings.testNumber, From: settings.fromNumber,
    Body: expect.stringContaining("Cleaner Core TEST: "), StatusCallback: `${settings.publicBaseUrl}${SMS_PROOF_STATUS}/reply_${work.id}` });
  expect((await sms.evidence()).outbound[0]).toMatchObject({ status: "accepted", providerStatus: "queued" });
});
