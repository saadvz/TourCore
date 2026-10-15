# Cleaner Core Full Flow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A new user pastes one prompt into a Grok Bot. It connects to the hosted Cleaner Core with one Allow click and runs Saad's diagram, from setup steps 1–8 through every booking's steps 1–7.

**Architecture:** OAuth grows a second protected resource and scope for `/mcp/cleaner-core`. `LiveDesk` gains one thin tool per setup step and passes the saved choices into `openCleanerCore`. The engine gains:
- sources keyed by id, persisted across a restart;
- an offer trigger;
- arrival time;
- photos Grok can see, notes, and timestamps;
- a completed record that Grok summarizes.

New `cleaner-template/` files and a `CLEANER_CORE_BOOTSTRAP.md` let a Grok Bot set itself up from the repo.

**Tech Stack:** TypeScript, Node 22, vitest, zod, and the MCP SDK OAuth handlers (`src/mcp/oauth/`).

**Spec:** `docs/superpowers/specs/2026-10-15-cleaner-core-full-flow-design.md`. It builds on `2026-10-15-cleaner-core-grok-demo-design.md`.

## Global Constraints

- Everything stays behind `CLEANER_CORE_ENABLED`.
- Tests use only 555 numbers and made-up door codes. Nothing is sent to a real phone. Never run `sendblue:*`.
- The door code goes privately to the approved cleaner only after the host says the guests have left. It never reaches extra contacts, a group, a summary, a note, a log, or a saved file, except the sealed pin.
- The cleaner gets a cleaning text only after the host confirmed checkout and check-in times. A calendar date never confirms a time.
- Tokens never cross resources. A `tourcore.operator` grant never opens `/mcp/cleaner-core`, and a `cleanercore.operator` grant never opens `/mcp`.
- No secret in chat, tool arguments shown back, logs, or `cleaner-live.json`.
- `hostedCleanerCoreUrl` is `https://tourcore-production-72ec.up.railway.app`.
- Existing tools keep working: `save_calendar_link`, `set_up_texting`, `run_checks`, `confirm_times`, `check_now`, `save_alert_routine`, and the Scratch tools. New tools are added beside them.
- `docs/cleaner-core-safety-gates.md` stays green. Known Windows baseline failures (25 tests: secret-scanner backslash paths and a CRLF byte compare) and the step C failure that `master` already has are not regressions. Compare failing names against a baseline worktree at `f44e178`.

## Review Focus

1. A Tour Core token is sent to `/mcp/cleaner-core`, or a cleaner token to `/mcp`. Expected: 401 with that path's resource metadata, and no tool runs. The test is in Task 1.
2. A host saves a group-chat choice of `cleaner-only` while the server flag `CLEANER_CORE_GROUP_CHAT` is on. Expected: no group thread for this property, and texts go one-to-one. The test is in Task 3.
3. A cleaner reply the server could misread: a time with no AM/PM, or a text that holds the door code. Expected: it is relayed to Grok as-is (with the code redacted), and the server never guesses a time. The test is in Task 5.
4. An MMS photo arrives with no text body. Expected: it is counted, it never triggers the generic guide reply, and it is never treated as a keyword. The test is in Task 6.
5. After a restart, one of two iCal links fails. Expected: the jobs from that source are not cancelled; the source is unread. The test is in Task 2.

---

### Task 1: One-click Allow for `/mcp/cleaner-core`

**Files:**
- Modify: `src/mcp/oauth/provider.ts`
- Modify: `src/mcp/oauth/index.ts`
- Modify: `src/mcp/oauth/pages.ts`
- Modify: `src/install/tenant.ts`
- Modify: `src/install/manifest.ts`
- Modify: `src/web/server.ts`
- Modify: `src/cleaner-core/http.ts`
- Test: `test/cleanerOauth.test.ts` (new). Copy the OAuth dance helpers from `test/hostedOauth.test.ts`.

