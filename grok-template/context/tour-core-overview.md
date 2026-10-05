# Tour Core overview (reusable context)

Tour Core is an open-source self-touring tool. A prospect texts the property's
number, books a time, agrees to texts and tour records, confirms who they are,
and tours one unit on their own. The text thread stays live through the tour:
Tour Core guides them door by door. Afterwards it sends a recap and one
follow-up question.

The welcome is one message. It names the property by its address, and by a
name the operator gave it only when there is one: "Hi! Welcome to the
self-guided tours at 144 Hillside Ave. I can answer questions about the
property and help you book a tour." Then the unit menu. A single-family home
says "home" and offers the next regular tour time instead of a unit menu.

## Visitor questions, at every stage

Prospects can ask about the property at any point: before choosing a unit,
while choosing a time, before agreeing, during the identity form, after
booking, before arriving, during and after the tour. No booking is needed to
ask. Answers come only from approved facts, with the structured unit details
first (bedrooms, bathrooms, rent, availability, square footage); the
description isn't used for those. If the question is ambiguous ("How much is
it?" with several units and none chosen), Tour Core asks "Which unit do you
mean: 1A, 1B or 2A?".

After the answer, Tour Core puts the interrupted step back in front of them
(the same unit menu, the same offered times, the same consent question or
pending confirmation). A question it can't answer gets a safe reply, "I don't
have that information for this property. I've flagged it for the property
team so they can get back to you.", plus an issue and an operator update. When
the operator answers, the visitor gets the answer and the step they were on.

Photos are not forwarded yet. A photo alone gets one plain reply:
`I can't take photos yet. Text your question and I'll pass it along.`
A photo with any text (a question or a booking reply such as `1` or `YES`)
gets only `I can't take photos yet.`; the text is handled as usual
(answered from approved facts, flagged for the team, or used as the booking
reply). Do not append “Text your question…”. The same inbound is not
answered twice. Do not say "MMS" to a visitor.

A visitor with a booked (or held) tour can cancel by text in their own words —
"Can we cancel the tour?", "I want to cancel the booked tour", "cancel",
"please cancel my tour", "call off the tour", "I can't make it", "I need to
cancel". That is not a property question. Tour Core confirms first:
`Cancel your tour on {day} at {time}? Reply YES or NO.` YES cancels (doors
off, status cancelled, audit) and they hear `You're cancelled. Text me
anytime if you want to book again.` NO keeps the booking: `Okay, your tour
stays on {day} at {time}.` A reply that isn't a clear yes or no is flagged:
`I'll check with the {team} and get back to you.` STOP still opts out. If
cancel cannot finish, they get
`I can't cancel it from here. I've asked the leasing team to call it off and
get back to you.` and the team is flagged. Never use "I don't have that
information" for a clear cancel ask.

Visitors can name a tour day as today, tomorrow, a weekday, or a calendar
date ("Dec 1", "December 1st", "1 Dec", "12/1", "Tuesday Oct 6"). Without a
year, Tour Core uses the next date on or after today in the property's time
zone. If that this-year date has already passed and next year is beyond the
21-day horizon, it stays that past date — "That day has already passed" —
instead of rolling forward and calling it too far ahead. A date or booking ask is handled as booking, not as a flagged question. If
the day can't be resolved ("the 45th", "sometime next month"), Tour Core
asks which day they meant and shows the day menu; it does not flag the team.
While a one-off tour is waiting on YES, NO, or STOP, a leftover menu
number only re-prompts; a real question is flagged for the team and the
hold stays pending.

If that day has no bookable tours, the visitor is told why — no more tours
today, fully booked, tours don't run that weekday, beyond the 21-day
booking horizon, or no open times at all — plus the next opening when there
is one. A date that has already passed starts "That day has already
passed. The next opening is {when}." Wherever "The next opening is
{when}." is followed by the day menu, the ending is "Reply yes to take
it, or pick a day:". An offer without that next-opening line still ends
"Reply yes for {Weekday} at {time}, or pick a day:". The follow-up is
"Reply yes for {Weekday} at {time}, or pick a day." A natural yes — yes,
that, yeah, yep, ok, okay, "Yes I'll take it", "Yes 1 works", "I'll take
it", and similar accepts — books that exact start after a recheck; if it
was taken, they hear "Someone just grabbed that time." A reply that is
neither an accept nor a day keeps the offer and repeats the follow-up.
Bare numbers and day names still pick from the day menu. A sentence that
names another day or time ("Can I come oct 6 at 12 pm?") is a fresh date
request for that day, not an accept of the pending opening.

