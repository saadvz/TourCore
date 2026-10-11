import { createHash } from "node:crypto";
import { chmodSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { writeJsonAtomic } from "../storage/atomicWrite";
import { twilioHttpClient, type TwilioClient } from "../messaging/twilio/client";
import { formParams, verifyTwilioSignature } from "../messaging/twilio/signature";
import { DelegationError, type DelegationPrototype, type ReplySink } from "./prototype";

export const SMS_PROOF_RECIPIENT = "sms_proof_controlled_recipient";
export const SMS_PROOF_TEXT = "CLEANER CORE TEST";
export const SMS_PROOF_INBOUND = "/sms-proof/twilio/inbound";
export const SMS_PROOF_STATUS = "/sms-proof/twilio/status";
const identity = { tenantId: "synthetic_host", agentId: "grok_test_agent" };
const MessageSid = z.string().regex(/^SM[a-fA-F0-9]{32}$/);
const Instant = z.iso.datetime();
const ProviderStatus = z.enum(["accepted", "queued", "sending", "sent", "delivered", "undelivered", "failed"]);
const Inbound = z.strictObject({ messageSid: MessageSid, workId: z.string(), turnId: z.string(), receivedAt: Instant,
  windowStart: Instant, windowEnd: Instant, nextArrival: Instant, requestedStart: Instant, processed: z.boolean() });
const Outbound = z.strictObject({ key: z.string(), text: z.string(), status: z.enum(["sending", "accepted", "review_required"]),
  attemptedAt: Instant, acceptedAt: Instant.optional(), messageSid: MessageSid.optional(), providerStatus: ProviderStatus.optional(),
  providerStatusAt: Instant.optional(), errorCode: z.number().int().optional() });
const State = z.strictObject({ schemaVersion: z.literal(1), routingBinding: z.string(), inbound: z.array(Inbound), outbound: z.array(Outbound) });
type State = z.infer<typeof State>;
type Incoming = z.infer<typeof Inbound>;
export interface SmsProofSettings { accountSid: string; authToken: string; fromNumber: string; testNumber: string; publicBaseUrl: string }
export type SmsProofClient = Pick<TwilioClient, "sendSms">;
export class SmsProofError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

/** One allowlisted phone, exact test phrase, signed provider callbacks. No real bookings. */
export class SmsProof {
  readonly idempotent = false; // A Twilio POST is not exactly-once; uncertain sends require review.
  private readonly path: string;
  private readonly binding: string;
  private serial: Promise<unknown> = Promise.resolve();
  private readonly now: () => number;
  private readonly client: Pick<TwilioClient, "sendSms">;
  constructor(root: string, private readonly settings: SmsProofSettings, options: {
    now?: () => number; client?: SmsProofClient;
  } = {}) {
    this.path = join(root, "sms-proof.json");
    this.now = options.now ?? Date.now;
    this.binding = createHash("sha256").update(JSON.stringify([settings.accountSid, settings.fromNumber, settings.testNumber, settings.publicBaseUrl])).digest("hex");
    this.client = options.client ?? twilioHttpClient(settings, (url, init) => fetch(url, { ...init, redirect: "error", signal: AbortSignal.timeout(8000) }));
    const state = this.read(); this.save(state); // Persist destination binding before accepting any work.
  }
  private read(): State {
    const state = existsSync(this.path) ? State.parse(JSON.parse(readFileSync(this.path, "utf8")))
      : { schemaVersion: 1 as const, routingBinding: this.binding, inbound: [], outbound: [] };
    if (state.routingBinding !== this.binding) throw new Error("SMS proof routing changed. Use the original settings or a separate test storage directory.");
    return state;
  }
  private save(state: State) { writeJsonAtomic(this.path, State.parse(state)); chmodSync(this.path, 0o600); }
  private exclusive<T>(action: () => Promise<T> | T): Promise<T> {
    const next = this.serial.then(action); this.serial = next.catch(() => {}); return next;
  }
  verify(path: string, raw: Buffer, signature: string | undefined) {
    const search = new URLSearchParams(raw.toString("utf8"));
    if (new Set(search.keys()).size !== [...search.keys()].length) throw new SmsProofError(400, "Repeated form fields are not supported.");
    const params = formParams(raw);
    if (!verifyTwilioSignature(this.settings.authToken, `${this.settings.publicBaseUrl}${path}`, params, signature).ok
      || params.AccountSid !== this.settings.accountSid) throw new SmsProofError(403, "Provider authentication failed.");
    return params;
  }
  private async ensureWork(engine: DelegationPrototype, record: Incoming) {
    try { return await engine.get(identity, record.workId); }
    catch (error) { if (!(error instanceof DelegationError) || error.code !== "NOT_FOUND") throw error; }
    try {
      await engine.saveTurn({ tenantId: identity.tenantId, id: record.turnId, version: 1, recipient: SMS_PROOF_RECIPIENT,
        timeZone: "America/New_York", windowStart: record.windowStart, windowEnd: record.windowEnd, nextArrival: record.nextArrival, minimumMinutes: 90 });
    } catch (error) { if (!(error instanceof DelegationError) || error.code !== "VERSION_CONFLICT") throw error; }
    await engine.receive({ tenantId: identity.tenantId, providerEventId: `twilio_${record.messageSid}`, turnId: record.turnId, requestedStart: record.requestedStart, receivedAt: record.receivedAt });
    return await engine.get(identity, record.workId);
  }
  async receive(engine: DelegationPrototype, params: Record<string, string>) {
    const record = await this.exclusive(() => {
      if (params.From !== this.settings.testNumber || params.To !== this.settings.fromNumber) throw new SmsProofError(403, "This test accepts only its configured phone pair.");
      if (params.Body?.trim().toUpperCase() !== SMS_PROOF_TEXT || params.NumMedia && params.NumMedia !== "0") throw new SmsProofError(400, "Send the exact SMS proof phrase without attachments.");
      const messageSid = MessageSid.safeParse(params.MessageSid);
      if (!messageSid.success) throw new SmsProofError(400, "A valid provider message ID is required.");
      const state = this.read();
      let record = state.inbound.find((r) => r.messageSid === messageSid.data);
      if (!record) {
        const now = this.now(); const iso = (hours: number) => new Date(now + hours * 3_600_000).toISOString();
        const providerEventId = `twilio_${messageSid.data}`;
        record = { messageSid: messageSid.data, workId: `work_${createHash("sha256").update(JSON.stringify([identity.tenantId, providerEventId])).digest("hex").slice(0, 32)}`,
          turnId: `turn_sms_${messageSid.data}`, receivedAt: iso(0), windowStart: iso(24), windowEnd: iso(30), nextArrival: iso(31), requestedStart: iso(25), processed: false };
        state.inbound.push(record); this.save(state); // Provider input durable before acknowledgment.
      }
      return { ...record };
    });
    const work = await this.ensureWork(engine, record);
    await this.exclusive(() => { const state = this.read(); state.inbound.find((r) => r.messageSid === record.messageSid)!.processed = true; this.save(state); });
    return work;
  }
  /** Recover input saved before an engine write, without relying on a provider retry. */
  async recover(engine: DelegationPrototype): Promise<void> {
    const records = await this.exclusive(() => this.read().inbound.filter((r) => !r.processed));
    for (const record of records) {
      await this.ensureWork(engine, record);
      await this.exclusive(() => { const state = this.read(); state.inbound.find((r) => r.messageSid === record.messageSid)!.processed = true; this.save(state); });
    }
  }
  send: ReplySink["send"] = (reply) => this.exclusive(async () => {
    if (reply.tenantId !== identity.tenantId || reply.recipient !== SMS_PROOF_RECIPIENT || !/^reply_work_[a-f0-9]{32}$/.test(reply.key)) throw new Error("Unapproved SMS destination.");
    const state = this.read();
    if (!state.inbound.some((r) => `reply_${r.workId}` === reply.key)) throw new Error("No authorized inbound SMS for this reply.");
    const previous = state.outbound.find((r) => r.key === reply.key);
    if (previous) {
      if (previous.text !== reply.text || previous.status !== "accepted" || !previous.messageSid) throw new Error("SMS send requires review; it will not be repeated.");
      return { receipt: previous.messageSid };
    }
    const record: z.infer<typeof Outbound> = { key: reply.key, text: reply.text, status: "sending", attemptedAt: new Date(this.now()).toISOString() };
    state.outbound.push(record); this.save(state);
    try {
      const result = await this.client.sendSms({ to: this.settings.testNumber, from: this.settings.fromNumber, body: `Cleaner Core TEST: ${reply.text}`,
        statusCallback: `${this.settings.publicBaseUrl}${SMS_PROOF_STATUS}/${reply.key}` });
      const sid = MessageSid.parse(result.sid);
      const status = ProviderStatus.safeParse(result.status);
      record.messageSid = sid;
      if (status.success) { record.providerStatus = status.data; record.providerStatusAt = new Date(this.now()).toISOString(); }
      if (result.errorCode != null) record.errorCode = result.errorCode;
      if (result.errorCode || status.success && ["failed", "undelivered"].includes(status.data)) throw new Error("SMS provider rejected delivery.");
      record.messageSid = sid; record.status = "accepted"; record.acceptedAt = new Date(this.now()).toISOString();
      if (status.success) { record.providerStatus = status.data; record.providerStatusAt = record.acceptedAt; }
      this.save(state); return { receipt: sid }; // Provider acceptance, not proof of carrier delivery.
    } catch {
      record.status = "review_required"; this.save(state); throw new Error("SMS outcome could not be confirmed; do not resend automatically.");
    }
  });
  updateStatus(key: string, params: Record<string, string>) {
    return this.exclusive(() => {
      const state = this.read(); const record = state.outbound.find((r) => r.key === key);
      const sid = MessageSid.safeParse(params.MessageSid); const status = ProviderStatus.safeParse(params.MessageStatus);
      if (!record || !sid.success || !status.success || record.messageSid && record.messageSid !== sid.data) throw new SmsProofError(400, "Unknown message status update.");
      // Older queued/sent callbacks cannot overwrite a terminal delivery result.
      if (record.providerStatus && ["delivered", "failed", "undelivered"].includes(record.providerStatus)) return;
      record.messageSid = sid.data; record.providerStatus = status.data; record.providerStatusAt = new Date(this.now()).toISOString();
      if (params.ErrorCode && /^\d+$/.test(params.ErrorCode)) record.errorCode = Number(params.ErrorCode);
      this.save(state);
    });
  }
  evidence(workId?: string) {
    return this.exclusive(() => {
      const state = this.read();
      return { provider: "twilio", receiptMeaning: "provider_acceptance", inbound: state.inbound.filter((r) => !workId || r.workId === workId),
        outbound: state.outbound.filter((r) => !workId || r.key === `reply_${workId}`) };
    });
  }
}
