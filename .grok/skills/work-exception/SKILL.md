---
name: work-exception
description: Show what needs the team's attention on live and recent tours (unanswered questions, a visitor text Tour Core could not handle, help requests, door problems, off-route attempts, paused tours, failed identity checks, tours that couldn't be restored, visitors who didn't confirm leaving), open one, and resolve it using only Tour Core's actions and the operator's own facts.
when-to-use: "what needs attention", "show exceptions", "any problems", "open Pat's issue", "what's happening with Pat's tour", "show active tours", "pause the tour", "call off the tour", a Tour Core Operator Updates routine run
allowed-tools: get_operator_update list_active_tours inspect_tour list_exceptions inspect_exception resolve_exception answer_flagged_question place_operator_hold clear_operator_hold revoke_tour_access pause_tours resume_tours remove_property list_tour_time_requests inspect_tour_time_request approve_tour_time_request decline_tour_time_request propose_tour_time reschedule_tour schedule_one_off_tour inject_local_sms read_local_outbox
argument-hint: "[visitor or issue]"
user-invocable: true
metadata:
  author: Tour Core
  short-description: Tour updates, exception queue, monitoring, holds and approved answers
  version: "0.3.20"
---

# Work Exception

Tour Core finds exceptions in the tour records; the team decides what to do.
You never decide access and never answer a visitor's question from your own
knowledge.

`get_state` carries the playbook. Your name picks wording only and never a
gate. A grok or Cursor name gets the full Grok playbook. After a restart
the stored OAuth name is used, and a baseline entry cannot override it.
Before a yes on a flagged answer, read `visitorWillReceive` in full.
A save asks `Send this to {name} and save it for anyone who asks the same thing later? "{visitorWillReceive}"`.
That quoted text is exactly what goes out, including any closing line.
A handler-failed reply saves nothing, so it stays `Send this to {who}? "{reply}"`.
A question about a service, assistance, support, guide, seeing-eye, or therapy dog, animal, cat, or pet, emotional support followed by any word, ESA, 55+, 55 and over, a senior community, age restrictions, housing assistance, a housing voucher, HUD, Section 8, undocumented status, sexual orientation, gender identity, gay, lesbian, LGBTQ, a same-sex couple, transgender, religion, Christian, Catholic, Protestant, Jewish, Jew, Muslim, Islamic, Hindu, Buddhist, Sikh, Mormon, atheist, a social security number or SSN, pregnancy, a newborn, a baby on the way, adults only, immigrants, immigration status, a minimum age, age limits, or discrimination is fair housing even when a pets answer is saved. `Do you allow pets?`, `Do you allow dogs?`, `Is there a dog park?`, `Is there a church nearby?`, and `Is there a minimum lease?` are not. A dog park is not parking. Parking matches `parking`, `park my car`, or `where do I park`. A fair-housing flag has `proposeDraft` false. The refusal is
`This one touches on fair housing, so I won't draft an answer. Reply to them yourself, then mark it handled.`
After that no-draft flag is saved, the visitor gets `Good question for the property team. I've passed it along, and they'll text you back here.` They never hear fair housing. `{team}` is the operator name only when it ends in "team"; otherwise "property team". If the flag cannot be saved, the team is texted first (`{who} asked a question, but I couldn't save it for you to answer. Please text them back. They're waiting.`) and the visitor gets `I can't open the doors for you right now. I've let the {team} know, and they'll text you here shortly.` only when that text went out. Otherwise they get `Sorry, I hit a snag with that. Could you text me again in a few minutes?` The audit write comes after and is logged if it fails. A door with no step left uses `{who} is at {door}, and I couldn't open it for them. Please text them or let them in.` the same way. A stale identity form is `It's been a while since you filled out the identity form, so I'll need you to fill it out again before I can open doors.` After the window the visitor hears `Your tour time ended at {time}, so the doors are locked now. Want to come back another time? Just reply with a day that works.` HELP after every door is already open, and HELP after the window while the tour is still in progress, texts the team first. The visitor gets `I've let the {team} know. Stay where you are and reply here. They'll reply as soon as they can.` only if that text went out; otherwise `Sorry, I hit a snag with that. Could you text me again in a few minutes?` When that team text does not go out, the landlord sees `I couldn't text you about {who}, so I asked them to text me again in a few minutes.` That line never names a provider or an error. A custom
time uses `place` from `inspect_tour_time_request` when that read has one.
Tool annotations are hints. If setup keeps failing, give the landlord the
setup help link as one plain link. Never put that link in a visitor text.
One alert address per install; a new save replaces the old one. The wake
offer is Grok only.

