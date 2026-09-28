import type { TourCoreConfig } from "../config/tourCoreConfig";
import { addDays, formatDay, localDateOf } from "../core/timezone";
import type { TourSlot } from "../core/schedule";
import type { ReplyPrompt } from "../messaging/presentation";

/**
 * The one message a visitor gets when a conversation starts. Property type
 * decides the wording; the recurring schedule decides which times are
 * offered. A later step never sends a second introduction.
 */

function sameDay(a: { year: number; month: number; day: number }, b: { year: number; month: number; day: number }): boolean {
  return a.year === b.year && a.month === b.month && a.day === b.day;
}

function dayWord(start: Date, now: Date, tz: string): string {
  const day = localDateOf(start, tz);
  const today = localDateOf(now, tz);
  if (sameDay(day, today)) return "today";
  if (sameDay(day, addDays(today, 1))) return "tomorrow";
  return `on ${formatDay(start, tz)}`;
}

function listOf(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

export function entryReply(config: TourCoreConfig, now: Date, slots: TourSlot[]): { body: string; prompt?: ReplyPrompt } {
  const home = config.property.propertyType === "SINGLE_FAMILY";
  const address = config.property.address.trim();
  const approved = config.property.displayName?.trim();
  const name = approved && approved.toLowerCase() !== address.toLowerCase() ? approved : undefined;
  const place = name ? `${name} at ${address}` : address;
  const welcome = home
    ? `Hi! Welcome to the self-guided tour for ${place}. I can answer questions about the home and help you book a tour.`
    : `Hi! Welcome to the self-guided tours ${name ? `for ${place}` : `at ${address}`}. I can answer questions about the property and help you book a tour.`;

  if (home) {
    if (slots.length === 0) {
      return { body: `${welcome}\n\nThere are no open tour times right now. The property team will reach out.` };
    }
    const labels = slots.map((slot) => slot.label);
    return {
      body: `${welcome}\n\nI have ${listOf(labels)} available ${dayWord(slots[0]!.start, now, config.property.timezone)}.`,
      prompt: { kind: "choose", options: labels, what: "a time" },
    };
  }

  return {
    body: `${welcome}\n\nWhich unit would you like to see?`,
    prompt: { kind: "choose", options: config.units.map((unit) => unit.name), what: "a unit" },
  };
}
