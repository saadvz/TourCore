import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { normalizePhone } from "../core/phone";
import type { IntentInterpreter } from "../intent";
import { MessagingEndpoints } from "../messaging/endpoints";
import type { InboundMessage } from "../messaging/inbound";
import type { MessagingAdapter } from "../messaging/Messenger";
import { isCurrent, type PropertyWorkspace } from "../setup/workspace";
import { writeJsonAtomic } from "../storage/atomicWrite";
import { StorageUnavailableError } from "../storage/errors";
import type { TourCoreStore } from "../storage/Store";
import { MemoryRuntimeStore, type RuntimeStore } from "../storage/runtimeStore";
import { isLiveMessaging } from "../config/tourCoreConfig";
import { publicBaseUrl } from "../messaging/publicUrl";
import { effectiveEnv } from "../install/settings";
import type { ResolvedConsentMode } from "../messaging/consentPolicy";
import { handleVisitorText, isGreeting } from "./conversation";
import { SmsConsentDirectory } from "./smsConsent";
import { restoreSession, RestoreError, SessionPersistence, type DurableSession } from "./durableSession";
import { VisitorDemoSession, type VisitorDemoRegistry } from "./session";
import type { VerificationLinks } from "./verificationLinks";

type Transport = MessagingAdapter & { noteChannel?: (number: string, channel: InboundMessage["channel"]) => void };

export const RESTORE_TROUBLE = "I'm having trouble restoring your tour. I've alerted the property team.";

/** A conversation that couldn't be restored safely, as the operator sees it. */
export interface NeedsAttention {
  visitorPhone: string;
  problem: string;
  at: string;
}

/**
 * Hands a verified, de-duplicated inbound message to the right visitor
 * conversation (the same session type the browser phone uses) and saves the
 * records afterwards. Provider-neutral: any messaging webhook can call it.
 * The receiving line decides the property; conversations are saved after
 * every message and picked up again after a restart.
 */
export class MessagingConversations {
  private readonly persistence: SessionPersistence;
  /** Conversations that couldn't be restored safely, by "<propertyId>:<phone>". */
  private readonly broken = new Map<string, DurableSession>();

  constructor(
    private readonly deps: {
      workspace: PropertyWorkspace;
      registry: VisitorDemoRegistry;
      /** The live transport, e.g. the Sendblue adapter. */
      transport: () => Transport;
      links: VerificationLinks;
      /** Where conversation snapshots are kept. Defaults to memory only (nothing survives a restart). */
      runtime?: RuntimeStore;
      /** Which property answers on which line. Defaults to adopting the line for the one real-phone property. */
      endpoints?: MessagingEndpoints;
      /** The line to assume when a provider doesn't say which number was texted. */
      defaultLine?: () => string | undefined;
      now?: () => Date;
      /** Real-time source for new conversations (tests move it; production uses the system clock). */
      realNow?: () => number;
      /** Reads what a typed message is trying to do. Defaults to the built-in rules. */
      interpreter?: IntentInterpreter;
      log?: (line: string) => void;
      /** Keyword confirmation or immediate conversation. Defaults to keyword confirmation. */
      consentMode?: () => ResolvedConsentMode;
      publicBaseUrl?: () => string | undefined;
      /** Google Drive canonical store for new and restored conversations. */
      storeFor?: (config: import("../config/tourCoreConfig").TourCoreConfig) => TourCoreStore | undefined;
      storageRead?: () => "live" | "cached" | "stale";
      beforeAccess?: () => Promise<void>;
      /** Called after a conversation's records are saved, from any surface (e.g. to look for new exceptions). */
      onSaved?: (session: VisitorDemoSession) => void;
    },
  ) {
    const runtime = deps.runtime ?? new MemoryRuntimeStore();
    this.persistence = new SessionPersistence(deps.workspace, runtime, deps.links);
    this.endpoints = deps.endpoints ?? new MessagingEndpoints(runtime);
    this.smsConsent = new SmsConsentDirectory(deps.workspace.root);
  }

  private readonly endpoints: MessagingEndpoints;
  private readonly smsConsent: SmsConsentDirectory;

  /** How many conversations are held for the operator after the last restore. */
  get attentionCount(): number {
    return this.broken.size;
  }

  /** Drops conversations this process was holding after a failed restore. */
  dropLive(): void {
    this.broken.clear();
  }

