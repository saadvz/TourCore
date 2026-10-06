import type { TourCoreConfig } from "../config/tourCoreConfig";
import {
  newId,
  type AccessGrant,
  type AuditEvent,
  type AuditEventType,
  type Consent,
  type Message,
  type Prospect,
  UNNAMED_VISITOR,
  type Reservation,
  type ReservationStatus,
  type TourTimeRequest,
  type Verification,
} from "../domain/model";
import { isCancelableReservation, TERMINAL, transition } from "../domain/stateMachine";
import type { DurinAccessAdapter, DurinAccessResult, DurinHealth } from "../durin/DurinAccessAdapter";
import { MessagingError, type DeliveryReceipt, type MessageChannel, type Messenger } from "../messaging/Messenger";
import { withPrompt, type ReplyPrompt } from "../messaging/presentation";
import { evaluateAccess, type AccessDecision, type AccessDecisionCode } from "../policy/evaluateAccess";
import { isSingleTourPlace, streetLine, visitorSubject } from "../visitor/identity";
import { entryInstructionsFragment } from "../setup/setupActions";
import { StorageUnavailableError } from "../storage/errors";
import type { TourCoreStore } from "../storage/Store";
import type { VerificationProvider } from "../verification/basicForm";
import { AuditLog, type AuditInput } from "../audit/audit";
import { buildExport, type ExportBundle } from "../export/exportBundle";
import type { Clock } from "./clock";
import { approvedAnswerText, approvedFacts, type ApprovedFact } from "./facts";
import { formatPhone, normalizePhone } from "./phone";
import { resolveQuestion } from "./questions";
import { closestOpenSlots, intervalsOverlap, occupiedInterval, overlapSummary, placementOf, relativeWhen, releasedWhen, tourInterval, touringHoursLabel, type OccupiedWindow, type TimeInterval } from "./customSlot";
import { DOOR_AFTER_T, LATE_ARRIVAL_EXPIRED, landlordRepliedAfterClose, landlordWho, tourFinishedFollowUp, visitorRepliedAfterClose } from "./overstayCopy";
import { withPropertySlotLock } from "./slotLock";
import { BOOKING_HORIZON_DAYS, isoDate, nextTourDay, slotsOn, tourWindow, type TourSlot } from "./schedule";
import { bookedTourCalledOffText } from "./availabilityCopy";
import { propertyDirectionsUrl, tourDirectionsText } from "./mapsLink";
import { addDays, formatDay as formatDayIn, formatTime as formatTimeIn, localDateOf, type LocalDate } from "./timezone";

export interface TourCoreDeps {
  config: TourCoreConfig;
  store: TourCoreStore;
  durin: DurinAccessAdapter;
  messenger: Messenger;
  verification: VerificationProvider;
  clock: Clock;
  /** Issues a personal identity-form link for visitors on a messaging channel. */
  verificationLink?: (ctx: { reservation: Reservation; prospect: Prospect }) => string | undefined | Promise<string | undefined>;
  /** Groups messages of one conversation in the records. */
  correlationId?: string;
  /**
   * The current approved content (facts, unit details), read at question time
   * so an active tour sees an operator's new fact immediately. Structural
   * settings always come from `config`, fixed for the tour.
   */
  approvedContent?: () => TourCoreConfig | undefined;
  /**
   * When Google Drive is canonical and briefly unreachable: "cached" may answer
   * an already-approved fact, "stale" must not. Unset means the local store is canonical.
   */
  storageRead?: () => "live" | "cached" | "stale";
  /** Called immediately before a door grant. Throw to deny without calling Durin. */
  beforeAccess?: () => Promise<void>;
  /** Other tours on this property that should count as busy (other conversations). */
  otherBusyStarts?: () => Promise<Date[]>;
  /** Same as otherBusyStarts, with each tour's real effective end (including extensions). */
  otherBusyWindows?: () => Promise<OccupiedWindow[]>;
  /**
   * When a property or unit is paused (or the property was removed), new
   * bookings must stop. Unset means booking is allowed (practice tours, older tests).
   */
  availability?: (unitId?: string) => { allowed: boolean; message: string } | undefined;
  /**
   * Test hook: runs after the property slot lock is taken, before the
   * critical section. Lets tests pause one locker so another can queue.
   */
  slotLockBarrier?: (op: "reserve" | "approve" | "decline" | "propose") => Promise<void>;
}

export interface InboundMeta {
  provider?: string;
  providerMessageId?: string;
  deliveryChannel?: Message["deliveryChannel"];
  correlationId?: string;
  /** True when the inbound included a photo or other attachment. The file is not stored or forwarded. */
  hasMedia?: boolean;
}

export interface AccessRequest {
  reservationId: string;
  prospectId: string;
  doorId: string;
}

export interface AccessOutcome {
  decision: AccessDecision;
  durinCalled: boolean;
  grant?: AccessGrant;
  reusedGrant?: boolean;
}

export class TourCoreError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export const CONSENT_TEXT = "Is it OK if I text you about this tour and keep a record of your visit (times and doors used)?";

/** The booking confirmation that precedes the consent question. */
export function bookedForLine(time: string, day: string): string {
  return `Great, you're booked for ${time} on ${day}.`;
}

export const PENDING_CUSTOM_TIME_REGULAR_OPTION =
  "If you'd rather pick one of the regular times instead, just reply with a day.";

/** After a tour ends, an unapproved custom-time request stays with the team. */
export function pendingCustomTimeLine(time: string, day: string, options?: { offerRegularTimes?: boolean }): string {
  const base = `Your request for ${time} on ${day} is still with the property team. I'll text you as soon as they respond.`;
  if (options?.offerRegularTimes === false) return base;
  return `${base} ${PENDING_CUSTOM_TIME_REGULAR_OPTION}`;
}

/** Operator-facing reason when a visitor books a regular slot instead of waiting. */
export const WITHDRAWN_FOR_REGULAR_BOOKING = "They booked a regular time instead.";

/** Visitor confirmation when a regular pick replaces a held or booked future tour. */
export function replacesTourLine(day: string, time: string): string {
  return `That replaces your ${day} ${time} tour.`;
}

/** Repeat help on the same reservation re-alerts the team at most once per this window. */
export const HELP_ALERT_WINDOW_MS = 5 * 60_000;

/** Where HELP copy and alerts apply. Dead / unbooked reservations are `null`. */
export type HelpContext = "in-window" | "upcoming";

/**
 * HELP alerts the team only for a booked tour that is upcoming (window not
 * started) or still inside its tour window. Finished, canceled, revoked,
 * failed-ID, expired, past-window, or not-yet-booked reservations do not.
 */
export function helpContext(reservation: Reservation, now: Date): HelpContext | null {
  if (TERMINAL.includes(reservation.status)) return null;
  if (!reservation.windowStart || !reservation.windowEnd) return null;
  const start = Date.parse(reservation.windowStart);
  const end = Date.parse(reservation.windowEnd);
  if (Number.isNaN(start) || Number.isNaN(end) || end <= now.getTime()) return null;
  return now.getTime() < start ? "upcoming" : "in-window";
}

export function isLiveHelpReservation(reservation: Reservation, now: Date): boolean {
  return helpContext(reservation, now) !== null;
}

/**
 * Visitor copy when Tour Core can't answer a question. Design can tweak these
 * constants. Do not mention tools, providers, or MMS.
 */
export const UNKNOWN_ANSWER = "I'll let the property team know about your question.";
export const UNKNOWN_ANSWER_WITH_PHOTO = "I can't take photos yet, but I'll let the property team know about your question.";
/** Appended to an approved-fact answer after a tour has ended. Also used in the locked ended unknown lines. */
export const TOUR_AGAIN_SUFFIX = " If you'd like to tour again, just text HI.";
export const UNKNOWN_ANSWER_ENDED = `${UNKNOWN_ANSWER}${TOUR_AGAIN_SUFFIX}`;
export const UNKNOWN_ANSWER_ENDED_WITH_PHOTO = `${UNKNOWN_ANSWER_WITH_PHOTO}${TOUR_AGAIN_SUFFIX}`;
export const TOUR_ENDED_REPLY = "This tour has ended. Text HI any time to start a new one.";

/** One visitor text for an unanswered question. Photo and ended-tour variants replace the short photo line. */
export function unknownAnswerReply(options: { hasMedia?: boolean; ended?: boolean } = {}): string {
  if (options.ended) return options.hasMedia ? UNKNOWN_ANSWER_ENDED_WITH_PHOTO : UNKNOWN_ANSWER_ENDED;
  return options.hasMedia ? UNKNOWN_ANSWER_WITH_PHOTO : UNKNOWN_ANSWER;
}

/** Append `suffix` to an approved answer. Adds a period first if the answer has no . ! or ?. Never doubles the suffix. */
export function withAnswerSuffix(answer: string, suffix = ""): string {
  if (!suffix) return answer;
  let body = answer.replace(/\s+$/u, "");
  const extra = suffix.replace(/^\s+/u, "");
  if (extra && body.endsWith(extra)) body = body.slice(0, body.length - extra.length).replace(/\s+$/u, "");
  if (body && !/[.!?]$/.test(body)) body += ".";
  return body + suffix;
}

/** Visitor cancel-by-text: Critiquito-locked confirm, done, and keep-booked lines. */
export const VISITOR_CANCEL_DONE = "You're cancelled. Text me anytime if you want to book again.";
export const VISITOR_CANCEL_FAILED = "I can't cancel it from here. I've asked the leasing team to call it off and get back to you.";

export function visitorCancelConfirm(day: string, time: string): string {
  return `Cancel your tour on ${day} at ${time}? Reply YES or NO.`;
}

export function visitorCancelKept(day: string, time: string): string {
  return `Okay, your tour stays on ${day} at ${time}.`;
}

export function visitorCancelConfirmFor(reservation: Reservation, timeZone: string): string | undefined {
  if (!reservation.slotStart) return undefined;
  const start = new Date(reservation.slotStart);
  return visitorCancelConfirm(formatDayIn(start, timeZone), formatTimeIn(start, timeZone));
}

/**
 * Visitor SMS when a door stays locked. Casual, no provider names.
 * `operator.contact` is never used here — that line is private.
 */
export class VisitorDenialCopy {
  static atDoor(team: string, visitorContact?: string, options?: { teamJustNamed?: boolean }): string {
    const who = options?.teamJustNamed ? "They'll" : `The ${team} will`;
    if (visitorContact) return `Stay where you are. ${who} reply as soon as they can, or call ${formatPhone(visitorContact)}.`;
    return `Stay where you are and reply here. ${who} reply as soon as they can.`;
  }

  static remote(team: string, visitorContact?: string, options?: { teamJustNamed?: boolean }): string {
    const who = options?.teamJustNamed ? "They'll" : `The ${team} will`;
    if (visitorContact) return `${who} reply here as soon as they can, or call ${formatPhone(visitorContact)}.`;
    return `${who} reply here as soon as they can.`;
  }

  static operatorHold(team: string, visitorContact?: string): string {
    return `Your tour is on hold, and your tour time keeps running while the ${team} sorts this out. ${this.atDoor(team, visitorContact, { teamJustNamed: true })}`;
  }

  static calledOff(team: string, visitorContact?: string): string {
    return `Your tour has been called off, so the doors won't open for it. ${this.remote(team, visitorContact)}`;
  }

  static tooEarly(opensAt?: string, relative?: string): string {
    if (!opensAt) return "You're a little early! I can open the doors from your tour time. Text me again at your tour time.";
    const atTime = ` at ${opensAt}`;
    const day = relative?.endsWith(atTime) ? relative.slice(0, -atTime.length) : relative;
    const again = day && day !== "today" ? "Text me again then." : `Text me again at ${opensAt}.`;
    return `You're a little early! I can open the doors from ${opensAt}${day ? ` ${day}` : ""}. ${again}`;
  }

  static followUpYes(team: string): string {
    return `Great. Someone from the ${team} will be in touch soon.`;
  }

  static helpAck(team: string, visitorContact?: string): string {
    return `I've let the ${team} know. ${this.atDoor(team, visitorContact, { teamJustNamed: true })}`;
  }

  static helpRepeatAck(team: string, visitorContact?: string): string {
    return `The ${team} already knows and is on it. ${this.atDoor(team, visitorContact, { teamJustNamed: true })}`;
  }

  static helpAckRemote(team: string, visitorContact?: string): string {
    return `I've let the ${team} know. ${this.remote(team, visitorContact, { teamJustNamed: true })}`;
  }

  static helpRepeatAckRemote(team: string, visitorContact?: string): string {
    return `The ${team} already knows and is on it. ${this.remote(team, visitorContact, { teamJustNamed: true })}`;
  }

  static noOpenTimes(team: string): string {
    return `There are no open tour times right now. The ${team} will reach out.`;
  }

  static doorsNotResponding(team: string, visitorContact?: string): string {
    return `Sorry, the doors aren't responding right now. I've let the ${team} know. ${this.atDoor(team, visitorContact, { teamJustNamed: true })}`;
  }

