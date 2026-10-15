# Cleaner Core Grok demo: design

Date: 2026-10-15. Status: draft for Saad's review.

## Goal

Saad runs one end-to-end Cleaner Core demo in the cleaning Grok Bot. The demo shows:

- the Grok setup: property, people, group chat, and booking sources
- a booking arriving in Google Calendar and the texts that follow on their own
- every text the cleaner receives
- every alert the host gets from the Grok Bot

The demo is rehearsed on Scratch numbers first. Then it runs once on real phones.

## What Saad decided

- Demo surface: the cleaning Grok Bot. It is a separate Grok Bot from Tour Core.
- Stages: a Scratch rehearsal on 555 numbers first, then one final run on real phones.
- Booking sources: Guesty Lite and Google Calendar.
- Google: Grok reads it with its own Google Calendar connector. Cleaner Core never signs in to Google.
- New booking on stage: Saad adds a stay in Google during the demo.
- Scenarios: the happy turnover and booking changes. Opt-out and injury are not shown.
- Host alerts are instant. A cleaner's reply wakes Grok within seconds.
- Use Grok's own tools as much as possible. Keep the Cleaner Core tools thin.

## Rule: the user never leaves the Grok Bot chat

All of setup happens inside the Grok Bot chat. The user never opens another page, app, or terminal.

| Setup step | How it stays in the chat |
| --- | --- |
| Property, host, cleaner, observer | The user answers in chat. |
| Group chat | The Grok Bot confirms it in chat. There is nothing to create. |
| Guesty Lite link | The user pastes the link in chat. |
| Google Calendar | The Grok Bot's own Google Calendar connector. Any approval prompt is the Grok Bot's own, shown in the chat. |
| Door code | The Grok Bot's secure card. |
| Texting | The user answers in chat. |
| Check routine and Alerts routine | The Grok Bot creates both routines itself. |
| Alerts routine address and key | The Grok Bot's secure card, passed to `save_alert_routine`. |

The user needs the Guesty Lite link, which comes from Guesty. When the user doesn't have it to hand, the Grok Bot tells them where to find it in one line. When the user has no Guesty Lite listing, Google Calendar alone is enough.

### Admin prep, not part of the user's flow

Saad does these once on the server, before a demo. The user never sees them:

- `CLEANER_CORE_ENABLED` on, and the cleaning Grok Bot connected.
- For the real-phone run: the two phones on `CLEANER_CORE_SMS_ALLOWLIST`, plus the verify-cleanercore preflight. The preflight covers the Railway connector, the Twilio inbound webhook, and the carrier STOP block.

## What is not in scope

- A server timer for polls or reminders. That work is parked. The note is in the session notes folder.
- Notion.
- A Google sign-in on the Cleaner Core side.
- A tool that creates the group chat.
- Opt-out and injury scenarios. Their existing safety behavior stays as it is.

## Design

### Grok's side

1. **Setup conversation.** The steps are the same as today: property, host, cleaner, optional observer, Guesty Lite link, door code in the private box, and texting. One question is added: "Do you also take bookings in Google Calendar?" When the answer is yes, Grok uses its own Google Calendar connector. Cleaner Core stores no Google credential. After texting is saved, `get_state` lists the group chat in `done`, with the people in it.
2. **Cleaner Core Check routine.** This is a scheduled Grok routine. It runs every few minutes for the demo and hourly in real use. Each run, Grok reads the property's Google Calendar events, calls `check_now` with them, and posts any new alerts in plain words. When Saad says "check my calendars," Grok runs the same steps at once.
3. **Cleaner Core Alerts routine.** This routine has an authenticated webhook trigger, built the same way as Tour Core's Operator Updates routine. A webhook wakes Grok. Grok calls `check_now` with no events and posts the new alerts. The routine's address and key are installation secrets. The Grok Bot shows its secure card in chat. Saad enters the address and key there, and the Grok Bot passes them to `save_alert_routine`. Cleaner Core does not use Tour Core's setup page. The values never appear in chat text, files, or logs.

The routine instructions live in `grok-template/routines/`. The tool descriptions and the `get_state` next steps tell Grok when to call each tool.

### Cleaner Core's side

1. **`check_now`.** This is the main new tool. Input: an optional `googleEvents` object in the Google Calendar API `events.list` shape (`timeZone`, `items`), passed through as Grok received it. The tool does these steps in order:
   - Re-reads the saved Guesty Lite link with `readPublicCalendar`, when one is saved.
   - Applies the Google events through the existing Google reader (`readGoogleCalendarFixture`, behind a thin `googleCalendarSource` wrapper). The server stamps the tenant id. Grok does not choose it. Each call is a full snapshot, so a stay missing from the list is removed. A job is kept when its cleaning started or finished, its door code was sent, or its checkout day has passed. Those stays only left the read window.
   - Merges the sources through the existing `readSource` path. A stay in both calendars is one job.
   - Runs `runReminders()`.
   - Returns the host alerts added since the last `check_now`, and marks them shown.

   It sends nothing when `CLEANER_CORE_ENABLED` is off. Calls do not overlap: a second call waits for the first.