  async receive(message: InboundMessage): Promise<{ correlationId?: string }> {
    const { workspace: ws, registry } = this.deps;
    const line = message.to ?? this.deps.defaultLine?.();
    if (!this.deps.endpoints) adoptLegacyLine(ws, this.endpoints, line);
    const endpoint = this.endpoints.resolve(line);
    if (!endpoint || !ws.has(endpoint.propertyId)) {
      this.deps.log?.("A message arrived on a texting number that isn't connected to a property. It was not answered.");
      return {};
    }
    const propertyId = endpoint.propertyId;
    const transport = this.deps.transport();
    transport.noteChannel?.(message.from, message.channel);
    const meta = { provider: message.provider, providerMessageId: message.providerMessageId, deliveryChannel: message.channel };
    const phone = normalizePhone(message.from);

    const trouble = this.broken.get(`${propertyId}:${phone}`);
    if (trouble && !(await this.answerBroken(trouble, message.text))) return { correlationId: trouble.sessionId };

    let session = registry.latestForPhone(propertyId, phone, "messaging");
    // A finished tour is never reopened: a greeting starts a new one (repeat tour). A paused tour isn't finished.
    if (session && ["done", "stopped"].includes(await session.stage()) && !(await session.isPaused()) && isGreeting(message.text) && !session.optedOut) session = undefined;

    if (!session) {
      const { config, state } = ws.load(propertyId);
      const ready = state.readiness?.passed && isCurrent(state.readiness, state);
      if (!ready) {
        await transport.send({ to: phone, audience: "PROSPECT", body: `Thanks for reaching out to ${config.property.name}. Self-guided tours by text aren't available right now. Please contact the property team.` }).catch(() => undefined);
        return {};
      }
      session = registry.add(
        new VisitorDemoSession(propertyId, config, ws.newVisitorTourId(propertyId, this.deps.now?.() ?? new Date(), "text"), {
          transport,
          kind: "messaging",
          verificationLinks: this.deps.links,
          realNow: this.deps.realNow,
          store: this.deps.storeFor?.(config),
          storageRead: this.deps.storageRead,
          beforeAccess: this.deps.beforeAccess,
        }),
      );
      // Someone who texted STOP earlier stays opted out until they text START.
      session.optedOut = this.isOptedOut(propertyId, phone);
    }
    session.line = endpoint.address;
    this.applySmsConsent(session, propertyId, phone);
    const published = ws.load(propertyId).config;
    if (session.applyPublishedConfig(published)) {
      const stage = await session.stage();
      if (stage === "choose-date" || stage === "choose-time") await session.refreshOfferedSchedule();
    }

    const wasOptedOut = session.optedOut;
    try {
      await handleVisitorText(session, phone, message.text, meta, this.deps.interpreter);
    } catch (err) {
      if (err instanceof StorageUnavailableError) {
        await transport.send({ to: phone, audience: "PROSPECT", body: "I couldn't save that, so nothing was booked or changed. Please try again in a little while." }).catch(() => undefined);
        return { correlationId: session.id };
      }
      throw err;
    }
    if (session.optedOut !== wasOptedOut) this.setOptOut(propertyId, phone, session.optedOut);
    await this.save(session);
    return { correlationId: session.id };
  }

  /** Saves a conversation's tour records and its snapshot. Use after any change, from any surface. */
  async save(session: VisitorDemoSession): Promise<void> {
    await this.persistence.save(session);
    this.deps.onSaved?.(session);
  }

  /** Conversations the operator should look at because they couldn't be picked up after a restart. */
  needsAttention(propertyId: string): NeedsAttention[] {
    return [...this.broken.values()]
      .filter((s) => s.propertyId === propertyId)
      .map((s) => ({ visitorPhone: s.visitorPhone, problem: s.recovery?.problem ?? "Couldn't be restored.", at: s.recovery?.at ?? s.updatedAt }));
  }

  private storeForProperty(propertyId: string) {
    if (!this.deps.storeFor || !this.deps.workspace.has(propertyId)) return undefined;
    return this.deps.storeFor(this.deps.workspace.load(propertyId).config);
  }

  /** Sends through the live transport, created only when a message actually goes out. */
  private lazyTransport(): Transport {
    return {
      provider: this.deps.transport().provider,
      presentation: "MESSAGING",
      send: (m) => this.deps.transport().send(m),
      noteChannel: (n, c) => this.deps.transport().noteChannel?.(n, c),
    };
  }

