# Step F rationale

## Problem

Step E (d469915) already reads Guesty Lite and a Google Calendar fixture into one job per stay, and it keeps Scratch Lane and Scratch Court apart. Step F adds a third booking source, Notion, plus a way to set up a new property and a way to share the cleaner texts. The engine still owns jobs, consent, the door code, and sending. `CLEANER_CORE_ENABLED` stays off unless it is `1` or `true`.

A Notion database can be missing or unreadable. That has to be a host-facing fallback with no crash and no cleaning text. A row that leaves the database cancels the future reminder. The same snapshot read again, including after a restart, must not open a second job or send a second question. A block is never a departure. Two sources that describe one stay stay one job, with both sources recorded.

Onboarding has to create a property that does not see Lane or Court. It activates only after the cleaner opts in and the owner approves. Quiet hours hold reminders. The outdoor code is a sealed reference. This demo cannot rotate or revoke the lock.

A group text is sent only when the account can send one and every participant has opted in. Otherwise the cleaner gets the normal text and the others get a labeled copy. A number that has not opted in is left out. The door code never goes to a group, an observer, a mirrored copy, or an unapproved number.

Task subagents were not available, so architect's ground and arena passes were done in-process, the same way as step E. Two shapes were screened before this one was kept.

## Usage (caller's view)

```ts
const source = notionFixtureSource(fixtureJson);
const core = openCleanerCore({
  enabled: cleanerCoreEnabled(env),
  tenantId: "scratch-lane",
  property: { id: "prop_12_scratch_lane", address: "12 Scratch Lane, Teaneck, NJ 07666", timeZone: "America/New_York" },
  ownerPhone: "+15555550100",
  cleaner: { phone: "+15555550101", approved: true },
  consented: true,
  sink,
});

await core.readSource(source, { conversation: "closed" });
```

`pollFeed` and `readSource` are unchanged for a Guesty-only or Google-only drive. A Notion snapshot joins the same normalizer. Permission missing or insufficient sets `sync.fallback` and returns `sent: []`. It does not throw and it does not wipe a previous good snapshot.

Onboarding is `beginOnboarding`, `attachPreview`, and `answerOnboarding` on an isolated draft. APPROVE publishes a second tenant slice only when the cleaner has replied YES. The smoke command is `npm run cleaner:smoke -- --notion <fixture>`, `--onboard`, and `--group-mode native|mirrored`.

Scratch Lane and Scratch Court stay the step E tenants. Annex is the onboarded property: owner `+15555550120`, cleaner `+15555550121`, observer `+15555550122`, 9 Scratch Annex. The outdoor code is read from a fixture file inside the process. Smoke and the evidence folder replace a door code with `[redacted]` and must not contain the digits.

## Shape

`BookingSource.read()` now also returns a Notion snapshot. `notionFixtureSource` maps date and status columns onto the same stay and block records as Guesty and Google. Date-only and timed values both become the tenant's calendar date. The clock on a timed value is ignored. Status `stay`, `reserved`, `booked`, and `confirmed` are stays. `block`, `blocked`, and `owner block` are blocks. `canceled`, `cancelled`, and `removed` drop the row. An unknown status is skipped.

`normalizeSnapshots` still walks Guesty, then Google, then Notion. The same check-in or the same checkout is one job. The earlier source keeps the dates. A later checkout that disagrees is a conflict, not a second job. Provenance lists every source uid on that job.

The engine stores freshness from `fetchedAt`. A read older than three hours, or a read with no `fetchedAt`, is stale and is still applied. Repeat reads keep the same outbox ids, so a restart does not send the question again. A removed row cancels the job with the existing cancel sentence and does not send another reminder.

Onboarding is a state machine in `onboarding.ts`. The engine stores the session and publishes the new tenant into the same `cleaner-core.json` slice map step E already uses. Unknown tenant ids do not adopt a file that belongs to someone else. Quiet hours block reminders only. The pin text is not a reminder.

Job texts go through one recipient resolver. When a door code is set, or a group was requested, the offer, the confirmation, the reminder, and the cancel notice go only to the opted-in approved cleaner. A host, owner, or observer YES does not schedule the job. With no opted-in cleaner, the job stays on hold and the host is told. Offer copies are the only texts anyone else can see. Native copies are prefixed `Group text: `. Mirror copies are prefixed `Copy of the group text: `. Those copies end with `The cleaner will reply to confirm.` Pending participants force the mirror and are excluded. A participant who is opted out stays out of the recipient list. An injury text from any known participant uses the same 911 path: the reporter is told to call 911, and the host is alerted unless the reporter is the host.

STOP from the owner still silences the property. STOP from an extra observer or manager sets only that person's consent to out. HELP and injury still run before the job reply.

## Synthesis decision

The base is the step E engine and `BookingSource`. A second job store for Notion lost: the merger would own the job a second time, and a Notion row could sit beside the Guesty stay it already is. Onboarding writes through the same slice map instead of a second file format. Group copies use the same outbox id with a per-recipient suffix, so a retry does not invent a new send.

## Tradeoffs accepted

- We accept Guesty's dates when Notion disagrees, in exchange for one job and no new conflict text.
- We accept a permission failure as `sync.fallback` with an empty `sent` list. The sentence is in the sync report. It is not an SMS, because a denied read must not send.
- We accept fixture JSON instead of a live Notion connection, in exchange for a sync that can be proven without a Notion account.
- We accept that a participant who replies STOP is no longer pending, so the remaining opted-in people can be described as a group afterward. The offers already sent while that person was pending stay mirrored.
- We accept the same crash window as step D: a sink that accepts and a process that dies before save can send the same text twice.

## Alternatives considered

- A Notion module with its own jobs and outbox. Split ownership, and the caller would have to merge stays. Rejected.
- A second onboarding database. The draft and the published property would be able to drift from the tenant slice that already isolates Lane and Court. Rejected.
- A real group MMS thread inside this demo. The capability flag is an input. The send path only labels native or mirrored copies. A live Twilio check is later.

## Open questions and risks

- Live Notion and Google OAuth, real group-MMS eligibility, lock rotation and revoke, checklists, photos, supplies, a ledger, an hourly scheduler, push channels, a host text for a date conflict, and alias memory when Guesty drops and Notion remains are later. None of those block this demo: the fixtures, the frozen clock, and the in-memory or JSON sink cover the journeys above.
- Two different stays that share a checkout date would collapse. Scratch Lane does not have that case.
- The fixture reader trusts the file. A live connector has to check permission before it applies rows. This demo does not call Notion.

## Next implementation step

Keep Notion behind `BookingSource`, and point `npm run cleaner:smoke -- --notion <fixture>` at the fixture reader. A smoke run without `--notion`, `--onboard`, or `--group-mode` stays the step C, step D, and step E path.