  static followUp(team: string, visitorContact?: string): string {
    if (visitorContact) return `The ${team} will follow up here, or call ${formatPhone(visitorContact)}.`;
    return `The ${team} will follow up here.`;
  }

  static failedIdAtDoor(team: string, visitorContact?: string): string {
    return `I couldn't confirm your details, so I can't open doors for this tour. ${this.followUp(team, visitorContact)}`;
  }

  static failedIdAtBooking(team: string, visitorContact?: string): string {
    return `Thanks for filling that out. ${this.failedIdAtDoor(team, visitorContact)}`;
  }

  static failedIdEnded(team: string, visitorContact?: string): string {
    return `I couldn't confirm your details, so your tour has ended. Please head out the way you came in. ${this.followUp(team, visitorContact)}`;
  }

  static staleVerification(): string {
    return "Your ID check has expired, so I need a quick re-check before I can open doors.";
  }

  static missingConsent(): string {
    return `Before I can open doors, I need your OK:\n${CONSENT_TEXT}`;
  }
}

export class TourCore {
  private readonly audit: AuditLog;
  private readonly inFlightAccess = new Map<string, Promise<AccessOutcome>>();

  constructor(private readonly deps: TourCoreDeps) {
    this.audit = new AuditLog(deps.store, deps.clock);
  }

  get config(): TourCoreConfig {
    return this.deps.config;
  }

  /** Use the property's current published settings without rebuilding the tour. */
  useConfig(config: TourCoreConfig): void {
    this.deps.config = config;
  }

  // ---------------------------------------------------------------- journey

  async startInquiry(input: { name: string; phone: string; unitId: string }, options: { announce?: boolean } = {}): Promise<{ prospect: Prospect; reservation: Reservation }> {
    const { config, store } = this.deps;
    this.assertBookingAllowed(input.unitId);
    const phone = normalizePhone(input.phone);
    const unit = config.units.find((u) => u.id === input.unitId);
    if (!unit) throw new TourCoreError("UNKNOWN_UNIT", `Unknown unit ${input.unitId}`);
    const route = config.routes.find((r) => r.unitId === unit.id);
    if (!route) throw new TourCoreError("NO_ROUTE", `No tour route is mapped for ${unit.name}`);

    let prospect = (await store.list("prospects")).find((p) => p.phone === phone);
    if (!prospect) {
      prospect = { id: newId("prs"), name: input.name.trim(), phone, createdAt: this.nowIso() };
      await store.put("prospects", prospect);
      await this.record("PROSPECT_CREATED", { prospectId: prospect.id, detail: `${prospect.name} (${phone})` });
    }

    const open = (await store.list("reservations")).find(
      (r) => r.prospectId === prospect.id && r.unitId === unit.id && r.status === "INQUIRY",
    );
    if (open) return { prospect, reservation: open };

    if ((await store.list("reservations")).some((r) => r.prospectId === prospect.id)) {
      await this.record("PROSPECT_RETURNED", { prospectId: prospect.id, detail: "existing prospect record reused for a new tour" });
    }

    const reservation: Reservation = {
      id: newId("res"),
      prospectId: prospect.id,
      propertyId: config.property.id,
      unitId: unit.id,
      routeId: route.id,
      allowedRoute: route.stops.map((s) => s.doorId),
      status: "INQUIRY",
      createdAt: this.nowIso(),
      updatedAt: this.nowIso(),
    };
    await store.put("reservations", reservation);
    await this.record("INQUIRY_STARTED", {
      reservationId: reservation.id,
      prospectId: prospect.id,
      detail: `${unit.name}; allowed route ${reservation.allowedRoute.join(" -> ")}`,
    });

    if (options.announce === false) return { prospect, reservation };
    const dates = await this.availableDates();
    const hello = prospect.name === UNNAMED_VISITOR ? "Hi!" : `Hi ${firstName(prospect.name)}!`;
    const place = isSingleTourPlace(config.property) ? visitorSubject(config.property, unit.name) : `${unit.name} at ${config.property.address}`;
    const intro =
      `${hello} Happy to set up a self-guided tour of ${place}.` +
      (unit.summary ? ` Here's what the property team shared: ${unit.summary.replace(/\.?$/, ".")}` : "");
    if (dates.length === 0) {
      await this.textProspect(prospect, reservation.id, `${intro}\n${VisitorDenialCopy.noOpenTimes(this.teamName())}`);
    } else {
      await this.textProspect(prospect, reservation.id, `${intro}\nI have tours available. Which day works for you?`, {
        kind: "choose",
        options: dates.map((day) => day.label),
        what: "a day",
      });
    }
    return { prospect, reservation };
  }

  /** The next few days that still have an open regular tour time. */
  async availableDates(limit = 5): Promise<{ date: string; label: string; start: Date }[]> {
    const now = this.deps.clock.now();
    const tz = this.deps.config.property.timezone;
    let day = localDateOf(now, tz);
    const out: { date: string; label: string; start: Date }[] = [];
    for (let i = 0; i < BOOKING_HORIZON_DAYS && out.length < limit; i++, day = addDays(day, 1)) {
      const slots = await this.availableSlots(day);
      if (!slots.length) continue;
      out.push({ date: isoDate(day), label: formatDayIn(slots[0]!.start, tz), start: slots[0]!.start });
    }
    return out;
  }

  /** Open tour times on a property-local date (defaults to the next day with openings). */
  async availableSlots(day?: LocalDate): Promise<TourSlot[]> {
    const now = this.deps.clock.now();
    const onDay = day ?? nextTourDay(this.deps.config, now);
    const busy = await this.busyIntervals();
    return slotsOn(this.deps.config, onDay).filter((s) => s.start > now && !this.overlapsAny(s.start, busy));
  }

  async reserveSlot(reservationId: string, slotStartIso: string, options: { replace?: boolean } = {}): Promise<Reservation> {
    return this.withSlotLock(async () => {
      await this.deps.slotLockBarrier?.("reserve");
      let reservation = await this.mustGetReservation(reservationId);
      this.assertBookingAllowed(reservation.unitId);
      const start = new Date(slotStartIso);
      if (Number.isNaN(start.getTime())) throw new TourCoreError("INVALID_SLOT", "That tour time isn't valid");
      if (reservation.slotStart === start.toISOString() && reservation.status !== "INQUIRY") return reservation;

      const slots = await this.availableSlots(localDateOf(start, this.deps.config.property.timezone));
      if (!slots.some((s) => s.start.getTime() === start.getTime())) {
        throw new TourCoreError("SLOT_UNAVAILABLE", "That time is no longer available");
      }

      const prospect = await this.mustGetProspect(reservation.prospectId);
      if (reservation.status !== "INQUIRY") {
        if (!options.replace || !reservation.slotStart || !this.canReplaceRegularBooking(reservation)) {
          throw new TourCoreError("ALREADY_BOOKED", "This tour already has a time");
        }
        const from = new Date(reservation.slotStart);
        const fromDay = this.day(from);
        const fromTime = this.time(from);
        reservation = (await this.doRescheduleReservation({ reservationId: reservation.id, newStartsAt: slotStartIso, notice: "none" })).reservation;
        await this.withdrawPendingCustomTimeRequests(prospect.id, reservation.id);
        await this.textProspect(prospect, reservation.id, bookedForLine(this.time(start), this.day(start)));
        await this.textProspect(prospect, reservation.id, replacesTourLine(fromDay, fromTime));
        if (reservation.status === "AWAITING_CONSENT" && !reservation.consentId) {
          await this.textProspect(prospect, reservation.id, CONSENT_TEXT, { kind: "yes-no" });
        }
        return reservation;
      }

      await this.cancelOtherLiveBookings(prospect.id, reservation.id);
      const { windowStart, windowEnd } = tourWindow(this.deps.config, start);
      reservation = { ...reservation, slotStart: start.toISOString(), windowStart: windowStart.toISOString(), windowEnd: windowEnd.toISOString() };
      reservation = await this.move(reservation, "RESERVED", "RESERVATION_CREATED", {
        detail: `${this.day(start)} at ${this.time(start)}; doors usable ${this.time(windowStart)}-${this.time(windowEnd)}`,
      });
      reservation = await this.move(reservation, "AWAITING_CONSENT", "CONSENT_REQUESTED", { detail: "asked permission to text and keep tour records" });

      await this.withdrawPendingCustomTimeRequests(prospect.id, reservation.id);
      await this.textProspect(prospect, reservation.id, `${bookedForLine(this.time(start), this.day(start))}\n${CONSENT_TEXT}`, { kind: "yes-no" });
      return reservation;
    });
  }

  async recordConsent(reservationId: string, granted: boolean): Promise<Reservation> {
    let reservation = await this.mustGetReservation(reservationId);
    if (reservation.consentId) return reservation;
    if (reservation.status !== "AWAITING_CONSENT") throw new TourCoreError("NOT_AWAITING_CONSENT", `Reservation is ${reservation.status}`);
    const prospect = await this.mustGetProspect(reservation.prospectId);

    const consent: Consent = {
      id: newId("cns"),
      prospectId: prospect.id,
      reservationId: reservation.id,
      granted,
      scope: ["messaging", "tour_records"],
      text: CONSENT_TEXT,
      recordedAt: this.nowIso(),
    };
    await this.deps.store.put("consents", consent);
    reservation = { ...reservation, consentId: consent.id };
    await this.deps.store.put("reservations", reservation);
    await this.record("CONSENT_RECORDED", {
      reservationId: reservation.id,
      prospectId: prospect.id,
      detail: granted ? "granted: messaging + tour records" : "declined",
    });

    if (!granted) {
      reservation = await this.move(reservation, "CANCELLED", "RESERVATION_CANCELLED", { detail: "prospect declined consent" });
      await this.textProspect(prospect, reservation.id, "No problem, I won't text you again about this tour. Reach out anytime if you change your mind.");
      return reservation;
    }

    const reusable = (await this.deps.store.list("verifications"))
      .filter((v) => v.prospectId === prospect.id && v.status === "PASSED" && Date.parse(v.validUntil) > Date.parse(reservation.windowEnd!))
      .sort((a, b) => b.completedAt.localeCompare(a.completedAt))[0];
    if (reusable) {
      reservation = { ...reservation, verificationId: reusable.id };
      await this.record("VERIFICATION_REUSED", {
        reservationId: reservation.id,
        prospectId: prospect.id,
        detail: `prior check ${reusable.id} valid until ${reusable.validUntil.slice(0, 10)}`,
      });
      return this.markReady(reservation, prospect);
    }

    reservation = await this.move(reservation, "AWAITING_VERIFICATION", "VERIFICATION_REQUESTED", { detail: `method ${this.deps.verification.method}` });
    const ask = this.deps.verification.request(prospect);
    await this.textProspect(prospect, reservation.id, ask.body, ask.form ? { kind: "form", link: await this.verificationFormLink(reservation, prospect) } : undefined);
    if (this.deps.verification.automatic) return this.submitVerification(reservation.id, {});
    return reservation;
  }

  async submitVerification(reservationId: string, submission: unknown): Promise<Reservation> {
    let reservation = await this.mustGetReservation(reservationId);
    const existing = reservation.verificationId ? await this.deps.store.get("verifications", reservation.verificationId) : undefined;
    const staleRecheck = this.isStalePassedCheck(existing) && (reservation.status === "READY" || reservation.status === "TOURING");
    if (reservation.verificationId && !staleRecheck) return reservation;
    if (reservation.status !== "AWAITING_VERIFICATION" && !staleRecheck) {
      throw new TourCoreError("NOT_AWAITING_VERIFICATION", `Reservation is ${reservation.status}`);
    }
    const prospect = await this.mustGetProspect(reservation.prospectId);
    const outcome = this.deps.verification.evaluate(submission, prospect);
    const now = this.deps.clock.now();

    const verification: Verification = {
      id: newId("ver"),
      prospectId: prospect.id,
      reservationId: reservation.id,
      method: this.deps.verification.method,
      status: outcome.passed ? "PASSED" : "FAILED",
      reference: outcome.reference,
      ...(outcome.passed ? { claimed: outcome.claimed } : { failureReason: outcome.reason }),
      completedAt: now.toISOString(),
      validUntil: new Date(now.getTime() + this.deps.config.verificationValidForDays * 86_400_000).toISOString(),
    };
    await this.deps.store.put("verifications", verification);

    if (!outcome.passed) {
      const activeGrants = (await this.listGrants(reservation.id)).filter((g) => g.status === "ACTIVE");
      const inside = (reservation.status === "READY" || reservation.status === "TOURING") && activeGrants.length > 0;
      await this.revokeGrants(reservation, "identity check failed");
      const copy = inside
        ? VisitorDenialCopy.failedIdEnded(this.teamName(), this.visitorHelpNumber())
        : VisitorDenialCopy.failedIdAtBooking(this.teamName(), this.visitorHelpNumber());
      await this.textProspect(prospect, reservation.id, copy);
      await this.notifyOperator(reservation, `Identity form for ${prospect.name} didn't check out (${outcome.reason}). Please follow up.`);
      return this.move(reservation, "VERIFICATION_FAILED", "VERIFICATION_FAILED", { detail: outcome.reason });
    }

    reservation = { ...reservation, verificationId: verification.id };
    if (staleRecheck) await this.deps.store.put("reservations", reservation);
    await this.record("VERIFICATION_COMPLETED", {
      reservationId: reservation.id,
      prospectId: prospect.id,
      detail: `basic form ${outcome.reference}: ${outcome.claimed.firstName} ${outcome.claimed.lastName} (claimed identity, not document-checked)`,
    });
    // A visitor who started by text is named by the form they just filled in.
    if (prospect.name === UNNAMED_VISITOR) {
      const named = `${outcome.claimed.firstName} ${outcome.claimed.lastName}`.trim();
      if (named) await this.deps.store.put("prospects", { ...prospect, name: named });
    }
    if (staleRecheck) return reservation;
    return this.markReady(reservation, prospect);
  }

