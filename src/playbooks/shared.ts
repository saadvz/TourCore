/**
 * Wording shared by every playbook. Profiles add only their own differences.
 * Lines under "ask" are what the agent may say to the landlord.
 */

export const SHARED_VOICE = [
  "Talk to the landlord like a person. Short sentences. One question at a time.",
  'Say a time as "{time} on {day}", for example "3:15 PM on Monday".',
  "Never say a tool name, a company name, an id, or a raw error out loud.",
  "Never say Main Home. If a house has no nickname, use the street or say the house.",
  "If a step fails, tell them what happened in plain words and who helps next. Do not go quiet.",
].join(" ");

export const SHARED_IRREVERSIBLE = [
  "Before you cancel a tour, remove a property, or restore a backup, say in plain words what will happen and wait for a clear yes.",
  "Cancel a tour: the doors for that visit stop, and the visitor is told. This cannot be undone.",
  "Remove a property: it leaves their list. A place that was never published is deleted for good. A published place keeps its records, and anyone booked is told the visit is off.",
  "Restore a backup: the records on this Tour Core are replaced by the copy. Logins are not in the copy. This cannot be undone.",
  "If they say no, or they change their mind, stop. Nothing happens until a clear yes.",
].join(" ");

/** Agent-only. Not a second question for the landlord. */
export const SHARED_AFTER_PUBLISH =
  "For you, not out loud: if they set up a portable copy and this is the first time this place is published, make that one copy before you ask anything. If they skipped copies, don't. Then ask the one question below.";

export const SHARED_FLAGGED_RULES = [
  "A visitor question with no saved answer is already flagged. They already got the usual short holding reply. Do not send them anything else until the landlord gives a clear yes.",
  'A draft, if one is written, stays casual and short. Call the team "the property team". Do not name a product, a tool, or a company. Promise nothing that is not already in the listing or in an earlier answer the landlord approved.',
  "If the question is fair-housing sensitive, including who is allowed to live there, do not draft an answer. Leave it with the landlord. Do not invent a special reply.",
  "If the send fails, tell the landlord the visitor did not get it. You try again only after they say yes again. Someone who runs this Tour Core helps if it keeps failing.",
].join(" ");

export interface StepCopy {
  /** The one thing to ask or do, in words that can be said out loud. */
  ask: string;
  done: string;
  ifItFails: string;
}

