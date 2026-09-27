import type { TourCoreConfig } from "../config/tourCoreConfig";
import {
  newId,
  type AccessGrant,
  type AuditEvent,
  type AuditEventType,
  type Consent,
  type Prospect,
  type Reservation,
  type ReservationStatus,
  type Verification,
} from "../domain/model";
import { TERMINAL, transition } from "../domain/stateMachine";
import type { DurinAccessAdapter, DurinAccessResult, DurinHealth } from "../durin/DurinAccessAdapter";
import type { Messenger } from "../messaging/Messenger";
import { evaluateAccess, type AccessDecision, type AccessDecisionCode } from "../policy/evaluateAccess";
import type { TourCoreStore } from "../storage/Store";
import type { VerificationProvider } from "../verification/basicForm";
import { AuditLog, type AuditInput } from "../audit/audit";
import { buildExport, type ExportBundle } from "../export/exportBundle";
import type { Clock } from "./clock";
import { approvedFacts, findApprovedAnswer, type ApprovedFact } from "./facts";
import { normalizePhone } from "./phone";
import { nextTourDay, slotsOn, tourWindow, type TourSlot } from "./schedule";
import { formatDay as formatDayIn, formatTime as formatTimeIn, localDateOf, type LocalDate } from "./timezone";

export interface TourCoreDeps {
  config: TourCoreConfig;
  store: TourCoreStore;
  durin: DurinAccessAdapter;
  messenger: Messenger;
  verification: VerificationProvider;
  clock: Clock;
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

const CONSENT_TEXT =
  "Is it OK if I text you about this tour and keep a record of your visit (times and doors used)? Reply YES or NO.";

export class TourCore {
  private readonly audit: AuditLog;
  private readonly inFlightAccess = new Map<string, Promise<AccessOutcome>>();

  constructor(private readonly deps: TourCoreDeps) {
    this.audit = new AuditLog(deps.store, deps.clock);
  }

  get config(): TourCoreConfig {
    return this.deps.config;
  }

  // ---------------------------------------------------------------- journey

  async startInquiry(input: { name: string; phone: string; unitId: string }): Promise<{ prospect: Prospect; reservation: Reservation }> {
    const { config, store } = this.deps;
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

    const slots = await this.availableSlots();
    const day = slots[0] ? this.day(slots[0].start) : "soon";
    await this.textProspect(
      prospect,
      reservation.id,
      `Hi ${firstName(prospect.name)}! Happy to set up a self-guided tour of ${unit.name} at ${config.property.name}.` +
        (unit.summary ? ` Here's what the property team shared: ${unit.summary.replace(/\.?$/, ".")}` : "") +
        "\n" +
        `Open times on ${day}: ${slots.map((s, i) => `${i + 1}) ${s.label}`).join("  ")}\nReply with the number that works for you.`,
    );
    return { prospect, reservation };
  }

  /** Open tour times on a property-local date (defaults to the next day with openings). */
  async availableSlots(day?: LocalDate): Promise<TourSlot[]> {
    const now = this.deps.clock.now();
    const onDay = day ?? nextTourDay(this.deps.config, now);
    const taken = new Set(
      (await this.deps.store.list("reservations"))
        .filter((r) => r.slotStart && !TERMINAL.includes(r.status))
        .map((r) => r.slotStart),
    );
    return slotsOn(this.deps.config, onDay).filter((s) => s.start > now && !taken.has(s.start.toISOString()));
  }