  /**
   * After a restart, brings back text-message conversations: the latest one
   * per phone at each property, finished or not, so a visitor mid-tour carries
   * on and a finished one gets the usual "text HI for a new tour". Anything
   * that doesn't check out against the tour records is held for the operator
   * and never resumed.
   */
  async restoreSaved(): Promise<number> {
    const log = this.deps.log ?? (() => {});
    const { snapshots, unreadable } = this.persistence.all();
    for (const key of unreadable) log(`A saved text-message conversation (${key}) couldn't be read. It was not resumed.`);

    const latest = new Map<string, DurableSession>();
    for (const s of snapshots.sort((a, b) => a.createdAt.localeCompare(b.createdAt))) latest.set(`${s.propertyId}:${s.visitorPhone}`, s);

    let restored = 0;
    for (const [key, snapshot] of latest) {
      if (snapshot.status === "needs-attention") {
        this.broken.set(key, snapshot);
        continue;
      }
      if (this.deps.registry.find(snapshot.sessionId)) continue;
      try {
        const { session, notes } = await restoreSession(snapshot, { workspace: this.deps.workspace, transport: this.lazyTransport(), links: this.deps.links, realNow: this.deps.realNow, store: this.storeForProperty(snapshot.propertyId), storageRead: this.deps.storageRead, beforeAccess: this.deps.beforeAccess });
        this.deps.registry.add(session);
        for (const note of notes) log(`Restoring a text-message tour: ${note}`);
        restored++;
      } catch (err) {
        const problem = err instanceof RestoreError ? err.message : `Unexpected problem: ${err instanceof Error ? err.message : "unknown"}`;
        // A finished tour has nothing to resume; its history stays readable and the next text starts fresh.
        if (snapshot.status !== "active") {
          log(`A finished text-message tour wasn't reloaded (${problem}). Its history is unchanged.`);
          continue;
        }
        this.broken.set(key, this.persistence.markNeedsAttention(snapshot, problem, this.deps.now?.()));
        log(`A text-message tour couldn't be restored safely and needs attention: ${problem}`);
      }
    }
    restored += await this.restoreLegacy(latest);
    return restored;
  }

  /** Tours saved before conversations had snapshots: rebuilt from their records once, then saved the new way. */
  private async restoreLegacy(known: Map<string, DurableSession>): Promise<number> {
    const { workspace: ws, registry } = this.deps;
    const knownTours = new Set([...known.values()].map((s) => `${s.propertyId}:${s.tourId}`));
    const withSnapshot = new Set(this.persistence.all().snapshots.map((s) => `${s.propertyId}:${s.tourId}`));
    let restored = 0;
    for (const saved of ws.list().filter((p) => isLiveMessaging(p.config.messagingMode))) {
      const propertyId = saved.config.property.id;
      const seen = new Set<string>();
      for (const record of ws.listTours(propertyId)) {
        if (record.kind !== "messaging" || !record.visitorPhone || seen.has(record.visitorPhone)) continue;
        seen.add(record.visitorPhone);
        if (known.has(`${propertyId}:${record.visitorPhone}`) || knownTours.has(`${propertyId}:${record.tourId}`) || withSnapshot.has(`${propertyId}:${record.tourId}`)) continue;
        if (record.outcome !== "in-progress" || registry.latestForPhone(propertyId, record.visitorPhone, "messaging")) continue;
        const tour = ws.loadTour(propertyId, record.tourId);
        if (!tour) continue;
        const sessionId = tour.bundle.messages.find((m) => m.correlationId)?.correlationId ?? `vd_${record.tourId.replace(/[^A-Za-z0-9]/g, "").slice(-12)}`;
        const pseudo: DurableSession = {
          schemaVersion: 1,
          sessionId,
          propertyId,
          tourId: record.tourId,
          kind: "messaging",
          status: "active",
          step: "intro",
          visitorPhone: record.visitorPhone,
          offeredSlots: [],
          offeredDates: [],
          optedOut: false,
          createdAt: record.ranAt,
          updatedAt: record.updatedAt,
        };
        try {
          const { session } = await restoreSession(pseudo, { workspace: ws, transport: this.lazyTransport(), links: this.deps.links, realNow: this.deps.realNow, store: this.storeForProperty(propertyId), storageRead: this.deps.storageRead, beforeAccess: this.deps.beforeAccess });
          registry.add(session);
          await this.save(session);
          restored++;
        } catch (err) {
          const problem = err instanceof RestoreError ? err.message : "Unexpected problem restoring older records.";
          this.broken.set(`${propertyId}:${record.visitorPhone}`, this.persistence.markNeedsAttention(pseudo, problem, this.deps.now?.()));
          this.deps.log?.(`An older text-message tour couldn't be restored safely and needs attention: ${problem}`);
        }
      }
    }
    return restored;
  }