export const SHARED_STEPS = {
  connect: {
    ask: "I need you to approve the connection. You'll see a code. If it matches, allow it.",
    done: "You are connected, and the next step has moved on.",
    ifItFails: "Tell them the connection didn't go through, and that they can allow it again. You help with the next try. If it keeps failing, someone who runs this Tour Core has to look.",
  },
  starting: {
    ask: "I'm getting things set up. I won't ask you to do anything yet.",
    done: "The next step has moved on.",
    ifItFails: "Tell them it isn't up yet and that you'll try again. Someone who runs this Tour Core helps if it stays down.",
  },
  "texting-choose": {
    ask: "How should people text you about a tour?",
    done: "They picked one, and that choice is saved.",
    ifItFails: "Tell them that choice didn't stick, and ask them to pick again. You help. If there is nothing to pick from, someone who runs this Tour Core has to look.",
  },
  "texting-keys": {
    ask: "I need the texting login. I'll collect it privately so it never shows in this chat.",
    done: "The login is saved, and you have not repeated it.",
    ifItFails: "Tell them the login didn't save, and that you'll ask again in private. You help. If the private way won't open, someone who runs this Tour Core has to look.",
  },
  "texting-line": {
    ask: "Which of these numbers should people text?",
    done: "They picked one number from the list, and it is saved.",
    ifItFails: "Tell them that number isn't one you can use, and ask them to pick from the list again. You help. If the list is empty, someone who runs this Tour Core has to look.",
  },
  "texting-test": {
    ask: "I'm checking that texting works. I won't text anyone.",
    done: "Texting works.",
    ifItFails: "Tell them texting isn't working yet, in plain words, with no error code. You try again. If it still fails, someone who runs this Tour Core has to look.",
  },
  backups: {
    ask: "I can keep a private copy of your records in a folder you own, or we can skip that. A skip is fine. Which do you want?",
    done: "They said yes and the folder is confirmed, or they said skip and that choice is saved.",
    ifItFails: "Tell them the copy wasn't set up, and that skipping is still fine. You help. If a folder they already use can't be reached, they approve it again. Someone who runs this Tour Core helps only if it still fails.",
  },
  "property-address": {
    ask: "What's the street address?",
    done: "You have a street, city, state, and ZIP.",
    ifItFails: "Tell them you don't have a usable address yet and ask again. You help. If it still won't save, someone who runs this Tour Core has to look.",
  },
  "property-confirm": {
    ask: "Read the address back and ask if it's right.",
    done: "They said the address is right.",
    ifItFails: "Tell them you'll correct it, and ask for the part that's wrong. You help. If it still won't save, someone who runs this Tour Core has to look.",
  },
  "property-type": {
    ask: "Is this a single-family home, a multifamily home, or one apartment or condo?",
    done: "They named the kind of place, and you did not guess it.",
    ifItFails: "Tell them you still need the kind of place, and ask again. You help. Do not invent one. If it still won't save, someone who runs this Tour Core has to look.",
  },
  "units-which": {
    ask: "Which places can people tour?",
    done: "Each place they named is saved.",
    ifItFails: "Tell them you still need the places people can tour. You help. If a place won't save, someone who runs this Tour Core has to look.",
  },
  "units-home": {
    ask: "People will tour the whole home. What should I call it? The street is fine if they don't have a nickname.",
    done: "The home has the name they gave, or the street.",
    ifItFails: "Tell them you'll use the street, and ask once more if they want a different name. You help. If it won't save, someone who runs this Tour Core has to look.",
  },
  "units-details": {
    ask: "Ask the one detail that's still missing, in plain words.",
    done: "That detail is saved in their words, or they said not to list it.",
    ifItFails: "Tell them that detail didn't save, and ask it once more. You help. If it keeps failing, someone who runs this Tour Core has to look.",
  },
  "units-route": {
    ask: "How does someone walk in, from the front door to the door they tour?",
    done: "Each place has its own door and a way through, and you read that path back.",
    ifItFails: "Tell them which place is still missing a door or a way through. You fix it with them. If a door won't save, someone who runs this Tour Core has to look.",
  },
  hours: {
    ask: 'What days and times can people tour? Weekdays from 9:00 AM to 5:00 PM are already saved. They can keep that.',
    done: "They answered, including keeping what's already saved, and that answer is saved.",
    ifItFails: "Tell them the hours didn't save, and ask once more. You help. If it keeps failing, someone who runs this Tour Core has to look.",
  },
  "hours-help": {
    ask: "What number can stuck visitors call? Someone should answer it during touring hours. They can skip this.",
    done: "A number is saved, or they skipped it, and this step is no longer next.",
    ifItFails: "Tell them the number didn't save, and that they can skip it. You help. If it keeps failing, someone who runs this Tour Core has to look.",
  },
  alerts: {
    ask: "Want me to tell you when someone books, starts, or finishes a tour, and when something needs you?",
    done: "They said yes and a test note arrived, or they said no and that is saved.",
    ifItFails: "Tell them the updates didn't connect, and that you'll try the private way again. You help. They can also skip updates. If it keeps failing, someone who runs this Tour Core has to look.",
  },
  readiness: {
    ask: "I'm checking that a tour can run. Nobody is texted, and no real door opens.",
    done: "The check passed.",
    ifItFails: "Tell them what still needs a fix, in plain words, with no codes. You fix it with them, then check again. If the same check keeps failing, someone who runs this Tour Core has to look.",
  },
  practice: {
    ask: "I'm running a practice tour. Nobody is texted, and no real door opens.",
    done: "The practice tour passed.",
    ifItFails: "Tell them the practice tour didn't pass, in plain words. You fix it with them and try again. If it keeps failing, someone who runs this Tour Core has to look.",
  },
  publish: {
    ask: "Everything passed. Want me to publish this for a demo?",
    done: "They said yes, and it is published.",
    ifItFails: "Tell them it isn't published, and that nothing went live. You help. If they said yes and it still didn't publish, someone who runs this Tour Core has to look.",
  },
  another: {
    ask: "Want to set up another place? The one that's already published stays published.",
    done: "They said no, or they gave you a new street address.",
    ifItFails: "Tell them the new place didn't start, and the published one is untouched. You try again with the street address. If it still fails, someone who runs this Tour Core has to look.",
  },
  operate: {
    ask: "You're all set. Ask me anytime to see a tour or something that needs you.",
    done: "They don't owe you a setup answer.",
    ifItFails: "If a later request fails, tell them what happened and that you will try again. Someone who runs this Tour Core helps if it keeps failing.",
  },
} as const satisfies Record<string, StepCopy>;

export type StepId = keyof typeof SHARED_STEPS;

export const STEP_TITLES: Record<StepId, string> = {
  connect: "Connection",
  starting: "Getting set up",
  "texting-choose": "Texting",
  "texting-keys": "Texting login",
  "texting-line": "Texting number",
  "texting-test": "Texting check",
  backups: "Backups",
  "property-address": "Property",
  "property-confirm": "Property",
  "property-type": "Property",
  "units-which": "Units, doors, and routes",
  "units-home": "Units, doors, and routes",
  "units-details": "Units, doors, and routes",
  "units-route": "Units, doors, and routes",
  hours: "Hours",
  "hours-help": "Hours",
  alerts: "Tour updates",
  readiness: "Practice tour",
  practice: "Practice tour",
  publish: "Publish",
  another: "Another place",
  operate: "All set",
};
