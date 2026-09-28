# Routine: Tour Core Operator Updates

Wakes the Tour Core Bot when something happens on a tour the operator asked to
hear about (a booking, a tour starting or finishing, a cancellation) or when a
visitor needs the team's judgment, so the operator hears about it without
asking "What needs attention?".

## Trigger

Authenticated webhook (POST). Grok gives the routine a webhook address and a
sender (bearer) key when the trigger is created. Those two values are
installation secrets:

- They don't travel with this template; each installation creates its own.
- They go into the **Tour updates (Grok Routine)** card on Tour Core's
  secure setup page, never in chat, tool arguments, files or commands. See
  "Connecting it" below. Rotate the key first if it was ever shown anywhere
  else.
- Tour Core keeps them in its secret store and never returns them to Grok.

## What Tour Core sends

Minimal JSON. No visitor names, phone numbers or message text, and no
credentials:

```json
{
  "schemaVersion": 1,
  "eventId": "evt_...",
  "eventType": "tour.booked",
  "propertyId": "prop_...",
  "tourId": "prop_...~...",
  "occurredAt": "2026-09-28T13:05:00.000Z"
}
```

`eventType` is one of:

| eventType | Sent when | Points at |
| --- | --- | --- |
| `tour.booked` | a visitor chose a time, agreed to texts and records, and passed the identity check | `tourId` |
| `tour.started` | the visitor's tour began | `tourId` |
| `tour.completed` | the visitor finished the tour | `tourId` |
| `tour.cancelled` | the tour was cancelled | `tourId` |
| `exception.created` | a visitor needs the team (e.g. a question with no approved answer) | `exceptionId` |
| `access.problem` | a door or access problem on a tour | `exceptionId` |
| `verification.problem` | an identity check didn't pass | `exceptionId` |
| `installation.test` | a test update (no property, tour or issue) | nothing |

`tourId` is the tour handle (`inspect_tour`'s `tourRef`). Only the kinds the
operator chose are sent (the recommended default is everything except
cancellations; before any choice, only the three problem kinds). Only real
text-message tours produce updates, not practice tours or the browser demo.
Something that happened before its kind was turned on is never sent late.
Missed tours (no-shows) aren't detected yet.

The same event always has the same `eventId`; Tour Core retries a failed
delivery with the same `eventId`, so treat a repeat as the same update.

## Instructions for the routine

1. If `eventType` is `installation.test`, post: "Tour updates are connected.
   I'll let you know about your tours here." and stop.
2. Otherwise call `get_operator_update` with the `eventId`. Tour Core is the
   source of truth; don't rely on anything in the webhook beyond the ids.
3. Post its `summary` in plain words, for example:
   > New tour booked: Testy is scheduled to tour Unit 1A today at 3:00 PM.

   > Testy's Unit 1A tour has started.

   > Testy's Unit 1A tour is complete.
4. For an issue: if `stillOpen` is false (it was handled already), stop
   quietly. For an unanswered question, ask for the answer itself (not a
   yes/no), so the only confirmation later is Tour Core's:
   > Testy, touring Unit 1A, asked how many bedrooms it has. Tour Core doesn't
   > have that yet. The tour is still active. What should I tell them? (Or say
   > "leave it" and the property team will follow up.)

   When the operator answers, the visitor gets the answer and is returned to
   the step they were on.
5. Don't act on tours or issues. Answering with a new approved fact, pausing,
   resuming or calling off a tour happen only when the operator replies, via
   the Work Exception skill and its confirmation questions.
6. Never show ids, codes or the webhook payload.

## Connecting it (routine setup)

The Install Tour Core skill offers tour updates after the first property is
saved. If the operator says yes:

1. Grok saves their choice (`set_notification_preferences`) and creates this
   routine itself, with an authenticated webhook trigger and the instructions
   above.
2. Grok opens Tour Core's secure setup page (`get_secure_setup_url`, step
   `operator-alerts`) in its cloud browser, next to the routine's trigger
   panel. The **Tour updates (Grok Routine)** card has two masked fields
   (webhook address and key) and a masked paste box, "Or paste the routine's
   whole webhook example"; Tour Core pulls the address and bearer key out of
   the example itself.
3. If the routine panel has copy buttons and both values stay hidden on
   screen, Grok may copy each one into the matching masked Tour Core field
   itself, without reading, repeating or storing it.
4. If either value is shown on screen, Grok doesn't move it. It hands control
   of the browser to the operator, who copies both values across (or pastes
   the whole webhook example into the paste box).
5. The address and key never go in chat, tool arguments, files or commands.
   Tour Core then has Grok send a test update (`test_operator_alerts`).

## Current Grok limitation

Grok's computer use works from screenshots, so any value visible on screen
enters the model's context. Tour Core can't see or verify how the Routine
panel displays the webhook address and key. That's why Grok moves the values
itself only when both stay masked (copy buttons), and otherwise the operator
copies them (or pastes the whole example into Tour Core's paste box). Webhook
credentials are never MCP tool arguments.

This policy was written from Tour Core's side; it has not been verified
against a live Grok Routine panel from this environment.

## Allowed tools

`get_operator_update`, `inspect_exception`, `inspect_tour`, and
`list_exceptions` if an issue can't be found.