  async reserveSlot(reservationId: string, slotStartIso: string): Promise<Reservation> {
    let reservation = await this.mustGetReservation(reservationId);
    const start = new Date(slotStartIso);
    if (Number.isNaN(start.getTime())) throw new TourCoreError("INVALID_SLOT", "That tour time isn't valid");
    if (reservation.slotStart === start.toISOString() && reservation.status !== "INQUIRY") return reservation;
    if (reservation.status !== "INQUIRY") throw new TourCoreError("ALREADY_BOOKED", "This tour already has a time");

    const slots = await this.availableSlots(localDateOf(start, this.deps.config.property.timezone));
    if (!slots.some((s) => s.start.getTime() === start.getTime())) {
      throw new TourCoreError("SLOT_UNAVAILABLE", "That time is no longer available");
    }

    const { windowStart, windowEnd } = tourWindow(this.deps.config, start);
    reservation = { ...reservation, slotStart: start.toISOString(), windowStart: windowStart.toISOString(), windowEnd: windowEnd.toISOString() };
    reservation = await this.move(reservation, "RESERVED", "RESERVATION_CREATED", {
      detail: `${this.day(start)} at ${this.time(start)}; doors usable ${this.time(windowStart)}-${this.time(windowEnd)}`,
    });
    reservation = await this.move(reservation, "AWAITING_CONSENT", "CONSENT_REQUESTED", { detail: "asked permission to text and keep tour records" });

    const prospect = await this.mustGetProspect(reservation.prospectId);
    await this.textProspect(prospect, reservation.id, `Great, you're booked for ${this.time(start)} on ${this.day(start)}.\n${CONSENT_TEXT}`);
    return reservation;
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
    await this.textProspect(prospect, reservation.id, this.deps.verification.requestText(prospect));
    if (this.deps.verification.automatic) return this.submitVerification(reservation.id, {});
    return reservation;
  }

  async submitVerification(reservationId: string, submission: unknown): Promise<Reservation> {
    let reservation = await this.mustGetReservation(reservationId);
    if (reservation.verificationId) return reservation;
    if (reservation.status !== "AWAITING_VERIFICATION") {
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
      reservation = await this.move(reservation, "VERIFICATION_FAILED", "VERIFICATION_FAILED", { detail: outcome.reason });
      await this.textProspect(prospect, reservation.id, "Thanks for filling that out. We couldn't confirm your details, so someone from the leasing team will reach out to help.");
      await this.notifyOperator(reservation, `Identity form for ${prospect.name} didn't check out (${outcome.reason}). Please follow up.`);
      return reservation;
    }

    reservation = { ...reservation, verificationId: verification.id };
    await this.record("VERIFICATION_COMPLETED", {
      reservationId: reservation.id,
      prospectId: prospect.id,
      detail: `basic form ${outcome.reference}: ${outcome.claimed.firstName} ${outcome.claimed.lastName} (claimed identity, not document-checked)`,
    });
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
    await this.textProspect(
      prospect,
      reservation.id,
      `Thanks for touring ${unit.name}, ${firstName(prospect.name)}!${unit.summary ? ` Quick recap: ${unit.summary.replace(/\.$/, "")}.` : ""} The doors are locked again behind you.\n` +
        "Would you like someone from the property team to follow up? Reply YES or NO.",
    );
    await this.record("FOLLOW_UP_SENT", { reservationId: reservation.id, prospectId: prospect.id, detail: "recap + follow-up question" });
    return reservation;
  }

  /** Records the visitor's answer to the follow-up question. Only the first answer counts. */
  async recordFollowUpResponse(reservationId: string, wantsContact: boolean): Promise<void> {
    const reservation = await this.mustGetReservation(reservationId);
    if (reservation.status !== "COMPLETED") throw new TourCoreError("NOT_COMPLETED", "The tour isn't finished yet");
    const already = (await this.deps.store.listAudit()).some((e) => e.type === "FOLLOW_UP_RESPONSE" && e.reservationId === reservationId);
    if (already) return;
    const prospect = await this.mustGetProspect(reservation.prospectId);
    await this.recordInbound(prospect.id, reservationId, wantsContact ? "Yes" : "No");
    await this.record("FOLLOW_UP_RESPONSE", { reservationId, prospectId: prospect.id, detail: wantsContact ? "yes" : "no" });
    if (wantsContact) {
      await this.notifyOperator(reservation, `${prospect.name} toured ${this.unitFor(reservation).name} and would like someone to follow up.`);
      await this.textProspect(prospect, reservationId, `Great. Someone from the ${this.deps.config.operator.name.toLowerCase()} will be in touch soon.`);
    } else {
      await this.textProspect(prospect, reservationId, "No problem. Thanks again for visiting!");
    }
  }

