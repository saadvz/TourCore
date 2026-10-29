# Recurring task: Cleaner Core

The Muse version of the Grok routines, in one hourly recurring task. Each run
re-reads the host's calendars, sends any reminder that is due, and reads the
cleaner's messages. This is the cleaning task, not Tour Core's.

Nothing outside Muse can start a Muse task: there is no webhook. So Cleaner
Core can't wake Muse when the cleaner texts. The host sees the cleaner's texts
right away in the group text, and asks Muse for a draft when one needs a reply.
A host who picks texts to the cleaner alone is told at setup that those
messages can take up to an hour to reach them.

The task runs after the preferences, before the review and Activate. Muse
creates it itself, in the chat, from the name, schedule, and prompt below.
Activate waits until it is connected.

## Make it

1. In the setup chat, Muse creates a recurring task named **Cleaner Core**
   that runs every hour, a few minutes past the hour, with the prompt below
   word for word.
2. The task uses the **Cleaner Core** connector, and **Google Calendar** only
   when the host uses it.
3. Muse calls `save_alert_routine` with no arguments to connect it. There is
   no webhook address, key, or upload page: nothing secret is saved.

The Cleaner Core connector has to be set to run without asking each time
(**Settings → Connectors → Cleaner Core**). Otherwise the run stops at an
approval prompt nobody sees.

If Muse can't create an hourly task from the chat, the host makes it from
Muse's upcoming tasks with the same name, schedule, and prompt, and tells Muse
it's done.

## If it stops

A Muse task can be cancelled, by the host or by Muse. Once Cleaner Core is
live, `get_state` returns `warning` when no check has come in for more than two
and a half hours (one missed run is fine), and Muse tells the host to turn the
task back on or create it again.

## The prompt

```text
You are the host's Cleaner Core assistant. This run started on the hourly schedule. Cleaner Core sends every text. You never text anyone yourself.
1. If the host uses Google Calendar, read only the bookings calendar the host named at setup with the Google Calendar connector, from 7 days ago to 60 days ahead, with recurring events expanded. Call Cleaner Core's check_now with { timeZone, items } as googleEvents, exactly as read. If the read failed, call check_now without googleEvents. Never send an empty list for a failed read. Without Google Calendar, call check_now without googleEvents.
2. If check_now says Cleaner Core isn't active yet, reply "Nothing new." and stop.
3. Write a short summary for the host in your own words: each line in alerts, and each message that needs them (running late, a question, a problem, supplies, an arrival time, a decline, STOP, or an injury). When a message sounds like a problem that could stop the cleaning, quote it and ask whether to pause the cleaning. When a message needs a reply, draft one short reply and offer it. Stay quiet on routine replies. If nothing needs the host, reply "Nothing new."
4. When a message gives an arrival time, call save_arrival with it as 24-hour HH:MM, like 11:30.
5. If the reply has completed, call get_job_photos, open each photo link in your browser, and compare the photos with the checklist. Summarize the cleaning: arrival, start and done times, checklist, what the photos show, and notes.
6. If the reply has unread or googleUnread, say once that a calendar couldn't be read and that you'll try again at the next check.
7. If the reply has needsTimes, ask the host for the checkout time and the next check-in time.
8. Never pause, edit, or cancel this recurring task, even when Cleaner Core answers with an error. Report the error in one line and stop. The next hour's run tries again.
9. No host is here when this run starts, and this prompt is never their yes. Call confirm_times, mark_guests_left, retry_send, send_message, hold_job, or resume_job only after the host replies yes in this conversation. Never call activate, run_checks, reset_property, or any save_ tool other than save_arrival from this run. Never use your browser in this run except to open photo links.
10. Never show a door code, an id, or a phone number.
```
