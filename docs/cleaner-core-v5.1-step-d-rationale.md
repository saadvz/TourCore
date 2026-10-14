# Step D rationale

## Problem

Cory's first real cleaning job needs the cleaner to opt in, a reminder on the morning of checkout, and a private door code only after the host says the guests have left. Step C (98443bb) already confirms host times and never sends a door code. Step D adds that private send without changing touring SMS and without changing a smoke run that does not ask for a door code. `CLEANER_CORE_ENABLED` stays off unless it is `1` or `true`.

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
  pin: scratchTenant("scratch-lane").pin,
  hostName: "Scratch",
  groupPhones: [],
});

await core.pollFeed(icalText);
await core.receive({ id, from: cleanerPhone, text: "YES" });
await core.receive({ id, from: ownerPhone, text: "YES" });
await core.runReminders();
await core.receive({ id, from: ownerPhone, text: "guests have left" });
```

Omit `pin` and the engine is step C: no opt-in, no door code, `pinRecipients` empty, and the host still receives the offer, the confirmation, and the reminder. With `pin`, the cleaner is asked to opt in, then receives the offer, the scheduled confirmation, and the reminder `Reminder: cleaning at {address} is {day} at {time}.` The job is confirmed only when that cleaner replies YES. A host departure phrase records a clearance for the current checkout version, and the private text goes only to the approved cleaner who opted in. The host receives `Door code sent to the cleaner.` and never the digits. A cleaner injury alerts the host and does not include the code. Flag off still returns `disabled` and sends nothing.

## Shape

One engine still owns jobs, host-time facts, tombstones, the outbox, and the transcript. The door code is an optional argument on that engine, not a second module.

Clearance is a fact keyed to the current checkout date, host minutes, and host version. The private outbox key is the idempotency key. `sent` is written only after the sink accepts the text. A throw leaves `failed`, does not mark the job cleared, and tells the host the send failed. The next reminder run retries that key once, then refuses it. STOP before departure drops the clearance, tells the host the code was held, and a later START re-opts the cleaner in without sending the code.

The store seals the code with AES-256-GCM. The transcript, the outbox, and the smoke stdout replace the digits with `[redacted]`. The sink receives the one private text. A group phone and an unapproved phone are never that recipient. The host notice is Cory's copy, because the Scratch allow-list is only `+15555550100` and `+15555550101`.

The job status after a confirmed checkout whose clock has passed, and before the private text is accepted, is `awaiting_departure`. After the sink accepts it, the status is `cleared`. Cleaner START then marks `in_progress`. Cleaner DONE marks `done`. No status is `ready`.

## Synthesis decision

The base is the single engine with an optional pin. A separate access-release module lost: the caller would have to sequence opt-in, clearance, and send, and two modules would write the job. The pure feed reader from step C stays. Tests that omit `pin` still see the step C turnover.

## Tradeoffs accepted

- We accept a derived key from the property id, stored beside the ciphertext in the JSON file, in exchange for a restart that can open the same code. There is no KMS.
- We accept one extra opt-in text when a pin is set, in exchange for never texting a cleaner who has not replied YES.
- We accept that a departure phrase before the host re-confirms a later checkout is ignored, in exchange for holding the code until that new time is confirmed.
- We accept that a pending opt-in at departure drops the clearance, in exchange for a later YES not sending the code on its own. The host says the guests have left again.
- We accept the same crash window as step C reminders: a sink that accepts and a process that dies before save can send the private text twice.

## Alternatives considered

- A second `AccessRelease` module beside the engine. Split ownership of the job and the outbox. Rejected.
- Store the door code in plaintext next to the job and redact only the CLI. The store, the transcript, and the evidence would still hold the digits. Rejected.
- Text Cory on a third handset. The Scratch allow-list has no such number. The host notice is the copy Cory reads. A separate handset is later.
- Send the code to a group thread. The demo blocker is that a group never receives it.

## Open questions and risks

- A separate Cory handset, native group MMS, a live Guesty HTTPS fetch, quiet hours, lock rotation, a checklist and READY, inventory, a ledger, Google Calendar, Notion, a second tenant, an hourly poll, and time-limited codes are later.
- The seal key is derived, not held in a secret store. Anyone who can read the JSON file and this code can open the seal. The smoke evidence still must not contain the digits.

## Next implementation step

Keep the pin path behind `openCleanerCore({ pin })` and `npm run cleaner:smoke -- --with-pin`. A smoke run without `--with-pin` stays the step C turnover and texts no door code.
