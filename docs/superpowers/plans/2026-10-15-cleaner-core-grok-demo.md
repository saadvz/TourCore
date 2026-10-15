# Cleaner Core Grok Demo Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The cleaning Grok Bot runs a whole Cleaner Core turnover from chat. Google and Guesty Lite bookings come in, alerts reach the host within seconds, and the Scratch outbox shows each text's wording.

**Architecture:** Two thin MCP tools are added to `src/cleaner-core/mcp.ts`. `check_now` re-reads Guesty, applies the Google events Grok passes in, runs reminders, and returns new host alerts. `save_alert_routine` stores the routine's webhook secrets. `LiveDesk` keeps its own `OperatorEventOutbox` and `GrokRoutineWebhookSink`, reused from `src/alerts/`. The server's existing 15 s retry timer drains that outbox. Grok routines do the scheduling.

**Tech Stack:** TypeScript, Node 22, vitest, zod. The tests use the existing wired-app harness, `test/wiringProof.ts`.

**Spec:** `docs/superpowers/specs/2026-10-15-cleaner-core-grok-demo-design.md`

## Global Constraints

- Everything stays behind `CLEANER_CORE_ENABLED`. With the flag off, the cleaner MCP path returns 503, and nothing is sent or queued.
- Tests use only 555 numbers and the made-up door code `DOOR_CODE` from `test/wiringProof.ts`. Nothing is sent to a real phone.
- The door code never appears in a tool reply, an alert, an event, a log, or a saved file except the sealed pin.
- A `cleaning.update` event carries only `schemaVersion`, `eventId`, `eventType`, and `occurredAt`. It has no `propertyId`, because the cleaner property ids contain `-` and fail `OperatorEventSchema`. It has no text, no phone number, and no code.
- The routine URL and key never appear in a tool reply, a log, or `cleaner-live.json`. They are stored only in the secret store, as `CLEANER_CORE_ROUTINE_URL` and `CLEANER_CORE_ROUTINE_KEY`.
- The cleaner gets the offer only after `confirm_times`. A calendar date never confirms a time. This is existing behavior and must not change.
- `docs/cleaner-core-safety-gates.md` stays green.

## Review Focus

1. Grok omits `googleEvents` because its Google read failed. Expected: the Google stays already saved are left as they are, and nothing is cancelled. Only a list that is passed counts as a snapshot. The test is in Task 2.
2. The Guesty link fails during `check_now`. Expected: the Google events still apply, the alerts still come back, and the reply says the Guesty link couldn't be read. The tool does not error. The test is in Task 2.
3. Grok passes a malformed event: a missing `end`, an unparseable date, or an object instead of a list. Expected: that event is skipped, the other events still apply, and nothing throws. The test is in Task 2.
4. The routine webhook refuses or is down. Expected: the event stays pending and is retried, and `check_now` still returns the alert. The test is in Task 3.
5. `check_now` runs before setup is finished. Expected: it fails with `Run the checks first.` and sends nothing. The test is in Task 2.

---

### Task 1: Booking sources at setup

Covers: Google at setup, Guesty optional, an empty calendar allowed, and the group chat line.

**Files:**
- Modify: `src/cleaner-core/sources.ts` (add a wrapper next to `googleCalendarFixtureSource`, line 75)
- Modify: `src/cleaner-core/liveDesk.ts`: `LiveFile` (line 74), `saveCalendarLink` (225), `runChecks` (265), `cleaningState` (506)
- Modify: `src/cleaner-core/mcp.ts`: the `save_calendar_link` and `run_checks` inputs and descriptions
- Modify: `test/wiringProof.ts`: options `now?: () => Date` and `calendar?: () => string`. Both default to today's behavior. `now` is passed to `createSetupServer` and to the Installation. `calendar` replaces the fixed `CALENDAR_ICS` body.
- Test: `test/cleanerGrokDemo.test.ts` (new)

**Interfaces:**
- Produces: `googleCalendarSource(list: GoogleEventList, tenantId: string): BookingSource` in `sources.ts`. `GoogleEventList = { timeZone?: string; items: unknown[] }`. It calls `readGoogleCalendarFixture(JSON.stringify({ ...list, tenantId }))`.
- Produces: `LiveFile.google?: boolean`.
- Produces: `LiveDesk.saveCalendarLink(input: { url?: string; google?: boolean }): ToolReply`.
- Produces: `LiveDesk.runChecks(input?: { googleEvents?: GoogleEventList }): Promise<ToolReply>`.
- Produces: a private `LiveDesk.readCalendars(googleEvents?: GoogleEventList): Promise<{ guestyFailed: boolean }>`. It reads Guesty with `readPublicCalendar` + `engine.pollFeed`, when a link is saved. It reads Google with `engine.readSource(googleCalendarSource(list, file.propertyId))`, when a list is passed. Task 2 reuses it.
- Produces: a test helper `googleList(stays: { id: string; start: string; end: string }[]): GoogleEventList`. Each stay becomes `{ id, status: "confirmed", summary: "Guest", start: { date }, end: { date } }`.