  /** Every door request goes through here: policy first, Durin only on ALLOW. */
  async requestAccess(request: AccessRequest): Promise<AccessOutcome> {
    const key = `${request.reservationId}:${request.prospectId}:${request.doorId}`;
    const pending = this.inFlightAccess.get(key);
    if (pending) return pending;
    const attempt = this.doRequestAccess(request).finally(() => this.inFlightAccess.delete(key));
    this.inFlightAccess.set(key, attempt);
    return attempt;
  }

  async completeTour(reservationId: string): Promise<Reservation> {
    let reservation = await this.mustGetReservation(reservationId);
    if (reservation.status === "COMPLETED") return reservation;
    if (reservation.status !== "TOURING") throw new TourCoreError("NOT_TOURING", `Reservation is ${reservation.status}`);
    const prospect = await this.mustGetProspect(reservation.prospectId);
    const unit = this.unitFor(reservation);

    await this.revokeGrants(reservation, "tour completed");
    reservation = await this.move(reservation, "COMPLETED", "TOUR_COMPLETED", { detail: "prospect finished the tour" });
    const place = visitorSubject(this.deps.config.property, unit.name);
    await this.textProspect(
      prospect,
      reservation.id,
      tourFinishedFollowUp(place, knownFirstName(prospect.name), unit.summary || undefined),
      { kind: "yes-no" },
    );
    await this.record("FOLLOW_UP_SENT", { reservationId: reservation.id, prospectId: prospect.id, detail: "recap + follow-up question" });
    return reservation;
  }

  /** Tour times this reservation could move to: configured slots whose window hasn't closed and that nobody else holds. */
  async rescheduleOptions(reservationId: string, limit = 12): Promise<TourSlot[]> {
    const reservation = await this.mustGetReservation(reservationId);
    const now = this.deps.clock.now();
    const tz = this.deps.config.property.timezone;
    const ownStart = reservation.slotStart ? Date.parse(reservation.slotStart) : undefined;
    const busy = (await this.busyIntervals()).filter((interval) => interval.startMs !== ownStart);
    const out: TourSlot[] = [];
    let day = localDateOf(now, tz);
    for (let i = 0; i < 14 && out.length < limit; i++, day = addDays(day, 1)) {
      for (const slot of slotsOn(this.deps.config, day)) {
        if (tourWindow(this.deps.config, slot.start).windowEnd <= now) continue;
        if (slot.start.toISOString() === reservation.slotStart || this.overlapsAny(slot.start, busy)) continue;
        out.push(slot);
      }
    }
    return out.slice(0, limit);
  }

  /**
   * Moves a booked tour to another configured tour time. Same reservation,
   * prospect, consent and verification; any doors opened for the old time
   * are switched off, and the visitor is told. Asking for the time it already
   * has changes nothing. `outsideTourHours` (developer mode only) skips the
   * tour-hours check; the door window still comes from the tour length.
   */
  async rescheduleReservation(input: {
    reservationId: string;
    newStartsAt: string;
    /** Lets a one-off time through. Inside touring hours is enough; outside hours still needs `outsideTourHours`. */
    customTime?: boolean;
    outsideTourHours?: boolean;
    /** "moved" is the visitor confirmation for an approved or operator-directed change. "none" sends no visitor text. */
    notice?: "default" | "moved" | "none";
  }): Promise<{ reservation: Reservation; changed: boolean }> {
    return this.withSlotLock(() => this.doRescheduleReservation(input));
  }

  private async doRescheduleReservation(input: {
    reservationId: string;
    newStartsAt: string;
    customTime?: boolean;
    outsideTourHours?: boolean;
    notice?: "default" | "moved" | "none";
  }): Promise<{ reservation: Reservation; changed: boolean }> {
    let reservation = await this.mustGetReservation(input.reservationId);
    const start = new Date(input.newStartsAt);
    if (Number.isNaN(start.getTime())) throw new TourCoreError("INVALID_SLOT", "That tour time isn't valid.");
    if (reservation.slotStart === start.toISOString()) return { reservation, changed: false };
    this.assertBookingAllowed(reservation.unitId);

    const movable: ReservationStatus[] = ["AWAITING_CONSENT", "AWAITING_VERIFICATION", "READY", "TOURING"];
    if (!movable.includes(reservation.status) || !reservation.slotStart) {
      throw new TourCoreError("NOT_RESCHEDULABLE", "Only a booked tour that hasn't finished can be moved.");
    }
    const { config, clock } = this.deps;
    const placement = placementOf(config, start);
    const offered = placement === "ON_GRID";
    if (!offered && !input.outsideTourHours && !input.customTime) throw new TourCoreError("SLOT_NOT_OFFERED", "That time isn't one of the property's tour times.");
    if ((input.customTime || !offered) && placement === "OUTSIDE_HOURS" && !input.outsideTourHours) {
      throw new TourCoreError("OUTSIDE_TOUR_HOURS", `${this.time(start)} is outside the property's normal ${touringHoursLabel(config)} touring hours.`);
    }
    const { windowStart, windowEnd } = tourWindow(config, start);
    if (windowEnd <= clock.now()) throw new TourCoreError("SLOT_PAST", "That tour time has already passed.");
    await this.assertNoConflict(start, reservation.id);

    const from = new Date(reservation.slotStart);
    await this.revokeGrants(reservation, "tour rescheduled");
    const override = placement === "OUTSIDE_HOURS" && input.outsideTourHours ? { kind: "OUTSIDE_HOURS" as const, approvedAt: this.nowIso() } : undefined;
    const { scheduleOverride: _previous, ...kept } = reservation;
    const moved: Reservation = {
      ...kept,
      slotStart: start.toISOString(),
      windowStart: windowStart.toISOString(),
      windowEnd: windowEnd.toISOString(),
      ...(override ? { scheduleOverride: override } : {}),
    };
    const detail = `from ${this.day(from)} ${this.time(from)} to ${this.day(start)} ${this.time(start)}; doors usable ${this.time(windowStart)}-${this.time(windowEnd)}`;
    if (reservation.status === "TOURING") {
      reservation = await this.move(moved, "READY", "RESERVATION_RESCHEDULED", { detail });
    } else {
      reservation = { ...moved, updatedAt: this.nowIso() };
      await this.deps.store.put("reservations", reservation);
      await this.record("RESERVATION_RESCHEDULED", { reservationId: reservation.id, prospectId: reservation.prospectId, detail });
    }

    if (input.customTime) {
      await this.record("TOUR_RESCHEDULED", { reservationId: reservation.id, prospectId: reservation.prospectId, detail: `to ${this.whenPhrase(start)}` });
      for (const request of await this.deps.store.list("tourTimeRequests")) {
        if (request.reservationId === reservation.id && request.status === "PENDING") {
          await this.deps.store.put("tourTimeRequests", { ...request, status: "SUPERSEDED", resolvedAt: this.nowIso(), operatorNote: "tour was moved" });
        }
      }
    }
    if (override) {
      await this.record("TOUR_TIME_OVERRIDE_APPROVED", {
        reservationId: reservation.id,
        prospectId: reservation.prospectId,
        detail: "one-time tour outside normal touring hours",
      });
    }

    const prospect = await this.mustGetProspect(reservation.prospectId);
    const when = `${this.day(start)} at ${this.time(start)}`;
    if (input.notice === "none") {
      return { reservation, changed: true };
    }
    if (input.notice === "moved") {
      await this.textProspect(prospect, reservation.id, `Your tour of ${visitorSubject(config.property, this.unitFor(reservation).name)} has been moved to ${this.whenPhrase(start)}. You're all set.`);
    } else if (reservation.status === "READY") {
      await this.textProspect(prospect, reservation.id, `Your tour has moved to ${when}.\nDoors will work for you from ${this.time(windowStart)} to ${this.time(windowEnd)}.`, {
        kind: "say",
        phrase: "I'm here",
        purpose: this.arrivalPurpose(reservation),
      });
    } else {
      await this.textProspect(prospect, reservation.id, `Your tour has moved to ${when}. Everything else stays the same.`);
    }
    return { reservation, changed: true };
  }

  /**
   * Books a one-off time onto an inquiry. Normal self-service still goes
   * through `reserveSlot`. This does not change the property's recurring hours.
   * `holdForVisitorConfirm` reserves the slot and waits for the visitor's YES
   * before the usual consent text.
   */
  async bookCustomSlot(
    reservationId: string,
    slotStartIso: string,
    options: { outsideTourHours?: boolean; holdForVisitorConfirm?: { confirmBy: Date } } = {},
  ): Promise<Reservation> {
    return this.withSlotLock(() => this.doBookCustomSlot(reservationId, slotStartIso, options));
  }

  private async doBookCustomSlot(
    reservationId: string,
    slotStartIso: string,
    options: { outsideTourHours?: boolean; holdForVisitorConfirm?: { confirmBy: Date } } = {},
  ): Promise<Reservation> {
    let reservation = await this.mustGetReservation(reservationId);
    this.assertBookingAllowed(reservation.unitId);
    const start = new Date(slotStartIso);
    if (Number.isNaN(start.getTime())) throw new TourCoreError("INVALID_SLOT", "That tour time isn't valid.");
    if (reservation.status !== "INQUIRY") throw new TourCoreError("ALREADY_BOOKED", "This tour already has a time.");
    const { config, clock } = this.deps;
    const placement = placementOf(config, start);
    if (placement === "OUTSIDE_HOURS" && !options.outsideTourHours) {
      throw new TourCoreError("OUTSIDE_TOUR_HOURS", `${this.time(start)} is outside the property's normal ${touringHoursLabel(config)} touring hours.`);
    }
    const { windowStart, windowEnd } = tourWindow(config, start);
    if (windowEnd <= clock.now()) throw new TourCoreError("SLOT_PAST", "That tour time has already passed.");
    await this.assertNoConflict(start, reservation.id);

    const override = placement === "OUTSIDE_HOURS" && options.outsideTourHours ? { kind: "OUTSIDE_HOURS" as const, approvedAt: this.nowIso() } : undefined;
    reservation = {
      ...reservation,
      slotStart: start.toISOString(),
      windowStart: windowStart.toISOString(),
      windowEnd: windowEnd.toISOString(),
      ...(override ? { scheduleOverride: override } : {}),
    };
    reservation = await this.move(reservation, "RESERVED", "RESERVATION_CREATED", {
      detail: `${this.day(start)} at ${this.time(start)}; doors usable ${this.time(windowStart)}-${this.time(windowEnd)}`,
    });
    if (override) {
      await this.record("TOUR_TIME_OVERRIDE_APPROVED", { reservationId: reservation.id, prospectId: reservation.prospectId, detail: "one-time tour outside normal touring hours" });
    }
    if (options.holdForVisitorConfirm) {
      reservation = {
        ...reservation,
        awaitingVisitorConfirm: { kind: "OPERATOR_SCHEDULED", confirmBy: options.holdForVisitorConfirm.confirmBy.toISOString() },
        updatedAt: this.nowIso(),
      };
      await this.deps.store.put("reservations", reservation);
      return reservation;
    }
    reservation = await this.move(reservation, "AWAITING_CONSENT", "CONSENT_REQUESTED", { detail: "asked permission to text and keep tour records" });
    const prospect = await this.mustGetProspect(reservation.prospectId);
    await this.textProspect(prospect, reservation.id, `${bookedForLine(this.time(start), this.day(start))}\n${CONSENT_TEXT}`, { kind: "yes-no" });
    return reservation;
  }

  /** Visitor said YES to an operator-set tour: the usual consent question is next. */
  async confirmOperatorScheduledTour(reservationId: string): Promise<Reservation> {
    let reservation = await this.mustGetReservation(reservationId);
    if (reservation.awaitingVisitorConfirm?.kind !== "OPERATOR_SCHEDULED" || reservation.status !== "RESERVED" || !reservation.slotStart) {
      throw new TourCoreError("NOT_AWAITING_CONFIRM", "That tour isn't waiting on the visitor to confirm.");
    }
    const slotStart = reservation.slotStart;
    const { awaitingVisitorConfirm: _dropped, ...kept } = reservation;
    reservation = { ...kept, updatedAt: this.nowIso() };
    await this.deps.store.put("reservations", reservation);
    reservation = await this.move(reservation, "AWAITING_CONSENT", "CONSENT_REQUESTED", { detail: "asked permission to text and keep tour records" });
    const prospect = await this.mustGetProspect(reservation.prospectId);
    const start = new Date(slotStart);
    await this.textProspect(prospect, reservation.id, `${bookedForLine(this.time(start), this.day(start))}\n${CONSENT_TEXT}`, { kind: "yes-no" });
    return reservation;
  }

