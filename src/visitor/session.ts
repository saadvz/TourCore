import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { TourCoreConfig } from "../config/tourCoreConfig";
import { DemoClock } from "../core/clock";
import { normalizePhone } from "../core/phone";
import { formatTime } from "../core/timezone";
import { TourCore, type AccessOutcome, type InboundMeta } from "../core/TourCore";
import type { TourSlot } from "../core/schedule";
import { createDurin, createStore, createVerificationProvider } from "../createTourCore";
import { UNNAMED_VISITOR, type Reservation } from "../domain/model";
import { countDurinCalls, type CountingDurin } from "../durin/countingDurin";
import type { DeliveryReceipt, MessagingAdapter, OutgoingMessage } from "../messaging/Messenger";
import type { ReplyPrompt } from "../messaging/presentation";
import { SetupInputError } from "../setup/setupActions";
import type { ConversationItem, TourRecord } from "../setup/workspace";
import type { ExportBundle } from "../export/exportBundle";
import type { TourCoreStore } from "../storage/Store";
import type { VerificationLinks } from "./verificationLinks";

/**
 * One visitor conversation driving the real Tour Core engine. The same
 * session serves the browser phone (buttons) and a real phone over a
 * messaging provider (typed replies): only the transport passed in differs.
 * Every reply, decision and denial comes from Tour Core itself.
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

/** The browser phone: nothing to deliver, the page reads the thread. Replies are phrased for buttons. */
export class WebVisitorTransport implements MessagingAdapter {
  readonly provider = "web-demo";
  readonly presentation = "WEB" as const;
  async send(_message: OutgoingMessage): Promise<DeliveryReceipt> {
    return { provider: this.provider, channel: "WEB", status: "SENT", sentAt: new Date().toISOString() };
  }
}

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

export interface VisitorSessionOptions {
  realNow?: () => number;
  /** How messages reach the visitor. Defaults to the browser phone. */
  transport?: MessagingAdapter;
  /** "messaging" for a real phone; "visitor-demo" for the browser simulator. */
  kind?: TourRecord["kind"];
  /** Personal identity-form links for visitors on a messaging channel. */
  verificationLinks?: VerificationLinks;
  /** Kept when a conversation is restored from its saved records. */
  id?: string;
  startedAt?: Date;
}

/** Optional details about the visitor's own message that triggered an action. */
export interface Said {
  /** What the visitor actually typed or tapped. */
  text?: string;
  meta?: InboundMeta;
}

export class VisitorDemoSession {
  readonly id: string;
  readonly clock: DemoClock;
  readonly store: TourCoreStore;
  readonly durin: CountingDurin;
  readonly core: TourCore;
  readonly transport: MessagingAdapter;
  readonly kind: TourRecord["kind"];
  readonly startedAt: Date;
  visitor?: { name: string; phone: string };
  prospectId?: string;
  reservationId?: string;
  lastAccess?: LastAccess;
  /** Times offered at inquiry; typed replies ("2") and buttons both pick from this list. */
  offeredSlots: TourSlot[] = [];
  optedOut = false;
  readonly durinLines: string[] = [];
  private readonly thread: ConversationItem[] = [];
  private readonly shown = new Set<string>();
  private readonly links?: VerificationLinks;

