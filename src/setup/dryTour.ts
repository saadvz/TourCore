import { TourCoreConfigSchema, type TourCoreConfig } from "../config/tourCoreConfig";
import { SimulatedClock } from "../core/clock";
import { nextTourDay, slotsOn } from "../core/schedule";
import { formatLocalDate, formatTime } from "../core/timezone";
import { TourCore } from "../core/TourCore";
import { createDurin, createMessenger, createStore, createVerificationProvider } from "../createTourCore";
import type { AuditEvent } from "../domain/model";
import type { DurinAccessAdapter } from "../durin/DurinAccessAdapter";
import type { ExportBundle } from "../export/exportBundle";
import type { Messenger } from "../messaging/Messenger";

export type DryTourEvent =
  | { kind: "stage"; title: string }
  | { kind: "moment"; time: string; text: string }
  | { kind: "text"; audience: "PROSPECT" | "OPERATOR"; body: string }
  | { kind: "check"; ok: boolean; label: string; detail?: string }
  /** Technical adapter output, for dev mode. */
  | { kind: "dev"; line: string };

export interface DryTourCheck {
  label: string;
  ok: boolean;
  detail?: string;
}

export interface DryTourResult {
  passed: boolean;
  ranAt: string;
  checks: DryTourCheck[];
  /** Plain-language reason when the practice tour stopped early. */
  failure?: string;
  audit: AuditEvent[];
  bundle?: ExportBundle;
}

export interface DryTourOptions {
  /** Which unit to practice; defaults to the first one. */
  unitId?: string;
  now?: Date;
  onEvent?: (event: DryTourEvent) => void | Promise<void>;
}

const PRACTICE_VISITOR = { name: "Pat Practice", phone: "+1 555 019 9999" };

class StopPractice extends Error {}

/**
 * Runs one complete simulated tour through the real Tour Core engine using
 * the operator's configuration, and checks every safety rule along the way.
 */