  /** Visitor said NO to an operator-set tour: cancel, tell the team, and acknowledge. */
  async declineOperatorScheduledTour(reservationId: string): Promise<Reservation> {
    let reservation = await this.mustGetReservation(reservationId);
    if (reservation.awaitingVisitorConfirm?.kind !== "OPERATOR_SCHEDULED") {
      throw new TourCoreError("NOT_AWAITING_CONFIRM", "That tour isn't waiting on the visitor to confirm.");
    }
    const start = reservation.slotStart ? new Date(reservation.slotStart) : undefined;
    const prospect = await this.mustGetProspect(reservation.prospectId);
    reservation = await this.cancelReservation(reservation.id, "visitor declined the scheduled tour");
    await this.textProspect(prospect, reservation.id, "No problem. I cancelled that tour. Text me anytime to book another.");
    const when = start ? releasedWhen(start, this.deps.clock.now(), this.deps.config.property.timezone) : "scheduled";
    await this.notifyOperator(reservation, `${this.visitorLabel(prospect)} said no to the ${when} tour, so I cancelled it.`);
    return reservation;
  }

  /**
   * Releases operator-set times the visitor never confirmed. Sends one text
   * (unless they opted out) and alerts the team. Idempotent.
   */
  async releaseExpiredOperatorScheduled(): Promise<Reservation[]> {
    const released: Reservation[] = [];
    const now = this.deps.clock.now();
    for (const reservation of await this.deps.store.list("reservations")) {
      const pending = reservation.awaitingVisitorConfirm;
      if (!pending || pending.kind !== "OPERATOR_SCHEDULED") continue;
      if (TERMINAL.includes(reservation.status)) continue;
      if (Date.parse(pending.confirmBy) > now.getTime()) continue;
      const start = reservation.slotStart ? new Date(reservation.slotStart) : undefined;
      const prospect = await this.mustGetProspect(reservation.prospectId);
      const when = start ? releasedWhen(start, now, this.deps.config.property.timezone) : "scheduled";
      const cancelled = await this.cancelReservation(reservation.id, "visitor didn't confirm the scheduled tour in time");
      await this.textProspect(prospect, cancelled.id, `I didn't hear back, so I released your ${when} tour. Text me anytime to book another.`);
      await this.notifyOperator(cancelled, `${this.visitorLabel(prospect)} didn't confirm the ${when} tour, so I released it.`);
      released.push(cancelled);
    }
    return released;
  }

  /** A visitor or operator asking for a time. Repeating the same pending time does not create another request. */
  async createTourTimeRequest(input: {
    prospectId: string;
    reservationId?: string;
    unitId?: string;
    requestedStartsAt: string;
    requestSource: TourTimeRequest["requestSource"];
    sourceMessageId?: string;
    operatorNote?: string;
  }): Promise<{ request: TourTimeRequest; created: boolean }> {
    const start = new Date(input.requestedStartsAt);
    if (Number.isNaN(start.getTime())) throw new TourCoreError("INVALID_SLOT", "That tour time isn't valid.");
    this.assertBookingAllowed(input.unitId ?? (input.reservationId ? (await this.mustGetReservation(input.reservationId)).unitId : undefined));
    const prospect = await this.mustGetProspect(input.prospectId);
    const existing = await this.deps.store.list("tourTimeRequests");
    if (input.sourceMessageId) {
      const sameMessage = existing.find((request) => request.sourceMessageId === input.sourceMessageId);
      if (sameMessage) return { request: sameMessage, created: false };
    }
    const pendingSame = existing.find(
      (request) =>
        request.status === "PENDING" &&
        request.prospectId === prospect.id &&
        request.requestedStartsAt === start.toISOString() &&
        (request.reservationId ?? "") === (input.reservationId ?? ""),
    );
    if (pendingSame) return { request: pendingSame, created: false };

    for (const request of existing) {
      if (request.status !== "PENDING" || request.prospectId !== prospect.id) continue;
      if ((request.reservationId ?? "") !== (input.reservationId ?? "")) continue;
      await this.deps.store.put("tourTimeRequests", { ...request, status: "SUPERSEDED", resolvedAt: this.nowIso() });
    }

    const length = this.deps.config.tourHours.tourLengthMinutes * 60_000;
    const request: TourTimeRequest = {
      id: newId("ttr"),
      propertyId: this.deps.config.property.id,
      prospectId: prospect.id,
      ...(input.reservationId ? { reservationId: input.reservationId } : {}),
      ...(input.unitId ? { unitId: input.unitId } : {}),
      requestedStartsAt: start.toISOString(),
      requestedEndsAt: new Date(start.getTime() + length).toISOString(),
      requestSource: input.requestSource,
      status: "PENDING",
      createdAt: this.nowIso(),
      ...(input.operatorNote ? { operatorNote: input.operatorNote } : {}),
      ...(input.sourceMessageId ? { sourceMessageId: input.sourceMessageId } : {}),
    };
    await this.deps.store.put("tourTimeRequests", request);
    await this.record("TOUR_TIME_REQUESTED", {
      reservationId: input.reservationId,
      prospectId: prospect.id,
      detail: `asked for ${this.whenPhrase(start)}`,
    });
    return { request, created: true };
  }

  /** First pending-line text for this request. A later text must not send it again. */
  async markPendingCustomTimeNotice(requestId: string): Promise<TourTimeRequest> {
    const request = await this.mustGetTimeRequest(requestId);
    if (request.pendingNoticeSentAt) return request;
    const next = { ...request, pendingNoticeSentAt: this.nowIso() };
    await this.deps.store.put("tourTimeRequests", next);
    return next;
  }

  /** Visitor booked a regular slot: the pending custom-time request cannot later approve into a second booking. */
  async withdrawPendingCustomTimeRequests(prospectId: string, reservationId?: string): Promise<TourTimeRequest[]> {
    const withdrawn: TourTimeRequest[] = [];
    for (const request of await this.deps.store.list("tourTimeRequests")) {
      if (request.status !== "PENDING") continue;
      if (request.prospectId !== prospectId && request.reservationId !== reservationId) continue;
      const next: TourTimeRequest = {
        ...request,
        status: "WITHDRAWN",
        resolvedAt: this.nowIso(),
        resolvedBy: "VISITOR",
        operatorNote: WITHDRAWN_FOR_REGULAR_BOOKING,
      };
      await this.deps.store.put("tourTimeRequests", next);
      await this.record("TOUR_TIME_REQUEST_WITHDRAWN", {
        reservationId: request.reservationId ?? reservationId,
        prospectId,
        detail: WITHDRAWN_FOR_REGULAR_BOOKING,
      });
      withdrawn.push(next);
    }
    return withdrawn;
  }

  private assertPendingTimeRequest(request: TourTimeRequest): void {
    if (request.status === "WITHDRAWN") throw new TourCoreError("REQUEST_WITHDRAWN", WITHDRAWN_FOR_REGULAR_BOOKING);
    if (request.status !== "PENDING") throw new TourCoreError("REQUEST_CLOSED", "That time request has already been handled.");
  }

  async approveTourTimeRequest(requestId: string, options: { outsideTourHours?: boolean } = {}): Promise<{ request: TourTimeRequest; reservation: Reservation; needsConsentAsk?: boolean }> {
    return this.withSlotLock(async () => {
      await this.deps.slotLockBarrier?.("approve");
      const request = await this.mustGetTimeRequest(requestId);
      this.assertPendingTimeRequest(request);
      this.assertBookingAllowed(request.unitId ?? (request.reservationId ? (await this.mustGetReservation(request.reservationId)).unitId : undefined));
      if (!request.reservationId) throw new TourCoreError("NO_RESERVATION", "That request isn't tied to a tour.");
      const current = await this.mustGetReservation(request.reservationId);
      this.assertMovableRequest(current);
      const outside = placementOf(this.deps.config, new Date(request.requestedStartsAt)) === "OUTSIDE_HOURS";
      if (outside && !options.outsideTourHours) {
        throw new TourCoreError("OUTSIDE_TOUR_HOURS", `${this.time(new Date(request.requestedStartsAt))} is outside the property's normal ${touringHoursLabel(this.deps.config)} touring hours.`);
      }
      const unconfirmed = current.status === "AWAITING_CONSENT" && !current.consentId;
      let reservation: Reservation;
      let needsConsentAsk = false;
      if (current.status === "INQUIRY" || !current.slotStart) {
        reservation = await this.doBookCustomSlot(current.id, request.requestedStartsAt, options);
      } else if (unconfirmed) {
        reservation = (await this.doRescheduleReservation({ reservationId: current.id, newStartsAt: request.requestedStartsAt, customTime: true, outsideTourHours: options.outsideTourHours, notice: "none" })).reservation;
        needsConsentAsk = true;
      } else {
        reservation = (await this.doRescheduleReservation({ reservationId: current.id, newStartsAt: request.requestedStartsAt, customTime: true, outsideTourHours: options.outsideTourHours, notice: "moved" })).reservation;
      }
      const approved = await this.resolveRequest(request, "APPROVED", "OPERATOR");
      await this.record("TOUR_TIME_REQUEST_APPROVED", { reservationId: reservation.id, prospectId: request.prospectId, detail: `approved ${this.whenPhrase(new Date(request.requestedStartsAt))}` });
      return { request: approved, reservation, ...(needsConsentAsk ? { needsConsentAsk: true } : {}) };
    });
  }

  async declineTourTimeRequest(requestId: string, note?: string): Promise<TourTimeRequest> {
    return this.withSlotLock(async () => {
      await this.deps.slotLockBarrier?.("decline");
      const request = await this.mustGetTimeRequest(requestId);
      this.assertPendingTimeRequest(request);
      const declined = await this.resolveRequest(request, "DECLINED", "OPERATOR", note);
      const reservation = request.reservationId ? await this.deps.store.get("reservations", request.reservationId) : undefined;
      const prospect = await this.mustGetProspect(request.prospectId);
      const current = reservation?.slotStart ? ` Your ${this.time(new Date(reservation.slotStart))} tour is still confirmed.` : "";
      await this.textProspect(prospect, request.reservationId, `The property team couldn't approve ${this.time(new Date(request.requestedStartsAt))}.${current}`);
      await this.record("TOUR_TIME_REQUEST_DECLINED", { reservationId: request.reservationId, prospectId: request.prospectId, detail: note?.trim() || "declined" });
      return declined;
    });
  }

  /** Offers another time. The existing booking is not moved until the visitor accepts. */
  async proposeTourTime(requestId: string, alternativeStartsAt: string): Promise<TourTimeRequest> {
    return this.withSlotLock(async () => {
      await this.deps.slotLockBarrier?.("propose");
      const request = await this.mustGetTimeRequest(requestId);
      this.assertPendingTimeRequest(request);
      const start = new Date(alternativeStartsAt);
      if (Number.isNaN(start.getTime())) throw new TourCoreError("INVALID_SLOT", "That tour time isn't valid.");
      const { windowEnd } = tourWindow(this.deps.config, start);
      if (windowEnd <= this.deps.clock.now()) throw new TourCoreError("SLOT_PAST", "That tour time has already passed.");
      if (request.reservationId) await this.assertNoConflict(start, request.reservationId);
      const next: TourTimeRequest = { ...request, proposedAlternativeAt: start.toISOString(), operatorNote: `offered ${this.time(start)}` };
      await this.deps.store.put("tourTimeRequests", next);
      const prospect = await this.mustGetProspect(request.prospectId);
      const reservation = request.reservationId ? await this.deps.store.get("reservations", request.reservationId) : undefined;
      const keep = reservation?.slotStart ? ` or NO to keep your ${this.time(new Date(reservation.slotStart))} time` : " or NO to keep looking";
      await this.textProspect(
        prospect,
        request.reservationId,
        `The property team can't do ${this.time(new Date(request.requestedStartsAt))}, but ${this.time(start)} works. Reply YES to switch to ${this.time(start)}${keep}.`,
      );
      await this.record("TOUR_TIME_ALTERNATIVE_PROPOSED", { reservationId: request.reservationId, prospectId: request.prospectId, detail: `offered ${this.whenPhrase(start)}` });
      return next;
    });
  }

