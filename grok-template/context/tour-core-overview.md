# Tour Core overview (reusable context)

Tour Core is an open-source self-touring tool. A prospect texts the landlord's
one touring number, which covers every property. A first text that names the
place, or a listing link, starts that tour; an unclear first text asks which
place, then stays on that choice. One published property does not ask. They book
a time, agree to texts and tour records, confirm who they are,
and tours one unit on their own. The text thread stays live through the tour:
Tour Core guides them door by door. After the tour has started they get a
15-minutes-left questions text, then a 5-minute warning. One extra 10 minutes
is granted when they ask any time before the tour ends and the next time is
free; a bare yes to the questions text never grants time. After the no-time
line, yes starts booking another look. After the end, doors never open. A +5 text
asks if they've left; at +15 the tour closes and the team gets one issue.
DONE, "I'm out", or "leaving" ends the tour with the usual goodbye. After a
+15 close, other replies alert the team once per message and always reply
to the visitor, until DONE, the operator marks the leaving issue handled,
or 24 hours pass (alerts stop then; the leaving issue stays open until
DONE or handled). While that 24-hour window is open, a standalone HI or
yo stays on after-close handling; a clear booking phrase (including
see it again / schedule another visit) starts a new booking only when
nothing is held. After 24 hours, greetings go back to normal. A
greeting with more text, or anything about being stuck, locked,
jammed, still in the unit, unable to leave, unable to get
outside, unable to find the way out, where the way out is, or how
to get out, does not start booking. Help booking does not hide those
other words. "Which way out of the lobby" is not distress. A rebook or custom-time
request during a tour stays secondary until that tour ends for any
reason (done, closed, called off, cancelled, or expired), then
an unfinished identity form continues. A bare yes or no
answers the latest question asked: a door check wins over a held
booking. While they are touring, `list_active_tours`,
`inspect_tour`, pause, resume and call-off target the running tour; the
later booking is their next booking. After the running tour ends, texts
and those tools move to the later booking, or a greeting starts a new
conversation if nothing is held. `pause_tours` with cancel cancels
every real future booking, including a held rebook, and counts only
tours actually cancelled; if they are still touring, the cancel text
says their tour right now isn't affected. A one-off overlap check sees
the running tour and every future or held booking. `reschedule_tour`
will not move a tour in progress, including hold or a door-system problem (`{who} is touring right now, so I can't
move this tour. Once it ends, you can book them another time.`); if they
have a later booking it asks `Want me to move their {oldTime} on {oldDay}
booking to {newTime} on {newDay} instead?` (outside hours: `{who} is
touring right now, so I can't move this tour. Their later booking is
{oldTime} on {oldDay}, and {newTime} on {newDay} is outside your tour
hours. Want me to move it there anyway?`) and a yes is `Moved {who}'s
later booking to {time} on {day}.`. Calling off describes the tour that was called off;
the later booking is `nextBooking`. After the follow-up
reply, an unapproved custom-time request is told once that it is still
with the property team; they can reply with a day for a regular
time only when they do not already have a held or booked regular tour.
A held rebook taking over gets the booked-for line, then the usual
next steps. Later texts use the normal
booking flow. Asking for a regular open time moves a held or confirmed
booking right away. A taken regular slot keeps the current booking and
says `Sorry, {time} on {day} is already taken.` plus `You're still booked
for {curTime} on {curDay}.` only when they have a held or future booking
(never the tour already in progress), then the remaining times that day
or `If you'd like another time, just reply with a day.` A numbered reply
from that menu books the pick only when the menu was shown after the
current booking, including after the operator moves it. On hold, send
the taken line and no menu. Farewells and
arrival remarks after booking (`yes, see you later`, `yes, I'll arrive
earlier`, `yes, no need to switch`, `yes, the sooner the better`) do not
ask again; `later`/`earlier`/`sooner` is
a change only when it is an actual ask (`make it later`, `earlier
if possible`, `later in the week`, `can we do it later`, `anything later`,
`sooner would be better`, `can we do it sooner`, `sooner?`).
`yes, anything earlier is fine too` does not ask again. A named day (`tuesday
works better`) shows
that day's times. A leftover number, time, or bare later/earlier/sooner
does not move a booking. If a visitor text cannot be handled, they are told
`Sorry, I hit a snag with that. I've let the property team know, and
they'll reply here as soon as they can.` when a landlord record was
created, or `Sorry, I hit a snag with that. Could you text me again in a
few minutes?` when it was not. That opens a handler-failed issue, not a
flagged question. The team sees `{who} texted "{their message}" and I
couldn't handle it, so they're waiting on you. I told them you'd reply
as soon as you can.` After a partial reply: `{who} texted "{their
message}" and I couldn't finish handling it. They got part of a reply,
so they may still be waiting on you.` Partial reply plus empty text:
`{who} sent a text I couldn't finish handling. They got part of a reply,
so they may still be waiting on you.` Empty text with no reply: `{who}
sent a text I couldn't handle, so they're waiting on you. I told them
you'd reply as soon as you can.` `answer_flagged_question` on that issue texts the
visitor and does not save a fact. First call: `Send this to {who}? "{reply}"`
After yes: `Sent to {who}.` If they cannot be texted: `I couldn't text
{who}, so nothing was sent and this is still open. If you can reach them
another way, do that, then mark it handled.` A repeat answer or resolve
on that issue returns `That's already been handled.` A repeat answer on a
flagged question returns `That question has already been handled.`
Booking a regular slot withdraws that request so a later
approve cannot double-book; replacing a held or booked future tour also
sends `That replaces your {time} tour on {day}.` Operators see
`They booked a regular time instead.` If the requested time has already
passed, the request expires and the visitor is texted once:
`The property team couldn't get to your request for {newTime} on {newDay} in time.`
then `You're still booked for {time} on {day}.` or
`If you'd like another time, just reply with a day.` Approve and decline
tell the operator `That time has already passed, so I've let {who} know
their request ran out. You can still book them a one-off time.`
Then use `schedule_one_off_tour` or `reschedule_tour`.
Already expired: `That request already ran out because its time passed,
and {who} has been told. You can still book them a one-off time.`
Already approved or declined: `That request has already been handled.`
Propose tells the operator `That request ran out because its time already
passed, so your offer of {newTime} on {newDay} didn't go out. I've let
{who} know, and you can still book them a one-off time.` and does not
send the proposal. Approving a custom time that
moves a confirmed booking uses the moved wording, then you're all set —
not a second question. While the leaving
issue is open after the close, stuck-inside texts and greetings stay
on after-close handling. After the follow-up reply, a booking that was
still waiting gets the booked-for line, then the usual next steps.
DONE after the close uses the usual thanks and follow-up; a yes is
the same follow-up as a normal finish and does not ask again. STOP
during a tour stops visitor texts only; the tour stays on its window and
team alerts still go out. Afterwards it sends a recap and one follow-up
question.

