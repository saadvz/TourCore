import type { Clock } from "../core/clock";
import {
  occupantFromReservation,
  occupantFromTimeRequest,
  extensionAvailability,
  EXTENSION_MS,
  type Occupant,
} from "../core/extensionAvailability";
import { earlyExtensionAskDecision } from "../core/extensionPolicy";
import {
  DOOR_AFTER_T,
  EXTENSION_AFTER_T,
  EXTENSION_ASK_DEFERRED,
  extensionAlreadyUsed,
  extensionGranted,
  extensionUnavailable,
  isLeavingTour,
  isMoreTimeAsk,
  isT15NoOrAllGood,
  landlordExtensionGranted,
  landlordPlus15,
  landlordPlus5,
  landlordWho,
  knownFirstName,
  plus15Closed,
  plus5CheckIn,
  T15_BARE_YES,
  T15_NO_OR_ALL_GOOD,
  T5_NO_OFFER_BARE_YES,
  t15Questions,
  t5NoOffer,
  t5Offering,
  tourEnded,
} from "../core/overstayCopy";
import { formatTime } from "../core/timezone";
import type { TourCore } from "../core/TourCore";
import type { Reservation } from "../domain/model";
import { TERMINAL } from "../domain/stateMachine";
import { visitorSubject } from "./identity";
import { normalize, stripFiller } from "../intent/normalize";
import { yesNo } from "../intent/yesNo";
import type { RuntimeStore } from "../storage/runtimeStore";
import type { VisitorDemoSession } from "./session";

export const OVERSTAY_STEPS = ["t15", "t5", "tEnd", "tPlus5", "tPlus15"] as const;
export type OverstayStep = (typeof OVERSTAY_STEPS)[number];

export type OverstayPrompt = "none" | "t15" | "t5-offer" | "t5-no-offer";

export interface OverstayRecord {
  schemaVersion: 1;
  reservationId: string;
  propertyId: string;
  tourId?: string;
  originalWindowEnd: string;
  windowEnd: string;
  startedAt?: string;
  extensionGranted: boolean;
  t5Kind?: "offering" | "no-offer";
  prompt: OverstayPrompt;
  fired: Partial<Record<OverstayStep, string>>;
  cancelled?: boolean;
}

const OFFSETS: Record<OverstayStep, number> = {
  t15: -15 * 60_000,
  t5: -5 * 60_000,
  tEnd: 0,
  tPlus5: 5 * 60_000,
  tPlus15: 15 * 60_000,
};

function dueAt(windowEnd: string, step: OverstayStep): number {
  return Date.parse(windowEnd) + OFFSETS[step];
}

/** Latest unsent step that is due. Never T-15 after T. After an extension, T-15 and T-5 stay skipped. */
export function latestDueStep(record: OverstayRecord, nowMs: number): OverstayStep | undefined {
  if (record.cancelled || !record.startedAt) return undefined;
  const end = Date.parse(record.windowEnd);
  const due = (step: OverstayStep) => nowMs >= dueAt(record.windowEnd, step) && !record.fired[step];
  if (due("tPlus15")) return "tPlus15";
  if (due("tPlus5") && nowMs < end + OFFSETS.tPlus15) return "tPlus5";
  if (due("tEnd") && nowMs < end + OFFSETS.tPlus5) return "tEnd";
  if (due("t5") && nowMs < end) return "t5";
  if (due("t15") && nowMs < end - 5 * 60_000 && !record.extensionGranted && shouldSendT15(record, nowMs)) return "t15";
  return undefined;
}

export function shouldSendT15(record: OverstayRecord, nowMs: number): boolean {
  if (record.fired.t15 || record.extensionGranted || record.cancelled || !record.startedAt) return false;
  const t15 = dueAt(record.windowEnd, "t15");
  const started = Date.parse(record.startedAt);
  if (t15 <= started) return false;
  if (started >= t15) return false;
  if (nowMs >= Date.parse(record.windowEnd)) return false;
  return nowMs >= t15;
}