export async function runDryTour(input: TourCoreConfig, options: DryTourOptions = {}): Promise<DryTourResult> {
  const realNow = options.now ?? new Date();
  const emit = async (e: DryTourEvent) => options.onEvent?.(e);
  const checks: DryTourCheck[] = [];
  const check = async (ok: boolean, label: string, detail?: string) => {
    checks.push({ label, ok, ...(detail ? { detail } : {}) });
    await emit({ kind: "check", ok, label, ...(detail ? { detail } : {}) });
    if (!ok) throw new StopPractice(detail ?? label);
  };

  const parsed = TourCoreConfigSchema.safeParse(input);
  if (!parsed.success) {
    return { passed: false, ranAt: realNow.toISOString(), checks, failure: "The setup has problems. Run the readiness check to see them.", audit: [] };
  }
  const config = parsed.data;
  const tz = config.property.timezone;
  const unit = config.units.find((u) => u.id === (options.unitId ?? config.units[0]?.id))!;
  const route = config.routes.find((r) => r.unitId === unit.id)!;
  const doorName = (id: string) => config.doors.find((d) => d.id === id)?.name ?? "a door that isn't on file";

  const day = nextTourDay(config, realNow);
  const slot = slotsOn(config, day).find((s) => s.start > realNow)!;
  const clock = new SimulatedClock(new Date(slot.start.getTime() - 3 * 60 * 60_000));
  const at = (text: string) => emit({ kind: "moment", time: formatTime(clock.now(), tz), text });

  const pending: DryTourEvent[] = [];
  const messenger: Messenger = {
    channel: createMessenger(config, () => {}).channel,
    async send(message) {
      pending.push({ kind: "text", audience: message.audience, body: message.body });
    },
  };
  const flush = async () => {
    for (const e of pending.splice(0)) await emit(e);
  };
  const durin = countCalls(createDurin(config, clock, (line) => pending.push({ kind: "dev", line: line.trim() })));
  const core = new TourCore({ config, clock, messenger, durin, store: createStore(config), verification: createVerificationProvider(config) });

  try {
    await emit({ kind: "stage", title: "Inquiry" });
    await at(`${PRACTICE_VISITOR.name} texts: "Hi! Can I tour ${unit.name}?"`);
    const { prospect, reservation: inquiry } = await core.startInquiry({ ...PRACTICE_VISITOR, unitId: unit.id });
    await core.recordInbound(prospect.id, inquiry.id, `Hi! Can I tour ${unit.name}?`);
    await flush();
    await check(inquiry.status === "INQUIRY", `Visitor asked about ${unit.name}`);

    await emit({ kind: "stage", title: "Reservation" });
    await at(`Visitor picks ${slot.label} on ${formatLocalDate(day, tz)}`);
    let reservation = await core.reserveSlot(inquiry.id, slot.start.toISOString());
    await flush();
    await check(reservation.status === "AWAITING_CONSENT", `Tour booked for ${slot.label}`);
    const request = (doorId: string) => core.requestAccess({ reservationId: reservation.id, prospectId: prospect.id, doorId });

    await emit({ kind: "stage", title: "Consent" });
    await at('Visitor replies "YES"');
    reservation = await core.recordConsent(reservation.id, true);
    await flush();
    await check(!!reservation.consentId, "Permission to text and keep records was recorded");

    await emit({ kind: "stage", title: "Verification" });
    if (reservation.status === "AWAITING_VERIFICATION") {
      await at("Visitor fills out the identity form");
      clock.advanceMinutes(2);
      const [first = "Pat", last = "Practice"] = PRACTICE_VISITOR.name.split(" ");
      reservation = await core.submitVerification(reservation.id, {
        responseId: `practice_form_${Date.now()}`,
        submittedAt: clock.now().toISOString(),
        answers: { governmentFirstName: first, governmentLastName: last, email: "pat.practice@example.com", phone: PRACTICE_VISITOR.phone },
      });
    }
    await flush();
    await check(reservation.status === "READY", "Visitor is checked and the tour is ready");

    await emit({ kind: "stage", title: "Arrival" });
    const entranceId = route.stops[0]!.doorId;
    clock.set(new Date(Date.parse(reservation.windowStart!) - 20 * 60_000));
    await at(`Visitor shows up early and asks for ${doorName(entranceId)}`);
    let before = durin.requestCount;
    const early = await request(entranceId);
    await flush();
    await check(
      !early.decision.allowed && durin.requestCount === before,
      `Too early: ${doorName(entranceId)} stayed locked, and Durin was never asked`,
      early.decision.allowed ? "The door opened before the tour window." : undefined,
    );

    clock.set(new Date(slot.start));
    await at(`Visitor arrives on time and asks for ${doorName(entranceId)}`);
    const entrance = await request(entranceId);
    await flush();
    await check(entrance.decision.allowed && !!entrance.grant, `Entrance access: ${doorName(entranceId)} opened through Durin`, entrance.decision.allowed ? undefined : entrance.decision.reason);

    before = durin.requestCount;
    const retry = await request(entranceId);
    await check(retry.decision.allowed && durin.requestCount === before, "A repeated request didn't create a second door grant");

    await emit({ kind: "stage", title: "Unit access and tour guidance" });
    for (const stop of route.stops.slice(1)) {
      clock.advanceMinutes(2);
      await at(`Visitor asks for ${doorName(stop.doorId)}`);
      const out = await request(stop.doorId);
      await flush();
      await check(out.decision.allowed && !!out.grant, `${doorName(stop.doorId)} opened, and the visitor got directions`, out.decision.allowed ? undefined : out.decision.reason);
    }

    await emit({ kind: "stage", title: "Safety check" });
    const offRoute = config.doors.find((d) => !route.stops.some((s) => s.doorId === d.id))?.id ?? "practice_door_not_on_file";
    clock.advanceMinutes(5);
    await at(`Visitor tries ${doorName(offRoute)}, which isn't on this tour`);
    before = durin.requestCount;
    const wrong = await request(offRoute);
    await flush();
    await check(
      !wrong.decision.allowed && wrong.decision.code === "DENY_WRONG_ROUTE" && durin.requestCount === before,
      `${doorName(offRoute)} stayed locked. Tour Core said no before Durin was ever asked`,
      wrong.decision.allowed ? "A door outside the route opened." : undefined,
    );

    await emit({ kind: "stage", title: "Completion and follow-up" });
    clock.set(new Date(slot.start.getTime() + Math.floor(config.tourHours.tourLengthMinutes * 0.75) * 60_000));
    await at("Visitor finishes the tour");
    const activeBefore = (await core.listGrants(reservation.id)).filter((g) => g.status === "ACTIVE").length;
    reservation = await core.completeTour(reservation.id);
    await flush();
    const stillActive = (await core.listGrants(reservation.id)).filter((g) => g.status === "ACTIVE").length;
    await check(reservation.status === "COMPLETED" && activeBefore > 0 && stillActive === 0, "Tour completed and every door was locked again");
    const audit = await core.auditTrail();
    await check(audit.some((e) => e.type === "FOLLOW_UP_SENT"), "Follow-up message sent");

    const bundle = await core.exportRecords();
    await check(bundle.auditEvents.length === audit.length, `Tour history saved (${audit.length} entries)`);
    return { passed: true, ranAt: realNow.toISOString(), checks, audit, bundle };
  } catch (err) {
    await flush();
    const failure = err instanceof StopPractice ? err.message : "Something unexpected stopped the practice tour.";
    if (!(err instanceof StopPractice)) await emit({ kind: "dev", line: String(err instanceof Error ? err.stack : err) });
    return { passed: false, ranAt: realNow.toISOString(), checks, failure, audit: await core.auditTrail() };
  }
}

/** Wraps any Durin adapter so the practice tour can prove when it was (not) called. */
function countCalls(inner: DurinAccessAdapter): DurinAccessAdapter & { requestCount: number } {
  const wrapper = {
    requestCount: 0,
    requestAccess: (req: Parameters<DurinAccessAdapter["requestAccess"]>[0]) => {
      wrapper.requestCount++;
      return inner.requestAccess(req);
    },
    revokeAccess: (req: Parameters<DurinAccessAdapter["revokeAccess"]>[0]) => inner.revokeAccess(req),
    getHealth: () => inner.getHealth(),
  };
  return wrapper;
}
