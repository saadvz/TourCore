import { spokenClockTime, type Weekday } from "../core/timezone";
import { isGeneralTourHoursQuestion } from "../intent/tourHoursAsk";
import { describeTourDays } from "../operator/tourDayWords";
import { renderSms } from "../sms/templates";

export { isGeneralTourHoursQuestion };

export function savedTourHours(hours: { days?: readonly string[]; start?: string; end?: string } | undefined): hours is {
  days: readonly string[];
  start: string;
  end: string;
} {
  return !!hours && Array.isArray(hours.days) && hours.days.length > 0 && !!hours.start && !!hours.end;
}

const EXAMPLE_NAME: Record<Weekday, string> = {
  MON: "Monday",
  TUE: "Tuesday",
  WED: "Wednesday",
  THU: "Thursday",
  FRI: "Friday",
  SAT: "Saturday",
  SUN: "Sunday",
};

/** An open day the visitor can copy. Saturday when it is open, otherwise the first weekday, then Sunday. */
export function tourHoursExamplePhrase(days: readonly Weekday[]): string {
  const named = days.includes("SAT")
    ? EXAMPLE_NAME.SAT
    : EXAMPLE_NAME[(["MON", "TUE", "WED", "THU", "FRI", "SUN"] as const).find((day) => days.includes(day)) ?? "MON"];
  return `today, tomorrow, or ${named}`;
}

/** Visitor reply from the hours that are saved. Days and clocks use the same wording as the hours step. */
export function tourHoursVisitorReply(hours: { days: readonly Weekday[]; start: string; end: string }): { templateId: string; body: string } {
  return renderSms("tour-hours-which-day", {
    days: describeTourDays(hours.days),
    hours: `${spokenClockTime(hours.start)} to ${spokenClockTime(hours.end)}`,
    examples: tourHoursExamplePhrase(hours.days),
  });
}