export class OverstayScheduler {
  private running?: Promise<void>;
  private again = false;

  constructor(
    private readonly runtime: RuntimeStore,
    private readonly options: { clock?: Clock; earlyAskGrants?: boolean; now?: () => Date } = {},
  ) {}

  private now(): Date {
    return this.options.clock?.now() ?? this.options.now?.() ?? new Date();
  }

  get(reservationId: string): OverstayRecord | undefined {
    return this.runtime.get<OverstayRecord>("overstay", reservationId);
  }

  private put(record: OverstayRecord): OverstayRecord {
    this.runtime.put("overstay", record.reservationId, record);
    return record;
  }

  cancel(reservationId: string): void {
    const existing = this.get(reservationId);
    if (!existing || existing.cancelled) return;
    this.put({ ...existing, cancelled: true, prompt: "none" });
  }

  ensure(reservation: Reservation, propertyId: string, tourId?: string): OverstayRecord {
    const existing = this.get(reservation.id);
    const windowEnd = reservation.windowEnd ?? existing?.windowEnd;
    if (!windowEnd) {
      return existing ?? {
        schemaVersion: 1,
        reservationId: reservation.id,
        propertyId,
        tourId,
        originalWindowEnd: "",
        windowEnd: "",
        extensionGranted: false,
        prompt: "none",
        fired: {},
      };
    }
    if (existing) {
      const startedAt = existing.startedAt ?? (reservation.status === "TOURING" ? reservation.updatedAt : undefined);
      return this.put({
        ...existing,
        windowEnd: reservation.windowEnd ?? existing.windowEnd,
        originalWindowEnd: existing.originalWindowEnd || windowEnd,
        extensionGranted: existing.extensionGranted || !!reservation.extensionGrantedAt,
        ...(startedAt && !existing.startedAt ? { startedAt } : {}),
        ...(tourId && !existing.tourId ? { tourId } : {}),
      });
    }
    return this.put({
      schemaVersion: 1,
      reservationId: reservation.id,
      propertyId,
      ...(tourId ? { tourId } : {}),
      originalWindowEnd: reservation.originalWindowEnd ?? windowEnd,
      windowEnd,
      ...(reservation.status === "TOURING" ? { startedAt: reservation.updatedAt } : {}),
      extensionGranted: !!reservation.extensionGrantedAt,
      prompt: "none",
      fired: {},
    });
  }