- [ ] **Step 1: Write the failing tests** in `test/cleanerGrokDemo.test.ts`. Set up the property and people the way `test/cleanerCoreWiring.test.ts` does.
  - `"saves Google without a Guesty link"`: `save_calendar_link {google: true}` succeeds. Then `get_state` `done` contains `"Google Calendar saved."` and does not contain `"Calendar link saved."`.
  - `"refuses a calendar step with neither source"`: `save_calendar_link {}` gives `isError` with text `"Send the Guesty Lite link, or say you use Google Calendar."`.
  - `"run_checks reads Google events"`: Google only, then `run_checks {googleEvents: googleList([{id:"g1", start:"2026-10-14", end:"2026-10-16"}])}`. `turns` has length 1 with `checkoutDate "2026-10-16"`, and `cleanerSent` is empty.
  - `"run_checks with no stay yet"`: `googleList([])` gives `ok` with `next` `"I read the calendar. There's no guest stay yet. I'll tell you when one shows up."` and `checked` true (`get_state` `done` contains `"Checks finished."`).
  - `"group chat line"`: with `groupChat: true` and an observer, after `set_up_texting`, `done` contains `"Group chat set up with you, the cleaner, and the observer."`. Without an observer, it contains `"Group chat set up with you and the cleaner."`. With `groupChat: false`, neither line appears.
- [ ] **Step 2: Run** `npx vitest run test/cleanerGrokDemo.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the interfaces above.
  - `saveCalendarLink`: a `url` must start with `https://`, using the same refusal as today. It saves `google: true` when passed, and requires at least one of the two.
  - `saveDoorCode` and `runChecks` guard on `calendarLink || google`, not on `calendarLink`.
  - `runChecks` no longer fails on zero turnovers. It fails `"Read Google Calendar and pass its events."` when `file.google` is set and `googleEvents` is missing.
  - The `save_calendar_link` input is `z.object({ url: z.string().optional(), google: z.boolean().optional() })`. The `run_checks` input is `z.object({ googleEvents: z.object({ timeZone: z.string().optional(), items: z.array(z.unknown()) }).optional() })`.
- [ ] **Step 4: Run** `npx vitest run test/cleanerGrokDemo.test.ts test/cleanerCoreWiring.test.ts test/cleanerScratchTools.test.ts test/cleanerOptionalObserver.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(cleaner-core): take Google bookings from Grok at setup`

### Task 2: `check_now`

Covers: the re-read, the snapshot, reminders, new alerts, and no overlap.

**Files:**
- Modify: `src/cleaner-core/liveDesk.ts`, `src/cleaner-core/mcp.ts`
- Test: `test/cleanerGrokDemo.test.ts`

**Interfaces:**
- Consumes: `readCalendars` and `GoogleEventList` from Task 1.
- Produces: `LiveDesk.checkNow(input: { googleEvents?: GoogleEventList }): Promise<ToolReply>`. Its result is `{ alerts: string[]; turns: Record<string, unknown>[]; guestyUnread?: true }`.
- Produces: `LiveFile.alertsShown?: number`. It counts the `engine.hostNotes()` entries that were already returned.
- Produces: a private `LiveDesk.serial<T>(work: () => Promise<T>): Promise<T>`. It runs `checkNow` and `runChecks` one at a time through a single promise chain.

