# Step G rationale

## Problem

Step F (`2dcaf75`) already reads Guesty Lite, a Google Calendar fixture, and a Notion fixture into one job per stay. It keeps Scratch Lane, Scratch Court, and an onboarded property apart. It sends the door code only to that property's opted-in approved cleaner, and it keeps STOP, HELP, and the injury path. The engine still owns jobs, consent, the door code, and sending. `CLEANER_CORE_ENABLED` stays off unless it is `1` or `true`.

Step G is what Cory's first job needs before anyone turns the flag on for real: one CI workflow, a host review queue, source freshness, permanent-code handling, backups, a health check, and a restart that does not send the same text twice. The demo still does not set, revoke, or control the lock.

The stale threshold is configurable. The default is three hours, which is three missed hourly Guesty Lite polls (`GUESTY_POLL_MS` times 3, `10_800_000` ms). `CLEANER_CORE_STALE_AFTER_MS`, `openCleanerCore({ staleAfterMs })`, and `smoke --stale-after` override it. A fetch that is exactly three hours old is still fresh. One millisecond past that is stale. Freshness enforcement is on only when the drive asks for it (`watchFreshness`, or smoke `--watch-freshness` / `--fetched-at`). A clock jump in an older proof does not by itself block a reminder or a door code.

Task subagents were not the delivery path, so architect's ground and arena passes were done in-process, the same way as step F. Two shapes were screened before this one was kept.

## Usage (caller's view)

```ts
const core = openCleanerCore({
  enabled: cleanerCoreEnabled(env),
  tenantId: "scratch-lane",
  property: { id: "prop_12_scratch_lane", address: "12 Scratch Lane, Teaneck, NJ 07666", timeZone: "America/New_York" },
  ownerPhone: "+15555550100",
  cleaner: { phone: "+15555550101", approved: true },
  consented: true,
  sink,
  watchFreshness: true,
  sqlite: true,
  dataDir,
  backupDir,
});

await core.pollFeed(ical);
await core.fileReview("same-day-capacity");
core.backup(backupPath);
core.restore(backupPath);
await core.replay();
core.health();
```

`npm run cleaner:health` prints the same health document and does not send. `npm run cleaner:smoke` grows `--watch-freshness`, `--stale-after`, `--fetched-at`, `--review`, `--replay`, `--backup`, `--restore`, `--backup-dir`, and `--crash before-pin|after-accept`. A smoke run without those flags stays the step C through step F path.

Scratch phones stay the step F phones. The door code is still read from the tenant store inside the process. Smoke, logs, backups, and `evidence/step-g` replace it with `[redacted]`.

## Shape

The live store is still `cleaner-core.json`, one slice per tenant. SQLite is a mirror of that redacted JSON plus a `VACUUM INTO` snapshot. `node:sqlite` `DatabaseSync` on Node 22 has no `backup()` method, so the snapshot is `VACUUM INTO` a new file. The database is opened and closed per call. It is not a second writer of jobs, and two processes do not share it.

Each source keeps the last successful fetch time, a content fingerprint, freshness, and an interpretation status. When the watched feed is older than the threshold, a new offer and a door-code release are held. The host gets one stale-source text for that fetch, not one per poll. A newer fetch resolves that review. A host checkout fact that is already on the job is left in place when a stale re-read names another day. A removed stay can still cancel. A block is still not a departure.

Review items are `stale-source`, `airbnb-exception`, `same-day-capacity`, `missed-reminder`, `conflicting-replies`, `failed-sms`, `uncertain-sms`, `shared-chat-routing`, and `possible-code-exposure`. The engine opens stale, Airbnb ("booked on airbnb"), failed, uncertain, and code-like texts itself. The other four are filed through `fileReview` / `smoke --review`. Every review text goes to the owner through the same `emit` path. The id is stable, so a second file sends nothing.

An outbox row is written as `uncertain` before the sink accepts it. A crash after the sink accepts and before the row is marked sent leaves it uncertain. Replay tells the host once and does not send the job text again. A crash after departure clearance and before the door-code send resumes from the saved clearance and sends the code once. Sent and canceled rows are not emitted again. A revoked or expired lease is skipped. Replay re-delivers inbound ids and those ids short-circuit.

`revealPin` returns the code only for the approved cleaner role on that tenant. The send still requires opt-in and an explicit departure. Logs use one redaction helper: configured secrets, phone numbers cut to the last four digits, and calendar URLs replaced. Fetch of a calendar URL stays HTTPS-only, with no private address, no redirect, and a size and time limit.

A scheduled snapshot is written on the first poll of a process that has `backupDir`, then again after an hour. Restore replaces only that tenant's slice. Counters cover sends, failures, uncertain rows, cancels, injury, STOP, HELP, polls, poll failures, and poll duration. Open reviews and stale sources are counted from the saved rows.

## Synthesis decision

The base is the step F engine and the single `emit` path. A second job or review store lost: the merger would own the job a second time, and a replay could send from a queue the consent check never saw. Enforcing `STALE_SOURCE` on every JSON clock jump also lost: step D's departure and step F's removed-row and quiet-hours proofs move the clock by days and must still send. SQLite is a snapshot of the redacted slice, not a second job writer.

## Tradeoffs accepted

- We accept `watchFreshness` as an explicit switch, in exchange for step C through F staying green when the clock jumps.
- We accept `VACUUM INTO` instead of the SQLite backup API, because this Node build does not expose `DatabaseSync.backup()`.
- We accept `--crash` as the restart proof. It saves the row and then throws. It is not a kill of a live process, and a live host is still later.
- We accept filing same-day capacity, missed reminders, conflicting replies, and shared-chat routing through the review queue. The turn itself opens the five reviews a host will see on this demo: stale feed, Airbnb exception, failed send, uncertain send, and a code-like text.
- We accept a failed door-code send keeping its existing host text, with the review row saved and no second SMS.

## Alternatives considered

- A second review database beside `cleaner-core.json`. Replay and restore would have two sources of truth. Rejected.
- Treating every feed older than three hours as a hard stop, including the informational Notion view. That blocks reminders in proofs that only move the clock. Rejected.
- Blindly retrying an uncertain send after restart. The host can already see a failed send retried. An uncertain send might have been delivered. Rejected.

## Open questions and risks

- Off-box backup storage, dashboards beyond these counters, a poll-cadence screen, lock rotation through a lock MCP, and horizontal scaling are later. None of them block this demo: the fixture feeds, the frozen clock, and the JSON plus SQLite snapshot cover the journeys above.
- "that hurt my schedule lol" and an ordinary "fall" can still match the injury words. That stays a later copy problem. STOP and HELP still run before the injury check.
- The secret scan allowlists the historical tenant store, the Annex lock fixture, the step C through F proofs that already name those values. New docs, new tests, and `evidence/step-g` are not on that list.

## Next implementation step

Keep the flag off until the safety-gate doc and `prove-step-g.sh` are green. A smoke run without the step G flags stays the step C, step D, step E, and step F path.
