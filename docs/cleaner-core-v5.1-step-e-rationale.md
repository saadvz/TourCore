# Step E rationale

## Problem

After the first Scratch Lane job, Cleaner Core has to accept a second booking source and a second landlord without mixing their jobs, cleaners, or door codes. Step D (c35c25a) already opts the cleaner in and sends one private door code after departure. Google Calendar is the second source. This demo cannot use a real Google account. The sync still has to run when no conversation is open. `CLEANER_CORE_ENABLED` stays off unless it is `1` or `true`.

Task subagents were not available, so architect's ground and arena passes were done in-process. Two shapes were written and screened against the design red flags before this one was kept.

## Usage (caller's view)

```ts
const source = googleCalendarFixtureSource(fixtureJson);
const core = openCleanerCore({
  enabled: cleanerCoreEnabled(env),
  tenantId: "scratch-court",
  property: { id: "prop_8_scratch_court", address: "8 Scratch Court, Teaneck, NJ 07666", timeZone: "America/New_York" },
  ownerPhone: "+15555550110",
  cleaner: { phone: "+15555550111", approved: true },
  consented: true,
  sink,
});

await core.readSource(source, { conversation: "closed" });
```

`pollFeed` is unchanged for a Guesty-only drive. `readSource` adds one snapshot and reconciles it with the snapshots already read. A closed conversation is a flag on that call. It does not require an inbound text. The smoke command is `npm run cleaner:smoke -- --closed --google <fixture>` and `--tenant scratch-court`.

Scratch Lane stays `+15555550100`, `+15555550101`, `+15555550199`, 12 Scratch Lane, door code 4821. Scratch Court is `+15555550110`, `+15555550111`, `+15555550119`, 8 Scratch Court, door code 7392. Neither code is stored or printed in plaintext. The private text, when a pin drive sends one, is still the only place the digits leave the process, and smoke replaces them with `[redacted]` before the report is saved.

## Shape

`BookingSource.read()` returns a snapshot of stays and blocks for one tenant. `googleCalendarFixtureSource` parses a saved Calendar API `events.list` document. `guestyLiteSource` parses the iCal the engine already understands. `normalizeSnapshots` keeps one turnover when a Google stay shares the Guesty stay's check-in or checkout. Guesty Lite is the aggregator, so its checkout date wins. A different Google checkout is a `conflict` on the sync report and is not a second job and not a new text. A block, including an `outOfOffice` event, never becomes a turnover.

The engine still owns jobs, the outbox, and the transcript. Each sync replaces that source's previous snapshot and reconciles the normalized set through the existing path. The same content hash sends nothing the next time. A failed send stays `failed` and the next sync retries that outbox id. A removed event takes the stay out of the snapshot, and the existing cancel sentence goes to that tenant's owner.

`tenantId` is on the engine. A snapshot for another tenant is refused and does not change jobs. A text from another Scratch tenant's phone is stored as an inbound line and does not opt this tenant out, confirm a time, or send a reply.

## What a live Google Calendar connector needs

The live adapter implements `BookingSource` and returns the same snapshot shape. It is not in this change.

- The landlord connects the calendar in Grok. Cleaner Core does not collect a Google password, refresh token, or service-account file.
- Scope is `https://www.googleapis.com/auth/calendar.events.readonly`. The connector reads events. It does not create or edit them.
- One calendar id per property, stored as that tenant's secret. It is not written into `cleaner-core.json` and not committed.
- The first read is `events.list` with `singleEvents: true` and a bounded time window. Later reads pass the saved `nextSyncToken`. A 410 from an expired token does a full read again.
- Cancelled events are omitted from the snapshot so a removal cancels the job with the existing sentence.
- All-day `end.date` is the checkout date. A clock on `dateTime` is ignored. The host still confirms the operational time.
- The closed-conversation run is a scheduled read with no chat session id. The connector calls `read()` and the engine calls `readSource(..., { conversation: "closed" })`. The engine does not call the Grok API to decide the text.
- Fetch over HTTPS only, with a timeout. Do not follow a redirect to a private address. Do not put the access token in the Cleaner Core log or store.

## Synthesis decision

The base is one engine and a `BookingSource` interface. A second job store that a merger copies into the engine lost: two writers would own the job, and a Google-only event could be inserted beside the Guesty job it already is. Stamping `tenantId` on the engine, and refusing a snapshot or a phone from the other Scratch tenant, keeps isolation in the same send path instead of a parallel cleaner module.

## Tradeoffs accepted

- We accept Guesty's checkout date when Google disagrees, in exchange for one job and no new conflict text.
- We accept that dropping the Guesty stay while Google still has it cancels the Guesty job id. A later sync can open `google:<eventId>` as its own job. Alias memory across that handoff is later.
- We accept fixture JSON instead of OAuth, in exchange for a sync that can be proven without a Google account.
- We accept a derived pin seal, the same as step D, in exchange for a restart that can open that tenant's own code. The other tenant's code is never that input.
- We accept the same crash window as step D: a sink that accepts and a process that dies before save can send the same text twice.

## Alternatives considered

- A second engine module that only polls Google and writes a second outbox. Split ownership, and the caller would have to merge jobs. Rejected.
- One shared job table and one sink for both landlords. A missed filter texts the other house. Rejected. Each `openCleanerCore` call is still one tenant. A shared `--data` directory keeps a separate slice per tenant in `cleaner-core.json`, so the second landlord does not load the first landlord's jobs or door code. A folder that only one tenant uses stays the flat step D file.
- Match only on a shared reservation id. The fixtures would pass and a real export that does not share ids would open two jobs. Matching check-in or checkout catches that case. A shared id can still be added later without a second code path.

## Open questions and risks

- Notion, hourly scheduling, Grok's live calendar tool, push channels, quiet hours, a host text for a date conflict, group MMS, and a checklist are later.
- Two different stays that check out on the same date would collapse. Scratch Lane does not have that case.
- The fixture reader trusts the file. A live connector has to enforce the HTTPS and token rules above. This demo does not.

## Next implementation step

Keep `readSource` behind `BookingSource`, and point `npm run cleaner:smoke -- --google <fixture> --closed` at the fixture reader. A smoke run without those flags stays the step C and step D path.