The welcome is one message. It names the property by its address, and by a
name the operator gave it only when there is one: "Hi! Welcome to the
self-guided tours at 144 Hillside Ave. I can answer questions about the
property and help you book a tour." Then the unit menu. A single-family home
says "home" and offers tour days instead of a unit menu. An apartment or condo
(one unit) names the street plus unit ("145 Main St, Unit 4B"), never "Main
Home", and also skips the unit menu. Entry instructions are not in the
welcome; they arrive only on the you're-all-set text after identity
verification.

## Visitor questions, at every stage

Prospects can ask about the property at any point: before choosing a unit,
while choosing a time, during the identity form, after
booking, before arriving, during and after the tour. No booking is needed to
ask. Answers come only from approved facts, with the structured unit details
first (bedrooms, bathrooms, rent, availability, square footage); the
description isn't used for those. If the question is ambiguous ("How much is
it?" with several units and none chosen), Tour Core asks "Which unit do you
mean: 1A, 1B or 2A?".

After the answer, Tour Core puts the interrupted step back in front of them
(the same unit menu, the same offered times, the same identity-form reminder or
pending confirmation). A question it can't answer gets one text, "I'll pass
your question to the property team, and they'll reply here as soon as they can.", plus an issue and an operator
update. When the operator answers, the visitor gets the answer and the step
they were on. The save question is `Send this to {name} and save it for anyone who asks the same thing later? "{visitorWillReceive}"`, and the quote equals that text byte for byte. After a tour has ended, an approved-fact question is answered
and that answer gets ` If you'd like to tour again, just text HI.` (a period
is added first if the answer has no `.` `!` or `?`). A question that fits
more than one unit is asked back as `Which unit do you mean: {A} or {B}?`
with no HI line; after the visitor picks a unit, the approved answer gets
the HI line, or the locked ended flag text if that unit has no approved
answer. A question with no approved answer is flagged:
`I'll pass your question to the property team, and they'll reply here as soon as they can. If you'd like to tour
again, just text HI.` A non-question keeps the ended-tour line and is not
flagged.