**Interfaces:**
- Produces: `CLEANER_SCOPE = "cleanercore.operator"` in `provider.ts`.
- Produces: `McpOAuthOptions.resources: { path: string; scope: string; label: "Tour Core" | "Cleaner Core" }[]`. It replaces `mcpPath`, and the existing callers pass the one Tour Core entry.
- Produces: `endpoints` returns one `OAuthEndpoints` per resource. `isOAuthPublicPath(path, paths: string[])`.
- Produces: `McpOAuth.authenticate(req, res, path)`, which checks the grant's resource and scope for that path.
- Produces: `tenantPolicy`, `onOwnerApproved`, and `publicApproval` gain a second argument, `resourcePath`.
- Produces: `InstallState.hostedCleanerTenant?: { clientId: string; boundAt: string }`, plus `hostedCleanerTenantDecision` and `bindHostedCleanerTenant` in `tenant.ts`.
- Produces: `CLEANER_CORE_HOSTED_OWNER_RESET=reset-cleaner-owner` clears `hostedCleanerTenant` at startup, the same way `TOURCORE_HOSTED_OWNER_RESET` is handled in `server.ts` (~928).
- Produces: `handleCleanerMcpHttp` input gains `oauth?: { authenticate(...) }`. When `CLEANER_CORE_MCP_TOKEN` is set, the fixed token is checked first. Otherwise OAuth is used. Without either it returns 503 as today.

Behavior:
- The approval page shows "Connect your Grok Bot to Cleaner Core" when the request's resource is the cleaner path.
- A request whose `resource` is the bare origin stays Tour Core.

- [ ] **Step 1: Write the failing tests.**
  - `"a new Grok Bot connects to Cleaner Core with one Allow"`, on a hosted install with no fixed token: discover `/.well-known/oauth-protected-resource/mcp/cleaner-core` → register → `/authorize` with `resource=<origin>/mcp/cleaner-core` → the page text contains "Cleaner Core" → approve → token → `tools/list` on `/mcp/cleaner-core` lists `get_state`.
  - `"tokens do not cross"` (Review Focus 1): the cleaner token on `/mcp` gives 401. A Tour Core token on `/mcp/cleaner-core` gives 401, and its `WWW-Authenticate` names the cleaner metadata URL.
  - `"a second Grok Bot is refused"`: a different client gets the refusal page. The cleaner owner binding doesn't touch `hostedTenant`.
  - `"reset clears the cleaner owner"`.
  - `"the fixed token still works"`: `CLEANER_CORE_MCP_TOKEN` set gives the existing behavior.
- [ ] **Step 2: Run** `npx vitest run test/cleanerOauth.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the interfaces above.
- [ ] **Step 4: Run** `npx vitest run test/cleanerOauth.test.ts test/hostedOauth.test.ts test/hostedRailway.test.ts test/oauth.test.ts test/cleanerCoreWiring.test.ts` and `npm run typecheck`. Expected: PASS, except the known baseline failure in `cleanerCoreWiring` ("catches a saved door code outside the file that stored it").
- [ ] **Step 5: Commit** `feat(cleaner-core): connect a Grok Bot with one Allow`.

### Task 2: Several calendar links, kept across a restart

**Files:**
- Modify: `src/cleaner-core/sources.ts`
- Modify: `src/cleaner-core/core.ts`: `latest` (~556), `pollFeed`, `applySnapshot` (~1181), `sourceNames`, freshness, `save()`/`load()`
- Modify: `src/cleaner-core/liveDesk.ts`: `readCalendars`, `LiveFile`
- Modify: `src/cleaner-core/mcp.ts`
- Test: `test/cleanerGrokDemo.test.ts`

**Interfaces:**
- Produces: `SourceSnapshot.sourceId: string`, which is `"guesty-lite"`, `"google-calendar"`, or `ical:<slug>`. `BookingSourceKind` gains `"ical"`.
- Produces: `icalSource(body: string, tenantId: string, sourceId: string): BookingSource`, reusing `interpretFeed`.
- Produces: the engine keys `latest` by `sourceId` and saves it, so a restart keeps every source's last snapshot.
- Produces: `LiveFile.calendars?: { name: string; url: string }[]`. A legacy `calendarLink` reads as `[{ name: "Guesty Lite", url }]`.
- Produces: `LiveDesk.saveSources(input: { calendars?: { name: string; url: string }[]; google?: boolean }): ToolReply`, and the tool `save_sources`. Each url must pass `calendarUrlAllowed`. At least one calendar or Google is required. At most 8 calendars.
- `readCalendars` reads every link. A failed link is reported in `unread: string[]` (names only) and is not applied. Its saved snapshot stays.
- `check_now` replies `unread` in place of `guestyUnread`, and keeps `guestyUnread` for one release when the Guesty link fails.

- [ ] **Step 1: Write the failing tests.**
  - `"two iCal links and Google make one job per stay"`.
  - `"a restart keeps every source"`: two links, `resetLiveDesks()`, then `check_now {}` with one link failing (Review Focus 5). No job is cancelled, and `unread` names the failing link.
  - `"save_sources refuses a private or http link"`.
  - `"save_calendar_link still saves one link"`.
- [ ] **Step 2: Run** `npx vitest run test/cleanerGrokDemo.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the interfaces above.
- [ ] **Step 4: Run** `npx vitest run test/cleanerGrokDemo.test.ts test/cleanerCore.test.ts test/cleanerCoreStepG.test.ts test/cleanerScratchTools.test.ts` and `npm run typecheck`. Expected: PASS, except the known baseline failures.
- [ ] **Step 5: Commit** `feat(cleaner-core): read several calendar links`.

