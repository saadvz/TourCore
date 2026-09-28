# Routine: Tour Core Exception Alert

Wakes the Tour Core Bot when a visitor needs the team's judgment, so the
operator hears about it without asking "What needs attention?".

## Trigger

Authenticated webhook (POST). Grok gives the routine a webhook address and a
sender (bearer) key when the trigger is created. Those two values are
installation secrets:

- They don't travel with this template; each installation creates its own.
- The operator enters them on Tour Core's **secure setup page** (opened by the
  Install Tour Core skill), never in chat. Rotate the key first if it was ever
  shown anywhere else.
- Tour Core keeps them in its secret store and never returns them to Grok.

## What Tour Core sends

Minimal JSON. No visitor names, numbers or message text, and no credentials:

```json
{
  "schemaVersion": 1,
  "eventId": "evt_...",
  "eventType": "exception.created",
  "propertyId": "prop_...",
  "exceptionId": "exc_...",
  "occurredAt": "2026-09-28T13:05:00.000Z"
}
```

`eventType` is `exception.created`, or `installation.test` for a test alert
(no property or exception). The same issue always has the same `eventId`;
Tour Core retries a failed delivery with the same `eventId`, so treat a
repeat as the same alert.

## Instructions for the routine

1. If `eventType` is `installation.test`, post: "Operator alerts are connected.
   Tour Core can reach you when a visitor needs attention." and stop.
2. Otherwise call `inspect_exception` with the `exceptionId`. Tour Core is the
   source of truth; don't rely on anything in the webhook beyond the ids.
3. If the issue isn't open any more (it was handled already), stop quietly.
4. Post one short message in everyday words: who (first name is fine), which
   unit, what happened, whether the tour is still going, and the choices from
   `nextSteps`. For an unanswered question:
   > A visitor touring Unit 101 asked whether the property has a pool. Tour
   > Core doesn't have an approved answer. The tour is still active. Would you
   > like to add an approved answer or leave it for the property team?
5. Don't act on the issue. Answering with a new approved fact, pausing,
   resuming or calling off a tour happen only when the operator replies, via
   the Work Exception skill and its confirmation questions.
6. Never show ids, codes or the webhook payload.

## Allowed tools

`inspect_exception` (and `list_exceptions` if the id isn't found).