2. **`run_checks`** accepts Guesty only, Google only, or both. Today it requires the Guesty link.
3. **Alert push.** When Cleaner Core records a new host alert, it queues one `cleaning.update` event. The queue and the sender are Tour Core's existing `OperatorEventOutbox` and `GrokRoutineWebhookSink`. Cleaner Core keeps its own outbox file and its own address and key, `CLEANER_CORE_ROUTINE_URL` and `CLEANER_CORE_ROUTINE_KEY`, in the existing secret store. The event holds only `schemaVersion`, `eventId`, `eventType`, and `occurredAt`. It leaves out `propertyId`, because cleaner property ids fail the shared event schema. It holds no text, no phone number, and no door code. The existing 15-second retry delivers it. With no address saved, events wait in the queue and nothing fails.
4. **`save_alert_routine`.** This is the second new tool. Input: the routine's webhook address and key, from the Grok Bot's secure card. It checks that the address is https and stores both values in the secret store as `CLEANER_CORE_ROUTINE_URL` and `CLEANER_CORE_ROUTINE_KEY`. It replaces an earlier pair and keeps no history. Its reply never includes either value, and it logs neither. It then queues one test event, so the Grok Bot can confirm the routine woke.
5. **`read_outbox`** on Scratch properties shows each text's wording. The door code prints as `[redacted]`.

No new flag. Everything sits behind `CLEANER_CORE_ENABLED`. The Scratch tools stay Scratch-only.

### Safety rules that stay as they are

- The cleaner gets the offer only after the host states the checkout and check-in times. A calendar date never confirms a time.
- The door code goes only in a private text to the approved cleaner, after the host says the guests have left.
- A live text goes only to a number on the texting allowlist.
- `docs/cleaner-core-safety-gates.md` stays green.

## Demo script (Scratch rehearsal)

Property: 12 Scratch Lane. Host `+15555550100`. Cleaner `+15555550101`. The Google calendar is one Saad owns for the demo. The door code is made up.

**Before the first booking**
- Enter each stay in Google as a timed event, from the check-in time to the checkout time. An all-day Google event ends on the day after its last day, so the checkout would read a day late.
- The Check routine reads Google from 7 days ago to 60 days ahead. A stay that ends today stays in the read.
- Create the Check routine and the Alerts routine, and save the alert routine, before Grok asks for the times. `get_state` asks for the routines right after the checks.

**Happy turnover**
1. Grok setup. Grok confirms the group chat.
2. Saad adds a stay in Google that checks out today and says "check my calendars." Grok reports the new booking and asks for the checkout and check-in times. A next stay is optional. With no next stay, only the checkout time is saved.
3. Saad answers. With group chat on, the cleaner first gets the invite to the cleaning group.
4. The cleaner replies YES twice. The first YES accepts the invite, and the offer goes out. The second YES takes the offer. In the rehearsal, Saad sends each YES with `send_test_text`. Grok shows the host alert.
5. The reminder goes out on the first check at or after 8 AM on the cleaning day.
6. "Guests have left." The private door code goes to the cleaner. The cleaner sends DONE, and the host gets the ready note.

**Booking changes**

These run on the same property after the first job is done. Nothing is reset.
1. Saad adds a later stay in Google and checks. Grok reports the new booking and asks for the times. The finished job stays done.
2. Saad answers. The cleaner already joined, so the offer goes out at once. The cleaner replies YES once.
3. Saad moves the later stay in Google and checks. Grok asks for the times again. Saad answers, and the cleaner gets the new time.
4. Saad deletes the later stay and checks. The cleaner gets one text that the job is called off. Nothing goes out about the finished job.

The exact texts come from the existing engine. The rehearsal records them. `reset_scratch` is only for starting the rehearsal over.

## Real-phone run

This runs after the Scratch rehearsal passes. Before it:

- Run the verify-cleanercore preflight: the Railway connector, the Twilio inbound webhook, and the carrier STOP block.
- Put both phones on the texting allowlist.
- Create the Check routine and the Alerts routine, and save the alert routine, before Grok asks for the times.
- Enter each stay in Google as a timed event, from check-in to checkout. A next stay is optional.
- The Check routine reads Google from 7 days ago to 60 days ahead.

The run follows the demo script on one property. In group mode, the cleaner's phone replies YES twice for the first job: once to the invite, then once to the offer. The booking changes run after the first job is done, on a later stay, with no reset.

Saad runs the demo. Each live text to a real person waits for Saad's okay. No agent sends one.

## Testing

Tests use fake timers, `setCleanerCalendarFetch` for Guesty, plain event objects for Google, only 555 numbers, and a made-up door code. They show:

- With the flag off, `check_now` sends nothing and queues nothing.
- Google events become a job. A moved stay updates the job. A removed stay calls it off. A stay in both calendars is one job.
- A reminder fires once at its trigger time. A restart does not resend it.
- A `cleaning.update` event has no text, no phone number, and no door code.
- The Scratch outbox shows the wording, with the door code redacted.
- Two `check_now` calls at the same time do not double-send.

Proof: run the verify-cleanercore skill's `prove-step-g.sh`, which reruns steps D, E, and F. The safety gates stay green.

## Open items to settle in the plan

- Confirm that the Grok Bot's secure card hands its value to the tool call without putting it in the chat or the model's context. If the value would show up there, it breaks the AGENTS.md secrets rule. The fallback is Railway environment variables that Saad sets as admin prep, so the user still never leaves the chat.
- Confirm that the Grok Bot can create a scheduled routine and a webhook routine from chat, and can read the webhook's address and key itself. If it can read them itself, the secure card step is skipped.
- Confirm that `save_door_code` already gets its value from the Grok Bot's secure card. If it does not, move it to the card.
- How Grok's Google Calendar connector shapes an event. The plan keeps a thin adapter if it differs from `events.list`.
- Settled while planning: `triggerDue` sends a trigger that is already past due, so the 8 AM reminder fires on the next check. On a new booking, the engine already writes a `host-checkout` note asking for the checkout time.