  /** Concurrent ticks share one pass so a step cannot fire twice. */
  tickCore(core: TourCore, ctx: { session?: VisitorDemoSession; propertyId?: string; tourId?: string } = {}): Promise<void> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      do {
        this.again = false;
        await this.pass(core, ctx);
      } while (this.again);
    })().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  async tickSession(session: VisitorDemoSession): Promise<void> {
    await this.tickCore(session.core, { session, propertyId: session.propertyId, tourId: session.tourId });
    await session.refreshThread();
  }

  private async pass(core: TourCore, ctx: { session?: VisitorDemoSession; propertyId?: string; tourId?: string }): Promise<void> {
    const reservations = await core.store.list("reservations");
    for (const reservation of reservations) {
      if (!reservation.windowEnd) continue;
      if (reservation.status === "TOURING" || this.get(reservation.id)) {
        this.ensure(reservation, ctx.propertyId ?? reservation.propertyId, ctx.tourId);
      }
      const record = this.get(reservation.id);
      if (!record || record.cancelled) continue;
      if (reservation.status === "COMPLETED") {
        this.cancel(reservation.id);
        continue;
      }
      if (TERMINAL.includes(reservation.status) && reservation.status !== "EXPIRED") {
        this.cancel(reservation.id);
        continue;
      }
      const step = latestDueStep(record, this.now().getTime());
      if (step) await this.fire(core, reservation.id, step, ctx.session);
    }
  }

  private async fire(core: TourCore, reservationId: string, step: OverstayStep, session?: VisitorDemoSession): Promise<void> {
    const claimed = this.get(reservationId);
    if (!claimed || claimed.fired[step] || claimed.cancelled) return;
    this.put({ ...claimed, fired: { ...claimed.fired, [step]: this.now().toISOString() } });
    const reservation = await core.getReservation(reservationId);
    if (!reservation) return;
    const prospect = await core.getProspect(reservation.prospectId);
    const place = visitorSubject(core.config.property, core.unitName(reservation));
    const name = knownFirstName(prospect?.name);
    const end = formatTime(new Date(reservation.windowEnd!), core.config.property.timezone);
    const who = landlordWho(prospect?.name);
    const help = core.visitorHelpNumber();

    if (step === "t15") {
      if (this.now().getTime() >= Date.parse(reservation.windowEnd!)) return;
      await core.messageVisitor(reservationId, t15Questions(place, name));
      this.put({ ...this.get(reservationId)!, prompt: "t15" });
      session?.expect("touring", { kind: "t15-questions" });
      return;
    }

    if (step === "t5") {
      if (claimed.extensionGranted) return;
      const available = await this.available(core, reservation);
      const body = available ? t5Offering(place, end, name) : t5NoOffer(place, end, name);
      await core.messageVisitor(reservationId, body);
      const kind = available ? "offering" : "no-offer";
      this.put({ ...this.get(reservationId)!, t5Kind: kind, prompt: available ? "t5-offer" : "t5-no-offer" });
      session?.expect("touring", { kind: available ? "t5-extension-offer" : "t5-no-offer" });
      return;
    }

    if (step === "tEnd") {
      await core.messageVisitor(reservationId, tourEnded(place, name));
      await core.revokeGrantsFor(reservationId, "tour window ended");
      this.put({ ...this.get(reservationId)!, prompt: "none" });
      return;
    }

    if (step === "tPlus5") {
      await core.messageVisitor(reservationId, plus5CheckIn(place));
      await core.alertOperator(reservationId, landlordPlus5(who, place));
      return;
    }

    await core.messageVisitor(reservationId, plus15Closed(place, help));
    await core.closeTourAsOverstay(reservationId);
    await core.alertOperator(reservationId, landlordPlus15(who, place));
  }

  async available(core: TourCore, reservation: Reservation): Promise<boolean> {
    return (await this.availability(core, reservation)).available;
  }

  async availability(core: TourCore, reservation: Reservation) {
    const occupants = (await this.occupants(core, reservation.id)).filter((o) => o.start.toISOString() !== reservation.slotStart);
    return extensionAvailability({ config: core.config, reservation, occupants });
  }

  private async occupants(core: TourCore, exceptId: string): Promise<Occupant[]> {
    const reservations = await core.store.list("reservations");
    const requests = await core.store.list("tourTimeRequests");
    const out: Occupant[] = [];
    for (const reservation of reservations) {
      if (reservation.id === exceptId) continue;
      const occupant = occupantFromReservation(core.config, reservation);
      if (occupant) out.push(occupant);
    }
    for (const request of requests) {
      const occupant = occupantFromTimeRequest(core.config, request);
      if (occupant) out.push(occupant);
    }
    for (const start of await core.extraBusyStarts()) {
      const windowStart = new Date(start.getTime() - core.config.tourHours.earlyArrivalMinutes * 60_000);
      const windowEnd = new Date(start.getTime() + core.config.tourHours.tourLengthMinutes * 60_000);
      out.push({ start, windowStart, windowEnd, unitId: "*", doors: ["*"], kind: "booked" });
    }
    return out;
  }

  async handleAsk(core: TourCore, reservationId: string, kind: "natural" | "bare-yes" = "natural"): Promise<string> {
    const reservation = await core.getReservation(reservationId);
    if (!reservation?.windowEnd) return EXTENSION_AFTER_T;
    const record = this.ensure(reservation, reservation.propertyId);
    const nowMs = this.now().getTime();
    const end = formatTime(new Date(reservation.windowEnd), core.config.property.timezone);
    if (nowMs >= Date.parse(reservation.windowEnd)) return EXTENSION_AFTER_T;
    if (record.extensionGranted || reservation.extensionGrantedAt) return extensionAlreadyUsed(end);

    const offering = record.t5Kind === "offering" || record.prompt === "t5-offer";
    const decision = earlyExtensionAskDecision({
      offeringT5Sent: offering,
      nowMs,
      windowEndMs: Date.parse(reservation.windowEnd),
      earlyAskGrants: this.options.earlyAskGrants,
    });
    if (decision === "after-t") return EXTENSION_AFTER_T;
    if (decision === "defer") return EXTENSION_ASK_DEFERRED;
    // A bare yes/sure/please only takes the extension after an offering T-5.
    if (kind === "bare-yes" && !offering) return EXTENSION_ASK_DEFERRED;

    const available = await this.available(core, reservation);
    if (!available) return extensionUnavailable(end);

    const extended = await core.extendTourWindow(reservationId);
    const newEnd = formatTime(new Date(extended.windowEnd!), core.config.property.timezone);
    const prospect = await core.getProspect(extended.prospectId);
    const place = visitorSubject(core.config.property, core.unitName(extended));
    this.put({
      ...this.get(reservationId)!,
      windowEnd: extended.windowEnd!,
      originalWindowEnd: record.originalWindowEnd || record.windowEnd,
      extensionGranted: true,
      prompt: "none",
      fired: { ...this.get(reservationId)!.fired, t15: this.get(reservationId)!.fired.t15 ?? this.now().toISOString(), t5: this.get(reservationId)!.fired.t5 ?? this.now().toISOString() },
    });
    await core.alertOperator(reservationId, landlordExtensionGranted(landlordWho(prospect?.name), place, newEnd));
    return extensionGranted(newEnd);
  }

  async replyToVisitor(core: TourCore, reservationId: string, text: string): Promise<string | undefined> {
    const reservation = await core.getReservation(reservationId);
    if (!reservation?.windowEnd) return undefined;
    const record = this.get(reservationId);
    const t = stripFiller(normalize(text));
    if (isLeavingTour(t)) return undefined;
    const nowMs = this.now().getTime();

    if (nowMs >= Date.parse(reservation.windowEnd) && (isMoreTimeAsk(t) || (record?.prompt === "t5-offer" && yesNo(t).answer === "yes"))) {
      return EXTENSION_AFTER_T;
    }

    if (record?.prompt === "t15") {
      if (isMoreTimeAsk(t)) {
        this.put({ ...record, prompt: "none" });
        return this.handleAsk(core, reservationId, "natural");
      }
      if (isT15NoOrAllGood(t) || yesNo(t).answer === "no") {
        this.put({ ...record, prompt: "none" });
        return T15_NO_OR_ALL_GOOD;
      }
      if (yesNo(t).answer === "yes" && yesNo(t).confidence >= 0.75 && !isMoreTimeAsk(t)) {
        this.put({ ...record, prompt: "none" });
        return T15_BARE_YES;
      }
      this.put({ ...record, prompt: "none" });
      return undefined;
    }

    if (record?.prompt === "t5-no-offer" || record?.t5Kind === "no-offer") {
      if (isMoreTimeAsk(t)) return this.handleAsk(core, reservationId, "natural");
      if (yesNo(t).answer === "yes" && yesNo(t).confidence >= 0.75 && !isMoreTimeAsk(t)) {
        this.put({ ...(record ?? this.ensure(reservation, reservation.propertyId)), prompt: "none" });
        return T5_NO_OFFER_BARE_YES;
      }
    }

    if (isMoreTimeAsk(t)) return this.handleAsk(core, reservationId, "natural");
    if ((record?.prompt === "t5-offer" || record?.t5Kind === "offering") && yesNo(t).answer === "yes" && yesNo(t).confidence >= 0.75) {
      return this.handleAsk(core, reservationId, "bare-yes");
    }
    return undefined;
  }
}

export { DOOR_AFTER_T };
