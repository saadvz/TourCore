import type { TourCoreConfig } from "../config/tourCoreConfig";
import type { ReplyPrompt } from "../messaging/presentation";
import { visitorPlace } from "./identity";

/**
 * The one message a visitor gets when a conversation starts. A home offers
 * the next tour days; a building asks which unit. Times come after a day
 * is chosen. A later step never sends a second introduction.
 */

export function entryReply(config: TourCoreConfig, dates: { label: string }[]): { body: string; prompt?: ReplyPrompt } {
  const home = config.property.propertyType === "SINGLE_FAMILY";
  const place = visitorPlace(config.property);
  const named = place.publicName ? `${place.publicName} at ${place.address}` : place.address;
  const welcome = home
    ? `Hi! Welcome to the self-guided tour for ${named}. I can answer questions about the home and help you book a tour.`
    : `Hi! Welcome to the self-guided tours ${place.publicName ? `for ${named}` : `at ${place.address}`}. I can answer questions about the property and help you book a tour.`;

  if (!home) {
    return {
      body: `${welcome}\n\nWhich unit would you like to see?`,
      prompt: { kind: "choose", options: config.units.map((unit) => unit.name), what: "a unit" },
    };
  }
  if (dates.length === 0) {
    return { body: `${welcome}\n\nThere are no open tour times right now. The property team will reach out.` };
  }
  return {
    body: `${welcome}\n\nI have tours available. Which day works for you?`,
    prompt: { kind: "choose", options: dates.map((day) => day.label), what: "a day" },
  };
}

export function timeMenu(dayLabel: string, labels: string[]): { body: string; prompt?: ReplyPrompt } {
  if (!labels.length) return { body: `I don't have any open times on ${dayLabel}.` };
  return {
    body: `I have these times available ${dayLabel}:`,
    prompt: { kind: "choose", options: labels, what: "a time" },
  };
}