  /**
   * A text from someone whose tour couldn't be restored. They're told once
   * (and the team alerted once); after that, a greeting starts a fresh tour.
   * Returns true when the message should go on to a new conversation.
   */
  private async answerBroken(snapshot: DurableSession, text: string): Promise<boolean> {
    const key = `${snapshot.propertyId}:${snapshot.visitorPhone}`;
    if (snapshot.recovery?.visitorTold && isGreeting(text)) {
      this.broken.delete(key);
      return true;
    }
    const transport = this.deps.transport();
    const optedOut = this.isOptedOut(snapshot.propertyId, snapshot.visitorPhone);
    if (!snapshot.recovery?.visitorTold) {
      if (!optedOut) await transport.send({ to: snapshot.visitorPhone, audience: "PROSPECT", body: RESTORE_TROUBLE }).catch(() => undefined);
      const { config } = this.deps.workspace.load(snapshot.propertyId);
      await transport
        .send({
          to: config.operator.contact,
          toName: config.operator.name,
          audience: "OPERATOR",
          body: `A text-message tour for ${snapshot.visitorPhone} couldn't be picked up after a restart (${snapshot.recovery?.problem ?? "unknown problem"}). No doors were opened. Please reach out to them.`,
        })
        .catch(() => undefined);
      const told: DurableSession = { ...snapshot, recovery: { problem: snapshot.recovery?.problem ?? "Couldn't be restored.", at: snapshot.recovery?.at ?? snapshot.updatedAt, visitorTold: true } };
      this.persistence.put(told);
      this.broken.set(key, told);
    } else if (!optedOut) {
      await transport.send({ to: snapshot.visitorPhone, audience: "PROSPECT", body: `${RESTORE_TROUBLE} Text HI to start a new tour.` }).catch(() => undefined);
    }
    return false;
  }

  /** Keyword campaign consent is the source of truth. An older STOP file still counts as opted out. Nothing here marks a past tour opted in. */
  private applySmsConsent(session: VisitorDemoSession, propertyId: string, phone: string): void {
    const record = this.smsConsent.get(propertyId, phone);
    session.persistSmsConsent = (next) => this.smsConsent.save(propertyId, next);
    session.complianceBaseUrl = this.deps.publicBaseUrl ?? (() => publicBaseUrl(effectiveEnv()));
    session.smsConsentMode = this.deps.consentMode?.() ?? "keyword_confirm";
    if (record) {
      session.smsConsent = record.status;
      session.smsRecord = record;
      session.optedOut = record.status === "opted_out";
      return;
    }
    session.smsConsent = session.optedOut ? "opted_out" : undefined;
    session.smsRecord = undefined;
  }

  // Opt-outs outlive any one conversation, so they're kept per property on disk.
  private optOutFile(propertyId: string): string {
    return join(this.deps.workspace.root, "properties", propertyId, "messaging-opt-outs.json");
  }

  private isOptedOut(propertyId: string, phone: string): boolean {
    const file = this.optOutFile(propertyId);
    if (!existsSync(file)) return false;
    try {
      return !!(JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>)[phone];
    } catch {
      return true;
    }
  }

  private setOptOut(propertyId: string, phone: string, optedOut: boolean): void {
    const file = this.optOutFile(propertyId);
    const current: Record<string, string> = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
    if (optedOut) current[phone] = new Date().toISOString();
    else delete current[phone];
    writeJsonAtomic(file, current);
  }
}

/**
 * Setups saved before lines were mapped explicitly: connect the one texting
 * number this computer uses to the property that was already answering on it
 * (the published one, or the only one using real messaging). Ambiguous cases
 * are left for the operator's readiness check.
 */
export function adoptLegacyLine(workspace: PropertyWorkspace, endpoints: MessagingEndpoints, line: string | undefined, log?: (line: string) => void, provider = "sendblue"): void {
  if (!line || endpoints.resolve(line)) return;
  const candidates = workspace.list().filter((p) => isLiveMessaging(p.config.messagingMode) && !endpoints.forProperty(p.config.property.id));
  const published = candidates.filter((p) => p.state.status === "PUBLISHED_FOR_DEMO");
  const pick = published.length === 1 ? published[0] : candidates.length === 1 ? candidates[0] : undefined;
  if (!pick) return;
  endpoints.attach({ address: line, provider, propertyId: pick.config.property.id });
  log?.(`Connected texting number ${line} to ${pick.config.property.name}.`);
}
