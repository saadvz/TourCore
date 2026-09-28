import { describeHistory } from "../audit/describe";
import { formatDay, formatTime } from "../core/timezone";
import type { ReservationStatus } from "../domain/model";
import { VISITOR_DEFAULTS, type VisitorDemoSession } from "./session";

/**
 * View models for the visitor phone and the operator's live panel. Both read
 * the same session; neither adds behavior. Technical details sit under `dev`.
 */

interface Choice {
  label: string;
  action: string;
  input?: Record<string, unknown>;
  hint?: string;
  tone?: "primary" | "quiet";
}

const EXAMPLE_QUESTIONS = ["How many bedrooms is this?", "Is there parking?", "What's included?"];

export async function visitorView(session: VisitorDemoSession) {
  const { config } = session;
  const tz = config.property.timezone;
  const stage = await session.stage();
  const r = await session.reservation();
  const choices: Choice[] = [];
  let input: { kind: "intro" | "choices" | "identity" | "none"; prefill?: Record<string, string> } = { kind: "choices" };
  const demoControls: Choice[] = [];

  switch (stage) {
    case "intro":
      input = { kind: "intro", prefill: { ...VISITOR_DEFAULTS } };
      break;
    case "choose-unit":
      for (const u of config.units) choices.push({ label: u.name, action: "chooseUnit", input: { unitId: u.id }, hint: u.summary || undefined });
      break;
    case "choose-time":
      for (const slot of session.offeredSlots) {
        choices.push({ label: `${formatDay(slot.start, tz)} \u00b7 ${slot.label}`, action: "chooseTime", input: { slotStart: slot.start.toISOString() } });
      }
      break;
    case "consent":
      choices.push({ label: "Yes, that's OK", action: "consent", input: { agree: true }, tone: "primary" }, { label: "No thanks", action: "consent", input: { agree: false } });
      break;
    case "identity": {
      const [firstName = "", ...rest] = (session.visitor?.name ?? "").split(/\s+/);
      input = {
        kind: "identity",
        prefill: { firstName, lastName: rest.join(" "), email: `${firstName.toLowerCase() || "visitor"}@example.com`, phone: session.visitor?.phone ?? "" },
      };
      break;
    }
    case "ready":
      choices.push({ label: "I'm here", action: "arrive", tone: "primary" }, { label: "I need help", action: "help", tone: "quiet" });
      if (r && session.clock.now().getTime() < Date.parse(r.windowStart!)) {
        demoControls.push({ label: "Skip ahead to my tour time", action: "demoSkipAhead", hint: "Moves the demo clock forward so you don't have to wait." });
      }
      break;
    case "touring": {
      const next = (await session.remainingStops())[0];
      if (next) choices.push({ label: `I'm at ${session.stopLabel(next)}`, action: "atStop", input: { doorId: next }, tone: "primary" });
      choices.push({ label: "Finish tour", action: "finish", tone: next ? "quiet" : "primary" }, { label: "I need help", action: "help", tone: "quiet" });
      break;
    }
    case "follow-up":
      choices.push({ label: "Yes", action: "followUp", input: { wantsContact: true }, tone: "primary" }, { label: "No", action: "followUp", input: { wantsContact: false } });
      break;
    case "done":
    case "stopped":
      input = { kind: "none" };
      break;
  }
  if ((stage === "ready" || stage === "touring") && r && session.offRouteDoor(r)) {
    demoControls.push({ label: "Test wrong door", action: "demoWrongDoor", hint: `Tries ${config.doors.find((d) => d.id === session.offRouteDoor(r))?.name}, which isn't on this tour.` });
  }

  return {
    sessionId: session.id,
    property: { name: config.property.name },
    visitorName: session.visitor?.name,
    stage,
    finished: stage === "done" || stage === "stopped",
    thread: session.conversation.map((m, i) => ({ id: i, from: m.from, text: m.text, time: formatTime(new Date(m.at), tz) })),
    input,
    choices,
    canAsk: stage === "ready" || stage === "touring",
    exampleQuestions: EXAMPLE_QUESTIONS,
    demoControls,
    dev: {
      reservationId: r?.id,
      reservationStatus: r?.status,
      lastAccess: session.lastAccess,
      durinRequests: session.durin.requestCount,
      durinLines: session.durinLines.slice(-5),
      demoClock: session.clock.now().toISOString(),
    },
  };
}

const CHANNEL_LABELS: Record<string, string | undefined> = { IMESSAGE: "iMessage", SMS: "SMS", RCS: "RCS", WEB: undefined, DEMO: undefined, UNKNOWN: undefined };