  constructor(
    readonly propertyId: string,
    readonly config: TourCoreConfig,
    readonly tourId: string,
    options: VisitorSessionOptions = {},
  ) {
    this.id = options.id ?? `vd_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    this.clock = new DemoClock(options.realNow);
    this.startedAt = options.startedAt ?? this.clock.now();
    this.store = createStore(config);
    this.transport = options.transport ?? new WebVisitorTransport();
    this.kind = options.kind ?? "visitor-demo";
    this.durin = countDurinCalls(createDurin(config, this.clock, (line) => this.durinLines.push(line.trim())));
    const links = options.verificationLinks;
    this.links = links;
    this.core = new TourCore({
      config,
      clock: this.clock,
      store: this.store,
      messenger: this.transport,
      durin: this.durin,
      verification: createVerificationProvider(config),
      correlationId: this.id,
      ...(links ? { verificationLink: ({ reservation, prospect }) => links.issue({ sessionId: this.id, reservationId: reservation.id, phone: prospect.phone }) } : {}),
    });
  }

  get conversation(): readonly ConversationItem[] {
    return this.thread;
  }

  get presentation() {
    return this.transport.presentation;
  }

  async reservation(): Promise<Reservation | undefined> {
    return this.reservationId ? this.store.get("reservations", this.reservationId) : undefined;
  }

  /** Current name: the visitor's own words, or the legal name from their form once they've filled it in. */
  async visitorName(): Promise<string | undefined> {
    const prospect = this.prospectId ? await this.store.get("prospects", this.prospectId) : undefined;
    const name = prospect?.name ?? this.visitor?.name;
    return name === UNNAMED_VISITOR ? undefined : name;
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

  stopLabel(doorId: string): string {
    return this.core.stopName(doorId);
  }

  /** Runs one visitor action. `said` carries the visitor's real words and provider details when they typed them. */
  async act(action: string, input: unknown, said: Said = {}): Promise<void> {
    const schema = (ACTIONS as Record<string, z.ZodType>)[action];
    if (!schema) throw new SetupInputError("UNKNOWN_ACTION", "That isn't something I can do.");
    const parsed = schema.safeParse(input ?? {});
    if (!parsed.success) throw new SetupInputError("INPUT_INVALID", "Some of that information is missing.");
    const stage = await this.stage();
    if (!ALLOWED[stage].includes(action as VisitorAction)) throw new SetupInputError("NOT_AVAILABLE", "That isn't available right now.");
    await this.run(action as VisitorAction, parsed.data as Record<string, unknown>, said);
    await this.syncReplies();
  }

  // ------------------------------------------- messaging-channel entry points

  /** A visitor on a real phone is known by their number; their name comes later from the identity form. */
  identify(phone: string): void {
    if (!this.visitor) this.visitor = { name: UNNAMED_VISITOR, phone: normalizePhone(phone) };
  }

  /** The first message from a phone ("Hi"): record it and send the welcome. */
  async greet(said: Said): Promise<void> {
    await this.recordText(said);
    await this.welcome();
  }

  /** Stores something the visitor sent that didn't trigger an action (so history is complete). */
  async recordText(said: Said): Promise<void> {
    if (!said.text) return;
    this.say("visitor", said.text);
    await this.core.recordIncoming({ phone: this.visitor?.phone ?? "", body: said.text, prospectId: this.prospectId, reservationId: this.reservationId, meta: said.meta });
  }

  /** A Tour Core message that isn't part of a tour step (welcome, "didn't catch that", help info). */
  async reply(body: string, prompt?: ReplyPrompt): Promise<void> {
    await this.core.sendConversationText({ phone: this.visitor?.phone ?? "", body, prompt, reservationId: this.reservationId });
    await this.syncReplies();
  }

  async optOut(said: Said): Promise<void> {
    await this.recordText(said);
    this.optedOut = true;
    await this.core.optOutOfMessaging(this.visitor?.phone ?? "", (said.text ?? "STOP").trim());
    await this.syncReplies();
  }

  async optIn(said: Said): Promise<void> {
    await this.recordText(said);
    this.optedOut = false;
    await this.core.optInToMessaging(this.visitor?.phone ?? "");
    await this.reply(`You'll get messages from ${this.config.property.name} again. Text HI any time to start a tour.`);
  }

  /** HELP: who this is and how to reach the property team; during a tour, the team is also alerted. */
  async help(said: Said): Promise<void> {
    const stage = await this.stage();
    const contact = /[@\d]{3,}/.test(this.config.operator.contact) ? ` at ${this.config.operator.contact}` : "";
    const info = `This is the self-tour assistant for ${this.config.property.name}. For help, contact the ${this.config.operator.name.toLowerCase()}${contact}. Reply STOP to stop messages.`;
    if ((stage === "ready" || stage === "touring" || stage === "stopped") && this.reservationId) {
      this.say("visitor", said.text ?? "HELP");
      await this.core.requestHelp(this.reservationId, await this.currentPlace(), { text: said.text ?? "HELP", meta: said.meta });
      await this.syncReplies();
    } else {
      await this.recordText(said);
    }
    await this.reply(info);
  }

  /** Sends a fresh identity-form link (the earlier one stops working). */
  async resendVerificationLink(said: Said): Promise<void> {
    await this.recordText(said);
    const link =
      this.reservationId && this.visitor ? this.links?.issue({ sessionId: this.id, reservationId: this.reservationId, phone: this.visitor.phone }) : undefined;
    await this.reply("Here's your identity form link again. The earlier link no longer works.", { kind: "form", link });
  }

  // ------------------------------------------------------- operator changes

  /** Tour times the operator can move this visitor's tour to. */
  async rescheduleOptions(): Promise<TourSlot[]> {
    return this.reservationId ? this.core.rescheduleOptions(this.reservationId) : [];
  }