### Task 3: Setup steps 2, 4, 6, 7, 8

**Files:**
- Modify: `src/cleaner-core/liveDesk.ts`: `saveProperty`, `savePeople`, `saveDoorCode`, `cleaningState`, `openEngine`
- Modify: `src/cleaner-core/mcp.ts`
- Test: `test/cleanerFullSetup.test.ts` (new)

**Interfaces:**
- Produces: `saveProperty` accepts optional `nickname`, `propertyType`, `checkoutTime`, and `checkInTime` ("10:30 AM" style). These are saved to `LiveFile` and passed as `defaultCheckout`/`defaultCheckIn` ("HH:MM") to `openCleanerCore`.
- Produces: `savePeople` accepts optional `cleanerName`, `contacts: { name: string; role: "co-host" | "assistant" | "observer"; phone: string }[]` (at most 4), and `groupChat: "cleaner-only" | "cleaner-and-host" | "everyone"`. The existing `observer` field keeps working as one contact.
  - `openEngine` turns on `groupChat` only when the server flag is on AND the choice isn't `cleaner-only`.
  - `everyone` adds the contacts to `groupChat.extra`.
  - `cleanerName` replaces the hardcoded "Maria".
- Produces: `saveDoorCode` accepts optional `lockLocation` (max 80 characters, no digits run of 4 or more). It is saved and passed to the engine, which puts it in the private code text: `Door code for the {lockLocation}: {code}`.
- Produces: `savePreferences(input: { checklist?: string[]; photosRequired?: boolean; supplyNotes?: boolean; instructions?: string }): ToolReply`, and the tool `save_preferences`. Max 12 checklist items of 80 characters; instructions max 300 characters. No item may carry the door code (`chatCarriesDoorCode`).
- Produces: `cleaningState` next steps follow the diagram order: property → sources → people → schedule (Task 4) → door code → preferences → review.
  - At review, `get_state` returns `setup`: structured saved fields. Phones show the last 4 digits only. It has no door code, and `lockLocation` only.
  - `next` is `Summarize this setup for the host in your own words, then ask them to reply Activate.`
  - Grok writes the summary. The server builds no summary text.
- Produces: the `activate` tool, which runs `setUpTexting()` and then `runChecks(input)`. It takes the same input as `run_checks`.

- [ ] **Step 1: Write the failing tests.**
  - Each tool saves its fields and `get_state` advances in diagram order.
  - At review, `setup` lists every saved choice and contains neither the door code nor a full phone number.
  - `activate` gives `Checks finished.`
  - Review Focus 2: `cleaner-only` with the flag on means one-to-one texts and no Conversations calls.
  - `everyone` puts the contacts in the group.
  - The private code text contains the lock location, and goes to the cleaner only.
  - The defaults reach the engine: the new-booking alert names the usual times (Task 4 asserts the wording).
