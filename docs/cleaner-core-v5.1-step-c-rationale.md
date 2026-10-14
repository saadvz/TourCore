# Step C rationale

## Problem

Cory's first cleaning job needs a Guesty Lite feed read, a host-confirmed checkout and check-in, and reminders that survive a second poll, a failed send, and a process restart. The module already offers a same-day turnover straight from date-only iCal and texts a door code on YES. That trusts a calendar clock, treats every event as a stay, and keeps the only job in memory. Step C has to replace that path without touching touring SMS. `CLEANER_CORE_ENABLED` stays off unless it is `1` or `true`.

Task subagents were not available in this session, so architect's ground and arena passes were done in-process. Two shapes were written and screened against the design red flags before this one was kept.

## Usage (caller's view)

```ts
const core = openCleanerCore({
  enabled: cleanerCoreEnabled(env),
  property: { id, address, timeZone },
  ownerPhone: "+15555550100",
  cleaner: { phone: "+15555550101", approved: true },
  consented: true,
  sink,
  now: () => new Date("2026-10-14T15:00:00.000Z"),
  dataDir,
});

const read = await core.pollFeed(icalText);
const answer = await core.receive({ id, from: ownerPhone, text: "1:00 PM" });
const reminders = await core.runReminders();
const jobs = core.jobs();
const transcript = core.transcript();
```

`pollFeed` is the only way to apply a feed. `receive` answers the owner. `runReminders` is the only way a reminder goes out. Flag off returns `disabled` and sends nothing.

## Shape

One engine owns jobs, host-time facts, tombstones, the outbox, and the transcript. The iCal reader is a pure function and returns stays, blocks, and turnovers. It keeps the calendar date and throws away any clock. Blocks never become turnovers and never become the next arrival.

A host time is a separate fact with its own version. The job's operational clock is the latest fact. A later feed cannot overwrite it. Feed date changes bump a monotonic job version. Removing a stay writes a cancellation tombstone and marks that same job canceled, so the turnover cannot come back as a second live job.

Outbound texts share one send path. The outbox key is the idempotency key. `sent` is written only after the sink accepts the text. A throw leaves `failed`. The next reminder run retries that key once it succeeds, then refuses it. Pending reminders for an older host version or an older checkout date are marked canceled and are not retried. Opt-out skips that path entirely.

The public surface is poll, receive, remind, and the three reads (jobs, outbox, transcript). Step C has no pin argument and no READY status.

## Synthesis decision

The base is the single engine. A staged pipeline (parse, reconcile, plan, deliver as separate callers) lost: the caller would have to run the stages in order and two modules would write the job. The pure feed reader is the piece kept from that alternative, so the engine does not parse iCal inline and tests can still see dates only through `jobs()`.

## Tradeoffs accepted

- We accept a JSON file in `dataDir` in exchange for a restart that reloads the same outbox. There is no network fetch of the Guesty URL.
- We accept one outbound notice per poll or reply in exchange for one question at a time. A second turnover stays on the job list until the earlier one is confirmed, declined, or canceled.
- We accept that a removed stay stays canceled when the same snapshot returns, in exchange for a tombstone that an older poll cannot undo. A changed snapshot of that same UID updates the one job in place.
- We accept property default clocks (11:00 AM and 4:00 PM) as the question's proposed time, in exchange for never reading a clock from iCal.

## Alternatives considered

- Keep `scheduleFromIcal` and add host confirmation beside it. Two ways to book the same turnover. Rejected.
- Store the host clock on the calendar event. The next poll would have to know which field is sacred. The separate fact list makes "newer host time wins" a read of one list.
- Send the door code after YES, behind another flag. Step C's demo blocker is that no such send exists.

## Open questions and risks

- A live HTTPS fetch of the host's Guesty link, quiet hours, group texts, departure clearance, and the private PIN are later.
- Guesty feeds that restore a removed stay without changing the snapshot stay canceled until the snapshot changes.

## Next implementation step

Replace the in-memory offer engine with the poll, receive, and reminder operations above, and point the smoke CLI at that path with no door code.
