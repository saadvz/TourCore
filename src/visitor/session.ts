import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { TourCoreConfig } from "../config/tourCoreConfig";
import { DemoClock } from "../core/clock";
import { normalizePhone } from "../core/phone";
import { formatTime } from "../core/timezone";
import { TourCore, type AccessOutcome } from "../core/TourCore";
import { createDurin, createStore, createVerificationProvider } from "../createTourCore";
import type { Reservation } from "../domain/model";
import { countDurinCalls, type CountingDurin } from "../durin/countingDurin";
import type { Messenger } from "../messaging/Messenger";
import { SetupInputError } from "../setup/setupActions";
import type { ConversationItem, TourRecord } from "../setup/workspace";
import type { ExportBundle } from "../export/exportBundle";
import type { TourCoreStore } from "../storage/Store";

/**
 * One live visitor demo: a pretend prospect on a phone, driving the real
 * Tour Core engine. The session only translates taps into engine calls and
 * keeps the phone thread; every reply, decision and denial comes from Tour
 * Core (policy, messaging contract, verification boundary, Durin adapter).
 */

export type VisitorStage =
  | "intro"
  | "choose-unit"
  | "choose-time"
  | "consent"
  | "identity"
  | "ready"
  | "touring"
  | "follow-up"
  | "done"
  | "stopped";

export const VISITOR_DEFAULTS = { name: "Pat Smith", phone: "(555) 010-2000" };

const Text = z.string();
const ACTIONS = {
  begin: z.object({ name: Text, phone: Text }),
  chooseUnit: z.object({ unitId: Text }),
  chooseTime: z.object({ slotStart: Text }),
  consent: z.object({ agree: z.boolean() }),
  submitIdentity: z.object({ firstName: Text, lastName: Text, email: Text, phone: Text }),
  arrive: z.object({}),
  atStop: z.object({ doorId: Text }),
  ask: z.object({ question: Text }),
  help: z.object({}),
  finish: z.object({}),
  followUp: z.object({ wantsContact: z.boolean() }),
  demoSkipAhead: z.object({}),
  demoWrongDoor: z.object({}),
};
export type VisitorAction = keyof typeof ACTIONS;

/** Which actions make sense at each stage. Anything else is refused. */
const ALLOWED: Record<VisitorStage, VisitorAction[]> = {
  intro: ["begin"],
  "choose-unit": ["chooseUnit"],
  "choose-time": ["chooseTime"],
  consent: ["consent"],
  identity: ["submitIdentity"],
  ready: ["arrive", "ask", "help", "demoSkipAhead", "demoWrongDoor"],
  touring: ["atStop", "ask", "help", "finish", "demoWrongDoor"],
  "follow-up": ["followUp"],
  done: [],
  stopped: ["help"],
};

export interface LastAccess {
  doorId: string;
  allowed: boolean;
  code: string;
  durinCalled: boolean;
  durinRequestsBefore: number;
  durinRequestsAfter: number;
}

