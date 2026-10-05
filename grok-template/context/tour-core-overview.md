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

Visitors can name a tour day as today, tomorrow, a weekday, or a calendar
date ("Dec 1", "December 1st", "1 Dec", "12/1", "Tuesday Oct 6"). Without a
year, Tour Core uses the next date on or after today in the property's time
zone. A date or booking ask is handled as booking, not as a flagged question. If
the day can't be resolved ("the 45th", "sometime next month"), Tour Core
asks which day they meant and shows the day menu; it does not flag the team.

## Who does what

| Part | Job |
| --- | --- |
| Operator (you) | Decides setup, answers, and anything consequential |
| Grok Bot (Tour Core Bot) | Understands the operator and calls Tour Core's tools |
| Tour Core | Keeps every record, applies policy, writes the audit |
| Durin | Carries out access Tour Core has already approved |

## The access rule

A door opens only when all of these hold for the visitor asking: their records
are valid (reservation, consent, identity check), it's their tour time, the
door is on their exact reserved route, and the system is healthy with no
conflict, provider failure or operator hold. Anything else is a safe denial,
decided before Durin is contacted.

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
   Tour Core also wakes the Bot (Tour Core Operator Updates routine) for the
   updates the operator chose: bookings, tour starts, completions and anything
   that needs their judgment. Only real text-message tours produce updates.
   A visitor can ask for a time that isn't a regular slot. The operator can
   also set up a tour for someone who asked (`schedule_one_off_tour`), even if
   they haven't texted in — only after confirming they asked. A leftover day or
   time menu with nothing booked does not block: the one-off replaces it, and
   later replies go to the new confirmation. A booked tour, a pending one-off,
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
- Visitor messaging: the provider the operator chooses (Sendblue, Twilio, or Photon). Do not assume Sendblue.
- Operator updates: the Tour Core Operator Updates Grok Routine.
- Tour records: on the hosted product, stored by hosted Tour Core. Google Drive keeps portable backups and exports through Grok's connector. Optional direct Drive remains a separate mode.
- Door access: Durin demo mode. No physical door is controlled.
- Visitor verification: basic identity form (records claimed identity; it
  doesn't prove it).

"Published for demo" is not a production launch. Describe each part as it is
("Visitor texting is live. Door access is still in demo mode, so no physical
locks will open."); never say "everything runs in demo mode".