- [ ] **Step 2: Run** `npx vitest run test/cleanerFullSetup.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the interfaces above.
- [ ] **Step 4: Run** `npx vitest run test/cleanerFullSetup.test.ts test/cleanerGrokDemo.test.ts test/cleanerCoreGroup.test.ts test/cleanerCoreWiring.test.ts test/cleanerOptionalObserver.test.ts` and `npm run typecheck`. Expected: PASS, except the known baseline failure.
- [ ] **Step 5: Commit** `feat(cleaner-core): full setup conversation`.

### Task 4: Messaging schedule and checkout nudge

**Files:**
- Modify: `src/cleaner-core/core.ts`: `ReminderTrigger`, `triggerDue`, `noticeFor` (~1593/1637), `runReminders`, `drainOne`
- Modify: `src/cleaner-core/liveDesk.ts`
- Modify: `src/cleaner-core/mcp.ts`
- Modify: `src/cleaner-core/cleanerTexts.ts`
- Test: `test/cleanerFullSetup.test.ts`

**Interfaces:**
- Produces: `CleanerCoreOptions.offerTrigger?: { kind: "when-confirmed" } | { kind: "days-after-check-in"; days: number; localTime: string }`. The default is `when-confirmed`. `noticeFor` holds a job's first offer until it is due. `runReminders` calls `drainOne` so a due offer fires from `check_now`.
- Produces: `saveSchedule(input: { firstText?: "when-confirmed" | "days-after-check-in"; firstTextDays?: number; reminder?: "morning-of" | "days-before-checkout"; reminderDays?: number; reminderTime?: string; quietFrom?: string; quietUntil?: string; escalateTo?: string }): ToolReply`, and the tool `save_schedule`. Days run 1–14 and times are "8:00 AM" style. It maps onto `offerTrigger`, `triggers` (one reminder), and `quietHours`.
- Produces: the reminder body asks for an arrival time: `Reminder: cleaning at {address} on {day}. Checkout is {time}. What time do you plan to arrive?`
- Produces: the new-booking alert names the usual times when they are saved: `New booking at {nickname}: check-in {day}, checkout {day}. Use the usual {checkout} checkout and {checkIn} check-in?` Without usual times, the existing copy stays.
- Produces: the checkout-time nudge. In `check_now`, when a confirmed job's checkout instant has passed and no departure is recorded, LiveDesk adds one host note: `Checkout time at {nickname}. Have the guests left?` Its id is `nudge:{jobId}`.
- Produces: `get_state` includes `escalateTo` in the review. Escalation routing stays the host.

- [ ] **Step 1: Write the failing tests** (fake clock through the `now` harness option).
  - `days-after-check-in` 2: no offer before check-in + 2 days at 9:00 AM local, and exactly one at it.
  - `days-before-checkout` 1 at 6:00 PM: one reminder at checkout − 1 day 6:00 PM, carrying the arrival question.
  - Quiet hours hold both.
  - The usual-times alert wording.
  - The nudge appears once after checkout time and not before.
  - The door code still waits for the host's "guests have left".
- [ ] **Step 2: Run** `npx vitest run test/cleanerFullSetup.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the interfaces above.
- [ ] **Step 4: Run** `npx vitest run test/cleanerFullSetup.test.ts test/cleanerGrokDemo.test.ts test/cleanerCore.test.ts test/cleanerCoreGroup.test.ts` and `npm run typecheck`. Expected: PASS, except the known baseline failures.
- [ ] **Step 5: Commit** `feat(cleaner-core): messaging schedule and checkout nudge`.

### Task 5: Cleaner replies reach Grok, and Grok saves the arrival time

**Files:**
- Modify: `src/cleaner-core/core.ts`: `answer`/`quietOrGuide` (~1388), `groupTimeReply` (~2047), `Job`, `JobView`
- Modify: `src/cleaner-core/liveDesk.ts`
- Modify: `src/cleaner-core/mcp.ts`
- Test: `test/cleanerFullSetup.test.ts`

**Interfaces:**
- Produces: a confirmed cleaner's text that is not a keyword (YES, NO, STOP, START, DONE, HELP, injury, a code-only text), one-to-one or in the group, adds a host note `{cleanerName}: "{text}"`.
  - The text is trimmed to 300 characters and the door code is redacted.
  - The id is `relay:{inboundId}`.
  - This wakes the Alerts routine through the existing `queueNewAlerts`.
  - The cleaner's existing guide reply is not sent for a relayed text, and the cleaner gets no other automatic reply.
