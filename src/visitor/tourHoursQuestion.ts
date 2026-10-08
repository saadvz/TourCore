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

/** Visitor reply from the hours that are saved. Days and clocks use the same wording as the hours step. */
export function tourHoursVisitorReply(hours: { days: readonly Weekday[]; start: string; end: string }): { templateId: string; body: string } {
  return renderSms("tour-hours-which-day", {
    days: describeTourDays(hours.days),
    hours: `${spokenClockTime(hours.start)} to ${spokenClockTime(hours.end)}`,
  });
}