export class VisitorDemoSession {
  readonly id = `vd_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  readonly clock: DemoClock;
  readonly store: TourCoreStore;
  readonly durin: CountingDurin;
  readonly core: TourCore;
  readonly startedAt: Date;
  visitor?: { name: string; phone: string };
  prospectId?: string;
  reservationId?: string;
  lastAccess?: LastAccess;
  readonly durinLines: string[] = [];
  private readonly thread: ConversationItem[] = [];
  private readonly shown = new Set<string>();

  constructor(
    readonly propertyId: string,
    readonly config: TourCoreConfig,
    readonly tourId: string,
    options: { realNow?: () => number } = {},
  ) {
    this.clock = new DemoClock(options.realNow);
    this.startedAt = this.clock.now();
    this.store = createStore(config);
    this.durin = countDurinCalls(createDurin(config, this.clock, (line) => this.durinLines.push(line.trim())));
    // Replies are stored by Tour Core through its normal messaging contract; the phone view reads them from the store.
    const phone: Messenger = { channel: "visitor-demo", send: async () => {} };
    this.core = new TourCore({ config, clock: this.clock, store: this.store, messenger: phone, durin: this.durin, verification: createVerificationProvider(config) });
  }

  get conversation(): readonly ConversationItem[] {
    return this.thread;
  }

  async reservation(): Promise<Reservation | undefined> {
    return this.reservationId ? this.store.get("reservations", this.reservationId) : undefined;
  }

  async stage(): Promise<VisitorStage> {
    if (!this.visitor) return "intro";
    const r = await this.reservation();
    if (!r) return "choose-unit";
    switch (r.status) {
      case "INQUIRY":
        return "choose-time";
      case "RESERVED":
      case "AWAITING_CONSENT":
        return "consent";
      case "AWAITING_VERIFICATION":
        return "identity";
      case "READY":
        return "ready";
      case "TOURING":
        return "touring";
      case "COMPLETED":
        return (await this.store.listAudit()).some((e) => e.type === "FOLLOW_UP_RESPONSE") ? "done" : "follow-up";
      default:
        return "stopped";
    }
  }

  /** Doors on the reserved route that haven't been opened yet, in order. */
  async remainingStops(): Promise<string[]> {
    const r = await this.reservation();
    if (!r) return [];
    const opened = new Set((await this.core.listGrants(r.id)).map((g) => g.doorId));
    return r.allowedRoute.filter((d) => !opened.has(d));
  }

  offRouteDoor(r: Reservation): string | undefined {
    return this.config.doors.find((d) => !r.allowedRoute.includes(d.id))?.id;
  }

  async act(action: string, input: unknown): Promise<void> {
    const schema = (ACTIONS as Record<string, z.ZodType>)[action];
    if (!schema) throw new SetupInputError("UNKNOWN_ACTION", "That isn't something I can do.");
    const parsed = schema.safeParse(input ?? {});
    if (!parsed.success) throw new SetupInputError("INPUT_INVALID", "Some of that information is missing.");
    const stage = await this.stage();
    if (!ALLOWED[stage].includes(action as VisitorAction)) throw new SetupInputError("NOT_AVAILABLE", "That isn't available right now.");
    await this.run(action as VisitorAction, parsed.data as Record<string, unknown>);
    await this.syncReplies();
  }

  private async run(action: VisitorAction, input: Record<string, unknown>): Promise<void> {
    const r = await this.reservation();
    const doorName = (id: string) => this.config.doors.find((d) => d.id === id)?.name ?? "a door";
    switch (action) {
      case "begin": {
        const name = String(input.name ?? "").trim();
        const phone = normalizePhone(String(input.phone ?? ""));
        if (!name) throw new SetupInputError("NAME_MISSING", "Please enter a name.");
        if (phone.replace(/\D/g, "").length < 10) throw new SetupInputError("PHONE_INVALID", "Please enter a full phone number.");
        this.visitor = { name, phone };
        this.say("tourcore", `Hi! I'm the self-tour assistant for ${this.config.property.name}. I can help you tour on your own. What would you like to see?`);
        return;
      }
      case "chooseUnit": {
        const unit = this.config.units.find((u) => u.id === input.unitId);
        if (!unit) throw new SetupInputError("UNIT_NOT_FOUND", "That unit isn't available.");
        this.say("visitor", `I'd like to see ${unit.name}.`);
        const { prospect, reservation } = await this.core.startInquiry({ ...this.visitor!, unitId: unit.id });
        this.prospectId = prospect.id;
        this.reservationId = reservation.id;
        await this.core.recordInbound(prospect.id, reservation.id, `I'd like to see ${unit.name}.`);
        return;
      }
      case "chooseTime": {
        const start = new Date(String(input.slotStart));
        const label = Number.isNaN(start.getTime()) ? String(input.slotStart) : formatTime(start, this.config.property.timezone);
        this.say("visitor", `${label} works for me.`);
        await this.inbound(`${label} works for me.`);
        await this.core.reserveSlot(r!.id, String(input.slotStart));
        return;
      }
      case "consent": {
        const text = input.agree ? "Yes, that's OK." : "No thanks.";
        this.say("visitor", text);
        await this.inbound(text);
        await this.core.recordConsent(r!.id, !!input.agree);
        return;
      }
      case "submitIdentity": {
        this.say("visitor", `Sent my details: ${input.firstName} ${input.lastName}, ${input.email}, ${input.phone}`);
        await this.inbound("Submitted the identity form.");
        await this.core.submitVerification(r!.id, {
          responseId: `visitor_form_${this.id}`,
          submittedAt: this.clock.now().toISOString(),
          answers: {
            governmentFirstName: String(input.firstName),
            governmentLastName: String(input.lastName),
            email: String(input.email),
            phone: String(input.phone),
          },
        });
        return;
      }
      case "arrive":
        this.say("visitor", "I'm here.");
        await this.inbound("I'm here.");
        await this.requestDoor(r!.allowedRoute[0]!);
        return;
      case "atStop": {
        if (!r!.allowedRoute.includes(String(input.doorId))) throw new SetupInputError("NOT_ON_ROUTE", "That door isn't on your tour.");
        const text = `I'm at ${this.stopLabel(String(input.doorId))}.`;
        this.say("visitor", text);
        await this.inbound(text);
        await this.requestDoor(String(input.doorId));
        return;
      }
      case "ask":
        this.say("visitor", String(input.question).trim());
        await this.core.answerQuestion(r!.id, String(input.question));
        return;
      case "help": {
        this.say("visitor", "I need help.");
        const last = (await this.core.listGrants(r!.id)).at(-1);
        await this.core.requestHelp(r!.id, last ? doorName(last.doorId) : undefined);
        return;
      }
      case "finish":
        this.say("visitor", "I'm done with the tour.");
        await this.inbound("I'm done with the tour.");
        await this.core.completeTour(r!.id);
        return;
      case "followUp":
        this.say("visitor", input.wantsContact ? "Yes, please." : "No, thanks.");
        await this.core.recordFollowUpResponse(r!.id, !!input.wantsContact);
        return;
      case "demoSkipAhead": {
        const windowStart = Date.parse(r!.windowStart!);
        const slot = Date.parse(r!.slotStart!);
        if (this.clock.now().getTime() >= windowStart) throw new SetupInputError("ALREADY_OPEN", "Your tour time has already started.");
        this.clock.jumpTo(new Date(Math.max(windowStart, slot - 2 * 60_000)));
        this.say("demo", `Demo: the clock skipped ahead to ${formatTime(this.clock.now(), this.config.property.timezone)}, just before the tour.`);
        return;
      }
      case "demoWrongDoor": {
        const wrong = this.offRouteDoor(r!) ?? "demo_door_not_on_file";
        this.say("visitor", `I'm at ${doorName(wrong)}.`);
        await this.inbound(`I'm at ${doorName(wrong)}.`);
        const access = await this.requestDoor(wrong);
        await this.syncReplies();
        this.say(
          "demo",
          !access.decision.allowed && !access.durinCalled
            ? "Demo safety check: Tour Core refused this door and never contacted Durin."
            : "Demo safety check FAILED: this door should not have opened.",
        );
        return;
      }
    }
  }

  private async requestDoor(doorId: string): Promise<AccessOutcome> {
    const before = this.durin.requestCount;
    const outcome = await this.core.requestAccess({ reservationId: this.reservationId!, prospectId: this.prospectId!, doorId });
    this.lastAccess = {
      doorId,
      allowed: outcome.decision.allowed,
      code: outcome.decision.code,
      durinCalled: outcome.durinCalled,
      durinRequestsBefore: before,
      durinRequestsAfter: this.durin.requestCount,
    };
    return outcome;
  }

  stopLabel(doorId: string): string {
    const unit = this.config.units.find((u) => u.doorId === doorId);
    const door = this.config.doors.find((d) => d.id === doorId);
    if (unit) return unit.name;
    return door?.kind === "ENTRANCE" ? "the entrance" : door?.name ?? "a door";
  }

  private async inbound(text: string): Promise<void> {
    if (this.prospectId) await this.core.recordInbound(this.prospectId, this.reservationId, text);
  }

  private say(from: ConversationItem["from"], text: string): void {
    this.thread.push({ from, text, at: this.clock.now().toISOString() });
  }

  /** Appends Tour Core's new texts to the visitor (read from the store, in order). */
  private async syncReplies(): Promise<void> {
    for (const m of await this.store.list("messages")) {
      if (this.shown.has(m.id)) continue;
      this.shown.add(m.id);
      if (m.audience === "PROSPECT" && m.direction === "OUTBOUND") this.thread.push({ from: "tourcore", text: m.body, at: m.at });
    }
  }

  async record(): Promise<{ record: TourRecord; bundle: ExportBundle }> {
    const stage = await this.stage();
    const r = await this.reservation();
    const record: TourRecord = {
      schemaVersion: 1,
      tourId: this.tourId,
      kind: "visitor-demo",
      ranAt: this.startedAt.toISOString(),
      updatedAt: this.clock.now().toISOString(),
      outcome: stage === "done" || stage === "follow-up" ? "finished" : stage === "stopped" ? "stopped" : "in-progress",
      ...(r ? { unitId: r.unitId } : {}),
      ...(this.visitor ? { visitorName: this.visitor.name } : {}),
      conversation: [...this.thread],
    };
    return { record, bundle: await this.core.exportRecords() };
  }
}

/** Live visitor demos for this server process. Records are saved after every step. */
export class VisitorDemoRegistry {
  private readonly sessions = new Map<string, VisitorDemoSession>();

  add(session: VisitorDemoSession): VisitorDemoSession {
    this.sessions.set(session.id, session);
    return session;
  }

  get(id: string): VisitorDemoSession {
    const session = this.sessions.get(id);
    if (!session) throw new SetupInputError("DEMO_NOT_FOUND", "This visitor demo has ended. Start a new one from the property page.");
    return session;
  }

  /** The most recent unfinished demo for a property, if any. */
  async activeFor(propertyId: string): Promise<VisitorDemoSession | undefined> {
    const mine = [...this.sessions.values()].filter((s) => s.propertyId === propertyId).reverse();
    for (const s of mine) {
      const stage = await s.stage();
      if (stage !== "done" && stage !== "stopped") return s;
    }
    return undefined;
  }
}
