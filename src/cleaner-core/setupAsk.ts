/**
 * What each setup step still needs, for Grok to ask in its own words. Cleaner Core names the fields,
 * the allowed answers, and the defaults. Grok asks one short question at a time and shows options as
 * a choice card. Nothing here is sent to anyone.
 */

export interface AskOption {
  value: string;
  label: string;
}

export interface AskQuestion {
  /** The tool argument this answer fills, or a choice Grok uses to pick the next question. */
  field: string;
  /** What to find out, as a short phrase. Grok words the question itself. */
  ask: string;
  required: boolean;
  /** Show these as a choice card. The host picks one, or several when `multiple` is set. */
  options?: AskOption[];
  multiple?: boolean;
  /** The answer to offer first, as an option value or a plain value. */
  default?: string;
  example?: string;
  /** Asked only when an earlier answer calls for it. */
  when?: string;
  /** How to collect or use the answer. */
  how?: string;
}

export interface SetupAsk {
  step: "start" | "property" | "sources" | "people" | "schedule" | "door-code" | "preferences" | "times";
  tool: string;
  questions: AskQuestion[];
}

/** The instruction beside every ask. */
export function askNext(tool: string): string {
  return `Ask the host the questions in ask, one at a time, in your own short words. Show any options as a choice card. Skip a question the host already answered. Then call ${tool}.`;
}

export const START_ASK: SetupAsk = {
  step: "start",
  tool: "get_state",
  questions: [
    {
      field: "choice",
      ask: "what the host wants help with",
      required: true,
      options: [
        { value: "tours", label: "Letting renters tour a unit on their own" },
        { value: "cleaners", label: "Scheduling cleaners between guest stays" },
      ],
      how: "Call get_state again with choice set to the option's value.",
    },
  ],
};

/** The property step. Once the address is saved, only the missing usual times are asked. */
export function propertyAsk(saved: { address: boolean; checkoutTime: boolean; checkInTime: boolean }): SetupAsk {
  const questions: AskQuestion[] = [];
  if (!saved.address) {
    questions.push(
      { field: "address", ask: "the property's street address", required: true },
      { field: "business", ask: "what to call the business in texts", required: true },
      { field: "timeZone", ask: "the property's time zone", required: true, how: "Work it out from the address. Ask only if it's unclear." },
    );
  }
  // save_property takes the whole property, so a later save passes the saved fields again.
  const how = saved.address ? "Call save_property with the saved business, address, and time zone, plus the times." : undefined;
  if (!saved.checkoutTime) questions.push({ field: "checkoutTime", ask: "the usual checkout time", required: true, example: "10:00 AM", ...(how ? { how } : {}) });
  if (!saved.checkInTime) questions.push({ field: "checkInTime", ask: "the usual check-in time", required: true, example: "4:00 PM", ...(how ? { how } : {}) });
  return { step: "property", tool: "save_property", questions };
}

export function sourcesAsk(property: string): SetupAsk {
  return {
    step: "sources",
    tool: "save_sources",
    questions: [
      {
        field: "source",
        ask: "where the bookings come from",
        required: true,
        multiple: true,
        options: [
          { value: "guesty", label: "Guesty Lite" },
          { value: "google", label: "Google Calendar" },
          { value: "other", label: "Another calendar link (Airbnb, Vrbo, or other)" },
        ],
      },
      {
        field: "calendars",
        ask: "the calendar's export link",
        required: true,
        when: "source is guesty or other",
        how: 'Collect the link on your secure card. A secure card can\'t pass a value to a tool, so call save_sources with uploadLink: { name: "Guesty Lite" } (or the calendar\'s name) and post the link to the upload link from your own computer.',
      },
      {
        field: "google",
        ask: "which Google calendar holds the bookings",
        required: true,
        when: "source is google",
        example: `${property} bookings`,
        how: "Read only that calendar with your own connector, never the main one unless the bookings are there. Save with google: true.",
      },
    ],
  };
}