  /** Operator action: move the tour. The visitor is told through this conversation's own transport. */
  async reschedule(newStartsAt: string, options: { outsideTourHours?: boolean } = {}): Promise<{ changed: boolean }> {
    if (!this.reservationId) throw new SetupInputError("NO_TOUR", "This visitor hasn't booked a tour yet.");
    const { changed } = await this.core.rescheduleReservation({ reservationId: this.reservationId, newStartsAt, ...options });
    await this.syncReplies();
    return { changed };
  }

  /** Developer mode only: the tour starts this minute, even outside tour hours. The clock is not touched. */
  async moveTourToNow(): Promise<{ changed: boolean }> {
    const start = new Date(Math.floor(this.clock.now().getTime() / 60_000) * 60_000);
    return this.reschedule(start.toISOString(), { outsideTourHours: true });
  }

  /** Rebuilds a conversation from its saved records (used after the server restarts). */
  async hydrate(record: TourRecord, bundle: ExportBundle): Promise<void> {
    for (const p of bundle.prospects) await this.store.put("prospects", p);
    for (const r of bundle.reservations) await this.store.put("reservations", r);
    for (const c of bundle.consents) await this.store.put("consents", c);
    for (const v of bundle.verifications) await this.store.put("verifications", v);
    for (const g of bundle.accessGrants) await this.store.put("accessGrants", g);
    for (const m of bundle.messages) {
      await this.store.put("messages", m);
      this.shown.add(m.id);
    }
    for (const e of bundle.auditEvents) await this.store.appendAudit(e);
    this.thread.push(...(record.conversation ?? []));
    const prospect = bundle.prospects[0];
    const phone = prospect?.phone ?? record.visitorPhone;
    if (phone) this.visitor = { name: prospect?.name ?? UNNAMED_VISITOR, phone };
    this.prospectId = prospect?.id;
    this.reservationId = bundle.reservations.at(-1)?.id;
    this.optedOut = !!prospect?.messagingOptedOut;
  }

  // ------------------------------------------------------------------ actions