  /**
   * Answers only from operator-approved facts for this reservation's unit and
   * property. With no matching fact, it says so and flags the question.
   */
  async answerQuestion(reservationId: string, question: string): Promise<{ answered: boolean; facts: ApprovedFact[] }> {
    const reservation = await this.mustGetReservation(reservationId);
    const prospect = await this.mustGetProspect(reservation.prospectId);
    const asked = question.trim().slice(0, 300);
    if (!asked) throw new TourCoreError("EMPTY_QUESTION", "Please type a question");
    await this.recordInbound(prospect.id, reservationId, asked);

    const matches = findApprovedAnswer(approvedFacts(this.deps.config, reservation.unitId), asked);
    if (matches.length) {
      await this.record("QUESTION_ANSWERED", { reservationId, prospectId: prospect.id, detail: asked });
      await this.textProspect(prospect, reservationId, `Here's what the property team shared: ${matches.map((f) => f.text).join(" ")}`);
      return { answered: true, facts: matches };
    }
    await this.record("QUESTION_UNANSWERED", { reservationId, prospectId: prospect.id, detail: asked });
    await this.textProspect(prospect, reservationId, "I don't have that information for this property. I've flagged it for the property team so they can get back to you.");
    await this.notifyOperator(reservation, `${prospect.name} asked "${asked}", and there's no approved answer yet.`);
    return { answered: false, facts: [] };
  }

  async requestHelp(reservationId: string, where?: string): Promise<void> {
    const reservation = await this.mustGetReservation(reservationId);
    const prospect = await this.mustGetProspect(reservation.prospectId);
    await this.recordInbound(prospect.id, reservationId, "I need help");
    await this.record("HELP_REQUESTED", { reservationId, prospectId: prospect.id, detail: where ?? "" });
    await this.notifyOperator(reservation, `${prospect.name} asked for help${where ? ` near ${where}` : ""}.`);
    await this.textProspect(prospect, reservationId, `I've let the ${this.deps.config.operator.name.toLowerCase()} know. Someone will reach out shortly.`);
  }

  // -------------------------------------------------------- operator actions

  async revokeReservation(reservationId: string, reason: string): Promise<Reservation> {
    let reservation = await this.mustGetReservation(reservationId);
    await this.revokeGrants(reservation, reason);
    reservation = await this.move(reservation, "REVOKED", "RESERVATION_REVOKED", { detail: reason });
    const prospect = await this.mustGetProspect(reservation.prospectId);
    await this.textProspect(prospect, reservation.id, "Your tour has been called off, so the doors won't open for it. The leasing team will reach out.");
    return reservation;
  }

