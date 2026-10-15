# Cleaner Core full flow in the Grok Bot: design

Date: 2026-10-15. Status: draft for Saad's review.
It builds on `2026-10-15-cleaner-core-grok-demo-design.md` (PR #107).

## Goal

Anyone pastes one prompt into a new Grok Bot. The bot finds this repo, connects to the hosted Cleaner Core with one Allow click, and runs Saad's diagram:

- the one-time setup, steps 1 to 8;
- every booking after that, steps 1 to 7.

The user never leaves the Grok Bot chat.

## What Saad decided

- **One owner, like Tour Core.** The first cleaning Grok Bot to click Allow owns the hosted Cleaner Core. Saad runs it on a dedicated Railway project that auto-deploys from `master`.
- **Door code rule unchanged.** The door code goes privately to the approved cleaner only after the host says the guests have left. It never goes out because of a calendar time. At the confirmed checkout time, Grok nudges the host to say whether the guests have left.
- **Build now:**
  - the full setup conversation;
  - a messaging schedule that takes effect;
  - several booking sources;
  - checklist, photos, and supplies.
- **Not now:** Notion, payment tracking, and live lock control. These are diagram items marked optional or "future".

## Rules that stay

- The cleaner gets a cleaning text only after the host has confirmed the checkout and check-in times. A calendar date never confirms a time. The property's usual times make that confirmation one word.
- Observers, co-hosts, and group threads never get the door code.
- Tests and Scratch runs use only 555 numbers and made-up door codes.
- `docs/cleaner-core-safety-gates.md` stays green.
- **The server holds the door-code seal key (Saad, 2026-10-15).** A Grok Bot connected by OAuth sends no key header, so the server makes one key once (32 random bytes, `CLEANER_CORE_PIN_KEY`, in its secret store) and uses it whenever a request has no `x-cleaner-core-pin-key` header; the header still wins when sent. The seal now guards a copied volume, not a copy of the volume and the secret store together, and the key never appears in a reply, a log, or `cleaner-live.json`.

## Part 1. Connecting with one Allow

- `/mcp/cleaner-core` joins Tour Core's OAuth server as a second protected resource, with its own scope, `cleanercore.operator`. The server publishes protected-resource metadata for that path.
- Checks are strict both ways. A grant's resource and scope must match the path. A Tour Core token never opens Cleaner Core, and a Cleaner Core token never opens Tour Core.
- The approval page has a Cleaner Core version: "Connect your Grok Bot to Cleaner Core."
- The first Allow binds the cleaner resource's owner. That binding is separate from Tour Core's owner, so a shared host also works. Any other client gets a refusal page. Setting `CLEANER_CORE_HOSTED_OWNER_RESET=reset-cleaner-owner` clears the binding once. The install state records that it was applied, so a variable left set doesn't clear it again on the next deploy; a deploy without the variable re-arms it.
- When `CLEANER_CORE_MCP_TOKEN` is set, that fixed token still works, for tests and Saad's own bot. On the dedicated host it stays unset.

## Part 2. The paste-in prompt and what the bot reads

- **`cleaner-template/SETUP_PROMPT.md`.** One short prompt. It names `https://github.com/saadvz/TourCore`, says to read `CLEANER_CORE_BOOTSTRAP.md`, to use the hosted service, and never to ask for a secret in chat.
- **`CLEANER_CORE_BOOTSTRAP.md`** at the repo root, under 80 lines. It covers:
  - what Cleaner Core is;
  - connecting to `hostedCleanerCoreUrl`, and never starting anything locally;
  - the setup order;
  - when to create the two routines;
  - the safety rules.
- **`cleaner-template/`** also holds:
  - `bot-profile.md`: role, voice, and starter prompts;
  - `template.json`: `hostedCleanerCoreUrl`, the connector, and both routines;
  - `README.md`.
- The two routine docs move from `grok-template/routines/` to `cleaner-template/routines/`.
- Tests pin this the way Tour Core's are pinned:
  - the prompt's hash;
  - the hosted URL set to https;
  - both routines named;
  - no secrets;
  - only 555 numbers in examples.

## Part 3. Setup conversation (diagram setup steps 1–8)

The tools stay thin. Grok asks the questions, and each tool saves one step. `get_state` names the next step, and the review summary shows everything at the end.

| Diagram step | Tool | Saves |
| --- | --- | --- |
| 1 Start | `get_state` | — |
| 2 Property | `save_property` | business name, property nickname, address, property type, time zone, usual checkout time, usual check-in time |
| 3 Sources | `save_sources` (replaces `save_calendar_link`) | a list of calendar links, each a name and an https iCal URL (Guesty, Airbnb, Vrbo, direct, other), plus whether Google Calendar is used |
| 4 People | `save_people` | host, cleaner (name and phone), extra contacts (name, role, phone), and a group-chat choice: `cleaner-only`, `cleaner-and-host`, or `everyone` |
| 5 Schedule | `save_schedule` | first cleaning text: `when-confirmed` or `days-after-check-in` with N; reminder: `morning-of` or `days-before-checkout` with N, at a time; quiet hours; who to escalate to |
| 6 Access | `save_door_code` | the door code (secure card) and the lock location |
| 7 Preferences | `save_preferences` | checklist items, photos required yes/no, supply notes yes/no, other instructions |
| 8 Review & Activate | `get_state` summary, then `activate` | `activate` replaces `set_up_texting`. It saves texting and runs the checks |

After activation, `get_state` asks Grok to create the two routines and save the alert routine.

## Part 4. Every booking (diagram booking steps 1–7)

1. **New booking.** `check_now` reads every saved link plus Google. Each link is its own source. A stay found in two sources is one job, using the existing same-checkout-or-same-check-in dedupe.
2. **Grok tells the host.** The alert names the stay and the usual times: "New booking at Lake House: check-in Wed May 10, checkout Sat May 13. Use the usual 11:00 AM checkout and 3:00 PM check-in?" A "yes" makes Grok call `confirm_times` with the usual times.
3. **First cleaning text.**
   - With `when-confirmed`, the text goes out right after the times are confirmed.
   - With `days-after-check-in` N, it waits for that day at 9:00 AM, after the times are confirmed.
   - Quiet hours hold it.
   - It includes the other instructions.
4. **Reminder.**
   - It goes at the saved trigger: N days before checkout at the saved time, or the morning of.
   - It asks for an estimated arrival time.
   - A cleaner reply with a clock time is read near the confirmed checkout: "around 11:30" with no AM or PM becomes the nearest time after checkout.
   - The arrival time is saved on the job, and the host gets an alert: "Maria plans to arrive around 11:30 AM."
5. **Checkout day.**
   - At the confirmed checkout time, Grok gets an alert: "Checkout time at Lake House. Have the guests left?"
   - When the host says yes, the door code goes privately to the cleaner, as today.
   - The private text includes the lock location.
6. **Cleaning in progress.**
   - After the code is sent, the cleaner gets the checklist when one is saved.
   - Photos sent by MMS are counted on the job. Their Twilio media ids are kept and the images are not downloaded.
   - A cleaner text that isn't a keyword is saved as a job note, when supply notes are on.
   - When photos are required and none have arrived, DONE gets "Please send a photo of the finished rooms, then reply DONE." and the job stays open.
7. **Final update.** On DONE, the host alert summarizes:
   - arrival estimate;
   - start and done times (new `startedAt` and `doneAt`);
   - checklist sent;
   - the photo count;
   - the notes.

   For example: "Cleaning complete at Lake House, May 13. Arrived 11:32 AM, done 2:10 PM. Checklist sent. 3 photos. Note: need more paper towels."

## Engine changes (`src/cleaner-core/core.ts`)

Each change is the smallest one that does the job.

- **Sources keyed by id, not kind.** `ical:<name>` sits next to `google-calendar`. The per-source snapshot map is keyed by id and saved, so a restart keeps every source.
- **Offer trigger.** `noticeFor` holds the first offer until the offer trigger is due. `runReminders` also drains, so a timed offer fires on `check_now`.
- **Arrival time.** A cleaner clock reply with no AM or PM is read against the confirmed checkout. `arrivalAt` is stored on the job.
- **Media and notes.** `receive` takes a `media` count. The job keeps `photos`, `notes`, `startedAt`, and `doneAt`. `finish` checks the photo rule. `tellHostDone` uses the summary line.
- **Defaults.** `defaultCheckout`, `defaultCheckIn`, `quietHours`, and `triggers` come from `LiveFile` in `openEngine`.
- **Checkout-time nudge.** At the confirmed checkout time, LiveDesk adds a host note: "Checkout time at {nickname}. Have the guests left?"

## Server changes

- `twilioHook.ts` reads `NumMedia` and passes the count. It does not fetch the media.
- The OAuth changes in Part 1.

## Testing

- Every new behavior gets a wired-harness test, in `test/cleanerGrokDemo.test.ts` style or a new file. All of them use 555 numbers and made-up door codes, with group chat on and off.
- **Connection.**
  - A full OAuth dance on `/mcp/cleaner-core`.
  - Tokens can't cross between `/mcp` and `/mcp/cleaner-core`.
  - A second client is refused.
  - Reset works.
  - The fixed token still works when set.
- **Setup.** Each tool saves its step. The review summary lists everything. `activate` runs the checks.
- **Booking.**
  - Two iCal links plus Google give one job per stay.
  - A restart keeps every source.
  - The offer waits for `days-after-check-in`.
  - The reminder goes N days before.
  - An arrival reply alerts the host.
  - The checkout-time nudge appears.
  - Photos are counted.
  - DONE is blocked without a photo when one is required.
  - The summary is correct.
- **Safety.**
  - The door code goes to the cleaner only, and only after the host says the guests left.
  - It never reaches extra contacts or a group.
  - It never appears in the summary or notes.
- **Rehearsal.** The demo-script rehearsal is extended to the full diagram.
- **Proof.** The verify-cleanercore step C–G journeys are run in an LF checkout and compared with `master`.

## Admin prep on the dedicated host (Saad, once)

- Deployment mode `HOSTED_RAILWAY_P0` with OAuth on (`TOURCORE_MCP_AUTH_MODE` unset or `oauth`, not `static`). Otherwise the Allow button never appears.
- `CLEANER_CORE_ENABLED=1`.
- The Cleaner Core Twilio settings.
- `CLEANER_CORE_SMS_ALLOWLIST` with the real numbers.
- `PUBLIC_BASE_URL` set to the host's public address.
- `CLEANER_CORE_MCP_TOKEN` left unset.
- Nothing to set for the door-code seal key: the server makes `CLEANER_CORE_PIN_KEY` once in its secret store. Keep the secret store with the volume, or the host enters the door code again.
- The Twilio inbound webhook pointed at the host.

## Host

- `hostedCleanerCoreUrl` is `https://tourcore-production-8b80.up.railway.app`, the dedicated Cleaner Core Railway project.

## Grok-first revision (Saad, 2026-10-15)

Grok does whatever its own abilities can do. These points replace the matching parts above.

- **Review & Activate.** `get_state` returns the saved setup as structured data (`setup`). Grok writes the review summary in its own words. The server builds no summary text.
- **Cleaner replies.**
  - A confirmed cleaner's text that isn't a keyword (YES, NO, STOP, START, DONE, HELP, an injury) is relayed to the host as an alert: `{cleanerName}: "{text}"`, with the door code redacted.
  - Grok reads it. When it holds an arrival time, Grok tells the host and calls `save_arrival({ time })`, which stores `arrivalAt` on the open job.
  - The server parses no arrival times.
- **Final summary.**
  - On DONE, `check_now` returns the job's facts: `completed: { nickname, day, arrivalTime, startedAt, doneAt, checklist, photos, notes }`.
  - Grok writes the "Cleaning complete" summary.
  - The host still gets the existing done text.
- **Photos Grok can see.**
  - Cleaner Core downloads each MMS photo from Twilio with its own Cleaner Core credentials: image types only, at most 10 per job, 5 MB each. It stores the photos under the job.
  - `get_job_photos({ job? })` returns links that expire after one hour. Each link carries a signed token and serves exactly one photo. The link never contains a phone number or the door code.
  - Grok looks at the photos, checks them against the checklist, and shows them in the summary.
  - Photos are deleted by `reset_scratch`, and 30 days after the job is done.
- **Texting stays with Cleaner Core.** Grok decides when, and Cleaner Core sends. The safety rules live at that one send point, and the Twilio keys stay out of Grok.
- **Not now:** Notion.

## Grok reads the messages (Saad, 2026-10-15)

This replaces the "Cleaner replies" point in the Grok-first revision.

- **Every message reaches Grok.** Every inbound text from the cleaner or a saved contact is recorded as a message: `{ from: role, name, text, at, handled }`.
  - The door code is redacted and the text is capped at 300 characters.
  - `handled` names what Cleaner Core did: `opted-in`, `confirmed`, `declined`, `done`, `stop`, `start`, `injury`, `code-held`, or `none`.
  - Each new message wakes the Alerts routine.
- **`check_now` returns `messages`** that are new since the last check, tracked by id.
- **Grok decides what the landlord needs to hear.**
  - Grok alerts the landlord in its own words when a message needs them: running late, a question, a problem, supplies, an arrival time, a decline, STOP, or an injury.
  - Grok stays quiet on routine acknowledgements.
  - Grok calls `save_arrival` when a message gives a time.
- **Deterministic safety stays on the server.** Grok does not decide these:
  - STOP and START;
  - the injury reply to the cleaner, plus the direct injury text to the host;
  - the door-code gate;
  - the no-reply-to-HELP rule.
- **The server-written host notes stay** as a fallback when Grok isn't running.

## The host sends a message through Grok (Saad, 2026-10-15)

- The host can ask Grok to text the cleaner, the group thread, or a saved contact: "Tell Maria the guests are running late."
- When a cleaner message needs a reply that Cleaner Core doesn't send itself, Grok drafts one and offers it.
- **One-click approval.**
  1. `send_message` called without a code returns a preview and a 10-minute approval code. The code is tied to the exact recipient and text, following Tour Core's `ConfirmationBook` pattern.
  2. Grok shows the host the exact text.
  3. After the host says yes, Grok calls `send_message` again with the code, and Cleaner Core sends it.
  4. Any change to the text after approval is refused.
- **The send goes through Cleaner Core's send point**, never from Grok directly.
  - It goes only to the saved cleaner, the group, or a saved contact who has opted in.
  - STOP and the allowlist are respected.
  - It never carries the door code.
  - It is capped at 600 characters and 10 messages an hour.
  - It is recorded in the message history.
  - Quiet hours don't hold it, because the host chose to send it now.

## Demo script: the full diagram (Scratch rehearsal)

This extends the Scratch rehearsal in `2026-10-15-cleaner-core-grok-demo-design.md` to the whole diagram. The test `"diagram rehearsal"` in `test/cleanerFullSetup.test.ts` runs it on 12 Scratch Lane with 555 numbers, a made-up door code, and group chat set to `cleaner-and-host`.

1. Grok connects to `/mcp/cleaner-core` with one Allow.
2. Setup: property with the usual 11:00 AM checkout and 4:00 PM check-in, Google Calendar, the people, the schedule (first text 1 day after check-in, reminder 1 day before checkout at 6:00 PM), the door code with the lock location, and the preferences. Grok reviews the setup, and the host replies Activate.
3. Grok saves the alert routine.
4. A stay appears in Google. The alert names the usual times, and the host says yes. The cleaner gets the group invite.
5. The cleaner replies YES to the invite. The offer waits until 9:00 AM the day after check-in. The cleaner replies YES to the offer.
6. The reminder asks "What time do you plan to arrive?" The cleaner answers "around 11:30". Grok reads it, saves the arrival time, and offers the host a reply. The host approves "Parking is on the street today.", and it reaches the cleaner once.
7. At checkout time, Grok asks the host whether the guests have left. The host says they have. The door code and the lock location go to the cleaner in a private text, then the checklist.
8. The cleaner sends one photo, the note "need paper towels", and DONE.
9. `check_now` returns the finished cleaning. Grok gets the photo link with `get_job_photos` and writes the summary.

After every step, every text goes to a Scratch number, and the door code is in no saved file, reply, or log.