- [ ] **Step 1: Write the failing tests.** The clock starts at `FROZEN`. A mutable `let now`, passed through the Task 1 `now` option, moves it.
  - `"new booking alerts the host"`: run setup with Google and an empty list. Then `check_now {googleEvents: googleList([{id:"g1", start:"2026-10-14", end:"2026-10-15"}])}`. `alerts` has length 1 and holds the engine's `host-checkout` body, and `cleanerSent` is empty. A second `check_now` with the same list returns `alerts: []`.
  - `"moved stay updates the job"`: confirm times and get the cleaner's YES through `postTwilio`. Then `check_now` with `end` moved to `"2026-10-16"`. `turns[0].checkoutDate` is `"2026-10-16"`, and a `corrected` text reaches the cleaner.
  - `"removed stay calls the job off"`: same as above, then `check_now` with `googleList([])`. The job is cancelled and the cleaner gets a `cancel-update`.
  - `"omitted googleEvents changes nothing"` (Review Focus 1): after the YES, `check_now {}`. The job and turns are unchanged, and `cleanerSent` has no new entry.
  - `"one job from both calendars"`: Guesty `calendar` serves `stay-a` (checkout `2026-10-18`). Google has a stay with the same dates. `turns` has length 1.
  - `"guesty failure still applies Google"` (Review Focus 2): the calendar fetch returns 500. `check_now` with Google events gives `ok`, `guestyUnread: true`, and the Google job present.
  - `"malformed events are skipped"` (Review Focus 3): items `[{ id: "bad" }, { id: "x", start: { date: "nope" }, end: {} }, <one good stay>]` give `ok` and one turn.
  - `"before setup"` (Review Focus 5): `check_now` on a fresh desk fails with `"Run the checks first."`. Nothing is sent.
  - `"reminder fires once"`: after the YES, with checkout today, set `now` to 07:59 local, then `check_now`. No `reminder` yet. Set `now` to 08:00 local, then `check_now`. Exactly one `reminder` reaches the cleaner. Another `check_now` sends no second one.
  - `"restart does not resend"`: after the reminder, call `resetLiveDesks()`, then `check_now`. Still one `reminder` in `cleanerSent`.
  - `"no overlap"`: `Promise.all` of two `check_now` calls with a new stay gives exactly one `host-checkout` note across both replies, and one engine outbox entry.
  - `"flag off"`: `startWiredApp({ enabled: false })`, then `check_now`. Status 503. `cleanerSent` and `tourSent` are empty.
- [ ] **Step 2: Run** `npx vitest run test/cleanerGrokDemo.test.ts`. Expected: the new cases FAIL.
- [ ] **Step 3: Implement** `checkNow`:
  1. Run `this.resume()`. Without `file.checked` or the engine, fail `"Run the checks first."`.
  2. `readCalendars(googleEvents)`.
  3. `this.engine.runReminders()`.
  4. `this.syncHold()`.
  5. Slice `hostNotes()` from `alertsShown`, filtered the way `cleaningState` filters notes (lines 523–525).
  6. Save `alertsShown`.

  Wrap it in `serial`. The `check_now` tool input is the same as `run_checks`. Description: `"Re-reads the booking calendars, sends any reminders that are due, and returns new alerts for the host. Pass googleEvents only when you just read Google Calendar."`