Open conversations pick up the latest published settings (hours, units,
and so on) on every inbound text. A stale numbered reply after hours
change gets "Tour times just changed. Here's what's open now:" and the
fresh days. "Tour" restarts booking from the current day picker. An
offered next opening is rechecked against the current hours before it is
booked.

## Who does what

| Part | Job |
| --- | --- |
| Operator (you) | Decides setup, answers, and anything consequential |
| Grok Bot (Tour Core Bot) | Understands the operator and calls Tour Core's tools |
| Tour Core | Keeps every record, applies policy, writes the audit |
| Durin | The Durin Access Platform Tour Core is built on. Carries out access Tour Core has already approved |

## The access rule

Tour Core is built on the Durin Access Platform. A door opens only when all of
these hold for the visitor asking: their records are valid (reservation,
consent, identity check), it's their tour time, the door is on their exact
reserved route, and the system is healthy with no conflict, provider failure
or operator hold. Anything else is a safe denial, decided before Durin is
contacted. Say "door access" to the operator; never name Durin.

## What an operator does with the Bot

0. **Set up Tour Core**: the Bot installs and starts Tour Core on its own cloud
   computer, then asks the operator only for what needs a person (see
   `installation.md`).
1. **Set up a property**: address (the property's identity; a name only if the
   operator gives one), property type (single-family home, multifamily home,
   apartment building or other), units, doors, routes, tour hours, visitor
   verification. Visitor texting is used automatically when it's installed.
2. **Check readiness**: real checks against the pieces the setup uses.
3. **Run a practice tour**: a full pretend tour with safety checks. Nobody is
   texted and no real door opens.
4. **Publish for demo**: only after both pass, and only after the operator's yes.
5. **Watch active tours** and **work exceptions**: unanswered questions, help
   requests, door problems, paused tours, tours that couldn't be restored.
   Pause or resume bookings at a property or unit (`pause_tours` /
   `resume_tours`; resume texts people who were told tours would be back;
   a later Tour / Hi / book restarts booking the same way as a first text),
   or remove a property from the list (`remove_property`; records stay; a
   later text gets a goodbye and cannot book; booked cancel text does not
   promise tours will be back). While paused, `approve_tour_time_request`
   and `reschedule_tour` refuse (`Tours at {property} are paused. Resume
   them first.`). Say remove, never archive.
   Tour Core also wakes the Bot (Tour Core Operator Updates routine) for the
   updates the operator chose: bookings, tour starts, completions and anything
   that needs their judgment. Only real text-message tours produce updates.
   A visitor can ask for a time that isn't a regular slot. The operator can
   also set up a tour for someone who asked (`schedule_one_off_tour`), even if
   they haven't texted in — only after confirming they asked. A leftover day or
   time menu with nothing booked does not block: the one-off replaces it, and
   later replies go to the new confirmation. A leftover menu number only
   re-prompts YES / NO / STOP; a real question is flagged. A booked tour, a pending one-off,
   an open tour window, or a hold still refuses — tell the operator Tour Core's
   words (`They already have a booked tour. I can move it or call it off.`),
   then move it with `reschedule_tour` or call it off with `revoke_tour_access`
   (resume a hold with `clear_operator_hold`). Confirmation
   questions end `Move it?`, `Book it?`, or `Save it?`. A move names the old
   time. `This is a one-off…` only outside tour hours.
6. **Export the audit**: a validated, provider-neutral record of the day.

## Current P0 demo configuration

- Tour Core runs on the Bot's cloud computer (a demo deployment) or at a
  stable self-hosted address.
- Visitor messaging: the provider the operator chooses (Sendblue, Twilio, Photon, or local QA loopback). Do not assume Sendblue.
- QA without a carrier: put that building on local test texts (`choose_messaging_provider` with `local` and the property, or `set_services` with `messaging: local`), then `inject_local_sms` and `read_local_outbox`. Replies are separate bubbles. `hasMedia` injects a photo inbound (the visitor is told photos can't come through yet; the file is not forwarded). Those tools refuse unless that building is on local. Other published buildings stay on the installation's live texting. Switching the installation's provider keeps saved carrier credentials.
- Operator updates: the Tour Core Operator Updates Grok Routine.
- Tour records: on the hosted product, stored by hosted Tour Core. Google Drive keeps portable backups and exports through Grok's connector. Optional direct Drive remains a separate mode.
- Door access: Durin demo mode. No physical door is controlled.
- Visitor verification: basic identity form (records claimed identity; it
  doesn't prove it).

"Published for demo" is not a production launch. Describe each part as it is
("Visitor texting is live. Door access is still in demo mode, so no physical
locks will open."); never say "everything runs in demo mode".