  async acceptProposedTime(requestId: string): Promise<{ request: TourTimeRequest; reservation: Reservation; needsConsentAsk?: boolean }> {
    return this.withSlotLock(async () => {
      const request = await this.mustGetTimeRequest(requestId);
      this.assertPendingTimeRequest(request);
      if (!request.proposedAlternativeAt) throw new TourCoreError("NOTHING_PROPOSED", "There isn't another time waiting on the visitor.");
      this.assertBookingAllowed(request.unitId ?? (request.reservationId ? (await this.mustGetReservation(request.reservationId)).unitId : undefined));
      if (!request.reservationId) throw new TourCoreError("NO_RESERVATION", "That request isn't tied to a tour.");
      const current = await this.mustGetReservation(request.reservationId);
      this.assertMovableRequest(current);
      const outside = placementOf(this.deps.config, new Date(request.proposedAlternativeAt)) === "OUTSIDE_HOURS";
      const unconfirmed = current.status === "AWAITING_CONSENT" && !current.consentId;
      let reservation: Reservation;
      let needsConsentAsk = false;
      if (current.status === "INQUIRY" || !current.slotStart) {
        reservation = await this.doBookCustomSlot(current.id, request.proposedAlternativeAt, { outsideTourHours: outside });
      } else if (unconfirmed) {
        reservation = (await this.doRescheduleReservation({ reservationId: current.id, newStartsAt: request.proposedAlternativeAt, customTime: true, outsideTourHours: outside, notice: "none" })).reservation;
        needsConsentAsk = true;
      } else {
        reservation = (await this.doRescheduleReservation({ reservationId: current.id, newStartsAt: request.proposedAlternativeAt, customTime: true, outsideTourHours: outside, notice: "moved" })).reservation;
      }
      const approved = await this.resolveRequest(request, "APPROVED", "VISITOR");
      await this.record("TOUR_TIME_REQUEST_APPROVED", { reservationId: reservation.id, prospectId: request.prospectId, detail: `visitor accepted ${this.whenPhrase(new Date(request.proposedAlternativeAt))}` });
      return { request: approved, reservation, ...(needsConsentAsk ? { needsConsentAsk: true } : {}) };
    });
  }

  async declineProposedTime(requestId: string): Promise<TourTimeRequest> {
    const request = await this.mustGetTimeRequest(requestId);
    if (request.status !== "PENDING" || !request.proposedAlternativeAt) throw new TourCoreError("NOTHING_PROPOSED", "There isn't another time waiting on the visitor.");
    const declined = await this.resolveRequest(request, "DECLINED", "VISITOR", "visitor kept their current time");
    const reservation = request.reservationId ? await this.deps.store.get("reservations", request.reservationId) : undefined;
    const prospect = await this.mustGetProspect(request.prospectId);
    const current = reservation?.slotStart ? ` Your ${this.time(new Date(reservation.slotStart))} tour is still confirmed.` : " Your tour time is unchanged.";
    await this.textProspect(prospect, request.reservationId, `No problem.${current}`);
    await this.record("TOUR_TIME_REQUEST_DECLINED", { reservationId: request.reservationId, prospectId: request.prospectId, detail: "visitor kept the current time" });
    return declined;
  }

  /** Records the visitor's answer to the follow-up question. Only the first answer counts. */
  async recordFollowUpResponse(reservationId: string, wantsContact: boolean, inbound?: { text: string; meta?: InboundMeta }): Promise<void> {
    const reservation = await this.mustGetReservation(reservationId);
    const leftAfterClose = reservation.status === "EXPIRED" && (await this.hasConfirmedLeftAfterClose(reservationId));
    if (reservation.status !== "COMPLETED" && !leftAfterClose) throw new TourCoreError("NOT_COMPLETED", "The tour isn't finished yet");
    const already = (await this.deps.store.listAudit()).some((e) => e.type === "FOLLOW_UP_RESPONSE" && e.reservationId === reservationId);
    if (already) return;
    const prospect = await this.mustGetProspect(reservation.prospectId);
    await this.recordInbound(prospect.id, reservationId, inbound?.text ?? (wantsContact ? "Yes" : "No"), inbound?.meta);
    await this.record("FOLLOW_UP_RESPONSE", { reservationId, prospectId: prospect.id, detail: wantsContact ? "yes" : "no" });
    if (wantsContact) {
      await this.notifyOperator(reservation, `${prospect.name} toured ${visitorSubject(this.deps.config.property, this.unitFor(reservation).name)} and would like someone to follow up.`);
      await this.textProspect(prospect, reservationId, VisitorDenialCopy.followUpYes(this.teamName()));
    } else {
      await this.textProspect(prospect, reservationId, "No problem. Thanks again for visiting!");
    }
  }

  /**
   * Answers only from operator-approved facts for this reservation's unit and
   * property. With no matching fact, it says so and flags the question.
   */
  async answerQuestion(reservationId: string, question: string, meta?: InboundMeta): Promise<{ answered: boolean; facts: ApprovedFact[] }> {
    const reservation = await this.mustGetReservation(reservationId);
    const prospect = await this.mustGetProspect(reservation.prospectId);
    const out = await this.answerPropertyQuestion({ phone: prospect.phone, question, reservationId, unitId: reservation.unitId, meta });
    return { answered: out.outcome === "answered", facts: out.facts };
  }

  /**
   * A visitor's question at any point in the conversation, booked or not.
   * Answers come only from approved facts: the property's, plus the unit the
   * visitor named or chose (`unitId`). A unit-specific question with no unit
   * to go on is asked back instead of guessed; nothing is sent in that case,
   * so the caller asks "Which unit do you mean?". With no matching fact the
   * visitor gets UNKNOWN_ANSWER (or `unknownReply`) and the question is flagged for the team.
   * `recordInbound: false` when the visitor's words were already stored
   * (e.g. the reply naming the unit for an earlier question).
   */
  async answerPropertyQuestion(input: {
    phone: string;
    question: string;
    reservationId?: string;
    unitId?: string;
    meta?: InboundMeta;
    recordInbound?: boolean;
    /** Visitor text when facts don't cover the question. Defaults to UNKNOWN_ANSWER. */
    unknownReply?: string;
    /** Appended to an approved-fact answer (ended-tour HI line). */
    answerSuffix?: string;
    /** Unit the visitor just picked from "Which unit do you mean?". */
    pickedUnitId?: string;
  }): Promise<{ outcome: "answered" | "unknown" | "which-unit"; facts: ApprovedFact[]; unitId?: string; units?: string[] }> {
    const phone = normalizePhone(input.phone);
    const read = this.deps.storageRead?.() ?? "live";
    const unitContext = { selectedUnitId: input.unitId, ...(input.pickedUnitId ? { pickedUnitId: input.pickedUnitId } : {}) };
    if (read !== "live") {
      const resolved = resolveQuestion(this.approvedContent(), input.question.trim().slice(0, 300), unitContext);
      if (resolved.kind === "which-unit") return { outcome: "which-unit", facts: [], units: resolved.units };
      if (read === "cached" && resolved.kind === "answer") {
        await this.deps.messenger.send({ to: phone, audience: "PROSPECT", body: withAnswerSuffix(approvedAnswerText(resolved.facts), input.answerSuffix) });
        return { outcome: "answered", facts: resolved.facts, ...(resolved.unitId ? { unitId: resolved.unitId } : {}) };
      }
      await this.deps.messenger.send({ to: phone, audience: "PROSPECT", body: "I can't check that right now. Please try again in a little while." });
      return { outcome: "unknown", facts: [] };
    }
    const prospect = (await this.deps.store.list("prospects")).find((p) => p.phone === phone);
    const reservation = input.reservationId ? await this.deps.store.get("reservations", input.reservationId) : undefined;
    const asked = input.question.trim().slice(0, 300);
    if (!asked) throw new TourCoreError("EMPTY_QUESTION", "Please type a question");
    if (input.recordInbound !== false) await this.recordIncoming({ phone, body: asked, prospectId: prospect?.id, reservationId: reservation?.id, meta: input.meta });

    const resolved = resolveQuestion(this.approvedContent(), asked, unitContext);
    const base = { reservationId: reservation?.id, prospectId: prospect?.id, ...(resolved.kind !== "which-unit" && resolved.unitId ? { unitId: resolved.unitId } : {}) };
    if (resolved.kind === "which-unit") return { outcome: "which-unit", facts: [], units: resolved.units };
    if (resolved.kind === "answer") {
      await this.record("QUESTION_ANSWERED", { ...base, detail: asked });
      await this.sendConversationText({ phone, body: withAnswerSuffix(approvedAnswerText(resolved.facts), input.answerSuffix), reservationId: reservation?.id });
      return { outcome: "answered", facts: resolved.facts, ...(resolved.unitId ? { unitId: resolved.unitId } : {}) };
    }
    await this.record("QUESTION_UNANSWERED", { ...base, detail: asked });
    await this.sendConversationText({ phone, body: input.unknownReply ?? UNKNOWN_ANSWER, reservationId: reservation?.id });
    const who = prospect && prospect.name !== UNNAMED_VISITOR ? prospect.name : `A visitor texting from ${phone}`;
    const named = resolved.unitId ? this.deps.config.units.find((u) => u.id === resolved.unitId) : undefined;
    const about = !reservation && named ? ` about ${visitorSubject(this.deps.config.property, named.name)}` : "";
    await this.notifyOperator(reservation, `${who} asked "${asked}"${about}, and there's no approved answer yet.`);
    return { outcome: "unknown", facts: [], ...(resolved.unitId ? { unitId: resolved.unitId } : {}) };
  }

  /**
   * Flags a visitor's words for the team the same way an unanswered property
   * question is flagged, and sends `reply`. Used while an operator-set tour is
   * still waiting for YES — the hold stays pending.
   */
  async flagUnansweredQuestion(input: { phone: string; question: string; reservationId?: string; meta?: InboundMeta; reply: string; recordInbound?: boolean; silent?: boolean }): Promise<void> {
    const phone = normalizePhone(input.phone);
    const prospect = (await this.deps.store.list("prospects")).find((p) => p.phone === phone);
    const reservation = input.reservationId ? await this.deps.store.get("reservations", input.reservationId) : undefined;
    const asked = input.question.trim().slice(0, 300);
    if (!asked) throw new TourCoreError("EMPTY_QUESTION", "Please type a question");
    if (input.recordInbound !== false) await this.recordIncoming({ phone, body: asked, prospectId: prospect?.id, reservationId: reservation?.id, meta: input.meta });
    await this.record("QUESTION_UNANSWERED", { reservationId: reservation?.id, prospectId: prospect?.id, detail: asked });
    if (!input.silent) await this.sendConversationText({ phone, body: input.reply, reservationId: reservation?.id });
    const who = prospect && prospect.name !== UNNAMED_VISITOR ? prospect.name : `A visitor texting from ${phone}`;
    await this.notifyOperator(reservation, `${who} asked "${asked}", and there's no approved answer yet.`);
  }

  private approvedContent(): TourCoreConfig {
    try {
      return this.deps.approvedContent?.() ?? this.deps.config;
    } catch {
      return this.deps.config;
    }
  }

  async requestHelp(reservationId: string, where?: string, inbound?: { text: string; meta?: InboundMeta }): Promise<void> {
    const reservation = await this.mustGetReservation(reservationId);
    const place = helpContext(reservation, this.deps.clock.now());
    if (!place) return;
    const prospect = await this.mustGetProspect(reservation.prospectId);
    const said = inbound?.text ?? "I need help";
    const repeat = (await this.deps.store.listAudit()).some((e) => e.reservationId === reservationId && e.type === "HELP_REQUESTED");
    await this.recordInbound(prospect.id, reservationId, said, inbound?.meta);
    await this.record("HELP_REQUESTED", { reservationId, prospectId: prospect.id, detail: where ?? "", code: said });
    if (await this.shouldAlertHelp(reservationId)) {
      await this.notifyOperator(reservation, `${prospect.name} asked for help${where ? ` near ${where}` : ""}.`);
    }
    const team = this.teamName();
    const contact = this.visitorHelpNumber();
    const ack =
      place === "upcoming"
        ? repeat
          ? VisitorDenialCopy.helpRepeatAckRemote(team, contact)
          : VisitorDenialCopy.helpAckRemote(team, contact)
        : repeat
          ? VisitorDenialCopy.helpRepeatAck(team, contact)
          : VisitorDenialCopy.helpAck(team, contact);
    await this.textProspect(prospect, reservationId, ack);
  }

  /** Re-alert at most once per HELP_ALERT_WINDOW_MS for the same reservation's open help. */
  private async shouldAlertHelp(reservationId: string): Promise<boolean> {
    const last = [...(await this.deps.store.listAudit())]
      .reverse()
      .find((e) => e.reservationId === reservationId && e.type === "OPERATOR_NOTIFIED" && e.detail.includes("asked for help"));
    if (!last) return true;
    return this.deps.clock.now().getTime() - Date.parse(last.at) >= HELP_ALERT_WINDOW_MS;
  }

  // -------------------------------------------------------- operator actions

  async revokeReservation(reservationId: string, reason: string): Promise<Reservation> {
    let reservation = await this.mustGetReservation(reservationId);
    await this.revokeGrants(reservation, reason);
    reservation = await this.move(reservation, "REVOKED", "RESERVATION_REVOKED", { detail: reason });
    const prospect = await this.mustGetProspect(reservation.prospectId);
    await this.textProspect(prospect, reservation.id, VisitorDenialCopy.calledOff(this.teamName(), this.visitorHelpNumber()));
    return reservation;
  }