  private async run(action: VisitorAction, input: Record<string, unknown>, said: Said): Promise<void> {
    const r = await this.reservation();
    const doorName = (id: string) => this.config.doors.find((d) => d.id === id)?.name ?? "a door";
    const visitorSays = async (fallback: string) => {
      const text = said.text ?? fallback;
      this.say("visitor", text);
      await this.inbound(text, said.meta);
    };
    switch (action) {
      case "begin": {
        const name = String(input.name ?? "").trim();
        const phone = normalizePhone(String(input.phone ?? ""));
        if (!name) throw new SetupInputError("NAME_MISSING", "Please enter a name.");
        if (phone.replace(/\D/g, "").length < 10) throw new SetupInputError("PHONE_INVALID", "Please enter a full phone number.");
        this.visitor = { name, phone };
        await this.welcome();
        return;
      }
      case "chooseUnit": {
        const unit = this.config.units.find((u) => u.id === input.unitId);
        if (!unit) throw new SetupInputError("UNIT_NOT_FOUND", "That unit isn't available.");
        const text = said.text ?? `I'd like to see ${unit.name}.`;
        this.say("visitor", text);
        const { prospect, reservation } = await this.core.startInquiry({ ...this.visitor!, unitId: unit.id });
        this.prospectId = prospect.id;
        this.reservationId = reservation.id;
        this.offeredSlots = await this.core.availableSlots();
        await this.core.recordInbound(prospect.id, reservation.id, text, said.meta);
        return;
      }
      case "chooseTime": {
        const start = new Date(String(input.slotStart));
        const label = Number.isNaN(start.getTime()) ? String(input.slotStart) : formatTime(start, this.config.property.timezone);
        await visitorSays(`${label} works for me.`);
        await this.core.reserveSlot(r!.id, String(input.slotStart));
        return;
      }
      case "consent":
        await visitorSays(input.agree ? "Yes, that's OK." : "No thanks.");
        await this.core.recordConsent(r!.id, !!input.agree);
        return;
      case "submitIdentity": {
        this.say("visitor", said.text ?? `Sent my details: ${input.firstName} ${input.lastName}, ${input.email}, ${input.phone}`);
        await this.inbound("Submitted the identity form.", said.meta);
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
        await visitorSays("I'm here.");
        await this.requestDoor(r!.allowedRoute[0]!);
        return;
      case "atStop": {
        // Any door on file may be asked for; Tour Core's policy decides. Doors off the route are refused before Durin.
        if (!this.config.doors.some((d) => d.id === input.doorId)) throw new SetupInputError("DOOR_NOT_FOUND", "I don't know that door.");
        await visitorSays(`I'm at ${this.stopLabel(String(input.doorId))}.`);
        await this.requestDoor(String(input.doorId));
        return;
      }
      case "ask":
        this.say("visitor", said.text ?? String(input.question).trim());
        await this.core.answerQuestion(r!.id, String(input.question), said.meta);
        return;
      case "help":
        this.say("visitor", said.text ?? "I need help.");
        await this.core.requestHelp(r!.id, await this.currentPlace(), { text: said.text ?? "I need help", meta: said.meta });
        return;
      case "finish":
        await visitorSays("I'm done with the tour.");
        await this.core.completeTour(r!.id);
        return;
      case "followUp":
        this.say("visitor", said.text ?? (input.wantsContact ? "Yes, please." : "No, thanks."));
        await this.core.recordFollowUpResponse(r!.id, !!input.wantsContact, { text: said.text ?? (input.wantsContact ? "Yes" : "No"), meta: said.meta });
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
        await visitorSays(`I'm at ${doorName(wrong)}.`);
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

  private async welcome(): Promise<void> {
    await this.reply(`Hi! I'm the self-tour assistant for ${this.config.property.name}. I can help you tour on your own. Which unit would you like to see?`, {
      kind: "choose",
      options: this.config.units.map((u) => u.name),
      what: "a unit",
    });
  }

  private async currentPlace(): Promise<string | undefined> {
    const last = this.reservationId ? (await this.core.listGrants(this.reservationId)).at(-1) : undefined;
    return last ? this.config.doors.find((d) => d.id === last.doorId)?.name : undefined;
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

  private async inbound(text: string, meta?: InboundMeta): Promise<void> {
    if (this.prospectId) await this.core.recordInbound(this.prospectId, this.reservationId, text, meta);
  }

  private say(from: ConversationItem["from"], text: string): void {
    this.thread.push({ from, text, at: this.clock.now().toISOString() });
  }

  /** Appends Tour Core's new messages to the visitor thread (read from the store, in order), with delivery details. */
  private async syncReplies(): Promise<void> {
    for (const m of await this.store.list("messages")) {
      if (m.audience !== "PROSPECT" || m.direction !== "OUTBOUND") continue;
      const existing = this.thread.find((t) => t.messageId === m.id);
      const delivery = { provider: m.provider, channel: m.deliveryChannel, status: m.deliveryStatus, providerMessageId: m.providerMessageId };
      if (existing) {
        existing.delivery = delivery;
        continue;
      }
      if (this.shown.has(m.id)) continue;
      this.shown.add(m.id);
      this.thread.push({ from: "tourcore", text: m.body, at: m.at, messageId: m.id, delivery });
    }
  }

  async record(): Promise<{ record: TourRecord; bundle: ExportBundle }> {
    const stage = await this.stage();
    const r = await this.reservation();
    const name = await this.visitorName();
    const record: TourRecord = {
      schemaVersion: 1,
      tourId: this.tourId,
      kind: this.kind,
      ranAt: this.startedAt.toISOString(),
      updatedAt: this.clock.now().toISOString(),
      outcome: stage === "done" || stage === "follow-up" ? "finished" : stage === "stopped" ? "stopped" : "in-progress",
      ...(r ? { unitId: r.unitId } : {}),
      ...(name ? { visitorName: name } : {}),
      ...(this.visitor ? { visitorPhone: this.visitor.phone } : {}),
      conversation: [...this.thread],
    };
    return { record, bundle: await this.core.exportRecords() };
  }
}

/** Live visitor conversations for this server process. Records are saved after every step. */
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

  find(id: string): VisitorDemoSession | undefined {
    return this.sessions.get(id);
  }

  /** The most recent conversation with this phone at this property, finished or not. */
  latestForPhone(propertyId: string, phone: string, kind?: TourRecord["kind"]): VisitorDemoSession | undefined {
    const e164 = normalizePhone(phone);
    return [...this.sessions.values()].reverse().find((s) => s.propertyId === propertyId && s.visitor?.phone === e164 && (!kind || s.kind === kind));
  }

  /** The most recent unfinished conversation for a property, if any. */
  async activeFor(propertyId: string): Promise<VisitorDemoSession | undefined> {
    const mine = [...this.sessions.values()].filter((s) => s.propertyId === propertyId).reverse();
    for (const s of mine) {
      const stage = await s.stage();
      if (stage !== "done" && stage !== "stopped") return s;
    }
    return undefined;
  }
}