export function peopleAsk(business: string): SetupAsk {
  return {
    step: "people",
    tool: "save_people",
    questions: [
      { field: "cleanerName", ask: "the cleaner's name", required: true },
      { field: "cleaner", ask: "the cleaner's phone number", required: true },
      { field: "host", ask: "the host's phone number", required: true },
      {
        field: "hostName",
        ask: "the host's own first name, for the group text",
        required: true,
        how: `The group intro greets the host by this name and calls you their cleaning assistant. Ask for a person's name, not the business name ("${business}").`,
      },
      {
        field: "groupChat",
        ask: "who is in the cleaning texts",
        required: true,
        default: "cleaner-and-host",
        options: [
          { value: "cleaner-and-host", label: "A group text with me and the cleaner" },
          { value: "everyone", label: "A group text with me, the cleaner, and extra contacts" },
          { value: "cleaner-only", label: "Texts to the cleaner alone" },
        ],
      },
      { field: "contacts", ask: "each extra contact's name, role, and phone number", required: true, when: "groupChat is everyone" },
      {
        field: "doorCodeTo",
        ask: "who gets the door code",
        required: true,
        when: "groupChat is everyone and there are contacts",
        options: [
          { value: "group", label: "The whole group" },
          { value: "cleaner", label: "Only the cleaner, privately" },
        ],
      },
    ],
  };
}

export const SCHEDULE_STEP: SetupAsk = {
  step: "schedule",
  tool: "save_schedule",
  questions: [
    {
      field: "timing",
      ask: "when the cleaner gets texts",
      required: true,
      default: "defaults",
      options: [
        { value: "defaults", label: "Keep the defaults" },
        { value: "custom", label: "Set the timing myself" },
      ],
      how: "The defaults: the first text goes when the host confirms the times, a reminder at 8:00 AM on checkout morning, no quiet hours, and problems go to the host. Keep them with save_schedule {}.",
    },
  ],
};

export const DOOR_CODE_STEP: SetupAsk = {
  step: "door-code",
  tool: "save_door_code",
  questions: [
    {
      field: "code",
      ask: "the door code",
      required: true,
      how: 'Only on your secure card. Never in chat. Call save_door_code with no code (lockLocation is fine) to get a one-time upload link, then post {"code": "<door code>"} to it from your own computer.',
    },
    { field: "lockLocation", ask: "where the lock is", required: false, example: "front door keypad" },
  ],
};

export const PREFERENCES_STEP: SetupAsk = {
  step: "preferences",
  tool: "save_preferences",
  questions: [
    {
      field: "any",
      ask: "whether the host has cleaning preferences",
      required: true,
      options: [
        { value: "none", label: "No preferences" },
        { value: "some", label: "Add preferences" },
      ],
      how: "No preferences saves save_preferences {}.",
    },
    {
      field: "supplyNotes",
      ask: "whether the cleaner should report supplies running low",
      required: false,
      when: "any is some",
      options: [
        { value: "true", label: "Yes" },
        { value: "false", label: "No" },
      ],
    },
    {
      field: "photosRequired",
      ask: "whether the cleaner must send photos when done",
      required: false,
      when: "any is some",
      options: [
        { value: "true", label: "Yes" },
        { value: "false", label: "No" },
      ],
    },
    { field: "checklist", ask: "checklist items", required: false, when: "any is some" },
    { field: "instructions", ask: "a note for the cleaner, sent with the door code", required: false, when: "any is some" },
  ],
};

/** Offers the usual times for every turnover that has none yet. */
export function allTimesAsk(checkout: string, checkIn: string, untimed: number): SetupAsk {
  return {
    step: "times",
    tool: "confirm_times",
    questions: [
      {
        field: "all",
        ask: `whether to use the usual times for all ${untimed} upcoming turnovers`,
        required: true,
        default: "all",
        options: [
          { value: "all", label: `Use ${checkout} checkout and ${checkIn} check-in for all ${untimed}` },
          { value: "one", label: "Set the times one turnover at a time" },
        ],
        how: `For all, call confirm_times with checkout ${checkout}, checkIn ${checkIn}, and all: true. For one at a time, ask for the first turnover's times and call confirm_times without all.`,
      },
    ],
  };
}
