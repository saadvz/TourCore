---
name: work-exception
description: Show what needs the team's attention on live and recent tours (unanswered questions, help requests, door problems, off-route attempts, paused tours, failed identity checks, tours that couldn't be restored), open one, and resolve it using only Tour Core's actions and the operator's own facts.
when-to-use: "what needs attention", "show exceptions", "any problems", "open Pat's issue", "what's happening with Pat's tour", "show active tours", "pause the tour", "call off the tour"
allowed-tools: list_active_tours inspect_tour list_exceptions inspect_exception resolve_exception answer_flagged_question place_operator_hold clear_operator_hold revoke_tour_access
argument-hint: "[visitor or issue]"
user-invocable: true
metadata:
  author: Tour Core
  short-description: Exception queue, monitoring, holds and approved answers
  version: "0.2.0"
---

# Work Exception

Tour Core finds exceptions in the tour records; the team decides what to do.
You never decide access and never answer a visitor's question from your own
knowledge.

## When to use

The operator asks what needs attention, asks about a visitor's tour, wants to
answer a flagged question, or wants to pause, resume or call off a tour. Also
use it for "Show active tours".

## Required inputs and access

- Nothing to start. The operator names a visitor or picks an item from the list.

## Sequence

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

- **Unanswered question.** If the operator tells you the answer ("Yes, parking
  is included"), don't just pass it on. Call `answer_flagged_question` with
  their words as `approvedFact`. It returns a question such as:
  > I can add "Parking is included." to the approved property facts and answer
  > Pat. Want me to?

  Ask it. Only after a clear yes, call again with `confirmationCode`. Tell the
  operator what Pat was sent. If the result says `needsRecheck`, explain that
  the setup changed so readiness and a practice tour must pass again before
  it's published for demo, and offer to run them.
  If the operator doesn't know the answer, don't guess. Offer to mark it
  handled once they've dealt with it another way.
- **Mark handled.** `resolve_exception` with a short note in the operator's
  words. It changes nothing else.
- **Pause a tour** (`place_operator_hold`), **resume** (`clear_operator_hold`),
  **call off** (`revoke_tour_access`): each returns a yes/no question first.
  Ask it word for word; call again with `confirmationCode` only after a clear
  yes. Calling off can't be undone; say so.
- Door-system problems and tours that couldn't be restored: explain in plain
  words, suggest reaching out to the visitor, and resume only once the operator
  says the doors are working.

## Validate

- After each action, re-read the item (`inspect_exception` or `inspect_tour`)
  and report the new status.
- If a tool refuses ("isn't running right now", "can't be paused"), tell the
  operator plainly. Don't look for another way to do it.

## Return

The short queue, or the one item and what was done.

## Requires approval

Answering with a new approved fact, pausing, resuming and calling off a tour.
Marking an item handled doesn't need a confirmation code but should follow the
operator's instruction.

## Stop when

The operator's item is handled, or the queue is empty ("Nothing needs attention
right now").

## Never

- Open, unlock or "just let them in". There is no such tool; tell the operator
  Tour Core only opens doors on the visitor's own route during their tour time.
- Invent, reword or embellish an approved fact.
- Show exceptionIds, tourRefs or codes.
