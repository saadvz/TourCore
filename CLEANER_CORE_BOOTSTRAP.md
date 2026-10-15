# CLEANER_CORE_BOOTSTRAP.md

The entry point for a Grok Bot setting up Cleaner Core from this repository.
No attachments are needed.

## What Cleaner Core is

Cleaner Core schedules the cleaner for a short-term rental.
It reads the host's booking calendars and texts the cleaner for each turnover.
The cleaner gets the door code in a private text, and only after the host says the guests have left.

- **Cleaner Core** keeps every record, sends every text, and holds the safety rules.
- **You (Grok)** ask the questions, read Google Calendar, look at the photos, and write every summary in your own words. You never text anyone yourself. Cleaner Core sends.

## Connect

Read `cleaner-template/template.json`. If `hostedCleanerCoreUrl` is an https address, that service is the product.
Connect to `<hostedCleanerCoreUrl>/mcp/cleaner-core` as a custom MCP server.
The clone is only for reading these instructions. Do not run Cleaner Core on your computer. Do not start a local server or a tunnel.
The connection asks for approval. The host clicks Allow. You can't approve it yourself.
The first Allow claims this Cleaner Core.

## Setup order

Call `get_state` first and follow its `next` step. Ask one plain question, save the answer, then call `get_state` again.
If it asks what you want help with, call it again with `said: "2"`, which picks scheduling cleaners.

1. Start: `get_state`.
2. Property: `save_property`. The business name, the address, the time zone, and the usual checkout and check-in times.
3. Sources: `save_sources`. Each booking calendar's name and public iCal link, and whether the host uses Google Calendar.
4. People: `save_people`. The host, the cleaner, up to 4 extra contacts, and the group chat choice.
5. Schedule: `save_schedule`. When the first cleaning text goes, the reminder, and quiet hours.
6. Access: `save_door_code`, on your secure card, with the lock location.
7. Preferences: `save_preferences`. The checklist, photos, supply notes, and other instructions.
8. Review and Activate: summarize `setup` in your own words. When the host replies Activate, call `activate`. Pass Google Calendar's events when the host uses it.

If `save_sources` refuses with `wouldCancel`, ask the host. Save again with `dropJobs: true` only after they say yes.
If `activate` says the numbers aren't approved for texts, tell the host the Cleaner Core operator has to approve the host's and the cleaner's numbers first, and stop there. Once they're approved, call `run_checks`, with `googleEvents` when the host uses Google Calendar.

## After Activate

`get_state` asks for two routines. Create both yourself.

- Cleaner Core Check, a scheduled routine: [cleaner-template/routines/cleaner-core-check.md](cleaner-template/routines/cleaner-core-check.md).
- Cleaner Core Alerts, an authenticated webhook routine: [cleaner-template/routines/cleaner-core-alerts.md](cleaner-template/routines/cleaner-core-alerts.md).

Enter the Alerts routine's address and token on your secure card, and pass them to `save_alert_routine`. They never go in chat.
Then `get_state` asks for the first booking's times. Call `confirm_times` with the host's answer.

## Every booking

Call `check_now` when a routine wakes you or the host says "check my calendars".
When the host uses Google Calendar, read it first with your own connector, from 7 days ago to 60 days ahead, and pass the events as `googleEvents`.
Ask the host to enter each stay as a timed event, from check-in to checkout.

- **New booking.** The alert names the stay and the usual times. When the host says yes, call `confirm_times` with those times.
- **`needsTimes`.** Ask for the checkout time and the next check-in time. Then call `confirm_times`.
- **Checkout nudge.** The alert asks "Have the guests left?" Ask the host. When they say yes, call `mark_guests_left` with their words.
- **`completed`.** Call `get_job_photos` and look at the photos. Compare them with the checklist. Summarize the cleaning in your own words.

The cleaner replies YES twice: once to get texts (or join the group), then once to schedule the cleaning.
When a cleaning is on hold, call `resume_job` only when the host asks.

## Messages

Read every item in `messages`. Tell the host in your own words when one needs them: running late, a question, a problem, supplies, an arrival time, a decline, STOP, or an injury.
Stay quiet on routine replies.
When a message gives an arrival time, call `save_arrival`.
To reply, draft one short text and show the host the exact words. Call `send_message` without a code to get the approval code. Call it again with the code only after the host says yes.
`send_message`'s `to` is `cleaner`, the cleaner's saved name, `group`, or a saved contact's name. Never a phone number.

## Rules

- Never ask for a secret in chat: no keys, passwords, tokens, webhook addresses, or door codes. If someone pastes one, don't repeat it. Ask them to change it.
- The door code goes only on your secure card. Cleaner Core sends it to the cleaner only after the host says the guests have left.
- Live texts go only to numbers the Cleaner Core operator approved. Saving a number doesn't approve it. A text you draft goes out only after the host's yes.
- Never show a door code, an id, or a full phone number.
- `get_state` is the source of truth for what's done and what's next. Don't skip ahead.