  async cancelReservation(reservationId: string, reason: string): Promise<Reservation> {
    let reservation = await this.mustGetReservation(reservationId);
    if (TERMINAL.includes(reservation.status)) return reservation;
    await this.revokeGrants(reservation, reason);
    if (reservation.awaitingVisitorConfirm) {
      const { awaitingVisitorConfirm: _dropped, ...kept } = reservation;
      reservation = { ...kept, updatedAt: this.nowIso() };
    }
    return this.move(reservation, "CANCELLED", "RESERVATION_CANCELLED", { detail: reason });
  }

  /**
   * Visitor confirmed cancel-by-text. Same engine path as calling the tour
   * off: doors are switched off, status is cancelled, audit is written.
   * The caller sends the short done line.
   */
  async cancelTourByVisitor(reservationId: string): Promise<Reservation> {
    const reservation = await this.mustGetReservation(reservationId);
    if (!isCancelableReservation(reservation)) {
      throw new TourCoreError("NOT_CANCELABLE", "This tour can't be cancelled from here.");
    }
    return this.cancelReservation(reservationId, "visitor cancelled by text");
  }

  /**
   * Cancel-by-text could not finish. Never uses the generic "I don't have that
   * information" line — flags the team and sends the interim call-off reply.
   */
  async flagVisitorCancelFailed(input: { phone: string; text: string; reservationId?: string; meta?: InboundMeta; recordInbound?: boolean }): Promise<void> {
    const phone = normalizePhone(input.phone);
    const prospect = (await this.deps.store.list("prospects")).find((p) => p.phone === phone);
    const reservation = input.reservationId ? await this.deps.store.get("reservations", input.reservationId) : undefined;
    const asked = input.text.trim().slice(0, 300) || "cancel";
    if (input.recordInbound !== false) await this.recordIncoming({ phone, body: asked, prospectId: prospect?.id, reservationId: reservation?.id, meta: input.meta });
    await this.record("QUESTION_UNANSWERED", { reservationId: reservation?.id, prospectId: prospect?.id, detail: asked });
    await this.sendConversationText({ phone, body: VISITOR_CANCEL_FAILED, reservationId: reservation?.id });
    const who = prospect && prospect.name !== UNNAMED_VISITOR ? prospect.name : `A visitor texting from ${phone}`;
    await this.notifyOperator(reservation, `${who} asked to cancel their tour, and I couldn't cancel it from here.`);
  }

  /**
   * Calls off a booked tour that has not started: pending door access is
   * revoked, the reservation is cancelled, and the visitor gets the approved
   * cancel text. A tour already in progress is left alone.
   */
  async cancelBookedTour(reservationId: string, options: { reason: string; propertyWide: boolean; removed?: boolean }): Promise<Reservation> {
    let reservation = await this.mustGetReservation(reservationId);
    if (reservation.status === "TOURING") return reservation;
    if (!reservation.slotStart || TERMINAL.includes(reservation.status)) return reservation;
    const slotStart = reservation.slotStart;
    await this.revokeGrants(reservation, options.reason);
    reservation = await this.move(reservation, "CANCELLED", "RESERVATION_CANCELLED", { detail: options.reason });
    const prospect = await this.mustGetProspect(reservation.prospectId);
    const start = new Date(slotStart);
    await this.textProspect(
      prospect,
      reservation.id,
      bookedTourCalledOffText({
        team: this.teamName(),
        day: this.day(start),
        time: this.time(start),
        address: this.deps.config.property.address,
        propertyWide: options.propertyWide,
        ...(options.removed ? { removed: true } : {}),
      }),
    );
    return reservation;
  }

  async placeOperatorHold(reservationId: string, reason: string): Promise<Reservation> {
    let reservation = await this.mustGetReservation(reservationId);
    await this.revokeGrants(reservation, `operator hold: ${reason}`);
    return this.move(reservation, "OPERATOR_HOLD", "OPERATOR_HOLD_PLACED", { detail: reason });
  }

  /** Clears an operator hold or a resolved provider failure. */
  async resumeReservation(reservationId: string): Promise<Reservation> {
    const reservation = await this.mustGetReservation(reservationId);
    if (!reservation.heldFromStatus) throw new TourCoreError("NOT_PAUSED", `Reservation is ${reservation.status}`);
    return this.move(reservation, reservation.heldFromStatus, "RESERVATION_RESUMED", { detail: "operator resumed the tour" });
  }

  async recordInbound(prospectId: string, reservationId: string | undefined, body: string, meta?: InboundMeta): Promise<void> {
    const prospect = await this.mustGetProspect(prospectId);
    await this.recordIncoming({ phone: prospect.phone, body, prospectId, reservationId, meta });
  }

  /** Stores a message from a visitor, including before they have a prospect record (e.g. a first "Hi"). */
  async recordIncoming(input: { phone: string; body: string; prospectId?: string; reservationId?: string; meta?: InboundMeta }): Promise<void> {
    const { meta } = input;
    await this.deps.store.put("messages", {
      id: newId("msg"),
      direction: "INBOUND",
      audience: "PROSPECT",
      channel: meta?.provider ?? this.deps.messenger.provider,
      counterparty: normalizePhone(input.phone),
      body: input.body,
      prospectId: input.prospectId,
      reservationId: input.reservationId,
      at: this.nowIso(),
      deliveryStatus: "RECEIVED",
      ...(meta?.provider ? { provider: meta.provider } : {}),
      ...(meta?.providerMessageId ? { providerMessageId: meta.providerMessageId } : {}),
      ...(meta?.deliveryChannel ? { deliveryChannel: meta.deliveryChannel } : {}),
      ...((meta?.correlationId ?? this.deps.correlationId) ? { correlationId: meta?.correlationId ?? this.deps.correlationId } : {}),
    });
  }

  /**
   * A conversation-level text (welcome, help, "didn't catch that"): stored and
   * sent like any other, and suppressed for anyone who opted out.
   */
  async sendConversationText(input: { phone: string; body: string; prompt?: ReplyPrompt; reservationId?: string; deliverDespiteOptOut?: boolean }): Promise<void> {
    const phone = normalizePhone(input.phone);
    const prospect = (await this.deps.store.list("prospects")).find((p) => p.phone === phone);
    await this.deliver({
      audience: "PROSPECT",
      to: phone,
      toName: prospect?.name,
      body: withPrompt(input.body, input.prompt, this.presentation),
      prospectId: prospect?.id,
      reservationId: input.reservationId,
      suppressed: !!prospect?.messagingOptedOut && !input.deliverDespiteOptOut,
    });
  }

  /**
   * STOP / UNSUBSCRIBE: no more messages to this person, and a tour that runs
   * over messages can't continue, so it's ended safely (any open doors are
   * switched off). Returns whether a tour was ended.
   */
  async optOutOfMessaging(phoneRaw: string, keyword: string): Promise<{ endedTour: boolean }> {
    const phone = normalizePhone(phoneRaw);
    const prospect = (await this.deps.store.list("prospects")).find((p) => p.phone === phone);
    if (!prospect) return { endedTour: false };
    if (!prospect.messagingOptedOut) {
      await this.deps.store.put("prospects", { ...prospect, messagingOptedOut: true });
      await this.record("MESSAGING_OPTED_OUT", { prospectId: prospect.id, detail: keyword });
    }
    let endedTour = false;
    for (const reservation of (await this.deps.store.list("reservations")).filter((r) => r.prospectId === prospect.id && !TERMINAL.includes(r.status))) {
      if (reservation.status === "TOURING") {
        // STOP blocks visitor texts only. Doors stay on policy until T; overstay alerts still fire.
        await this.notifyOperator(reservation, `${prospect.name} replied ${keyword.toUpperCase()} and won't get more messages.`);
        continue;
      }
      await this.revokeGrants(reservation, "visitor opted out of messages");
      await this.move(reservation, "CANCELLED", "RESERVATION_CANCELLED", { detail: "visitor opted out of messages" });
      endedTour = true;
      await this.notifyOperator(reservation, `${prospect.name} replied ${keyword.toUpperCase()} and won't get more messages. Their tour was ended.`);
    }
    return { endedTour };
  }

  /** START: messages are allowed again. A tour that ended stays ended. */
  async optInToMessaging(phoneRaw: string): Promise<void> {
    const phone = normalizePhone(phoneRaw);
    const prospect = (await this.deps.store.list("prospects")).find((p) => p.phone === phone);
    if (!prospect?.messagingOptedOut) return;
    await this.deps.store.put("prospects", { ...prospect, messagingOptedOut: false });
    await this.record("MESSAGING_OPTED_IN", { prospectId: prospect.id, detail: "START" });
  }

  /** How replies are phrased for this conversation: buttons (web) or typed replies (messaging). */
  get presentation(): MessageChannel {
    return this.deps.messenger.presentation ?? "MESSAGING";
  }

  // ------------------------------------------------------------------ reads

  get store() {
    return this.deps.store;
  }

  async getProspect(id: string): Promise<Prospect | undefined> {
    return this.deps.store.get("prospects", id);
  }

  unitName(reservation: Reservation): string {
    return this.unitFor(reservation).name;
  }

  /** Visitor-facing help number only. Never `operator.contact`. */
  visitorHelpNumber(): string | undefined {
    return this.deps.config.operator.visitorContact;
  }

  async extraBusyWindows(): Promise<OccupiedWindow[]> {
    const padded = ((await this.deps.otherBusyStarts?.()) ?? []).map((start) => ({
      start,
      end: new Date(start.getTime() + this.deps.config.tourHours.tourLengthMinutes * 60_000),
    }));
    return [...padded, ...((await this.deps.otherBusyWindows?.()) ?? [])];
  }

  async messageVisitor(reservationId: string, body: string, options?: { recordFailure?: boolean }): Promise<boolean> {
    const reservation = await this.mustGetReservation(reservationId);
    const prospect = await this.mustGetProspect(reservation.prospectId);
    return this.textProspect(prospect, reservation.id, body, undefined, options);
  }

  /** True when this visitor already received `body` (so a retry will not double-send). */
  async visitorAlreadyReceived(reservationId: string, body: string): Promise<boolean> {
    return (await this.deps.store.list("messages")).some(
      (m) =>
        m.reservationId === reservationId &&
        m.audience === "PROSPECT" &&
        m.direction === "OUTBOUND" &&
        m.body === body &&
        (m.deliveryStatus === "SENT" || m.deliveryStatus === "DELIVERED" || m.deliveryStatus === "SUPPRESSED"),
    );
  }

  async alertOperator(reservationId: string, body: string): Promise<void> {
    const reservation = await this.mustGetReservation(reservationId);
    await this.notifyOperator(reservation, body);
  }

  async revokeGrantsFor(reservationId: string, reason: string): Promise<void> {
    const reservation = await this.mustGetReservation(reservationId);
    await this.revokeGrants(reservation, reason);
  }

  /**
   * Extends the access window and tour end by exactly 10 minutes and
   * re-requests scoped Durin grants so already-opened doors stay valid.
   */
  async extendTourWindow(reservationId: string, extraMinutes = 10): Promise<Reservation> {
    return this.withSlotLock(() => this.doExtendTourWindow(reservationId, extraMinutes));
  }

  /** Caller already holds the property slot lock (used by the overstay grant path). */
  async extendTourWindowLocked(reservationId: string, extraMinutes = 10): Promise<Reservation> {
    return this.doExtendTourWindow(reservationId, extraMinutes);
  }

  private async doExtendTourWindow(reservationId: string, extraMinutes = 10): Promise<Reservation> {
    const reservation = await this.mustGetReservation(reservationId);
    if (!reservation.windowEnd) throw new TourCoreError("NO_WINDOW", "This tour has no end time.");
    if (reservation.extensionGrantedAt) return reservation;
    const newEnd = new Date(Date.parse(reservation.windowEnd) + extraMinutes * 60_000);
    const next: Reservation = {
      ...reservation,
      originalWindowEnd: reservation.originalWindowEnd ?? reservation.windowEnd,
      windowEnd: newEnd.toISOString(),
      extensionGrantedAt: this.nowIso(),
      updatedAt: this.nowIso(),
    };
    await this.deps.store.put("reservations", next);
    await this.record("TOUR_EXTENDED", {
      reservationId: next.id,
      prospectId: next.prospectId,
      detail: `+${extraMinutes} minutes; doors until ${this.time(newEnd)}`,
    });
    await this.regrantUntil(next, newEnd);
    return next;
  }

  /** Closes a tour that ran past T without a DONE. Doors off; no goodbye follow-up. */
  async closeTourAsOverstay(reservationId: string): Promise<Reservation> {
    const reservation = await this.mustGetReservation(reservationId);
    if (reservation.status === "EXPIRED") return reservation;
    if (reservation.status !== "TOURING") throw new TourCoreError("NOT_TOURING", `Reservation is ${reservation.status}`);
    await this.revokeGrants(reservation, "tour closed after time ended");
    return this.move(reservation, "EXPIRED", "TOUR_OVERSTAY_CLOSED", { detail: "visitor didn't confirm leaving" });
  }

  async hasConfirmedLeftAfterClose(reservationId: string): Promise<boolean> {
    return (await this.deps.store.listAudit()).some((e) => e.reservationId === reservationId && e.type === "VISITOR_CONFIRMED_LEFT");
  }