const STATUS_LABELS: Record<ReservationStatus, string> = {
  INQUIRY: "Choosing a time",
  RESERVED: "Booked",
  AWAITING_CONSENT: "Waiting for consent",
  AWAITING_VERIFICATION: "Checking identity",
  READY: "Ready, waiting for arrival",
  TOURING: "Touring",
  COMPLETED: "Finished",
  CANCELLED: "Cancelled",
  VERIFICATION_FAILED: "Identity check didn't pass",
  EXPIRED: "Tour time ended",
  REVOKED: "Called off",
  OPERATOR_HOLD: "Paused",
  PROVIDER_FAILURE: "Door system problem",
};

/** What the operator watches while a visitor demo runs. */
export async function liveTourView(session: VisitorDemoSession) {
  const { config } = session;
  const tz = config.property.timezone;
  const r = await session.reservation();
  const stage = await session.stage();
  const audit = await session.store.listAudit();
  const context = {
    doors: config.doors,
    units: config.units,
    prospects: await session.store.list("prospects"),
    reservations: await session.store.list("reservations"),
    operatorName: config.operator.name,
  };
  const history = describeHistory(audit, context, tz);
  const unit = config.units.find((u) => u.id === r?.unitId);
  const grants = r ? await session.core.listGrants(r.id) : [];
  const lastDoor = grants.at(-1)?.doorId;
  const next = (await session.remainingStops())[0];

  let currentStep = "Looking at the property";
  if (r?.status === "TOURING") currentStep = lastDoor ? `At ${session.stopLabel(lastDoor)}${next ? `, next: ${session.stopLabel(next)}` : ""}` : "Arriving";
  else if (r?.status === "READY") currentStep = "Not arrived yet";
  else if (r?.status === "COMPLETED") currentStep = "Left the property";
  else if (r) currentStep = STATUS_LABELS[r.status];

  const followUp = audit.find((e) => e.type === "FOLLOW_UP_RESPONSE");
  const messages = await session.store.list("messages");
  const lastInbound = [...messages].reverse().find((m) => m.direction === "INBOUND" && m.deliveryChannel);
  const failed = messages.filter((m) => m.audience === "PROSPECT" && m.deliveryStatus === "FAILED").length;
  const name = await session.visitorName();
  return {
    sessionId: session.id,
    tourId: session.tourId,
    active: stage !== "done" && stage !== "stopped",
    /** A booked tour the operator can move ("Change tour time"). */
    canReschedule: !!r?.slotStart && ["AWAITING_CONSENT", "AWAITING_VERIFICATION", "READY", "TOURING"].includes(r.status),
    source: session.kind === "messaging" ? "Real phone" : "Visitor demo",
    visitorName: name ?? (session.visitor ? "A visitor (name not given yet)" : "A visitor (not started yet)"),
    visitorPhone: session.kind === "messaging" ? session.visitor?.phone : undefined,
    channel: lastInbound ? CHANNEL_LABELS[lastInbound.deliveryChannel!] : undefined,
    optedOut: session.optedOut,
    messageProblems: failed ? `${failed === 1 ? "1 message" : `${failed} messages`} couldn't be delivered to the visitor.` : undefined,
    recentMessages: session.conversation
      .slice(-6)
      .map((m) => ({ from: m.from, text: m.text, time: formatTime(new Date(m.at), tz), ...(m.interpretation ? { dev: { interpretation: m.interpretation } } : {}) })),
    unitName: unit?.name,
    tourTime: r?.slotStart
      ? `${formatDay(new Date(r.slotStart), tz)}, ${formatTime(new Date(r.slotStart), tz)}\u2013${formatTime(new Date(r.windowEnd!), tz)}`
      : undefined,
    status: r ? STATUS_LABELS[r.status] : session.visitor ? "Browsing" : "Waiting for the visitor to start",
    currentStep,
    recent: history.slice(-12),
    questions: history.filter((e) => e.dev.type === "QUESTION_UNANSWERED" || e.dev.type === "HELP_REQUESTED"),
    followUp: followUp ? (followUp.detail === "yes" ? "Wants someone to follow up" : "No follow-up needed") : undefined,
    demoClock: formatTime(session.clock.now(), tz),
    dev: {
      reservationId: r?.id,
      reservationStatus: r?.status,
      durinRequests: session.durin.requestCount,
      durinRevokes: session.durin.revokeCount,
      lastAccess: session.lastAccess,
    },
  };
}
