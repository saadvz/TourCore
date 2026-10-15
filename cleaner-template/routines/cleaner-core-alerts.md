# Routine: Cleaner Core Alerts

Wakes the cleaning Grok Bot the moment something happens on a turnover, for
example the cleaner texts YES, a question, or DONE, so the host hears about it
without asking. This is the cleaning bot's routine, not Tour Core's.

## Trigger

Authenticated webhook (POST). Grok creates the routine and gets a webhook
address and a sender (bearer) key. Those two values are installation secrets:

- They don't travel with this template. Each installation creates its own.
- Grok enters them through the Grok Bot's secure card into
  `save_alert_routine`. The card's fields are `url` and `token`. They never go
  in chat, in files, or in commands. Rotate the key first if it was ever shown
  anywhere else.
- Cleaner Core keeps them in its secret store and never returns them to Grok.
  Its reply never repeats them.

## What Cleaner Core sends

Minimal JSON. No message text, no phone numbers, no door code, and no
credentials:

```json
{
  "schemaVersion": 1,
  "eventId": "evt_...",
  "eventType": "cleaning.update",
  "occurredAt": "2026-10-15T13:05:00.000Z"
}
```

`eventType` is `cleaning.update` when something new is waiting for the host, or
`installation.test` for the test sent when the routine is saved. The payload
never holds message text. The words come from `check_now`.

Every new message from the cleaner or a saved contact wakes the routine. Cleaner
Core keeps at most one wake-up waiting. If several things happen before the
routine runs, it wakes once, and `check_now` returns all of them.

## Instructions for the routine

1. If `eventType` is `installation.test`, post:
   "Cleaner Core alerts are connected." and stop.
2. Otherwise call `check_now` without `googleEvents`. A webhook can't read the
   host's Google Calendar. The Cleaner Core Check routine does that.
3. Post each line in `alerts` in your own short words. Post nothing when
   `alerts` is empty. A new booking asks the host to confirm the usual times.
   "Have the guests left?" asks the host about the checkout. Only the host's
   yes in chat sends the door code, with `mark_guests_left`.
4. Read every item in `messages`. Tell the host in your own words when one
   needs them: running late, a question, a problem, supplies, an arrival time,
   a decline, STOP, or an injury. Stay quiet on routine replies.
5. When a message gives an arrival time, call `save_arrival` with it, like
   11:30 AM.
6. If a message needs a reply, draft one and offer it to the host. Don't send
   it from the routine. It goes out with `send_message` only after the host's
   yes in chat.
7. If the reply has `completed`, call `get_job_photos`, look at the photos, and
   compare them with the checklist. Summarize the cleaning in your own words.
8. If the reply has `needsTimes`, ask the host for the checkout time and the
   next check-in time, then call `confirm_times`.
9. Never show a door code, an id, or the webhook payload.

## Connecting it

After Activate and the checks, `get_state` asks for the two routines. Then:

1. Grok creates this routine with an authenticated webhook trigger and the
   instructions above.
2. Grok asks for the webhook address and key with the Grok Bot's secure card
   and passes them to `save_alert_routine` as `url` and `token`. The values are
   never typed in chat.
3. Cleaner Core sends one `installation.test`. Grok posts
   "Cleaner Core alerts are connected." and the setup is done.

If the secure card isn't available, Grok stops and tells the host so. If a
value was pasted in chat anyway, Grok doesn't repeat it and asks the host to
rotate the key.

## Allowed tools

`check_now`, `confirm_times`, `get_state`, `save_arrival`, and
`get_job_photos`.