  /** DONE / I'm out after the +15 close: same thanks as a normal finish, no after-close alert. */
  async confirmLeftAfterClose(reservationId: string): Promise<void> {
    const reservation = await this.mustGetReservation(reservationId);
    if (reservation.status !== "EXPIRED") return;
    if (await this.hasConfirmedLeftAfterClose(reservationId)) return;
    const prospect = await this.mustGetProspect(reservation.prospectId);
    const unit = this.unitFor(reservation);
    const place = visitorSubject(this.deps.config.property, unit.name);
    await this.record("VISITOR_CONFIRMED_LEFT", {
      reservationId: reservation.id,
      prospectId: prospect.id,
      detail: "visitor confirmed they left after the tour closed",
    });
    await this.textProspect(prospect, reservation.id, tourFinishedFollowUp(place, knownFirstName(prospect.name), unit.summary || undefined), { kind: "yes-no" });
    await this.record("FOLLOW_UP_SENT", { reservationId: reservation.id, prospectId: prospect.id, detail: "recap + follow-up question" });
  }

  /** Any other reply after the +15 close: one landlord alert and the property-team ack. */
  async replyAfterOverstayClose(reservationId: string, message: string): Promise<void> {
    const reservation = await this.mustGetReservation(reservationId);
    if (reservation.status !== "EXPIRED") return;
    if (await this.hasConfirmedLeftAfterClose(reservationId)) return;
    const prospect = await this.mustGetProspect(reservation.prospectId);
    const place = visitorSubject(this.deps.config.property, this.unitFor(reservation).name);
    const said = message.trim().slice(0, 300);
    await this.notifyOperator(reservation, landlordRepliedAfterClose(landlordWho(prospect.name), place, said));
    await this.textProspect(prospect, reservation.id, visitorRepliedAfterClose(this.visitorHelpNumber()));
  }

  private async regrantUntil(reservation: Reservation, newEnd: Date): Promise<void> {
    const active = (await this.listGrants(reservation.id)).filter((g) => g.status === "ACTIVE");
    for (const grant of active) {
      let result;
      try {
        result = await this.deps.durin.requestAccess({
          reservationId: reservation.id,
          prospectId: reservation.prospectId,
          doorId: grant.doorId,
          validFrom: grant.validFrom,
          validUntil: newEnd.toISOString(),
          idempotencyKey: `${reservation.id}:${grant.doorId}:ext:${newEnd.toISOString()}`,
        });
      } catch (err) {
        result = { ok: false as const, reason: err instanceof Error ? err.message : "Durin request failed" };
      }
      if (!result.ok) continue;
      await this.deps.store.put("accessGrants", { ...grant, validUntil: newEnd.toISOString(), durinGrantRef: result.grantRef });
      await this.record("ACCESS_ALLOWED", {
        reservationId: reservation.id,
        prospectId: reservation.prospectId,
        doorId: grant.doorId,
        detail: `extension; Durin grant ${result.grantRef} until ${this.time(newEnd)}`,
      });
    }
  }

  /** The only facts tour guidance may use for this reservation: the property's and the reserved unit's. */
  async approvedFacts(reservationId: string): Promise<ApprovedFact[]> {
    const reservation = await this.mustGetReservation(reservationId);
    return approvedFacts(this.approvedContent(), reservation.unitId);
  }

  getReservation(id: string): Promise<Reservation | undefined> {
    return this.deps.store.get("reservations", id);
  }

  async listGrants(reservationId: string): Promise<AccessGrant[]> {
    return (await this.deps.store.list("accessGrants")).filter((g) => g.reservationId === reservationId);
  }

  async auditTrail(reservationId?: string): Promise<AuditEvent[]> {
    const events = await this.deps.store.listAudit();
    return reservationId ? events.filter((e) => !e.reservationId || e.reservationId === reservationId) : events;
  }

  exportRecords(): Promise<ExportBundle> {
    return buildExport(this.deps.config, this.deps.store, this.deps.clock.now());
  }

  // --------------------------------------------------------------- internals

  private async doRequestAccess(request: AccessRequest): Promise<AccessOutcome> {
    const { store, clock, config } = this.deps;
    const now = clock.now();
    const door = config.doors.find((d) => d.id === request.doorId);
    const base = { reservationId: request.reservationId, prospectId: request.prospectId, doorId: request.doorId };
    await this.record("ACCESS_REQUESTED", { ...base, detail: door?.name ?? "unknown door" });

    const reservation = await store.get("reservations", request.reservationId);
    const prospect = await store.get("prospects", request.prospectId);
    const consent = reservation?.consentId ? await store.get("consents", reservation.consentId) : undefined;
    const verification = reservation?.verificationId ? await store.get("verifications", reservation.verificationId) : undefined;
    const durinHealth = await this.checkDurinHealth();

    const decision = evaluateAccess({ reservation, prospect, consent, verification, doorId: request.doorId, requestedAt: now, durinHealth });
    if (!decision.allowed) {
      await this.record("ACCESS_DENIED", { ...base, code: decision.code, detail: decision.reason });
      await this.explainDenial(decision.code, reservation, prospect, request.doorId);
      return { decision, durinCalled: false };
    }
    const approved = reservation!;

    const existing = (await store.list("accessGrants")).find(
      (g) => g.reservationId === approved.id && g.doorId === request.doorId && g.status === "ACTIVE" && Date.parse(g.validUntil) > now.getTime(),
    );
    if (existing) {
      await this.record("ACCESS_ALLOWED", { ...base, code: decision.code, detail: `duplicate request; reused grant ${existing.durinGrantRef}, Durin not called again` });
      return { decision, durinCalled: false, grant: existing, reusedGrant: true };
    }

    try {
      await this.deps.beforeAccess?.();
    } catch (err) {
      if (err instanceof StorageUnavailableError) {
        const failed: AccessDecision = { allowed: false, code: "DENY_PROVIDER_FAILURE", reason: "Tour records couldn't be confirmed, so the door stays closed." };
        return { decision: failed, durinCalled: false };
      }
      throw err;
    }

    let result: DurinAccessResult;
    try {
      result = await this.deps.durin.requestAccess({
        reservationId: approved.id,
        prospectId: approved.prospectId,
        doorId: request.doorId,
        validFrom: now.toISOString(),
        validUntil: approved.windowEnd!,
        idempotencyKey: `${approved.id}:${request.doorId}`,
      });
    } catch (err) {
      result = { ok: false, reason: err instanceof Error ? err.message : "Durin request failed" };
    }

    if (!result.ok) {
      const failed: AccessDecision = { allowed: false, code: "DENY_PROVIDER_FAILURE", reason: `Durin could not grant access: ${result.reason}` };
      const paused = await this.move(approved, "PROVIDER_FAILURE", "PROVIDER_FAILURE", { doorId: request.doorId, detail: result.reason });
      await this.record("ACCESS_DENIED", { ...base, code: failed.code, detail: failed.reason });
      await this.explainDenial(failed.code, paused, prospect, request.doorId);
      return { decision: failed, durinCalled: true };
    }

    const grant: AccessGrant = {
      id: newId("grt"),
      reservationId: approved.id,
      prospectId: approved.prospectId,
      doorId: request.doorId,
      durinGrantRef: result.grantRef,
      status: "ACTIVE",
      validFrom: now.toISOString(),
      validUntil: approved.windowEnd!,
      createdAt: now.toISOString(),
    };
    try {
      await store.put("accessGrants", grant);
    } catch (err) {
      if (err instanceof StorageUnavailableError) {
        await this.deps.durin.revokeAccess({ reservationId: approved.id, doorId: request.doorId, grantRef: result.grantRef }).catch(() => undefined);
        const failed: AccessDecision = { allowed: false, code: "DENY_PROVIDER_FAILURE", reason: "Tour records couldn't be saved, so the door stays closed." };
        return { decision: failed, durinCalled: true };
      }
      throw err;
    }
    await this.record("ACCESS_ALLOWED", { ...base, code: decision.code, detail: `Durin grant ${result.grantRef} until ${this.time(new Date(grant.validUntil))}` });

    if (approved.status === "READY") {
      await this.move(approved, "TOURING", "TOUR_STARTED", { detail: `entered via ${door?.name ?? request.doorId}` });
    }

    const stop = config.routes.find((r) => r.id === approved.routeId)?.stops.find((s) => s.doorId === request.doorId);
    const opened = new Set((await this.listGrants(approved.id)).map((g) => g.doorId));
    const nextStop = approved.allowedRoute.find((d) => !opened.has(d));
    const atBuildingEntrance = request.doorId === approved.allowedRoute[0] && door?.kind === "ENTRANCE";
    const reminder = atBuildingEntrance ? entryInstructionsFragment(this.unitFor(approved).entryInstructions) : undefined;
    await this.textProspect(
      prospect!,
      approved.id,
      `${door?.name ?? "The door"} is open for you now. ${stop?.guidance ?? ""}${reminder ? ` ${reminder}` : ""}`.trim(),
      nextStop ? { kind: "say", phrase: `at ${this.stopName(nextStop)}`, purpose: "when you get there" } : { kind: "say", phrase: "finish", purpose: "when you're done" },
    );
    return { decision, durinCalled: true, grant };
  }

  private async checkDurinHealth(): Promise<DurinHealth | undefined> {
    try {
      return await this.deps.durin.getHealth();
    } catch {
      return undefined;
    }
  }

  private async markReady(reservation: Reservation, prospect: Prospect): Promise<Reservation> {
    const ready = await this.move(reservation, "READY", "TOUR_READY", { detail: "consent and verification satisfied" });
    const start = new Date(ready.slotStart!);
    const fragment = entryInstructionsFragment(this.unitFor(ready).entryInstructions);
    await this.textProspect(
      prospect,
      ready.id,
      `You're all set for your tour on ${this.day(start)} at ${this.time(start)}!\n` +
        `Doors will work for you from ${this.time(new Date(ready.windowStart!))} to ${this.time(new Date(ready.windowEnd!))}.` +
        (fragment ? `\n${fragment}` : ""),
      { kind: "say", phrase: "I'm here", purpose: this.arrivalPurpose(ready) },
    );
    const directions = propertyDirectionsUrl(this.deps.config.property);
    if (directions) await this.textProspect(prospect, ready.id, tourDirectionsText(directions));
    return ready;
  }

  /** Unit-only routes have no building door, so arrival copy must not mention one. */
  private arrivalPurpose(reservation: Reservation): string {
    const first = this.deps.config.doors.find((d) => d.id === reservation.allowedRoute[0]);
    return first?.kind === "ENTRANCE" ? "when you arrive and I'll open the entrance" : "when you arrive and I'll open the unit door";
  }

  /** How a door is named in visitor guidance: "Unit 4B", "the front door", or "the entrance". Never "Main Home". */
  stopName(doorId: string): string {
    const unit = this.deps.config.units.find((u) => u.doorId === doorId);
    const door = this.deps.config.doors.find((d) => d.id === doorId);
    if (unit) {
      if (this.deps.config.property.propertyType === "SINGLE_FAMILY") {
        const named = door?.name?.trim();
        if (named) return `the ${named.replace(/^the\s+/i, "").toLowerCase()}`;
        return streetLine(this.deps.config.property);
      }
      return unit.name;
    }
    return door?.kind === "ENTRANCE" ? "the entrance" : door?.name ?? "the next door";
  }

  private async revokeGrants(reservation: Reservation, reason: string): Promise<void> {
    const active = (await this.listGrants(reservation.id)).filter((g) => g.status === "ACTIVE");
    for (const grant of active) {
      try {
        await this.deps.durin.revokeAccess({ reservationId: reservation.id, doorId: grant.doorId, grantRef: grant.durinGrantRef });
      } catch (err) {
        await this.notifyOperator(reservation, `Couldn't revoke access on ${grant.doorId} (${err instanceof Error ? err.message : "unknown error"}). Please check the door.`);
        continue;
      }
      await this.deps.store.put("accessGrants", { ...grant, status: "REVOKED", revokedAt: this.nowIso() });
      await this.record("ACCESS_REVOKED", {
        reservationId: reservation.id,
        prospectId: reservation.prospectId,
        doorId: grant.doorId,
        detail: `${grant.durinGrantRef}: ${reason}`,
      });
    }
  }