- Produces: `LiveDesk.saveArrival(input: { time?: string }): ToolReply` and the tool `save_arrival`.
  - `time` is "11:30 AM" style and must have AM or PM (`statedClock`).
  - It sets `job.arrivalAt` (ISO, property time zone, on the open job's checkout day). If no job is open, it fails: `There's no open cleaning to save an arrival time for.`
  - Tool description: `Saves the cleaner's arrival time after you read it in their message. Use AM or PM.`
- Produces: `JobView.arrivalTime` ("11:30 AM") is shown in `turns`.
- Produces: the `initialize` instructions add: `When an alert quotes the cleaner, tell the host what they said in your own words. If it gives an arrival time, call save_arrival.`
- The server parses no arrival time.

- [ ] **Step 1: Write the failing tests.** Review Focus 3 now means a reply the server must not misread:
  - "Yes I'll be there around 11:30" from a confirmed cleaner is relayed verbatim to the host, and nothing else changes.
  - A YES still confirms and is not relayed.
  - A text holding the door code is relayed redacted.
  - `save_arrival "11:30 AM"` sets `arrivalTime`, `save_arrival "11:30"` fails, and with no open job it fails.
  - A group-chat time reply is relayed.
  - The relay wakes the routine once.
- [ ] **Step 2: Run** `npx vitest run test/cleanerFullSetup.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the interfaces above.
- [ ] **Step 4: Run** `npx vitest run test/cleanerFullSetup.test.ts test/cleanerCoreGroup.test.ts test/cleanerCore.test.ts test/cleanerGrokDemo.test.ts` and `npm run typecheck`. Expected: PASS, except the known baseline failures. Update any existing test that pinned the guide reply for a non-keyword cleaner text, and say so in the report.
- [ ] **Step 5: Commit** `feat(cleaner-core): relay cleaner replies to Grok and save the arrival time`.

### Task 6: Checklist, photos Grok can see, and the completed record

**Files:**
- Create: `src/cleaner-core/photos.ts` (download, store, sign, serve)
- Modify: `src/cleaner-core/twilioHook.ts`
- Modify: `src/cleaner-core/liveDesk.ts`: `inbound`, `checkNow`
- Modify: `src/cleaner-core/core.ts`: `receive`, `finish` (~1344), the start branch (~2209), `Job`
- Modify: `src/cleaner-core/mcp.ts`
- Modify: `src/web/server.ts` (the photo GET route)
- Modify: `src/cleaner-core/cleanerTexts.ts`
- Test: `test/cleanerFullSetup.test.ts`, `test/cleanerPhotos.test.ts` (new)

**Interfaces:**
- Produces: `twilioHook` reads `NumMedia` (0–10) and `MediaUrl{i}` / `MediaContentType{i}`, and passes `media: { url: string; contentType: string }[]` to `LiveDesk.inbound`. Media URLs are never logged and never stored in `cleaner-live.json`.
- Produces: `photos.ts`:
  - `savePhoto(root, jobId, media, fetchImpl)`. It is skipped unless `contentType` starts with `image/`. It downloads with Basic auth `CLEANER_CORE_TWILIO_ACCOUNT_SID:CLEANER_CORE_TWILIO_AUTH_TOKEN`, only from `https://api.twilio.com/`. The limits are 5 MB, 10 s, and 10 photos per job. It writes `cleaner-job/photos/<jobId>/<n>.<ext>`.
  - `photoLinks(root, jobId, baseUrl, key, now): { url: string; expiresAt: string }[]`. The url is `/cleaner-core/photos/<token>`. The token is an HMAC-SHA256 over `jobId|n|expiry` with a server key, and expires after 1 hour.
  - `servePhoto(token)`, which checks the token and returns the file with `Cache-Control: no-store`.
  - The key comes from `CLEANER_CORE_PHOTO_KEY`, or else from a random key saved once in the secret store.
  - `setCleanerPhotoFetch(fetchImpl | undefined)` is there for tests.
- Produces: `GET /cleaner-core/photos/<token>` in `server.ts`, public and behind `CLEANER_CORE_ENABLED`. A bad or expired token gives 404.
- Produces: after the private code is sent, the cleaner gets the checklist when one is saved: `Checklist for {nickname}: {item}; {item}. Send photos, then reply DONE when finished.` Kind `checklist`, once per job.
- Produces: while a job is in progress (code delivered, not done):
  - photos are saved and counted in `job.photos`;
  - the non-keyword text is relayed (Task 5) and also kept in `job.notes` (max 5 notes, 200 characters each, redacted) when `supplyNotes` is on;
  - a photo with no body is never relayed as text and never gets a guide reply (Review Focus 4).
- Produces: `job.startedAt` is set on START or on the first in-progress message, and `job.doneAt` on DONE.
- Produces: with `photosRequired` and `photos === 0`, DONE replies `Please send a photo of the finished rooms, then reply DONE.` and the job stays open.
- Produces: `check_now` returns `completed: { nickname, day, arrivalTime, startedAt, doneAt, checklist: string[], photos: number, notes: string[] }[]` for jobs done since the last check. They are tracked by id, the same way as `alertsShown`.
- Produces: `LiveDesk.getJobPhotos(input: { job?: string }): ToolReply` and the tool `get_job_photos`. It returns `{ photos: { url, expiresAt }[] }` for the latest job, or the job given.
  - Tool description: `Gets expiring links to the cleaner's photos for a job. Look at them, compare with the checklist, and show them to the host.`
- Produces: the `initialize` instructions add: `When check_now returns completed, call get_job_photos, look at the photos, and give the host a short summary in your own words: arrival, start and done times, checklist, what the photos show, and any notes.`
- Produces: `reset_scratch` deletes `cleaner-job/photos`. Photos older than 30 days after `doneAt` are deleted on `check_now`.

- [ ] **Step 1: Write the failing tests.**
  - In `test/cleanerPhotos.test.ts`, with a stubbed Twilio media fetch:
    - an MMS photo on the cleaner hook is saved, and its body is image bytes;
    - a non-image type is skipped;
    - more than 10 photos are capped;
    - a non-Twilio media host is refused;
    - a link works within 1 hour and 404s after;
    - a tampered token 404s;
    - the URL and the file path hold no phone number and no door code;
    - nothing is served with the flag off.
  - In `test/cleanerFullSetup.test.ts`:
    - the checklist goes after the code, once;
    - a photo-only MMS has no guide reply and no relay;
    - DONE is blocked without a photo when photos are required;
    - `completed` has exact counts and times, appears once, and holds no door code;
    - `get_job_photos` returns working links.
- [ ] **Step 2: Run** `npx vitest run test/cleanerPhotos.test.ts test/cleanerFullSetup.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the interfaces above.
- [ ] **Step 4: Run** `npx vitest run test/cleanerPhotos.test.ts test/cleanerFullSetup.test.ts test/cleanerDone.test.ts test/cleanerCoreWiring.test.ts test/cleanerCore.test.ts` and `npm run typecheck`. Expected: PASS, except the known baseline failures.
- [ ] **Step 5: Commit** `feat(cleaner-core): checklist, photos Grok can see, and the completed record`.

### Task 7: The paste-in prompt, setup guide, and bot template

**Files:**
- Create: `cleaner-template/SETUP_PROMPT.md`, `cleaner-template/bot-profile.md`, `cleaner-template/template.json`, `cleaner-template/README.md`
- Create: `CLEANER_CORE_BOOTSTRAP.md`
- Move: `grok-template/routines/cleaner-core-check.md` and `grok-template/routines/cleaner-core-alerts.md` to `cleaner-template/routines/`, updating any test that names the old paths
- Modify: `src/cleaner-core/mcp.ts` (`initialize` instructions: point at the setup order)
- Test: `test/cleanerTemplate.test.ts` (new)

Content decisions:
- **`SETUP_PROMPT.md`.** It mirrors `grok-template/SETUP_PROMPT.md`'s shape, naming Cleaner Core, `https://github.com/saadvz/TourCore`, and `CLEANER_CORE_BOOTSTRAP.md`. It says: use the hosted Cleaner Core service, do as much as possible yourself, never ask for keys, passwords, tokens, or door codes in chat (use the secure card), approve the connection with Allow, then follow `get_state`, and start now.
- **`CLEANER_CORE_BOOTSTRAP.md`.** Under 80 lines. It covers:
  - what Cleaner Core is;
  - if `cleaner-template/template.json`'s `hostedCleanerCoreUrl` is https, connect to `<url>/mcp/cleaner-core` and never clone-and-run or start a tunnel;
  - the approval;
  - the setup order (the diagram's 8 steps, naming each tool);
  - after Activate, create the Check routine and the Alerts routine (link their docs) and save the alert routine on the secure card;
  - every booking: what each alert means and which tool answers it (`confirm_times`, `mark_guests_left`, `needsTimes`, the nudge);
  - the rules: no secrets in chat; the door code only on the secure card and only after the host says the guests left; live texts only to approved numbers.
- **`template.json`.**
  - `hostedCleanerCoreUrl: "https://tourcore-production-72ec.up.railway.app"`;
  - one connector, `url: hostedCleanerCoreUrl/mcp/cleaner-core`, with auth "OAuth 2.1 discovered from the Cleaner Core service. The owner clicks Allow. Grok cannot approve itself.", and `travelsWithTemplate: false`;
  - Grok's own Google Calendar connector;
  - two routines (Cleaner Core Check, scheduled; Cleaner Core Alerts, authenticated webhook), with `credentialsTravelWithTemplate: false`;
  - `suggestedPrompts`.
- **`bot-profile.md`.** Role (sets up and runs cleaner turnovers), voice (short plain sentences, one question at a time), the suggested prompts, and the safety rules above.

- [ ] **Step 1: Write the failing tests** in `test/cleanerTemplate.test.ts`.
  - `SETUP_PROMPT.md` matches a pinned sha256 (compute it after writing and pin it), names the repo and `CLEANER_CORE_BOOTSTRAP.md`, and contains "secure".
  - `template.json`'s `hostedCleanerCoreUrl` is exactly the URL above.
  - Every file the template lists exists.
  - Both routines are named.
  - `CLEANER_CORE_BOOTSTRAP.md` is under 80 lines and names every setup tool in order.
  - No file has a secret pattern, a phone outside 555-01xx, or a 4–8 digit door-code-like example.
  - `grok-template/template.json` is unchanged (`test/grokTemplate.test.ts` still passes).
- [ ] **Step 2: Run** `npx vitest run test/cleanerTemplate.test.ts`. Expected: FAIL.
- [ ] **Step 3: Write** the files.
- [ ] **Step 4: Run** `npx vitest run test/cleanerTemplate.test.ts test/grokTemplate.test.ts test/grokBootstrap.test.ts test/cleanerGrokDemo.test.ts`. Expected: PASS, except baseline failures.
- [ ] **Step 5: Commit** `docs(cleaner-core): paste-in prompt, setup guide, and Grok Bot template`.

### Task 8: Full-diagram rehearsal and proof

**Files:**
- Test: `test/cleanerFullSetup.test.ts` (`"diagram rehearsal"` case)
- Modify: the spec's demo script, if the copy changed

- [ ] **Step 1: Write** `"diagram rehearsal"`. It runs on the Scratch property with group chat set to `cleaner-and-host`:
  1. Connect through OAuth (Task 1 helpers).
  2. Setup steps 2–8 through the new tools, then `activate`.
  3. Save the alert routine with a stubbed fetch.
  4. A booking appears in Google; the alert names the usual times; the host says yes (`confirm_times`).
  5. The first text waits for `days-after-check-in` 1.
  6. Cleaner YES (invite and offer).
  7. The reminder 1 day before carries the arrival question; the cleaner replies "around 11:30"; the reply is relayed; `save_arrival 11:30 AM`.
  8. The checkout nudge; "guests have left"; the private code with lock location to the cleaner only.
  9. The checklist; one photo; the note "need paper towels"; DONE.
  10. `check_now` returns `completed`, and `get_job_photos` returns a working link.

  After every step, recipients are Scratch numbers only and no file, reply, or log holds the door code.
- [ ] **Step 2: Run** `npx vitest run test/cleanerFullSetup.test.ts`. Expected: PASS. Fix code, not the test.
- [ ] **Step 3: Run** `npx vitest run` and `npm run typecheck`. Compare failing names with a baseline worktree at `f44e178`. Expected: no new failures.
- [ ] **Step 4: Run** `prove-step-c.sh` through `prove-step-g.sh` in an LF checkout of HEAD, and compare each journey with `master` in an LF checkout. Expected: no journey that passes on `master` fails here. Never commit evidence changes.
- [ ] **Step 5: Commit** `test(cleaner-core): rehearse the full diagram flow`.