- [ ] **Step 4: Run** the Task 1 test command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(cleaner-core): check_now re-reads calendars and runs reminders`

### Task 3: Instant alerts to the cleaning routine

**Files:**
- Modify: `src/install/secretStore.ts`: `SETTINGS` gets `CLEANER_CORE_ROUTINE_URL: { secret: true }` and `CLEANER_CORE_ROUTINE_KEY: { secret: true }`.
- Modify: `src/alerts/operatorEvents.ts`: append `"cleaning.update"` to `OPERATOR_EVENT_TYPES`. Add `cleaningUpdateEvent(now: Date): OperatorEvent`, with `eventId` `evt_${randomUUID().replace(/-/g, "")}`.
- Modify: `src/alerts/describeUpdate.ts`: at the top of `describeOperatorUpdate`, throw `SetupInputError("UPDATE_INCOMPLETE", "That update is for the cleaning scheduler.")` for `cleaning.update`. Fix any other exhaustive map that `npm run typecheck` flags the same way.
- Modify: `src/cleaner-core/liveDesk.ts`, `src/cleaner-core/http.ts`, `src/cleaner-core/twilioHook.ts`, `src/cleaner-core/mcp.ts`, `src/web/server.ts` (the `handleCleanerMcpHttp` call at about line 657, and the retry timer at line 792)
- Test: `test/cleanerGrokDemo.test.ts`

**Interfaces:**
- Produces: `setCleanerAlertFetch(fetchImpl | undefined)` in `liveDesk.ts`. It is passed to `GrokRoutineWebhookSink` as `options.fetch`, for tests.
- Produces: `LiveDesk.useEnv(env: () => NodeJS.ProcessEnv): void`. `liveDeskFor` calls it on every lookup, so a secret saved later is seen. Today the first request's env is kept forever.
- Produces: `LiveDesk.saveAlertRoutine(input: { url?: string; key?: string }, save: (values: { CLEANER_CORE_ROUTINE_URL: string; CLEANER_CORE_ROUTINE_KEY: string }) => void): ToolReply`.
- Produces: `LiveDesk.drainAlerts(): Promise<void>`, and `drainCleanerAlerts(root: string, env: () => NodeJS.ProcessEnv, now: () => Date): Promise<void>`. The latter calls `liveDeskFor(...).drainAlerts()`.
- Produces: `LiveFile.alertsQueued?: number`, and a private `LiveDesk.queueNewAlerts(): void`. When `hostNotes().length > alertsQueued`, it enqueues one `cleaningUpdateEvent`, saves the count, and starts `void this.drainAlerts()`.
- The outbox is `new OperatorEventOutbox(new FileRuntimeStore(join(root, "cleaner-alerts")), () => sink)`. The sink is `new GrokRoutineWebhookSink({ url: () => env().CLEANER_CORE_ROUTINE_URL?.trim() || undefined, key: () => env().CLEANER_CORE_ROUTINE_KEY?.trim() || undefined }, { fetch })`.
- `handleCleanerMcpHttp` input gains `saveSecrets: (values: Partial<Record<SettingName, string>>) => void`. The server passes `(values) => installation.secrets.set(values)`.

- [ ] **Step 1: Write the failing tests.** The alert fetch stub records `{ url, headers, body }` and returns a status the test picks.
  - `"save_alert_routine stores without echoing"`: `save_alert_routine {url: "https://routine.example/hook", key: "k-test-123456"}` gives `ok` with `next` `"Alerts are connected. I queued a test alert for the routine."`. The raw reply and `cleaner-live.json` contain neither value. After `drainCleanerAlerts`, the stub got one POST with `Authorization: Bearer k-test-123456` and `eventType` `"installation.test"`.
  - `"refuses a non-https routine"`: `url: "http://x"` gives `isError` `"Send the routine's https address and its key."`.
  - `"cleaner YES wakes the routine"`: with the routine saved and setup through `confirm_times`, the cleaner's YES arrives by `postTwilio`. After `drainCleanerAlerts`, one POST arrives whose body keys are exactly `["schemaVersion","eventId","eventType","occurredAt"]` and whose `eventType` is `"cleaning.update"`. The body contains no `+1`, no `DOOR_CODE`, and no host note text. A following `check_now` returns that note in `alerts`.
  - `"routine down keeps the event"` (Review Focus 4): the stub returns 503. The outbox record stays `pending`, and `check_now` still returns the alert. When the stub returns 200, the next drain delivers it.
  - `"no routine saved"`: the event is queued, the drain does not throw, and nothing is posted.
- [ ] **Step 2: Run** `npx vitest run test/cleanerGrokDemo.test.ts`. Expected: the new cases FAIL.
- [ ] **Step 3: Implement** the interfaces above.
  - Call `queueNewAlerts()` at the end of `inbound()` and `notePinDelivery()`. Those are the paths Grok doesn't see.
  - `saveAlertRoutine` checks `calendarUrlAllowed(url)` from `fetchLimits.ts` and that `key.length >= 8`, then saves and enqueues `testEvent(now)`.
  - `save_alert_routine` tool description: `"Saves the alert routine's webhook address and key from the secure card. The reply never repeats them."`
  - The server's retry timer chains `.then(() => cleanerCoreEnabled(installation.env()) ? drainCleanerAlerts(installation.root, () => installation.env(), now) : undefined)`.
- [ ] **Step 4: Run** `npx vitest run test/cleanerGrokDemo.test.ts test/alertHealth.test.ts test/operatorUpdates.test.ts test/operatorAlerts.test.ts test/operatorAlertRecovery.test.ts test/cleanerCoreWiring.test.ts` and `npm run typecheck`. Expected: PASS, with 0 type errors.
- [ ] **Step 5: Commit** `feat(cleaner-core): wake the cleaning routine on new host alerts`

### Task 4: Scratch outbox shows the wording

**Files:**
- Modify: `src/cleaner-core/liveDesk.ts`: `readOutbox` (line 401)
- Test: `test/cleanerScratchTools.test.ts`

**Interfaces:**
- Produces: `readOutbox()` result `{ lines: string[]; texts: { label: string; status: string; body: string }[] }`. `lines` stays byte-for-byte unchanged. `body` goes through `hideCode`, so the door code shows as `[redacted]`. Local rows use the body the desk sent (`inboundBeforeJob`): store `body` on `localSends`.

- [ ] **Step 1: Write the failing test** `"outbox shows the wording with the code redacted"`. On a Scratch run through `mark_guests_left`, `texts` has an entry with `label` `"Door code text to the cleaner"` whose `body` contains `"[redacted]"` and not `DOOR_CODE`. The offer's `body` starts with `"Hi, this is "`. `lines` equals the value the existing tests expect.
- [ ] **Step 2: Run** `npx vitest run test/cleanerScratchTools.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** as above.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(cleaner-core): show text wording in the Scratch outbox`

### Task 5: Grok guidance

**Files:**
- Modify: `src/cleaner-core/mcp.ts`: the `initialize` instructions
- Modify: `src/cleaner-core/liveDesk.ts`: the `cleaningState` next steps
- Create: `grok-template/routines/cleaner-core-check.md`, `grok-template/routines/cleaner-core-alerts.md`
- Test: `test/cleanerGrokDemo.test.ts`

Copy decisions:
- The calendar step's `next` becomes `"Where do bookings come from? Send the Guesty Lite link, and tell me if you also use Google Calendar."`
- After `Checks finished.`, when no routine is saved (`!env().CLEANER_CORE_ROUTINE_URL`), `next` is `"Create the Cleaner Core Check and Cleaner Core Alerts routines, then save the alert routine's address and key with the secure card."` After that, the existing times question.
- Append to the instructions: `"Use check_now when a routine wakes you or the host says check my calendars. Read Google Calendar with your own connector first when the host uses it. Post each alert in your own short words. Collect secrets only with your secure card."`
- `cleaner-core-check.md`: a scheduled trigger, every 5 minutes for a demo and hourly otherwise. Steps: read today and the next 60 days from the host's Google Calendar, call `check_now` with `{ timeZone, items }` exactly as read, and post each alert. Leave out `googleEvents` when the read failed.
- `cleaner-core-alerts.md`: an authenticated webhook trigger. Grok creates it and enters the address and key through the secure card into `save_alert_routine`. On wake, call `check_now` without `googleEvents` and post each alert. For an `installation.test` event, post `"Cleaner Core alerts are connected."`. The payload never holds message text.

- [ ] **Step 1: Write the failing tests.** `tools/list` includes `check_now` and `save_alert_routine`. `get_state` after `Checks finished.` with no routine returns the routine `next` above. Both routine files exist and name `check_now`.
- [ ] **Step 2: Run** `npx vitest run test/cleanerGrokDemo.test.ts test/grokTemplate.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the copy and files above.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `docs(cleaner-core): Grok routines and steps for the demo`