  async cancelReservation(reservationId: string, reason: string): Promise<Reservation> {
    let reservation = await this.mustGetReservation(reservationId);
    await this.revokeGrants(reservation, reason);
    return this.move(reservation, "CANCELLED", "RESERVATION_CANCELLED", { detail: reason });
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

  async recordInbound(prospectId: string, reservationId: string | undefined, body: string): Promise<void> {
    const prospect = await this.mustGetProspect(prospectId);
    await this.deps.store.put("messages", {
      id: newId("msg"),
      direction: "INBOUND",
      audience: "PROSPECT",
      channel: this.deps.messenger.channel,
      counterparty: prospect.phone,
      body,
      prospectId,
      reservationId,
      at: this.nowIso(),
    });
  }

  // ------------------------------------------------------------------ reads

  /** The only facts tour guidance may use for this reservation: the property's and the reserved unit's. */
  async approvedFacts(reservationId: string): Promise<ApprovedFact[]> {
    const reservation = await this.mustGetReservation(reservationId);
    return approvedFacts(this.deps.config, reservation.unitId);
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
    await store.put("accessGrants", grant);
    await this.record("ACCESS_ALLOWED", { ...base, code: decision.code, detail: `Durin grant ${result.grantRef} until ${this.time(new Date(grant.validUntil))}` });

    if (approved.status === "READY") {
      await this.move(approved, "TOURING", "TOUR_STARTED", { detail: `entered via ${door?.name ?? request.doorId}` });
    }

    const stop = config.routes.find((r) => r.id === approved.routeId)?.stops.find((s) => s.doorId === request.doorId);
    await this.textProspect(prospect!, approved.id, `${door?.name ?? "The door"} is open for you now. ${stop?.guidance ?? ""}`.trim());
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
    await this.textProspect(
      prospect,
      ready.id,
      `You're all set for your tour on ${this.day(start)} at ${this.time(start)}! When you arrive, text me "I'm here" and I'll open the entrance.\n` +
        `Doors will work for you from ${this.time(new Date(ready.windowStart!))} to ${this.time(new Date(ready.windowEnd!))}.`,
    );
    return ready;
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
    const team = this.deps.config.operator.name.toLowerCase();
    const needsOperator: AccessDecisionCode[] = ["DENY_WRONG_ROUTE", "DENY_DURIN_UNHEALTHY", "DENY_PROVIDER_FAILURE", "DENY_UNKNOWN", "DENY_PROSPECT_MISMATCH", "DENY_NO_RESERVATION"];

    if (reservation && prospect && prospect.id === reservation.prospectId) {
      const unit = this.unitFor(reservation);
      const text: Partial<Record<AccessDecisionCode, string>> = {
        DENY_TOO_EARLY: `You're a little early! I can open the doors from ${reservation.windowStart ? this.time(new Date(reservation.windowStart)) : "your tour time"}.`,
        DENY_EXPIRED: "Your tour time has ended, so I can't open doors anymore. Want me to find you another time?",
        DENY_WRONG_ROUTE: `That door isn't part of your tour, so I can't open it. You're here to see ${unit.name}. I've let the ${team} know in case you need a hand.`,
        DENY_DURIN_UNHEALTHY: `Sorry, the doors aren't responding right now. I've let the ${team} know and someone will reach out shortly.`,
        DENY_PROVIDER_FAILURE: `Sorry, the doors aren't responding right now. I've let the ${team} know and someone will reach out shortly.`,
        DENY_TOUR_COMPLETED: "Your tour is finished, so the doors are locked again. Want to book another visit?",
        DENY_OPERATOR_HOLD: `Your tour is paused for a moment. The ${team} will be in touch shortly.`,
        DENY_CANCELLED: "This tour is no longer active, so I can't open doors. Reply if you'd like to book a new time.",
        DENY_REVOKED: "This tour is no longer active, so I can't open doors. Reply if you'd like to book a new time.",
      };
      await this.textProspect(
        prospect,
        reservation.id,
        text[code] ?? "We're not quite ready to open doors yet. Finish the steps I sent earlier and you'll be all set.",
      );
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

  private async textProspect(prospect: Prospect, reservationId: string, body: string): Promise<void> {
    await this.deps.store.put("messages", {
      id: newId("msg"),
      direction: "OUTBOUND",
      audience: "PROSPECT",
      channel: this.deps.messenger.channel,
      counterparty: prospect.phone,
      body,
      prospectId: prospect.id,
      reservationId,
      at: this.nowIso(),
    });
    await this.deps.messenger.send({ to: prospect.name, audience: "PROSPECT", body });
  }

  private async notifyOperator(reservation: Reservation | undefined, body: string): Promise<void> {
    const { operator } = this.deps.config;
    await this.deps.store.put("messages", {
      id: newId("msg"),
      direction: "OUTBOUND",
      audience: "OPERATOR",
      channel: this.deps.messenger.channel,
      counterparty: operator.contact,
      body,
      prospectId: reservation?.prospectId,
      reservationId: reservation?.id,
      at: this.nowIso(),
    });
    await this.record("OPERATOR_NOTIFIED", { reservationId: reservation?.id, prospectId: reservation?.prospectId, detail: body });
    await this.deps.messenger.send({ to: operator.name, audience: "OPERATOR", body });
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
