import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { removedPropertyVisitorText } from "../core/availabilityCopy";
import { normalizePhone } from "../core/phone";
import { keywordOf, type IntentInterpreter } from "../intent";
import { MessagingEndpoints, type MessagingEndpoint } from "../messaging/endpoints";
import { hasInboundMedia, type InboundMessage } from "../messaging/inbound";
import type { MessagingAdapter } from "../messaging/Messenger";
import { TERMINAL } from "../domain/stateMachine";
import type { Reservation, TourTimeRequest } from "../domain/model";
import type { OccupiedWindow } from "../core/customSlot";
import { SetupInputError } from "../setup/setupActions";
import { isCurrent, type PropertyWorkspace } from "../setup/workspace";
import { writeJsonAtomic } from "../storage/atomicWrite";
import { StorageUnavailableError } from "../storage/errors";
import type { TourCoreStore } from "../storage/Store";
import { MemoryRuntimeStore, type RuntimeStore } from "../storage/runtimeStore";
import { isLiveMessaging } from "../config/tourCoreConfig";
import { publicBaseUrl } from "../messaging/publicUrl";
import { effectiveEnv } from "../install/settings";
import type { ResolvedConsentMode } from "../messaging/consentPolicy";
import { isLeavingTour } from "../core/overstayCopy";
import { normalize, stripFiller } from "../intent/normalize";
import { handleVisitorText, isGreeting, startsNewBookingAfterClose } from "./conversation";
import { pickerMiss, placeAliases, propertyPickerText, propertyShortName, resolveNamedPlace, STREET_MISS, menuChoice, type PlaceCandidate } from "./portfolioPick";
import { OverstayScheduler } from "./overstayScheduler";
import { oneOffBlockReason } from "./oneOffGate";
import { markRemovedReply, shouldReplyRemoved } from "./removedReplies";
import { smsHelpBody, smsStopAck, SmsConsentDirectory } from "./smsConsent";
import { restoreSession, RestoreError, SessionPersistence, type DurableSession } from "./durableSession";
import { VisitorDemoSession, type VisitorDemoRegistry } from "./session";
import type { VerificationLinks } from "./verificationLinks";

type Transport = MessagingAdapter & { noteChannel?: (number: string, channel: InboundMessage["channel"]) => void };

interface PendingPick {
  schemaVersion: 1;
  phone: string;
  line: string;
  offeredIds: string[];
  matchIds: string[];
  streetPrompt: boolean;
  originalText: string;
  at: string;
}

function pickKey(phone: string, line: string): string {
  return `pick_${phone.replace(/\D/g, "")}_${line.replace(/\D/g, "")}`;
}

/** The property choice is not a tour reply. A bare number is not replayed as the first text. */
function openerFor(original: string): string {
  const text = original.trim();
  return text && !menuChoice(text) ? text : "Tour";
}

/** A menu number or a street-name pick is the opt-in keyword. The original first text is what gets recorded. */
function pickedOpener(message: InboundMessage, original: string): InboundMessage {
  return { ...message, text: openerFor(original), countsAsOptIn: true };
}

export const RESTORE_TROUBLE = "I'm having trouble restoring your tour. I've alerted the property team.";
export const HANDLER_SNAG_ALERTED = "Sorry, I hit a snag with that. I've let the property team know, and they'll reply here as soon as they can.";
export const HANDLER_SNAG_RETRY = "Sorry, I hit a snag with that. Could you text me again in a few minutes?";