## When to use

The operator asks what needs attention, asks about a visitor's tour, wants to
answer a flagged question, or wants to pause, resume or call off a tour. Also
use it for "Show active tours", and whenever the Tour Core Operator Updates
routine wakes you with an update.

## Required inputs and access

- Nothing to start. The operator names a visitor or picks an item from the
  list, or the routine hands you an `eventId`.

## Sequence

### Tour updates (the routine wakes you)

Tour Core sends only an `eventId` and an event type; never names or details.

1. Call `get_operator_update` with the `eventId`. Tour Core's records are the
   source of truth.
2. Post its `summary` in your own short words, for example:
   > New tour booked: Testy is scheduled to tour Unit 1A today at 3:00 PM.
   > Testy's Unit 1A tour has started.
   > Testy's Unit 1A tour is complete.
3. For an issue, if `stillOpen` is false (someone already handled it), stop
   quietly. For an unanswered question, ask for the answer itself ("What
   should I tell them?"), not a yes/no, then continue with **Resolve** below
   when the operator replies. For a text Tour Core could not handle, ask
   what to tell the visitor; `answer_flagged_question` texts them from this
   number and does not save an approved fact.
4. Don't act on the tour or the issue on your own. Never show ids or the
   payload.

### Monitor

- "Show active tours": `list_active_tours`. One short block per tour:
  > Pat Smith
  > Unit 101
  > Monday, Sep 28, 9:00–9:45 AM
  > Touring
  > Current step: at Unit 101
- "What's happening with Pat's tour?": find Pat's `tourRef` from the list, then
  `inspect_tour`. Summarize status, latest activity, questions, access denials
  and anything in `needsAttention`. The summary already names the status once
  (no "Cancelled. Cancelled."). Tour time includes extra time if the window
  was extended. When they are touring and also have a later booking, these
  tools show the running tour; the later booking is their next booking.
- Pause, resume, or call off that running tour. After it ends for any reason
  (done, closed, called off, cancelled), the later booking takes over and can
  be called off or cancelled by text. If nothing is held, HI starts a new
  conversation. `pause_tours` with cancel cancels every real future booking,
  including a held rebook, and counts only tours actually cancelled.
  If they are still touring, the cancel text says their tour right now
  isn't affected. A one-off overlap check sees the running tour and
  every future or held booking. `reschedule_tour` will not move a tour
  in progress (including hold or a door-system problem); it can offer to move the later booking instead
  (`Want me to move their {oldTime} on {oldDay} booking to {newTime} on
  {newDay} instead?`; outside hours: `{who} is touring right now, so I
  can't move this tour. Their later booking is {oldTime} on {oldDay}, and
  {newTime} on {newDay} is outside your tour hours. Want me to move it
  there anyway?`; yes: `Moved {who}'s later booking to {time} on
  {day}.`). A visitor cancel by text while touring targets that later
  booking (`Cancel your later tour at {time} on {day}? Your tour right now
  isn't affected. Reply YES or NO.`). If they name the tour they are on:
  `You can't cancel the tour you're on, but you're free to wrap up whenever
  you like. Your later tour at {time} on {day} is still booked. Want me to
  cancel that one instead? Reply YES or NO.` A touring visitor with no
  later booking who texts cancel hears `You can't cancel the tour you're
  on, but you're free to wrap up whenever you like. Text me anytime if you
  want to book another tour.` On hold or a door-system problem those
  refusal lines insert `The {team} is still working on the problem and
  will text you here.` after the first sentence. Calling
  off describes the tour that was called off; the later booking is
  `nextBooking`. A held later booking stays. Any other live booking on that
  same conversation is called off too, so list and inspect cannot stay Ready
  while the visitor's next text on that conversation is the ended-tour reply
  (`This tour has ended. Text HI any time to start a new one.`).
- QA on the local loopback: `inject_local_sms` then `read_local_outbox` (separate
  bubbles, never one blob). Those tools refuse unless that building is on local
  test texts. Other published buildings can stay on live visitor texting.
  A local live tour still shows up in `list_active_tours` and `inspect_tour`.

### Queue

1. "Show me what needs attention": `list_exceptions`. Number them, newest first:
   > 1. Pat Smith — Unit 101
   >    Asked "Is parking included?". There's no approved answer yet.
   >    Tour still active.
   >
   > 2. Jamie Lee — Unit 102
   >    Couldn't be restored after a restart. No doors will open for it.
   >    Access is blocked.
   >
   > 3. Sam Lee — Unit 103
   >    Hasn't confirmed leaving Unit 103.
   >    Tour time ended.
   >
   > 4. Jane Smith — Unit 101
   >    Tour Core couldn't save the visit record, so the tour was paused.
   A records check that fails before unlock keeps the door locked ("Tour Core
   couldn't save the visit record, so {door} stayed locked.") and does not
   open an issue; the booking stays ready. A leaving issue uses the ended
   tour's status ("Tour time ended"), even when a later booking is held and
   waiting for consent.
2. "Open Pat's issue": `inspect_exception` with that item's `exceptionId`. Show
   what happened, the visitor's words, where the tour stands and `nextSteps`.

### Resolve

- **Unanswered question.** Ask for the answer itself ("What should I tell
  them?"), not a yes/no. As soon as the operator gives it ("2 bedrooms"), call
  `answer_flagged_question` with their words as `approvedFact`, before saying
  anything else. It returns the one confirmation question, such as:
  > Send this to Pat and save it for anyone who asks the same thing later? "Parking is included. Let me know if you have any other questions."

  Ask exactly that, once. Don't ask a separate "want me to add it?" first.
  Before the yes, also read `visitorWillReceive` in full. That is the exact
  text that goes out, including any closing line. What they approve is that
  full text.
  After a clear yes, call again with `confirmationCode`, then say what Pat was
  sent. If they turned off texts (STOP), it still saves the answer and
  returns exactly `Saved "{answer}" for future questions. {who} has turned
  off texts from us, so I didn't send it and this is still open. If you can
  reach them another way, do that, then mark it handled.` Any other send
  failure returns `Saved "{answer}" for future questions, but I couldn't
  text {who}, so nothing was sent and this is still open. If you can reach
  them another way, do that, then mark it handled.` The issue stays open
  until you mark it handled. Tour Core then returns Pat to where they were
  (the same unit menu, offered times, identity-form reminder or tour step) without
  resending a live day or time menu. The property stays published: an
  approved fact never needs another readiness check or practice tour. The
  closed issue shows the answer that was sent, not "There's no approved
  answer yet."
  If the operator doesn't know the answer, don't guess. Offer to mark it
  handled once they've dealt with it another way. A repeat answer returns
  exactly `That question has already been handled.`
- **Couldn't handle their text.** This is not a flagged question. Show the
  landlord alert line as the detail. Next step:
  `Tell me what to say and I'll text them, or book or change their tour yourself.`
  When the operator gives the reply, call `answer_flagged_question` with
  their words. The first call returns exactly `Send this to {who}? "{reply}"`
  with the landlord's exact reply and no future-visitors line. After yes,
  when the text is in the outbox and the issue is closed, it returns
  exactly `Sent to {who}.` It texts the visitor from the Tour Core number,
  does not save an approved fact (`savedToSetup` is false), and never
  says future visitors will get it too. If the visitor cannot be texted,
  it returns `I couldn't text {who}, so nothing was sent and this is
  still open. If you can reach them another way, do that, then mark it
  handled.` and leaves the issue open. {who} is their first name, or the
  phone-based label when they have no name — never "A". `resolve_exception`
  also closes it. A repeat answer or resolve returns exactly
  `That's already been handled.`
- **Mark handled.** `resolve_exception` with a short note in the operator's
  words. It changes nothing else. For "Visitor hasn't confirmed leaving",
  marking it handled also ends the after-close visitor alerts (alerts also
  stop when they text DONE / I'm out, or 24 hours after the close). The
  leaving issue itself stays open until they text DONE or you mark it
  handled. While the 24-hour after-close window is open, a standalone
  HI or yo stays on after-close handling. After 24 hours, greetings go
  back to normal even if the leaving issue is still open: HI starts a
  booking if nothing is held, or takes over a held booking. A clear
  booking phrase (including see it again / schedule another visit)
  starts a new booking when nothing is held; a greeting with more text,
  or anything about being stuck, locked, jammed, still in the unit,
  unable to leave, unable to get outside, unable to find the way out,
  where the way out is, or how to get out, still alerts the team
  and replies to the visitor. "Which way out of the lobby" is not
  distress. Help booking does not hide those other words. Marking the leaving issue handled closes after-close alerts
  for that closed tour, even when a later booking is held. While that
  leaving issue is open, those after-close texts run before a held
  booking can take over. A rebook held from during the tour continues after the
  follow-up reply: if that booking was still waiting, they get the
  booked-for line, then the usual next steps.
  An unapproved custom-time request is told once that it is
  still with the property team (`Your request for {time} on {day} is
  still with the property team. I'll text you as soon as they respond.`).
  The extra sentence (`If you'd rather pick one of the regular times
  instead, just reply with a day.`) is only for visitors with no held
  or booked regular tour. A held rebook taking over gets the booked-for
  line, then the usual next steps — not
  that regular-times sentence. Later texts use the normal booking flow.
  Booking a regular slot withdraws that request and, when it replaces a
  held or booked future tour, adds `That replaces your {time} tour on {day}.`
  list, inspect, and approve or decline then show `They booked a regular
  time instead.` If the requested time has already passed, the request
  expires: the visitor is texted once (`The property team couldn't get
  to your request for {newTime} on {newDay} in time.` plus still-booked
  or reply-with-a-day). Asking for a regular open time moves a held or confirmed
  booking right away. A taken regular slot keeps the current booking
  (`Sorry, {time} on {day} is already taken.` plus still-booked only for
  a held or future booking, never the tour in progress) and offers the
  remaining times that day or `If you'd like another time, just reply
  with a day.` A numbered pick from that menu books it only when the menu was shown
  after the current booking, including after the operator moves it
  (`reschedule_tour`, approving a time request, accepting a proposed
  time, a one-off, cancel, or revoke). A leftover number, time, or bare
  later/earlier/sooner does not move it. On hold, a taken slot gets the
  taken line and no menu.
  Farewells and
  arrival remarks after booking do not ask again; later/earlier/sooner is a
  change only when it is an actual ask (`make it later`, `later in the week`,
  `can we do it later`, `anything later`, `sooner would be better`,
  `can we do it sooner`, `anything sooner`, `sooner?`). Idioms such as
  `yes, the sooner the better` and `yes, anything earlier is fine too`
  do not ask again. A
  named day stays on the ask: `could I do Thursday at 2:45`, `would Thursday at 2:45 work`,
  `can I make Thursday`, `how about Thursday at 2:45`, and `can we do Thursday`.
  A named weekday is that day (the next one, or today only if today is that
  weekday and the time is still ahead). `No, Saturday at 2:45 PM` starts a
  request for that time. A bare no with nothing booked is `No problem. If
  you'd like another time, just reply with a day.` Declining a request with
  nothing booked uses that same ending after the couldn't-approve line. A
  booked tour keeps the still-booked or still-confirmed ending.
  `tuesday works better` shows that day's times. Only a PENDING
  custom-time request occupies an off-grid window. An APPROVED request does not;
  the booking itself is what occupies the slot after it is on the calendar. A visitor
  text that cannot be handled opens a handler-failed issue (not a flagged
  question) and tells them the team will reply here, or asks them to text
  again if no landlord record could be created. The team is told
  `{who} texted "{their message}" and I couldn't handle it, so they're
  waiting on you. I told them you'd reply as soon as you can.` After a
  partial reply: `{who} texted "{their message}" and I couldn't finish
  handling it. They got part of a reply, so they may still be waiting on
  you.` Partial reply plus empty text: `{who} sent a text I couldn't
  finish handling. They got part of a reply, so they may still be waiting
  on you.` Empty text with no reply: `{who} sent a text I couldn't handle,
  so they're waiting on you. I told them you'd reply as soon as you can.`
  Approve and decline return `That time has already
  passed, so I've let {who} know their request ran out. You can still
  book them a one-off time.` Then use `schedule_one_off_tour` or
  `reschedule_tour`. Propose returns `That request ran out
  because its time already passed, so your offer of {newTime} on {newDay}
  didn't go out. I've let {who} know, and you can still book them a
  one-off time.` and does not send the proposal to the visitor. If it
  was already expired, return `That request already ran out because its
  time passed, and {who} has been told. You can still book them a one-off
  time.` Already approved or declined: `That request has already been
  handled.` Do not text again.
  Default `list_tour_time_requests` hides withdrawn;
  show them with status withdrawn or all. A follow-up yes does not
  ask again. Approving a custom time that moves a confirmed
  booking uses the moved wording, then you're all set — not a second question.
- **After a closed tour.** Other visitor texts before that window ends
  alert the team once per message. DONE after the close uses the usual
  thanks and follow-up question; a yes is the same follow-up as a normal
  finish (`{name} toured {place} and would like someone to follow up.`).
- **STOP during a tour.** Visitor texts stop. The tour stays on its
  window; doors still follow policy, and the leave check-in, close, and
  team alerts still fire. The team is told they replied STOP and won't
  get more messages. The tour is not ended.
- **Pause a tour** (`place_operator_hold`), **resume** (`clear_operator_hold`),
  **call off** (`revoke_tour_access`): each returns a yes/no question first.
  Ask it word for word; call again with `confirmationCode` only after a clear
  yes. Calling off can't be undone; say so. When the visitor is touring and
  also has a later booking, these act on the running tour. After that tour
  ends, they act on the later booking.
- **Pause or resume bookings** at a property or unit (`pause_tours`,
  `resume_tours`), or **remove a property** (`remove_property`): these are not
  the same as holding one visitor. Ask the exact question first. If tours are
  already booked, the operator chooses keep or cancel. Resume texts waiting
  visitors that tours are back. A later visitor Tour, Hi, or book restarts
  booking the same way as a first text (a home gets the welcome and day list).
  Removal drops that list without sending it,
  and a later text to that line gets a goodbye and cannot book. Booked
  cancel text on remove does not say they'll be texted when tours are back.
  Removal is refused while someone is on a tour. It also finds an unpublished
  setup `list_properties` shows (same lookup by id, name, or address), whether
  or not that setup is complete, and removes it completely; published records
  stay, including a property sent back to draft that still has publishedAt,
  visitor tour or reservation records, or a publish event in its audit. A
  practice tour alone does not count. Unpublished confirmation says it isn't published yet so no visitors
  are affected, but everything entered for it will be deleted for good.
  Published with no bookings says no one is booked, so no cancel texts go
  out; one booked visitor is singular. {name} is the operator-given property
  name, or street plus unit when there is exactly one unit, otherwise the
  street line — never "Main Home". If it was an unpublished setup, say
  **Removed the setup for {name}.** Say remove, never archive.
- Door-system problems and tours that couldn't be restored: explain in plain
  words, suggest reaching out to the visitor, and resume only once the operator
  says the doors are working.

### Custom tour times

A visitor can ask for a time that isn't one of the regular slots, or to move
a tour they already have. Asking for a regular open time moves a held or
confirmed booking right away and withdraws a pending request. A taken
regular slot keeps the current booking and shows what's left that day; a
numbered pick from that menu books it. `tour.time_requested` wakes you even
when ordinary tour updates are off, because someone has to decide. The
regular hours do not change. If a request expired because its time passed,
do not approve it — use `schedule_one_off_tour` or `reschedule_tour`.

1. Call `inspect_tour_time_request` for that request and ask only this:
   "{name} asked to tour {place} at {time} on {day}. I can approve that time, offer another time, or decline it. Nothing goes to the visitor until you pick."
   Fill {name} from the visitor's name on that read, {place} from `place` on that read, and say the time as {time} on {day}.
   If that read has no place, say this instead: "{name} asked for {time} on {day}. I can approve that time, offer another time, or decline it. Nothing goes to the visitor until you pick."
2. The landlord can say it naturally:
   - "Approve 3:15" → `approve_tour_time_request`. Ask the question it returns, once. After a clear yes, call it again with `confirmationCode`. If the property is paused, it refuses (`Tours at {property} are paused. Resume them first.`) — say that, don't approve. If they already booked a regular time, the request is withdrawn (`They booked a regular time instead.`) — say that, don't approve, and don't text the visitor. If the request expired, return the ran-out line and use `schedule_one_off_tour` or `reschedule_tour`.
   - "Offer them 3:30" → `propose_tour_time`. The current booking stays until the visitor agrees. With a booking, say `I asked {who} about {time} on {day}. Their current booking stays until they say yes.` With nothing booked, say `Sent {who} {time} on {day}. Nothing's booked until they say yes.` The same time they asked for is `The property team can do {time} on {day} as a one-off.` A different time stays `The property team can't do {requestedTime} on {requestedDay}, but {proposedTime} on {proposedDay} works.` Then `Reply YES to switch, or NO to keep your {current} tour on {day}.` or `Reply YES to switch, or NO to keep looking.`
   - "Decline" or "Keep the 4 PM booking" → `decline_tour_time_request`. If the request is withdrawn, Tour Core returns `They booked a regular time instead.` — say that and don't text the visitor.
   - "Move Testa to 3:15" → `reschedule_tour` with their name and the time. Ask the one question it returns, then call again after yes. If they are touring right now, it refuses (`{who} is touring right now, so I can't move this tour. Once it ends, you can book them another time.`); if they have a later booking, that refusal asks `Want me to move their {oldTime} on {oldDay} booking to {newTime} on {newDay} instead?` (outside hours: `{who} is touring right now, so I can't move this tour. Their later booking is {oldTime} on {oldDay}, and {newTime} on {newDay} is outside your tour hours. Want me to move it there anyway?` — a plain yes is enough) and a yes moves that booking (`Moved {who}'s later booking to {time} on {day}.`). The visitor move text is `Your tour of {unit} has been moved to {time} on {day}.` READY keeps `You're all set.` AWAITING_VERIFICATION omits `You're all set.` If the property is paused, it refuses the same way.
   - "Set up a tour for Dana at 1A on Monday at 3:15" → `schedule_one_off_tour` with their phone, the unit and the time. Ask the one question it returns (it ends `Book it?`), then call again after yes. Only if they asked for this tour. A leftover day or time menu with nothing booked does not block — the one-off replaces it. If they already have a booked tour, say Tour Core's refusal word for word (`They already have a booked tour. I can move it or call it off.`), then use `reschedule_tour` to move it or `revoke_tour_access` to call it off. A pending one-off (`They already have a tour waiting for them to reply YES or NO. I can call it off, or we can wait for them to answer.` → `revoke_tour_access` or wait), an open tour window (`They're on a tour right now. I can call it off.` → `revoke_tour_access`), or a hold (`Their tour is on hold. I can resume it or call it off.` → `clear_operator_hold` or `revoke_tour_access`) is also refused. STOP / opt-out still refuses.
   - "Who's waiting for a different time?" → `list_tour_time_requests`. Pending only by default. Withdrawn requests (visitor booked a regular time instead) are hidden unless you ask for withdrawn or all; they show `They booked a regular time instead.` — they are not pending.
3. A time outside normal touring hours returns a stronger question. Call again
   with `confirmationCode` and `acknowledgeOutsideHours` true only after they
   agree to that one-time exception.
4. If Tour Core says the time overlaps another tour, tell them the options it
   names. Don't approve it.
5. Never describe this as a schedule change. Future visitors still get the
   regular times.
6. After a one-off is set, Tour Core texts the visitor first: Reply YES to
   confirm, NO to cancel, or STOP to opt out. YES continues to the usual
   consent step. STOP opts out and sends only the standard opt-out
   confirmation — nothing further. NO cancels and tells the team. A leftover
   menu number (`1`, `2`) only gets that same confirmation line again — no
   team issue and no alert. A real question is flagged for the team (`I'll
   check with the {team} and get back to you.`); the hold stays pending and
   the no-reply timer still applies. If the one-off replaced a leftover day
   or time menu, a later reply (including a leftover menu number such as
   "1") is a reply to that confirmation, not a booking from the old menu.
   If they never reply in time, the time is released; unless they opted out
   they get exactly one text that it was released, then no further texts.
7. Tour-time confirmation questions name the action and end with the verb:
   `Move it?` or `Book it?`. Never "Continue?". A move inside hours includes
   the old time. `This is a one-off. Your regular tour hours stay the same`
   only when the time is outside tour hours.

One visitor text is one intent. If they ask a question and name a custom time
in the same message, Tour Core answers the question and asks them to confirm
the time. It does not file the request until they say yes.

## Validate

- After each action, re-read the item (`inspect_exception` or `inspect_tour`)
  and report the new status.
- If a tool refuses ("isn't running right now", "can't be paused", "Tours at
  {property} are paused. Resume them first."), tell the operator plainly.
  Don't look for another way to do it.

## Return

The short queue, or the one item and what was done.

## Requires approval

Answering with a new approved fact, pausing, resuming and calling off a tour,
approving a custom time, moving a tour, and setting up a one-off tour. A time
outside normal touring hours needs the stronger confirmation. Marking an item
handled, declining a time request, or offering another time doesn't need a
confirmation code but should follow the operator's instruction.

## Stop when

The operator's item is handled, or the queue is empty ("Nothing needs attention
right now").

## Never

- Open, unlock or "just let them in". There is no such tool; tell the operator
  Tour Core only opens doors on the visitor's own route during their tour time.
- Invent, reword or embellish an approved fact.
- Show exceptionIds, tourRefs or codes.
- Treat a visitor naming a tour date ("Can I come Dec 1?", "Can I come
  October 1"), an unparseable date ("the 45th", "sometime next month"), or
  a day that isn't bookable (already passed, no more today, fully booked,
  that weekday, too far ahead, no open times) as an unanswered question.
  Tour Core handles those itself — including a natural yes (yes, that,
  "Yes I'll take it", "Yes 1 works") for the offered next opening, and a
  new day/time ask while that offer is pending ("Can I come oct 6 at 12
  pm?") as that day, not as accepting the offer — and they should not
  appear as a flagged question. A visitor who texts to cancel a booked
  tour (any natural phrasing) is also handled by Tour Core: it confirms,
  then YES cancels (`You're cancelled. Text me anytime if you want to book
  again.`) or NO keeps the booking (`Okay, your {time} tour on {day} stays booked.`). While they are touring and the cancel targets a later booking:
  confirm `Cancel your later tour at {time} on {day}? Your tour right now
  isn't affected. Reply YES or NO.`; YES `Done, I've cancelled your later
  tour at {time} on {day}. Your tour right now isn't affected.`; NO `Okay,
  your later tour at {time} on {day} stays booked.` If they name the tour
  they are on: `You can't cancel the tour you're on, but you're free to
  wrap up whenever you like. Your later tour at {time} on {day} is still
  booked. Want me to cancel that one instead? Reply YES or NO.` A touring
  visitor with no later booking who texts cancel hears `You can't cancel
  the tour you're on, but you're free to wrap up whenever you like. Text me
  anytime if you want to book another tour.` On hold or a door-system
  problem those refusal lines insert `The {team} is still working on the
  problem and will text you here.` after the first sentence. A reply that isn't a
  clear yes or no on that confirm is
  flagged (`I'll check with the {team} and get back to you.`). That should
  not appear as a flagged question unless they were unclear on the confirm,
  or cancel could not finish (then the team is asked to call it off).
  When nothing is booked yet, that same cancel phrasing at the day menu, the
  time menu, or the property picker (a bare cancel is still STOP) clears the
  step and replies `No problem, nothing's booked yet, so I'll stop here.
  Text me anytime if you want to pick a time.` It does not ask YES or NO and
  it does not say the tour is cancelled. The next text from someone already
  opted in starts scheduling again, with no TOUR keyword. A named day is
  used. At the property picker, that next text asks which place again.
  While a one-off tour is waiting on YES, NO or STOP, a leftover menu
  number only re-prompts; a real question is flagged. Handle a flagged
  question as an unanswered question and leave the hold pending.
- Treat a visitor photo as something to forward or as silence. Tour Core
  tells them `I can't take photos yet. Text your question and I'll pass it
  along.` when the photo has no caption. A photo plus a question it can't
  answer is one text: `I can't open photos yet. I'll pass your question
  to the property team, and they'll reply here as soon as they can.` (flagged; after an ended tour that line
  adds `If you'd like to tour again, just text HI.`). Handleable text with
  a photo still gets only `I can't take photos yet.` and is handled as
  usual. Do not say "MMS" to the visitor.
- Treat a real question after a tour has ended as dropped. Tour Core
  answers from approved facts first and appends ` If you'd like to tour
  again, just text HI.` (a period is added first if the answer has no
  `.` `!` or `?`). A question that fits more than one unit is asked back
  as `Which unit do you mean: {A} or {B}?` with no HI line; after they
  pick a unit, the approved answer gets the HI line, or the locked ended
  flag text if that unit has no approved answer. It flags only when there
  is no approved answer (`I'll pass your question to the property team, and
  they'll reply here as soon as they can. If you'd like to tour again, just text HI.`; with a photo,
  the combined photo line). A photo plus an answerable ended question
  gets `I can't take photos yet.` once, then the answer with the HI line.
  A non-question keeps `This tour has ended. Text HI any time to start a
  new one.` and is not flagged. Mention photos at most once per inbound.
