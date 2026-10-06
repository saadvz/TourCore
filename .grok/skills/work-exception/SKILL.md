---
name: work-exception
description: Show what needs the team's attention on live and recent tours (unanswered questions, help requests, door problems, off-route attempts, paused tours, failed identity checks, tours that couldn't be restored), open one, and resolve it using only Tour Core's actions and the operator's own facts.
when-to-use: "what needs attention", "show exceptions", "any problems", "open Pat's issue", "what's happening with Pat's tour", "show active tours", "pause the tour", "call off the tour", a Tour Core Operator Updates routine run
allowed-tools: get_operator_update list_active_tours inspect_tour list_exceptions inspect_exception resolve_exception answer_flagged_question place_operator_hold clear_operator_hold revoke_tour_access pause_tours resume_tours remove_property list_tour_time_requests inspect_tour_time_request approve_tour_time_request decline_tour_time_request propose_tour_time reschedule_tour schedule_one_off_tour inject_local_sms read_local_outbox
argument-hint: "[visitor or issue]"
user-invocable: true
metadata:
  author: Tour Core
  short-description: Tour updates, exception queue, monitoring, holds and approved answers
  version: "0.3.5"
---

# Work Exception

Tour Core finds exceptions in the tour records; the team decides what to do.
You never decide access and never answer a visitor's question from your own
knowledge.

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
   when the operator replies.
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
  and anything in `needsAttention`.
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
2. "Open Pat's issue": `inspect_exception` with that item's `exceptionId`. Show
   what happened, the visitor's words, where the tour stands and `nextSteps`.

### Resolve

- **Unanswered question.** Ask for the answer itself ("What should I tell
  them?"), not a yes/no. As soon as the operator gives it ("2 bedrooms"), call
  `answer_flagged_question` with their words as `approvedFact`, before saying
  anything else. It returns the one confirmation question, such as:
  > Send "Parking is included" to Pat? Future visitors who ask the same thing
  > will get it too. Save it?

  Ask exactly that, once. Don't ask a separate "want me to add it?" first.
  After a clear yes, call again with `confirmationCode`, then say what Pat was
  sent. Tour Core then returns Pat to where they were (the same unit menu,
  offered times, consent question or tour step), so they carry on without
  starting over. The property stays published: an approved fact never needs
  another readiness check or practice tour.
  If the operator doesn't know the answer, don't guess. Offer to mark it
  handled once they've dealt with it another way.
- **Mark handled.** `resolve_exception` with a short note in the operator's
  words. It changes nothing else.
- **Pause a tour** (`place_operator_hold`), **resume** (`clear_operator_hold`),
  **call off** (`revoke_tour_access`): each returns a yes/no question first.
  Ask it word for word; call again with `confirmationCode` only after a clear
  yes. Calling off can't be undone; say so.
- **Pause or resume bookings** at a property or unit (`pause_tours`,
  `resume_tours`), or **remove a property** (`remove_property`): these are not
  the same as holding one visitor. Ask the exact question first. If tours are
  already booked, the operator chooses keep or cancel. Resume texts waiting
  visitors that tours are back. A later visitor Tour, Hi, or book restarts
  booking the same way as a first text (a home gets the welcome and day list).
  Removal drops that list without sending it,
  and a later text to that line gets a goodbye and cannot book. Booked
  cancel text on remove does not say they'll be texted when tours are back.
  Removal is refused while someone is on a tour. It also finds an in-progress
  setup `list_properties` shows (same lookup by id, name, or address) and
  removes that setup completely; published records stay. For a draft, the
  question says it isn't published yet so no visitors are affected. If it was
  a setup still in progress, say **Removed the setup for {name}.** Say remove, never archive.
- Door-system problems and tours that couldn't be restored: explain in plain
  words, suggest reaching out to the visitor, and resume only once the operator
  says the doors are working.

### Custom tour times

A visitor can ask for a time that isn't one of the regular slots, or to move
a tour they already have. `tour.time_requested` wakes you even when ordinary
tour updates are off, because someone has to decide. The regular hours do
not change.

1. Call `get_operator_update` with the `eventId` and post its `summary`.
   It names the visitor, the time they want, and whether that time is outside
   normal touring hours.
2. The landlord can say it naturally:
   - "Approve 3:15" → `approve_tour_time_request`. Ask the question it returns, once. After a clear yes, call it again with `confirmationCode`. If the property is paused, it refuses (`Tours at {property} are paused. Resume them first.`) — say that, don't approve.
   - "Offer them 3:30" → `propose_tour_time`. The current booking stays until the visitor agrees.
   - "Decline" or "Keep the 4 PM booking" → `decline_tour_time_request`.
   - "Move Testa to 3:15" → `reschedule_tour` with their name and the time. Ask the one question it returns, then call again after yes. If the property is paused, it refuses the same way.
   - "Set up a tour for Dana at 1A on Monday at 3:15" → `schedule_one_off_tour` with their phone, the unit and the time. Ask the one question it returns (it ends `Book it?`), then call again after yes. Only if they asked for this tour. A leftover day or time menu with nothing booked does not block — the one-off replaces it. If they already have a booked tour, say Tour Core's refusal word for word (`They already have a booked tour. I can move it or call it off.`), then use `reschedule_tour` to move it or `revoke_tour_access` to call it off. A pending one-off (`They already have a tour waiting for them to reply YES or NO. I can call it off, or we can wait for them to answer.` → `revoke_tour_access` or wait), an open tour window (`They're on a tour right now. I can call it off.` → `revoke_tour_access`), or a hold (`Their tour is on hold. I can resume it or call it off.` → `clear_operator_hold` or `revoke_tour_access`) is also refused. STOP / opt-out still refuses.
   - "Who's waiting for a different time?" → `list_tour_time_requests`.
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
7. Confirmation questions name the action and end with the verb: `Move it?`,
   `Book it?`, or `Save it?`. Never "Continue?". A move inside hours includes
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
  again.`) or NO keeps the booking (`Okay, your tour stays on {day} at
  {time}.`). A reply that isn't a clear yes or no on that confirm is
  flagged (`I'll check with the {team} and get back to you.`). That should
  not appear as a flagged question unless they were unclear on the confirm,
  or cancel could not finish (then the team is asked to call it off).
  While a one-off tour is waiting on YES, NO or STOP, a leftover menu
  number only re-prompts; a real question is flagged. Handle a flagged
  question as an unanswered question and leave the hold pending.
- Treat a visitor photo as something to forward or as silence. Tour Core
  tells them `I can't take photos yet. Text your question and I'll pass it
  along.` when the photo has no caption, or only `I can't take photos yet.`
  when there is any text in the same message. That text is handled as usual.
  Do not say "MMS" to the visitor.