  private async explainDenial(
    code: AccessDecisionCode,
    reservation: Reservation | undefined,
    prospect: Prospect | undefined,
    doorId: string,
  ): Promise<void> {
    const team = this.teamName();
    const help = this.visitorHelpNumber();
    const needsOperator: AccessDecisionCode[] = ["DENY_WRONG_ROUTE", "DENY_DURIN_UNHEALTHY", "DENY_PROVIDER_FAILURE", "DENY_UNKNOWN", "DENY_PROSPECT_MISMATCH", "DENY_NO_RESERVATION"];

    if (reservation && prospect && prospect.id === reservation.prospectId) {
      const unit = this.unitFor(reservation);
      if (code === "DENY_CONSENT_MISSING") {
        await this.textProspect(prospect, reservation.id, VisitorDenialCopy.missingConsent(), { kind: "yes-no" });
      } else if (code === "DENY_VERIFICATION_STALE" || code === "DENY_VERIFICATION_INCOMPLETE") {
        const ask = code === "DENY_VERIFICATION_STALE" ? { body: VisitorDenialCopy.staleVerification(), form: true } : this.deps.verification.request(prospect);
        await this.textProspect(prospect, reservation.id, ask.body, ask.form ? { kind: "form", link: await this.verificationFormLink(reservation, prospect) } : undefined);
      } else {
        const text: Partial<Record<AccessDecisionCode, string>> = {
          DENY_TOO_EARLY: reservation.windowStart
            ? VisitorDenialCopy.tooEarly(this.time(new Date(reservation.windowStart)), this.whenPhrase(new Date(reservation.windowStart)))
            : VisitorDenialCopy.tooEarly(),
          DENY_EXPIRED: (await this.tourHadStarted(reservation)) ? DOOR_AFTER_T : LATE_ARRIVAL_EXPIRED,
          DENY_WRONG_ROUTE: `That door isn't part of your tour, so I can't open it. You're here to see ${visitorSubject(this.deps.config.property, unit.name)}. I've let the ${team} know in case you need a hand.`,
          DENY_DURIN_UNHEALTHY: VisitorDenialCopy.doorsNotResponding(team, help),
          DENY_PROVIDER_FAILURE: VisitorDenialCopy.doorsNotResponding(team, help),
          DENY_TOUR_COMPLETED: "Your tour is finished, so the doors are locked again. Want to book another visit?",
          DENY_OPERATOR_HOLD: VisitorDenialCopy.operatorHold(team, help),
          DENY_CANCELLED: "This tour is no longer active, so I can't open doors. Reply if you'd like to book a new time.",
          DENY_REVOKED: "This tour is no longer active, so I can't open doors. Reply if you'd like to book a new time.",
          DENY_VERIFICATION_FAILED: VisitorDenialCopy.failedIdAtDoor(team, help),
        };
        await this.textProspect(
          prospect,
          reservation.id,
          text[code] ?? "We're not quite ready to open doors yet. Finish the steps I sent earlier and you'll be all set.",
        );
      }
    }
    if (needsOperator.includes(code)) {
      const who = prospect?.name ?? "Someone without a booked tour";
      const door = this.deps.config.doors.find((d) => d.id === doorId)?.name ?? "a door that isn't on file";
      const alert =
        code === "DENY_WRONG_ROUTE"
          ? `${who} tried ${door}, which isn't on their tour. It stayed locked.`
          : code === "DENY_DURIN_UNHEALTHY" || code === "DENY_PROVIDER_FAILURE"
            ? `The doors aren't responding for ${who}'s tour. They're waiting at ${door}.`
            : `${who} couldn't get into ${door}. They may need a hand.`;
      await this.notifyOperator(reservation, alert);
    }
  }

  private async move(
    reservation: Reservation,
    to: ReservationStatus,
    type: AuditEventType,
    extra: Omit<AuditInput, "statusChange" | "reservationId" | "prospectId">,
  ): Promise<Reservation> {
    const next = transition(reservation, to, this.deps.clock.now());
    await this.deps.store.put("reservations", next);
    await this.record(type, {
      reservationId: next.id,
      prospectId: next.prospectId,
      statusChange: { from: reservation.status, to },
      ...extra,
    });
    return next;
  }

  private record(type: AuditEventType, input: AuditInput): Promise<AuditEvent> {
    return this.audit.record(type, input);
  }

  private assertBookingAllowed(unitId?: string): void {
    const check = this.deps.availability?.(unitId);
    if (check && !check.allowed) throw new TourCoreError("TOURS_PAUSED", check.message);
  }

  private teamName(): string {
    return this.deps.config.operator.name;
  }

  private isStalePassedCheck(verification: Verification | undefined): boolean {
    return !!verification && verification.status === "PASSED" && Date.parse(verification.validUntil) <= this.deps.clock.now().getTime();
  }

  private async verificationFormLink(reservation: Reservation, prospect: Prospect): Promise<string | undefined> {
    if (this.deps.verification.automatic || this.presentation !== "MESSAGING") return undefined;
    if (this.deps.verificationLink) return this.deps.verificationLink({ reservation, prospect });
    return this.deps.verification.defaultLink?.(prospect);
  }

  private async textProspect(prospect: Prospect, reservationId: string | undefined, body: string, prompt?: ReplyPrompt, options?: { recordFailure?: boolean }): Promise<boolean> {
    const current = (await this.deps.store.get("prospects", prospect.id)) ?? prospect;
    return this.deliver({
      audience: "PROSPECT",
      to: current.phone,
      toName: current.name,
      body: withPrompt(body, prompt, this.presentation),
      prospectId: current.id,
      reservationId,
      suppressed: !!current.messagingOptedOut,
      recordFailure: options?.recordFailure,
    });
  }

  private async notifyOperator(reservation: Reservation | undefined, body: string): Promise<void> {
    const { operator } = this.deps.config;
    await this.record("OPERATOR_NOTIFIED", { reservationId: reservation?.id, prospectId: reservation?.prospectId, detail: body });
    await this.deliver({ audience: "OPERATOR", to: operator.contact, toName: operator.name, body, prospectId: reservation?.prospectId, reservationId: reservation?.id });
  }

  /**
   * The single path out. The message is stored first, then handed to the
   * adapter, then updated with the provider's receipt. A delivery failure is
   * recorded, never thrown: it must not undo or fake any tour or access state.
   */
  private async deliver(m: {
    audience: Message["audience"];
    to: string;
    toName?: string;
    body: string;
    prospectId?: string;
    reservationId?: string;
    suppressed?: boolean;
    recordFailure?: boolean;
  }): Promise<boolean> {
    const { store, messenger } = this.deps;
    const message: Message = {
      id: newId("msg"),
      direction: "OUTBOUND",
      audience: m.audience,
      channel: messenger.provider,
      counterparty: m.to,
      body: m.body,
      prospectId: m.prospectId,
      reservationId: m.reservationId,
      at: this.nowIso(),
      provider: messenger.provider,
      ...(this.deps.correlationId ? { correlationId: this.deps.correlationId } : {}),
    };
    if (m.suppressed) {
      await store.put("messages", { ...message, deliveryStatus: "SUPPRESSED" });
      return true;
    }
    await store.put("messages", message);
    let receipt: DeliveryReceipt;
    try {
      receipt = await messenger.send({ to: m.to, toName: m.toName, audience: m.audience, body: m.body, idempotencyKey: message.id, correlationId: this.deps.correlationId });
    } catch (err) {
      const code = err instanceof MessagingError ? err.code : "MESSAGING_FAILED";
      receipt = { provider: messenger.provider, channel: "UNKNOWN", status: "FAILED", sentAt: this.nowIso(), error: { code, message: err instanceof Error ? err.message : "send failed" } };
    }
    await store.put("messages", {
      ...message,
      provider: receipt.provider,
      deliveryChannel: receipt.channel,
      deliveryStatus: receipt.status,
      ...(receipt.providerMessageId ? { providerMessageId: receipt.providerMessageId } : {}),
      ...(receipt.error ? { deliveryError: receipt.error.code } : {}),
    });
    if (receipt.status === "FAILED") {
      if (m.recordFailure !== false) {
        await this.record("MESSAGE_FAILED", {
          reservationId: m.reservationId,
          prospectId: m.prospectId,
          code: receipt.error?.code,
          detail: `${m.audience === "OPERATOR" ? "alert" : "message"} not delivered`,
        });
      }
      return false;
    }
    return true;
  }

  private unitFor(reservation: Reservation) {
    const unit = this.deps.config.units.find((u) => u.id === reservation.unitId);
    if (!unit) throw new TourCoreError("UNKNOWN_UNIT", `Unknown unit ${reservation.unitId}`);
    return unit;
  }

  private async mustGetReservation(id: string): Promise<Reservation> {
    const reservation = await this.deps.store.get("reservations", id);
    if (!reservation) throw new TourCoreError("NO_RESERVATION", `No reservation ${id}`);
    return reservation;
  }

  private async mustGetProspect(id: string): Promise<Prospect> {
    const prospect = await this.deps.store.get("prospects", id);
    if (!prospect) throw new TourCoreError("NO_PROSPECT", `No prospect ${id}`);
    return prospect;
  }

  private nowIso(): string {
    return this.deps.clock.now().toISOString();
  }

  private whenPhrase(start: Date): string {
    return relativeWhen(start, this.deps.clock.now(), this.deps.config.property.timezone);
  }

  private visitorLabel(prospect: Prospect): string {
    return prospect.name && prospect.name !== UNNAMED_VISITOR ? prospect.name.trim().split(/\s+/)[0]! : formatPhone(prospect.phone);
  }

  private withSlotLock<T>(fn: () => Promise<T>): Promise<T> {
    return withPropertySlotLock(this.deps.config.property.id, fn);
  }

  private async tourHadStarted(reservation: Reservation): Promise<boolean> {
    if (reservation.status === "TOURING" || reservation.status === "EXPIRED") return true;
    return (await this.listGrants(reservation.id)).length > 0;
  }

  private async busyIntervals(exceptId?: string): Promise<TimeInterval[]> {
    await this.releaseExpiredOperatorScheduled();
    const mine = (await this.deps.store.list("reservations"))
      .filter((reservation) => reservation.id !== exceptId && reservation.slotStart && !TERMINAL.includes(reservation.status))
      .map((reservation) => {
        const start = new Date(reservation.slotStart!);
        const end = reservation.windowEnd ? new Date(reservation.windowEnd) : undefined;
        return tourInterval(this.deps.config, start, end);
      });
    const startOnly = ((await this.deps.otherBusyStarts?.()) ?? []).map((start) => tourInterval(this.deps.config, start));
    const windows = ((await this.deps.otherBusyWindows?.()) ?? []).map(occupiedInterval);
    return [...mine, ...startOnly, ...windows];
  }

  private overlapsAny(start: Date, busy: TimeInterval[]): boolean {
    const interval = tourInterval(this.deps.config, start);
    return busy.some((other) => intervalsOverlap(interval, other));
  }

  private async assertNoConflict(start: Date, exceptId: string): Promise<void> {
    const busy = await this.busyIntervals(exceptId);
    if (busy.some((other) => other.startMs === start.getTime())) {
      throw new TourCoreError("SLOT_UNAVAILABLE", "Another visitor already has that time.");
    }
    if (this.overlapsAny(start, busy)) {
      throw new TourCoreError("SLOT_OVERLAP", overlapSummary(this.deps.config, start, closestOpenSlots(this.deps.config, this.deps.clock.now(), start, busy)));
    }
  }

  private async mustGetTimeRequest(id: string): Promise<TourTimeRequest> {
    const request = await this.deps.store.get("tourTimeRequests", id);
    if (!request) throw new TourCoreError("REQUEST_NOT_FOUND", "That time request couldn't be found.");
    return request;
  }

  private assertMovableRequest(reservation: Reservation): void {
    if (TERMINAL.includes(reservation.status)) throw new TourCoreError("NOT_RESCHEDULABLE", "That tour has already finished.");
    if (reservation.status === "OPERATOR_HOLD" || reservation.status === "PROVIDER_FAILURE") {
      throw new TourCoreError("NOT_RESCHEDULABLE", "That tour is paused, so its time can't be changed yet.");
    }
  }

  private canReplaceRegularBooking(reservation: Reservation): boolean {
    return !TERMINAL.includes(reservation.status) && reservation.status !== "TOURING" && reservation.status !== "OPERATOR_HOLD" && reservation.status !== "PROVIDER_FAILURE";
  }

  /** A visitor may hold only one future booking. Cancel any other live hold when they pick a regular slot. */
  private async cancelOtherLiveBookings(prospectId: string, keepId: string): Promise<void> {
    for (const other of await this.deps.store.list("reservations")) {
      if (other.id === keepId || other.prospectId !== prospectId) continue;
      if (!other.slotStart || TERMINAL.includes(other.status)) continue;
      if (other.status === "TOURING") continue;
      await this.cancelReservation(other.id, "replaced by a regular booking");
    }
  }

  private async resolveRequest(request: TourTimeRequest, status: "APPROVED" | "DECLINED", by: "OPERATOR" | "VISITOR", note?: string): Promise<TourTimeRequest> {
    const next: TourTimeRequest = { ...request, status, resolvedAt: this.nowIso(), resolvedBy: by, ...(note?.trim() ? { operatorNote: note.trim() } : {}) };
    await this.deps.store.put("tourTimeRequests", next);
    return next;
  }

  private time(d: Date): string {
    return formatTimeIn(d, this.deps.config.property.timezone);
  }

  private day(d: Date): string {
    return formatDayIn(d, this.deps.config.property.timezone);
  }
}

function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] ?? name;
}

function knownFirstName(name: string): string | undefined {
  const trimmed = name.trim();
  if (!trimmed || trimmed === UNNAMED_VISITOR) return undefined;
  return firstName(trimmed);
}