Photos are not forwarded yet. A photo alone gets one plain reply:
`I can't take photos yet. Text your question and I'll pass it along.`
A photo plus a question Tour Core can't answer gets one text:
`I can't open photos yet. I'll pass your question to the property team, and they'll reply here as soon as they can.`
(and is flagged). After an ended tour, that line adds
`If you'd like to tour again, just text HI.` A photo plus an answerable
ended question gets `I can't take photos yet.` once, then the answer with
the HI line. A photo with handleable text (an approved-fact question or a
booking reply such as `1` or `YES`) gets only `I can't take photos yet.`;
the text is handled as usual. Mention photos at most once per inbound.
Do not also send the short photo line when the combined unknown-question
text is used.
Do not append “Text your question…”. The same inbound is not answered twice.
Do not say "MMS" to a visitor.

A visitor with a booked (or held) tour can cancel by text in their own words —
"Can we cancel the tour?", "I want to cancel the booked tour", "cancel",
"please cancel my tour", "call off the tour", "I can't make it", "I need to
cancel". That is not a property question. Tour Core confirms first:
`Cancel your tour on {day} at {time}? Reply YES or NO.` YES cancels (doors
off, status cancelled, audit) and they hear `You're cancelled. Text me
anytime if you want to book again.` NO keeps the booking: `Okay, your tour
stays on {day} at {time}.` While they are touring and the cancel targets a
later booking: `Cancel your later tour at {time} on {day}? Your tour right
now isn't affected. Reply YES or NO.` YES: `Done, I've cancelled your later
tour at {time} on {day}. Your tour right now isn't affected.` NO: `Okay,
your later tour at {time} on {day} stays booked.` If they name the tour
they are on: `You can't cancel the tour you're on, but you're free to wrap
up whenever you like. Your later tour at {time} on {day} is still booked.
Want me to cancel that one instead? Reply YES or NO.` A touring visitor
with no later booking who texts cancel hears `You can't cancel the tour
you're on, but you're free to wrap up whenever you like. Text me anytime
if you want to book another tour.` On hold or a door-system problem those
refusal lines insert `The {team} is still working on the problem and will
text you here.` after the first sentence. A reply that isn't a clear yes or no is flagged:
`I'll check with the {team} and get back to you.` STOP still opts out. If
cancel cannot finish, they get
`I can't cancel it from here. I've asked the property team to call it off and
get back to you.` and the team is flagged. Never use the unanswered-question fallback for a clear cancel ask.
When nothing is booked yet, that same cancel phrasing at the day menu, the time menu, or the property picker (`Actually cancel that`, `cancel that`, `cancel please`, `nevermind`; a bare `cancel` is still STOP) clears the step and replies `No problem, nothing's booked yet, so I'll stop here. Text me anytime if you want to pick a time.` It does not ask YES or NO and it does not say the tour is cancelled. The next text from someone already opted in starts scheduling again, with no TOUR keyword. A named day is used. At the property picker, that next text asks which place again.

