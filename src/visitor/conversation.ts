import type { InboundMeta } from "../core/TourCore";
import type { VisitorDemoSession } from "./session";

/**
 * Typed replies from a real phone ("1", "YES", "at unit 101", "how many
 * bedrooms?") mapped onto the same visitor actions the browser phone's
 * buttons use. Deterministic keyword matching; no provider knowledge and no
 * LLM. Anything it can't place gets a short "didn't catch that" with the
 * options for the current step.
 */

export type Keyword = "stop" | "start" | "help";

const STOP_WORDS = new Set(["stop", "stopall", "unsubscribe", "cancel", "end", "quit", "opt out", "optout"]);
const START_WORDS = new Set(["start", "unstop", "subscribe"]);
const HELP_WORDS = new Set(["help", "info"]);

export function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[.!,;:]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Messaging-service keywords. Only whole-message matches count ("stop" yes, "don't stop" no). */
export function keywordOf(text: string): Keyword | undefined {
  const t = normalizeText(text);
  if (STOP_WORDS.has(t)) return "stop";
  if (START_WORDS.has(t)) return "start";
  if (HELP_WORDS.has(t)) return "help";
  return undefined;
}

const YES = /^(y|yes|yeah|yea|yep|yup|sure|ok|okay|agree|i agree|yes please|sounds good|👍)$/;
const NO = /^(n|no|nope|nah|no thanks|no thank you)$/;
const ARRIVED = /^(i'?m here|im here|i am here|here|arrived|i'?ve arrived|i have arrived|at the (entrance|door|building|lobby)|i'?m at the (entrance|door|building|lobby)|outside)$/;
const FINISHED = /^(finish|finished|done|i'?m done|im done|all done|end tour|finish tour|i'?m finished|leaving)$/;
const QUESTION = /\?$|^(how|what|what'?s|whats|is|are|does|do|can|could|where|when|which|who|any|tell me|will)\b/;

export const isGreeting = (text: string) => /^(hi|hello|hey|hiya|tour|book|start over|new tour|hi there|good (morning|afternoon|evening))\b/.test(normalizeText(text));

function pickNumber(t: string, count: number): number | undefined {
  const m = t.match(/^#?(\d{1,2})$/);
  const n = m ? Number(m[1]) : NaN;
  return Number.isInteger(n) && n >= 1 && n <= count ? n - 1 : undefined;
}

/** "9", "9am", "9:00", "10:30 am" -> index into the offered time labels ("9:00 AM", ...). */
function pickTime(t: string, labels: string[]): number | undefined {
  const m = t.replace(/\s+/g, "").match(/^(\d{1,2})(?::(\d{2}))?(am|pm|a|p)?$/);
  if (!m) return undefined;
  const hour = Number(m[1]);
  const minute = m[2] ?? "00";
  const matches = labels.map((l, i) => ({ l, i })).filter(({ l }) => {
    const lm = l.match(/^(\d{1,2}):(\d{2}) (AM|PM)$/);
    if (!lm) return false;
    if (Number(lm[1]) !== hour || lm[2] !== minute) return false;
    return !m[3] || lm[3]!.toLowerCase().startsWith(m[3][0]!);
  });
  return matches.length === 1 ? matches[0]!.i : undefined;
}

/** Finds which door the visitor means: "at unit 101", "101", "the entrance", "lobby entrance". */
export function doorFromText(session: VisitorDemoSession, text: string, remaining: string[]): string | undefined {
  const t = normalizeText(text)
    .replace(/^(i'?m|im|i am|we'?re|now)\s+/, "")
    .replace(/^(at|by|outside|in front of)\s+/, "")
    .replace(/^the\s+/, "")
    .replace(/\s+(door|now|please)$/, "")
    .trim();
  if (!t) return undefined;
  if (/^(next|here|next door|next stop)$/.test(t)) return remaining[0];
  const { config } = session;
  for (const unit of config.units) {
    const name = unit.name.toLowerCase();
    const digits = name.match(/\d+/)?.[0];
    if (t === name || (digits && (t === digits || t === `unit ${digits}` || t === `apt ${digits}` || t === `apartment ${digits}`))) return unit.doorId;
  }
  for (const door of config.doors) {
    const name = door.name.toLowerCase();
    if (t === name || t === name.replace(/\s+door$/, "")) return door.id;
  }
  if (/^(entrance|front|front entrance|lobby|building|main entrance)$/.test(t)) return config.doors.find((d) => d.kind === "ENTRANCE")?.id;
  return undefined;
}

/**
 * The single entry point for a typed message from a visitor. The caller
 * (any messaging webhook) has already verified and de-duplicated it.
 */
export async function handleVisitorText(session: VisitorDemoSession, from: string, text: string, meta?: InboundMeta): Promise<void> {
  const said = { text, meta };
  const firstMessage = !session.visitor;
  if (firstMessage) session.identify(from);

  const keyword = keywordOf(text);
  if (keyword === "stop") return session.optOut(said);
  if (keyword === "start") return session.optIn(said);
  if (session.optedOut) return session.recordText(said);
  if (keyword === "help") return session.help(said);
  if (firstMessage) return session.greet(said);

  const t = normalizeText(text);
  const stage = await session.stage();
  const sorry = "Sorry, I didn't catch that.";

  switch (stage) {
    case "intro":
      return session.greet(said);

    case "choose-unit": {
      const units = session.config.units;
      const byNumber = pickNumber(t, units.length);
      const byName = units.findIndex((u) => t.includes(u.name.toLowerCase()) || (u.name.match(/\d+/)?.[0] ?? "\u0000") === t);
      const index = byNumber ?? (byName >= 0 ? byName : undefined);
      if (index !== undefined) return session.act("chooseUnit", { unitId: units[index]!.id }, said);
      await session.recordText(said);
      return session.reply(`${sorry} Which unit would you like to see?`, { kind: "choose", options: units.map((u) => u.name), what: "a unit" });
    }

    case "choose-time": {
      const labels = session.offeredSlots.map((s) => s.label);
      const index = pickNumber(t, labels.length) ?? pickTime(t, labels);
      if (index !== undefined) return session.act("chooseTime", { slotStart: session.offeredSlots[index]!.start.toISOString() }, said);
      await session.recordText(said);
      return session.reply(`${sorry} Which time works for you?`, { kind: "choose", options: labels, what: "a time" });
    }

    case "consent":
      if (YES.test(t)) return session.act("consent", { agree: true }, said);
      if (NO.test(t)) return session.act("consent", { agree: false }, said);
      await session.recordText(said);
      return session.reply(`${sorry} Is it OK if I text you about this tour and keep a record of your visit?`, { kind: "yes-no" });

    case "identity":
      return session.resendVerificationLink(said);

    case "ready":
      if (ARRIVED.test(t)) return session.act("arrive", {}, said);
      if (QUESTION.test(t)) return session.act("ask", { question: text }, said);
      await session.recordText(said);
      return session.reply(`${sorry} You can ask me a question about the property.`, { kind: "say", phrase: "I'm here", purpose: "when you arrive" });

    case "touring": {
      const remaining = await session.remainingStops();
      if (FINISHED.test(t)) return session.act("finish", {}, said);
      const door = doorFromText(session, text, remaining);
      if (door) return session.act("atStop", { doorId: door }, said);
      if (QUESTION.test(t)) return session.act("ask", { question: text }, said);
      await session.recordText(said);
      const next = remaining[0];
      return session.reply(
        `${sorry} You can ask me a question${next ? `, text "at ${session.stopLabel(next)}" when you get there,` : ","} or text "finish" when you're done.`,
      );
    }

    case "follow-up":
      if (YES.test(t)) return session.act("followUp", { wantsContact: true }, said);
      if (NO.test(t)) return session.act("followUp", { wantsContact: false }, said);
      await session.recordText(said);
      return session.reply(`${sorry} Would you like someone from the property team to follow up?`, { kind: "yes-no" });

    case "done":
    case "stopped":
      await session.recordText(said);
      return session.reply("This tour has ended. Text HI any time to start a new one.");
  }
}
