import { loadConfig } from "../src/config/tourCoreConfig";
import { SimulatedClock } from "../src/core/clock";
import { zonedTimeToUtc, type LocalDate } from "../src/core/timezone";
import { createTourCore } from "../src/createTourCore";
import { MockDurinAccessAdapter } from "../src/durin/MockDurinAccessAdapter";
import { ConsoleMessenger } from "../src/messaging/Messenger";
import { InMemoryStore } from "../src/storage/Store";

/** Monday 28 Sep 2026 at the property (America/New_York). */
export const TOUR_DAY: LocalDate = { year: 2026, month: 9, day: 28 };

export function setup(options: { visitorContact?: string; operatorName?: string } = {}) {
  const loaded = loadConfig();
  const config =
    options.visitorContact !== undefined || options.operatorName !== undefined
      ? {
          ...loaded,
          operator: {
            ...loaded.operator,
            ...(options.visitorContact !== undefined ? { visitorContact: options.visitorContact } : {}),
            ...(options.operatorName !== undefined ? { name: options.operatorName } : {}),
          },
        }
      : loaded;
  const clock = new SimulatedClock(zonedTimeToUtc({ ...TOUR_DAY, hour: 10, minute: 0 }, config.property.timezone));
  const durin = new MockDurinAccessAdapter({
    doorNames: Object.fromEntries(config.doors.map((d) => [d.id, d.name])),
    log: () => {},
    now: () => clock.now(),
  });
  const store = new InMemoryStore();
  const core = createTourCore(config, { clock, durin, messenger: new ConsoleMessenger(() => {}), store });
  return { config, clock, durin, core, store };
}

export function basicForm(phone = "555-010-1234") {
  return {
    responseId: "form_resp_test",
    submittedAt: new Date(2026, 8, 28, 10, 5).toISOString(),
    answers: { governmentFirstName: "Jane", governmentLastName: "Smith", email: "jane@example.com", phone },
  };
}

type Ctx = ReturnType<typeof setup>;

/** Books Jane into the 2:00 PM Unit 101 tour. Stops early if asked. */
export async function bookTour(ctx: Ctx, until: "awaiting-verification" | "ready" = "ready", day = TOUR_DAY) {
  const { prospect, reservation } = await ctx.core.startInquiry({ name: "Jane Smith", phone: "(555) 010-1234", unitId: "apt_101" });
  const slot = (await ctx.core.availableSlots(day))[0]!;
  await ctx.core.reserveSlot(reservation.id, slot.start.toISOString());
  let current = await ctx.core.recordConsent(reservation.id, true);
  if (until === "ready" && current.status === "AWAITING_VERIFICATION") {
    current = await ctx.core.submitVerification(reservation.id, basicForm());
  }
  const request = (doorId: string) => ctx.core.requestAccess({ reservationId: reservation.id, prospectId: prospect.id, doorId });
  return { prospect, reservation: current, slotStart: slot.start, request };
}

export function minutesFrom(base: Date, minutes: number): Date {
  return new Date(base.getTime() + minutes * 60_000);
}
