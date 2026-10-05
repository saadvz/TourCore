import type { TourCoreConfig } from "../config/tourCoreConfig";
import type { ReplyPrompt } from "../messaging/presentation";
import { isApartmentOrCondo, isSingleTourPlace, streetAndUnit, visitorPlace } from "./identity";

/**
 * The one message a visitor gets when a conversation starts. A home or one
 * apartment or condo unit offers the next tour days; a building asks which
 * unit. Times come after a day is chosen. A later step never sends a second
 * introduction.
 */

export function entryReply(config: TourCoreConfig, dates: { label: string }[], units = config.units): { body: string; prompt?: ReplyPrompt } {
  const onePlace = isSingleTourPlace(config.property);
  const place = visitorPlace(config.property);
  const named = place.publicName ? `${place.publicName} at ${place.address}` : place.address;
  const condoName = isApartmentOrCondo(config.property) && config.units[0] ? streetAndUnit(config.property, config.units[0].name) : named;
  const welcome = isApartmentOrCondo(config.property)
    ? `Hi! Welcome to the self-guided tour for ${condoName}. I can answer questions about the unit and help you book a tour.`
    : onePlace
      ? `Hi! Welcome to the self-guided tour for ${named}. I can answer questions about the home and help you book a tour.`
      : `Hi! Welcome to the self-guided tours ${place.publicName ? `for ${named}` : `at ${place.address}`}. I can answer questions about the property and help you book a tour.`;

  if (!onePlace) {
    return {
      body: `${welcome}\n\nWhich unit would you like to see?`,
      prompt: { kind: "choose", options: units.map((unit) => unit.name), what: "a unit" },
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
