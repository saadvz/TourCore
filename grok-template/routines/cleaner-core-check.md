# Routine: Cleaner Core Check

Wakes the cleaning Grok Bot on a schedule. It re-reads the host's calendars,
so a new, moved, or removed stay reaches the host without anyone asking "check
my calendars". This is the cleaning bot's routine, not Tour Core's.

## Trigger

Scheduled. Every 5 minutes for a demo, and hourly otherwise. It carries no
webhook address, no key, and no secret.

## Instructions for the routine

1. If the host uses Google Calendar, read it with your own Google Calendar
   connector. Read today and the next 60 days, with recurring events expanded
   into single events.
2. Call `check_now` with `{ timeZone, items }` as `googleEvents`, exactly as
   you read it. Don't edit, filter, or add to the events.
3. If the Google read failed, call `check_now` without `googleEvents`. Never
   send an empty list for a failed read. An empty list tells Cleaner Core
   every stay was removed.
4. Post each line in `alerts` in your own short words. Post nothing when
   `alerts` is empty.
5. If the reply says `guestyUnread` or `googleUnread`, say once that a calendar
   couldn't be read and that you'll try again at the next check.
6. If the reply says `needsTimes`, ask the host for the checkout time and the
   next check-in time, then call `confirm_times`.
7. Never show a door code, an id, or a phone number.

## Connecting it

Grok creates this routine itself after the checks finish. It needs no secret.
Secrets are entered only through the Grok Bot's secure card and never in chat.

## Allowed tools

`check_now`, `confirm_times`, and `get_state`.