Visitors can name a tour day as today, tomorrow, a weekday, or a calendar
date ("Dec 1", "December 1st", "1 Dec", "12/1", "Tuesday Oct 6"). Without a
year, Tour Core uses the next date on or after today in the property's time
zone. If that this-year date has already passed and next year is beyond the
21-day horizon, it stays that past date — "That day has already passed" —
instead of rolling forward and calling it too far ahead. A named weekday is that day: the next one, or today only when today is that weekday and the time is still ahead. `Is Saturday at 2:45 PM possible?` is Saturday, not today. A no that names a time (`No, Saturday at 2:45 PM`) starts a request for that time. A bare no with nothing booked is `No problem. If you'd like another time, just reply with a day.` When a tour is booked, that no keeps the current booking. Declining a request with nothing booked is `The property team couldn't approve {time} on {day}. If you'd like another time, just reply with a day.` A booked tour keeps the still-booked or still-confirmed ending. A fair-housing question is detected before rent, keywords, or a saved answer. The visitor gets the ordinary holding reply and never hears fair housing. The flag has `proposeDraft` false. The landlord refusal is `This one touches on fair housing, so I won't draft an answer. Reply to them yourself, then mark it handled.` `How much is rent?` and `Is rent due monthly?` stay rent answers. A date or booking ask is handled as booking, not as a flagged question. If
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
contacted. If visit records cannot be confirmed before unlock, the door stays
locked and the operator is told "Tour Core couldn't save the visit record, so
{door} stayed locked." (no issue; booking stays ready). If the grant cannot be
saved after unlock, the tour is paused and the issue is "Tour Core couldn't
save the visit record, so the tour was paused." Say "door access" to the
operator; never name Durin.

## What an operator does with the Bot

0. **Set up Tour Core**: the Bot installs and starts Tour Core on its own cloud
   computer, then asks the operator only for what needs a person (see
   `installation.md`).
1. **Set up a property**: address (the property's identity; a name only if the
   operator gives one), property type (single-family home; multifamily — duplex
   or small building they own; apartment or condo — one unit), units, doors,
   routes, tour hours, visitor verification. Visitor texting is used
   automatically when it's installed.
2. **Check readiness**: real checks against the pieces the setup uses.
3. **Run a practice tour**: a full pretend tour with safety checks. Nobody is
   texted and no real door opens. A single-family home keeps the entrance proof
   line; a unit-door-only apartment or condo shows the unit-door proof instead.
4. **Publish for demo**: only after both pass, and only after the operator's yes.
5. **Watch active tours** and **work exceptions**: unanswered questions, help
   requests, door problems, paused tours, tours that couldn't be restored.
   Pause or resume bookings at a property or unit (`pause_tours` /
   `resume_tours`; resume texts people who were told tours would be back;
   a later Tour / Hi / book restarts booking the same way as a first text),
   or remove a property from the list (`remove_property`; finds any
   property `list_properties` shows, including an unpublished setup;
   published records stay, including a property sent back to draft that
   still has publishedAt, visitor tour or reservation records, or a publish
   event in its audit (a practice tour alone does not count); an unpublished setup is removed completely,
   whether or not it is complete; unpublished confirmation says it isn't
   published yet so no visitors are affected, but everything entered will
   be deleted for good; published with no bookings says no one is booked,
   so no cancel texts go out; one booked visitor is singular; it names the
   operator-given name, or street plus unit when there is exactly one unit,
   otherwise the street line, never Main Home; a later text
   gets a goodbye and cannot book; booked cancel text does not promise tours
   will be back). While paused, `approve_tour_time_request`
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
- QA without a carrier: put that building on local test texts (`choose_messaging_provider` with `local` and the property, or `set_services` with `messaging: local`), then `inject_local_sms` and `read_local_outbox`. Replies are separate bubbles. `hasMedia` injects a photo inbound (the file is not forwarded; a photo alone is told it can't take photos yet, and a photo plus a question it can't answer is one combined text and is flagged). Those tools refuse unless that building is on local. Other published buildings stay on the installation's live texting. `get_services` reports `messaging.current` as `"test"` (never `"live"`) and "Visitor texting: test mode". `get_services` / `set_services local` say "Texting is in test mode, so texts don't reach real phones. Real visitors won't get anything until live texting is turned on. Door access is still in demo mode, so no physical locks will open." Do not say texting is live. Publishing a local building leaves out "Visitors can start a tour by texting your touring number." Switching the installation's provider keeps saved carrier credentials.
- Operator updates: the Tour Core Operator Updates Grok Routine.
- Tour records: on the hosted product, stored by hosted Tour Core. Google Drive keeps portable backups and exports through Grok's connector. Optional direct Drive remains a separate mode.
- Door access: demo mode. No physical door is controlled.
- Visitor verification: basic identity form (records claimed identity; it
  doesn't prove it).

"Published for demo" is not a production launch. Describe each part as it is
("Visitor texting is live. Door access is still in demo mode, so no physical
locks will open."); for local test texts, use the test-mode sentence above.
Never say "everything runs in demo mode".