/** Live sessions and saved bundles share each tour's real effective end, including extensions. */
export function occupiedWindowsFromRecords(
  tourLengthMinutes: number,
  reservations: Reservation[],
  requests: TourTimeRequest[] = [],
): OccupiedWindow[] {
  const lengthMs = tourLengthMinutes * 60_000;
  const windows: OccupiedWindow[] = [];
  for (const reservation of reservations) {
    if (!reservation.slotStart || TERMINAL.includes(reservation.status)) continue;
    const start = new Date(reservation.slotStart);
    windows.push({ start, end: reservation.windowEnd ? new Date(reservation.windowEnd) : new Date(start.getTime() + lengthMs) });
  }
  for (const request of requests) {
    // Only a still-open request holds the asked-for window. After approve,
    // move, cancel, or revoke the reservation is the occupancy; a leftover
    // APPROVED record must not keep the off-grid slot busy.
    if (request.status !== "PENDING") continue;
    windows.push({ start: new Date(request.requestedStartsAt), end: new Date(request.requestedEndsAt) });
  }
  return windows;
}

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
 * One touring number covers every property. A first text that names the
 * place, or a listing link, starts that property. An unclear first text asks
 * which place, then stays on that choice. Conversations are saved after
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
      /** The live transport for a property. Local-scoped buildings use the loopback. */
      transport: (propertyId?: string) => Transport;
      links: VerificationLinks;
      /** Where conversation snapshots are kept. Defaults to memory only (nothing survives a restart). */
      runtime?: RuntimeStore;
      /** Which properties share which line. Defaults to adopting the line for every real-phone property. */
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
      slotLockBarrier?: import("../core/TourCore").TourCoreDeps["slotLockBarrier"];
    },
  ) {
    const runtime = deps.runtime ?? new MemoryRuntimeStore();
    this.runtime = runtime;
    this.persistence = new SessionPersistence(deps.workspace, runtime, deps.links);
    this.endpoints = deps.endpoints ?? new MessagingEndpoints(runtime);
    this.smsConsent = new SmsConsentDirectory(deps.workspace.root);
    this.overstay = new OverstayScheduler(runtime, { now: () => deps.now?.() ?? new Date() });
  }

  readonly overstay: OverstayScheduler;

  private attachOverstay(session: VisitorDemoSession): VisitorDemoSession {
    session.overstay = this.overstay;
    return session;
  }

  private readonly runtime: RuntimeStore;
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

  /**
   * The property this text belongs to. A shared line with two or more published
   * properties asks which place when the text doesn't already name one.
   * Returns nothing when the text was answered here (the picker, or no property).
   */
  private async route(message: InboundMessage): Promise<{ propertyId: string; endpoint: MessagingEndpoint; message: InboundMessage } | undefined> {
    const { workspace: ws } = this.deps;
    const line = message.to ?? this.deps.defaultLine?.();
    if (!this.deps.endpoints) adoptLegacyLine(ws, this.endpoints, line);
    const endpoint = this.endpoints.resolve(line);
    const ids = endpoint?.propertyIds.filter((id) => ws.has(id)) ?? [];
    if (!endpoint || !ids.length || !line) {
      this.deps.log?.("A message arrived on a texting number that isn't connected to a property. It was not answered.");
      return undefined;
    }
    const phone = normalizePhone(message.from);
    const bound = await this.boundProperty(ids, phone, message.text);
    if (bound) return { propertyId: bound, endpoint, message };
    const pending = this.pendingPick(phone, endpoint.address);
    if (pending) return this.answerPick(pending, message, endpoint);

    const candidates = this.portfolioCandidates(ids);
    if (!candidates.length) {
      if (ids.length === 1) return { propertyId: ids[0]!, endpoint, message };
      const named = this.namedPlace(message, ids);
      if (named) return { propertyId: named, endpoint, message };
      this.deps.log?.("A message arrived on a texting number that isn't connected to a property. It was not answered.");
      return undefined;
    }
    if (candidates.length === 1) return { propertyId: candidates[0]!, endpoint, message };
    const named = this.namedPlace(message, candidates);
    if (named) return { propertyId: named, endpoint, message };

    const keyword = keywordOf(message.text);
    if (keyword === "stop" || keyword === "help") {
      await this.answerLineKeyword(candidates, phone, keyword);
      return undefined;
    }
    if (candidates.every((id) => this.isOptedOut(id, phone)) && keyword !== "start") return undefined;
    await this.askWhichPlace(phone, endpoint.address, candidates, message.text);
    return undefined;
  }

  private async answerPick(
    pending: PendingPick,
    message: InboundMessage,
    endpoint: MessagingEndpoint,
  ): Promise<{ propertyId: string; endpoint: MessagingEndpoint; message: InboundMessage } | undefined> {
    const keyword = keywordOf(message.text);
    if (keyword === "stop" || keyword === "help") {
      if (keyword === "stop") this.clearPick(pending);
      await this.answerLineKeyword(pending.matchIds, pending.phone, keyword);
      return undefined;
    }
    const choice = menuChoice(message.text);
    if (choice) {
      const propertyId = pending.offeredIds[choice - 1];
      if (!propertyId) {
        await this.sendLine(pending.offeredIds[0], pending.phone, pickerMiss(pending.offeredIds.length));
        return undefined;
      }
      this.clearPick(pending);
      return { propertyId, endpoint, message: pickedOpener(message, pending.originalText) };
    }
    const named = this.namedPlace(message, pending.matchIds);
    if (named) {
      this.clearPick(pending);
      return { propertyId: named, endpoint, message: pickedOpener(message, pending.originalText) };
    }
    const body = pending.streetPrompt && message.text.trim() ? STREET_MISS : pickerMiss(pending.offeredIds.length);
    await this.sendLine(pending.offeredIds[0], pending.phone, body);
    return undefined;
  }

  private async askWhichPlace(phone: string, line: string, candidates: string[], originalText: string): Promise<void> {
    const offeredIds = candidates.slice(0, 3);
    const streetPrompt = candidates.length > 3;
    const names = offeredIds.map((id) => propertyShortName(this.deps.workspace.load(id).config.property));
    this.runtime.put("portfolio-picks", pickKey(phone, line), {
      schemaVersion: 1,
      phone,
      line,
      offeredIds,
      matchIds: candidates,
      streetPrompt,
      originalText,
      at: (this.deps.now?.() ?? new Date()).toISOString(),
    } satisfies PendingPick);
    await this.sendLine(offeredIds[0], phone, propertyPickerText(names, streetPrompt));
  }

  private portfolioCandidates(ids: string[]): string[] {
    const ws = this.deps.workspace;
    const open = ids.filter((id) => ws.has(id) && !ws.load(id).state.removedAt);
    const published = open.filter((id) => ws.load(id).state.status === "PUBLISHED_FOR_DEMO");
    const pool = published.length ? published : open;
    return [...pool].sort((a, b) => {
      const left = ws.load(a).state;
      const right = ws.load(b).state;
      const byTime = (right.publishedAt ?? right.savedAt).localeCompare(left.publishedAt ?? left.savedAt);
      return byTime || a.localeCompare(b);
    });
  }

  private namedPlace(message: InboundMessage, ids: string[]): string | undefined {
    const places = ids.filter((id) => this.deps.workspace.has(id)).map((id) => this.placeCandidate(id));
    return resolveNamedPlace({ text: message.text, listingProperty: message.listingProperty }, places);
  }

  private placeCandidate(id: string): PlaceCandidate {
    return { id, aliases: placeAliases(this.deps.workspace.load(id).config.property) };
  }

  private async boundProperty(ids: string[], phone: string, text: string): Promise<string | undefined> {
    const broken = ids.find((id) => this.broken.has(`${id}:${phone}`));
    const sessions = ids
      .map((id) => this.deps.registry.latestForPhone(id, phone, "messaging"))
      .filter((session): session is VisitorDemoSession => !!session);
    const keep: VisitorDemoSession[] = [];
    for (const session of sessions) {
      const stage = await session.stage();
      const finished = ["done", "stopped"].includes(stage) && !(await session.isPaused());
      const stillThisTour = !finished || !!session.pendingBookingId || (await session.afterCloseStillOpen()) || !startsNewBookingAfterClose(text);
      if (stillThisTour) keep.push(session);
    }
    keep.sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());
    if (keep[0]) return keep[0].propertyId;
    return broken;
  }

  private async answerLineKeyword(propertyIds: string[], phone: string, keyword: "stop" | "help"): Promise<void> {
    const propertyId = propertyIds.find((id) => this.deps.workspace.has(id));
    if (!propertyId) return;
    if (keyword === "help") {
      await this.sendLine(propertyId, phone, smsHelpBody());
      return;
    }
    const now = (this.deps.now?.() ?? new Date()).toISOString();
    for (const id of propertyIds) {
      this.setOptOut(id, phone, true);
      this.smsConsent.save(id, { sender: phone, status: "opted_out", method: "keyword", keyword: "STOP", updatedAt: now, optedOutAt: now });
    }
    await this.sendLine(propertyId, phone, smsStopAck());
  }

  private async sendLine(propertyId: string | undefined, phone: string, body: string): Promise<void> {
    await this.deps.transport(propertyId).send({ to: phone, audience: "PROSPECT", body }).catch(() => undefined);
  }

  private pendingPick(phone: string, line: string): PendingPick | undefined {
    try {
      const saved = this.runtime.get<PendingPick>("portfolio-picks", pickKey(phone, line));
      if (!saved || saved.schemaVersion !== 1 || !saved.offeredIds?.length) return undefined;
      return saved;
    } catch {
      return undefined;
    }
  }

  private clearPick(pending: PendingPick): void {
    this.runtime.delete("portfolio-picks", pickKey(pending.phone, pending.line));
  }

  async receive(message: InboundMessage): Promise<{ correlationId?: string }> {
    await this.releaseUnconfirmed();
    const routed = await this.route(message);
    if (!routed) return {};
    message = routed.message;
    const endpoint = routed.endpoint;
    const propertyId = routed.propertyId;
    const { workspace: ws, registry } = this.deps;
    if (ws.load(propertyId).state.removedAt) {
      await this.answerRemovedProperty(propertyId, message);
      return {};
    }
    const transport = this.deps.transport(propertyId);
    transport.noteChannel?.(message.from, message.channel);
    const meta = {
      provider: message.provider,
      providerMessageId: message.providerMessageId,
      deliveryChannel: message.channel,
      ...(hasInboundMedia(message) ? { hasMedia: true } : {}),
      ...(message.countsAsOptIn ? { countsAsOptIn: true } : {}),
    };
    const phone = normalizePhone(message.from);

    const trouble = this.broken.get(`${propertyId}:${phone}`);
    if (trouble && !(await this.answerBroken(trouble, message.text))) return { correlationId: trouble.sessionId };

    let session = registry.latestForPhone(propertyId, phone, "messaging");
    if (session && !isLeavingTour(stripFiller(normalize(message.text))) && !(await session.afterCloseStillOpen())) {
      await session.promotePendingBookingIfTourEnded();
    }
    // A held rebook after a close stays on this thread: HI continues that booking instead of starting over.
    // While the leaving issue is still open, after-close handling runs first.
    if (session && session.pendingBookingId && startsNewBookingAfterClose(message.text) && !(await session.afterCloseStillOpen())) {
      const current = await session.reservation();
      if (!current || TERMINAL.includes(current.status)) {
        session.promotePendingBookingIfEnded();
      }
    }
    // A finished tour is never reopened: a standalone greeting or booking phrase starts a new one.
    // Keep this thread while a leaving issue is still in the 24-hour after-close window,
    // or while a booking is held from during the tour.
    if (session && ["done", "stopped"].includes(await session.stage()) && !(await session.isPaused()) && startsNewBookingAfterClose(message.text) && !session.optedOut) {
      const keep = !!session.pendingBookingId || (await session.afterCloseStillOpen());
      if (!keep) session = undefined;
    }

    if (!session) {
      const { config, state } = ws.load(propertyId);
      const ready = state.readiness?.passed && isCurrent(state.readiness, state);
      if (!ready) {
        await transport.send({ to: phone, audience: "PROSPECT", body: `Thanks for reaching out to ${config.property.name}. Self-guided tours by text aren't available right now. Please contact the property team.` }).catch(() => undefined);
        return {};
      }
      const tourId = ws.newVisitorTourId(propertyId, this.deps.now?.() ?? new Date(), "text");
      session = registry.add(
        this.attachOverstay(
          new VisitorDemoSession(propertyId, config, tourId, {
            transport,
            kind: "messaging",
            verificationLinks: this.deps.links,
            realNow: this.deps.realNow,
            store: this.deps.storeFor?.(config),
            storageRead: this.deps.storageRead,
            beforeAccess: this.deps.beforeAccess,
            otherBusyWindows: () => this.otherBusyWindows(propertyId, tourId),
            ...(this.deps.slotLockBarrier ? { slotLockBarrier: this.deps.slotLockBarrier } : {}),
          }),
        ),
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
    const outboundBefore = (await session.store.list("messages")).filter((m) => m.audience === "PROSPECT" && m.direction === "OUTBOUND").length;
    const auditBeforeIds = new Set((await session.store.listAudit().catch(() => [])).map((event) => event.id));
    try {
      await handleVisitorText(session, phone, message.text, meta, this.deps.interpreter);
    } catch (err) {
      if (err instanceof StorageUnavailableError) {
        await transport.send({ to: phone, audience: "PROSPECT", body: "I couldn't save that, so nothing was booked or changed. Please try again in a little while." }).catch(() => undefined);
        return { correlationId: session.id };
      }
      this.deps.log?.(`Handler error for visitor ${phone}: ${err instanceof Error ? err.message : "unknown error"}`);
      const outboundAfterThrow = (await session.store.list("messages")).filter((m) => m.audience === "PROSPECT" && m.direction === "OUTBOUND").length;
      const alreadyReplied = outboundAfterThrow > outboundBefore;
      let alertRecorded = false;
      try {
        const res = await session.reservation();
        alertRecorded = await session.core.alertHandlerFailure({
          phone,
          visitorText: message.text,
          reservationId: res?.id,
          alreadyReplied,
        });
      } catch {
        alertRecorded = false;
      }
      if (!alertRecorded) {
        const audit = await session.store.listAudit().catch(() => []);
        alertRecorded = audit.some((event) => !auditBeforeIds.has(event.id) && (event.type === "HANDLER_FAILED" || event.type === "OPERATOR_NOTIFIED"));
      }
      try {
        await this.save(session);
      } catch (saveErr) {
        this.deps.log?.(`Could not save the conversation after a handler error: ${saveErr instanceof Error ? saveErr.message : "unknown error"}`);
      }
      const outboundAfter = (await session.store.list("messages")).filter((m) => m.audience === "PROSPECT" && m.direction === "OUTBOUND").length;
      if (outboundAfter === outboundBefore) {
        const fallback = alertRecorded ? HANDLER_SNAG_ALERTED : HANDLER_SNAG_RETRY;
        await transport.send({ to: phone, audience: "PROSPECT", body: fallback }).catch(() => undefined);
      }
      return { correlationId: session.id };
    }
    if (session.optedOut !== wasOptedOut) this.setOptOut(propertyId, phone, session.optedOut);
    await this.save(session);
    return { correlationId: session.id };
  }

  /**
   * Starts a text-message conversation the visitor hasn't opened yet, so the
   * operator can set up a tour and Tour Core can text first.
   */
  async openOutbound(propertyId: string, phone: string): Promise<VisitorDemoSession> {
    const e164 = normalizePhone(phone);
    const existing = this.deps.registry.latestForPhone(propertyId, e164, "messaging");
    if (existing) {
      const blocked = await oneOffBlockReason(existing);
      if (blocked) throw new SetupInputError("TOUR_EXISTS", blocked);
      const stage = await existing.stage();
      if (!["done", "stopped"].includes(stage)) {
        await existing.supersedeForOperatorOneOff();
        await this.save(existing);
      }
    }
    const { config } = this.deps.workspace.load(propertyId);
    const line = this.endpoints.forProperty(propertyId)?.address ?? this.deps.defaultLine?.();
    if (!line) throw new SetupInputError("NO_MESSAGING_LINE", "Visitor texting isn't connected for that property.");
    const tourId = this.deps.workspace.newVisitorTourId(propertyId, this.deps.now?.() ?? new Date(), "text");
    const session = this.deps.registry.add(
      this.attachOverstay(
        new VisitorDemoSession(propertyId, config, tourId, {
          transport: this.lazyTransport(propertyId),
          kind: "messaging",
          verificationLinks: this.deps.links,
          realNow: this.deps.realNow,
          store: this.deps.storeFor?.(config),
          storageRead: this.deps.storageRead,
          beforeAccess: this.deps.beforeAccess,
          otherBusyWindows: () => this.otherBusyWindows(propertyId, tourId),
          ...(this.deps.slotLockBarrier ? { slotLockBarrier: this.deps.slotLockBarrier } : {}),
        }),
      ),
    );
    session.identify(e164);
    session.line = line;
    this.applySmsConsent(session, propertyId, e164);
    return session;
  }

  private async otherBusyWindows(propertyId: string, exceptTourId: string): Promise<OccupiedWindow[]> {
    const { config } = this.deps.workspace.load(propertyId);
    const length = config.tourHours.tourLengthMinutes;
    const windows: OccupiedWindow[] = [];
    const live = this.deps.registry.all().filter((session) => session.propertyId === propertyId && session.tourId !== exceptTourId);
    const seen = new Set<string>([exceptTourId]);
    for (const session of live) {
      seen.add(session.tourId);
      windows.push(...occupiedWindowsFromRecords(length, await session.store.list("reservations"), await session.store.list("tourTimeRequests")));
    }
    for (const record of this.deps.workspace.listTours(propertyId)) {
      if (seen.has(record.tourId) || record.kind === "practice") continue;
      const saved = this.deps.workspace.loadTour(propertyId, record.tourId);
      windows.push(...occupiedWindowsFromRecords(length, saved?.bundle.reservations ?? [], saved?.bundle.tourTimeRequests ?? []));
    }
    return windows;
  }

  /** Fires due overstay steps on every live text-message tour. Concurrent calls share one pass. */
  async tickOverstay(): Promise<void> {
    for (const session of this.deps.registry.all()) {
      if (session.kind !== "messaging") continue;
      this.attachOverstay(session);
      await this.overstay.tickSession(session);
      await this.save(session);
    }
  }

  /** Releases operator-set tours the visitor never confirmed. Safe to call often. */
  async releaseUnconfirmed(): Promise<void> {
    for (const session of this.deps.registry.all()) {
      if (session.kind !== "messaging") continue;
      await session.releaseUnconfirmedOperatorTour();
      await this.save(session);
    }
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
  private lazyTransport(propertyId?: string): Transport {
    return {
      provider: this.deps.transport(propertyId).provider,
      presentation: "MESSAGING",
      send: (m) => this.deps.transport(propertyId).send(m),
      noteChannel: (n, c) => this.deps.transport(propertyId).noteChannel?.(n, c),
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
        const { session, notes } = await restoreSession(snapshot, { workspace: this.deps.workspace, transport: this.lazyTransport(snapshot.propertyId), links: this.deps.links, realNow: this.deps.realNow, store: this.storeForProperty(snapshot.propertyId), storageRead: this.deps.storageRead, beforeAccess: this.deps.beforeAccess, otherBusyWindows: (propertyId, tourId) => this.otherBusyWindows(propertyId, tourId), slotLockBarrier: this.deps.slotLockBarrier });
        this.deps.registry.add(this.attachOverstay(session));
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
          const { session } = await restoreSession(pseudo, { workspace: ws, transport: this.lazyTransport(propertyId), links: this.deps.links, realNow: this.deps.realNow, store: this.storeForProperty(propertyId), storageRead: this.deps.storageRead, beforeAccess: this.deps.beforeAccess, otherBusyWindows: (id, tourId) => this.otherBusyWindows(id, tourId), slotLockBarrier: this.deps.slotLockBarrier });
          registry.add(this.attachOverstay(session));
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
   * A text to a removed property: STOP/HELP still work; everyone else who
   * hasn't opted out gets the goodbye once per 24 hours. No session, booking,
   * or flagged question.
   */
  private async answerRemovedProperty(propertyId: string, message: InboundMessage): Promise<void> {
    const phone = normalizePhone(message.from);
    const transport = this.deps.transport(propertyId);
    transport.noteChannel?.(message.from, message.channel);
    const now = this.deps.now?.() ?? new Date();
    const keyword = keywordOf(message.text);
    if (keyword === "stop") {
      this.setOptOut(propertyId, phone, true);
      this.smsConsent.save(propertyId, {
        sender: phone,
        status: "opted_out",
        method: "keyword",
        keyword: "STOP",
        updatedAt: now.toISOString(),
        optedOutAt: now.toISOString(),
      });
      await transport.send({ to: phone, audience: "PROSPECT", body: smsStopAck() }).catch(() => undefined);
      return;
    }
    if (keyword === "help") {
      await transport.send({ to: phone, audience: "PROSPECT", body: smsHelpBody() }).catch(() => undefined);
      return;
    }
    if (keyword === "start") {
      this.setOptOut(propertyId, phone, false);
      return;
    }
    if (this.removedUnreachable(propertyId, phone)) return;
    if (!shouldReplyRemoved(this.deps.workspace.root, propertyId, phone, now)) return;
    const { config } = this.deps.workspace.load(propertyId);
    await transport
      .send({
        to: phone,
        audience: "PROSPECT",
        body: removedPropertyVisitorText(config.property.address, config.operator.visitorContact),
      })
      .catch(() => undefined);
    markRemovedReply(this.deps.workspace.root, propertyId, phone, now);
  }

  private removedUnreachable(propertyId: string, phone: string): boolean {
    if (this.isOptedOut(propertyId, phone)) return true;
    return this.smsConsent.get(propertyId, phone)?.status === "opted_out";
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
    const transport = this.deps.transport(snapshot.propertyId);
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
  if (!line) return;
  const candidates = workspace.list().filter((p) => {
    if (!isLiveMessaging(p.config.messagingMode) || p.state.removedAt) return false;
    if (p.config.messagingProvider === "local" && provider !== "local") return false;
    return !endpoints.forProperty(p.config.property.id);
  });
  if (!candidates.length) return;
  for (const pick of candidates) endpoints.attach({ address: line, provider, propertyId: pick.config.property.id });
  log?.(`Connected texting number ${line} to ${candidates.map((p) => p.config.property.name).join(", ")}.`);
}