### Task 6: Demo rehearsal test and proof

**Files:**
- Test: `test/cleanerGrokDemo.test.ts`, which gets the `"demo script"` case
- Modify: `docs/cleaner-core-safety-gates.md`, only if a gate's evidence path changes

- [ ] **Step 1: Write** the `"demo script"` case. It follows the spec's demo script on a Scratch property (`scratchTools: true`, Scratch Lane numbers from `SCRATCH_TENANTS[0]`, `DOOR_CODE`):
  1. Setup with Google, with an empty list.
  2. `check_now` with one stay that checks out today. The alert asks for checkout.
  3. `confirm_times "10:00 AM" / "3:00 PM"`. The offer appears in `read_outbox.texts`.
  4. `send_test_text` YES from the cleaner.
  5. Set `now` to 08:00 local, then `check_now`. One reminder.
  6. `mark_guests_left "guests have left"`. The private code text is in `texts` as `[redacted]`.
  7. `send_test_text` DONE. The host's ready note is in `alerts` or `notes`.
  8. `reset_scratch`. Repeat steps 1–4, then move the stay. `corrected` is in `texts`. Remove it. `cancel-update` is in `texts`.

  At every step, no outbound recipient is outside the Scratch numbers, and no saved file under `root` contains `DOOR_CODE`.
- [ ] **Step 2: Run** `npx vitest run test/cleanerGrokDemo.test.ts`. Expected: PASS. Fix the code, not the test, if a step fails.
- [ ] **Step 3: Run** `npm test` and `npm run typecheck`. Expected: all green.
- [ ] **Step 4: Run** `.cursor/skills/verify-cleanercore/scripts/prove-step-g.sh`. It reruns D, E, and F. Expected: exit 0, and the printed `evidence/step-g` path exists.
- [ ] **Step 5: Commit** `test(cleaner-core): Scratch rehearsal of the Grok demo`, then open a PR against `master`. Do not merge.
