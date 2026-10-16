# Cleaner Core Group-First Texting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cleaner Core starts the group text as soon as the cleaner says YES. It posts an intro, then keeps every text in that group, the door code included under the landlord's rule. The only one-to-one texts are invites, STOP and HELP replies, and the fallback when the group can't be made.

**Architecture:** All the routing lives in the engine (`src/cleaner-core/core.ts`). `emit()` gains one group-routing step that decides group, one-to-one, or exception for each draft. A new `ensureIntro()` posts the intro before the first group post for each membership. The live desk (`liveDesk.ts`) only saves the landlord's door-code choice, passes it to the engine, and makes `send_message` group-only. How Twilio groups are built (`liveSms.ts`, from #110) is unchanged.

**Tech Stack:** TypeScript, vitest, zod (MCP tool schemas), the Twilio Conversations fake in `test/fakeConversations.ts`.

**Spec:** `docs/superpowers/specs/2026-10-16-cleaner-core-group-first-design.md`

## Global Constraints

- Invite copy, exact: `{landlord_name} wants to set up a group chat with you for cleaner services at {property address}. Reply YES to join, or STOP to opt out.`
- Intro copy, exact: `Hi {names}! This is the cleaning group for {property address}. I'm {landlord_name}'s cleaning assistant, and I'll post cleaning times and updates here. Reply STOP anytime to leave.`
- `{names}` order: the landlord, the cleaner, then contacts in saved order. Two names are `A and B`, and three or more are `A, B and C`.
- `{landlord_name}` is `hostName`, or the business name when none is saved (`groupChat.hostName` already carries this).
- The door-code question, exact: `You added other people to the group. Should the door code go to the whole group, or only privately to the cleaner?`
- `send_message` refusal, exact: `Messages go to the group. Send it with to: group.`
- Tests use only 555 numbers, made-up door codes, and the fakes. No real Twilio call, and no text to a real phone (AGENTS.md).
- The door code never goes before "guests have left", never to an unapproved person, and is never in logs, notes, Grok replies, or saved files except the sealed pin.
- The intro is never sent from server start or engine open alone. It goes only from an engine step (receive, poll, check, confirm, reminders).
- `CLEANER_CORE_BOOTSTRAP.md` stays under 80 lines (`test/cleanerTemplate.test.ts`).

## Review Focus

1. **A contact says YES before the cleaner.** There is no group and no intro yet. The cleaner's YES then starts one group, with the contact in it, and one intro naming all three. This is tested in Task 3.
2. **The cleaner sends STOP.** Fewer than two people are left, so nothing is posted to a group, and no intro goes to the landlord alone. The cleaner gets only the opt-out confirmation, one-to-one. This is tested in Task 3.
3. **The engine is reopened from its saved store.** The same membership doesn't get a second intro. This is tested in Task 3.
4. **A contact who leaves turns the group back into just the landlord and the cleaner.** The door code then goes into the group, even with `doorCodeTo: "cleaner"`. This is tested in Task 5.
5. **The door code is due while the group can't be made.** It goes one-to-one to the cleaner only, never to a contact or the landlord. This is tested in Task 5.

---

### Task 1: Group copy helpers

**Files:**
- Modify: `src/cleaner-core/cleanerTexts.ts`
- Test: `test/cleanerGroupFirst.test.ts` (new)

**Interfaces:**
- Produces: `groupInviteBody(landlordName: string, address: string): string`, `groupIntroBody(names: readonly string[], landlordName: string, address: string): string`, `nameList(names: readonly string[]): string`, `namedAsk(name: string, body: string): string`.

- [ ] **Step 1: Write the failing tests** in `test/cleanerGroupFirst.test.ts`, under `describe("group-first: copy")`:
  - `groupInviteBody("Saad", "145 Tenafly Road")` returns exactly `Saad wants to set up a group chat with you for cleaner services at 145 Tenafly Road. Reply YES to join, or STOP to opt out.`
  - `nameList(["Saad","Mike"])` returns `Saad and Mike`. `nameList(["Saad","Mike","Ana"])` returns `Saad, Mike and Ana`. `nameList(["Saad"])` returns `Saad`.
  - `groupIntroBody(["Saad","Mike"], "Saad", "145 Tenafly Road")` returns exactly `Hi Saad and Mike! This is the cleaning group for 145 Tenafly Road. I'm Saad's cleaning assistant, and I'll post cleaning times and updates here. Reply STOP anytime to leave.`
  - `namedAsk("Mike", "Update: checkout at X moved to Sunday at 10:00 AM. Reply YES to keep the cleaning, or STOP to opt out.")` returns `Update: checkout at X moved to Sunday at 10:00 AM. Mike, reply YES to keep the cleaning, or STOP to opt out.`
  - `namedAsk("Mike", "Reminder: cleaning at X on Sunday. Checkout is 11:00 AM. What time do you plan to arrive?")` returns `Reminder: cleaning at X on Sunday. Checkout is 11:00 AM. Mike, what time do you plan to arrive?`
  - `namedAsk("Mike", "Thanks, cleaning marked done.")` returns the body unchanged.
  - None of these outputs contain `door code` or `ready`.
- [ ] **Step 2: Run** `npx vitest run test/cleanerGroupFirst.test.ts`. Expected: FAIL (not exported).
- [ ] **Step 3: Implement the four functions** in `cleanerTexts.ts`. `namedAsk` works like this:
  - It replaces the first `Reply ` that starts a sentence with `{name}, reply `.
  - Otherwise, when the last sentence ends with `?`, it puts `{name}, ` before that sentence and lowercases the sentence's first letter.
  - Otherwise it returns the body unchanged.
  - A host note (`hostNoteOf`) stays at the end, untouched, like `groupOfferBody`.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(cleaner-core): group invite, intro and named-ask copy`.

### Task 2: Invites in group mode

**Files:**
- Modify: `src/cleaner-core/core.ts`: `cleanerOptInBody()` (~1587), `sendGroupInvites()` (~1309), `sendHostOptIn()` (~1576), and the `hostGroup = "pending"` reset in `addTestTurn()` (~1165).
- Test: `test/cleanerGroupFirst.test.ts`. Also update tests pinned to `groupOptInBody` invites (`test/cleanerCoreGroup.test.ts`, `cleanerDone.test.ts`, `cleanerTestTurn.test.ts`, `cleanerHostGroupSeat.test.ts`, `cleanerGroupMms.test.ts`, `cleanerFullSetup.test.ts`, `cleanerGrokDemo.test.ts`).

**Interfaces:**
- Consumes: `groupInviteBody` (Task 1).
- Produces: in group mode, the cleaner and each contact get `groupInviteBody(groupChat.hostName, address)` under their existing ids (`opt-in:{phone}`). The landlord gets no invite text in group mode. The landlord's seat comes only from setup consent (`seatHost`).

- [ ] **Step 1: Write the failing tests** (`describe("group-first: invites")`). They use an `openCleanerCore` engine like `test/cleanerGroupMms.test.ts`'s `engine()`, with `groupChat: { hostName: "Saad", cleanerName: "Mike", extra: [{ phone: "+15555550122", name: "Ana" }] }`.
  - After `pollFeed` and `confirmHostTimes`, the opt-in texts are exactly `[{ to: MIKE, kind: "opt-in", body: groupInviteBody("Saad", LANE) }, { to: ANA, kind: "opt-in", body: groupInviteBody("Saad", LANE) }]`, and none goes to the owner.
  - A cleaner whose saved consent is already `in` (`cleanerConsent: "in"` option) gets no invite.
  - `addTestTurn` in group mode sends no text to the owner, and the owner stays seated once `consented: true`.
- [ ] **Step 2: Run** `npx vitest run test/cleanerGroupFirst.test.ts`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement.**
  - `cleanerOptInBody()` and `sendGroupInvites()` use `groupInviteBody(this.groupChat.hostName, address)` when `groupChat` is set.
  - `sendHostOptIn()` returns `null` when `groupChat` is set.
  - `addTestTurn()` in group mode sets `hostGroup` to `"in"` (not `"pending"`) unless it is `"out"`.
  - Keep `groupOptInBody` exported for now, since `cli.ts` uses it.
- [ ] **Step 4: Run** `npx vitest run test/cleaner`. Expected: only tests pinning the old invite fail. Update them to `groupInviteBody(...)`, as #110 updated invite expectations, and re-run until green.
- [ ] **Step 5: Commit** `feat(cleaner-core): group invite wording, no landlord invite`.

### Task 3: The intro starts the group

**Files:**
- Modify: `src/cleaner-core/core.ts`. Add `"intro"` to `TextKind`, add `ensureIntro()`, and call it at the start of `drainOne()` (~1968) and before every non-intro group post in `emitGroup()` / `emitGroupOffer()` and the Task 4 routing step.
- Modify: `src/cleaner-core/liveDesk.ts`: the read-outbox label for `intro` (wherever kinds get labels such as "Cleaning offer to the cleaner"). The label is `Group intro`.
- Test: `test/cleanerGroupFirst.test.ts`.

**Interfaces:**
- Consumes: `groupIntroBody` (Task 1) and `groupAudience()` (existing).
- Produces:
  - `private async ensureIntro(): Promise<CleanerText | null>`. It posts `groupIntroBody(names, hostName, address)` as `{ kind: "intro", channel: "group", audience }` with id `intro:{sorted audience joined by ","}`. It does nothing when `groupChat` is unset, when fewer than 2 people are `in`, or when that id is already sent.
  - `names` comes from `groupSeats()` in order (landlord, cleaner, extras), filtered to `consent === "in"`.

- [ ] **Step 1: Write the failing tests** (`describe("group-first: intro")`). They use a sink that records texts and the engine from Task 2.
  - The landlord is seated and Mike replies YES to the invite with no job booked. Exactly one `intro` is sent: `{ to: MIKE, kind: "intro", channel: "group", audience: [OWNER, MIKE], body: groupIntroBody(["Saad","Mike"], "Saad", LANE) }`.
  - The intro comes before the first offer in the sent order.
  - Ana replies YES after Mike. A second intro goes to `[OWNER, MIKE, ANA]` naming `Saad, Mike and Ana`.
  - **Review Focus 1:** Ana replies YES before Mike. There is no intro until Mike's YES, then one intro to all three.
  - **Review Focus 2:** Mike sends STOP. Nothing with `channel: "group"` is sent after it, no intro goes to `[OWNER]`, and Mike gets only the `stop` text.
  - **Review Focus 3:** reopen the engine with the same `dataDir` and run `pollFeed`. There is no second intro for the same members.
  - Opening the engine with both already `in` sends nothing until `pollFeed` or `receive`, which then sends the intro once.
- [ ] **Step 2: Run** `npx vitest run test/cleanerGroupFirst.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement `ensureIntro()`** and the calls listed above. `emitOne` must let `intro` through every check that a `confirm` group text passes. Add `"intro"` to any exhaustive kind maps or label maps that typecheck flags.
- [ ] **Step 4: Run** `npx vitest run test/cleaner` and `npm run typecheck`. Update tests whose recorded group posts now start with the intro, for example `fake.posts[0]` in `test/cleanerGroupMms.test.ts`'s `groupReady`, which should look up the offer post instead. Re-run until green.
- [ ] **Step 5: Commit** `feat(cleaner-core): post an intro when the group starts`.

### Task 4: Route job texts into the group

**Files:**
- Modify: `src/cleaner-core/core.ts`: `emit()` (~2093) and `groupUnconfirmedLine` topics in `cleanerTexts.ts`.
- Test: `test/cleanerGroupFirst.test.ts`, plus existing tests pinned to one-to-one job texts.

**Interfaces:**
- Consumes: `namedAsk` (Task 1), `ensureIntro()` (Task 3), and `emitGroupOffer` (#110, generalized here).
- Produces:
  - `private groupRouted(): boolean`: `groupChat` is set and at least 2 people are `in`.
  - `GROUP_ROUTED: ReadonlySet<TextKind>` = `offer`, `corrected`, `cancel-update`, `reminder`, `confirm`, `declined`, `started`, `done`, `next`, `checklist`, `held`, `emergency`, `host-message`.
  - While `groupRouted()`, a draft in `GROUP_ROUTED` goes to the group with these rules:
    - Its `to` is not the owner (owner-only notes keep going to Grok). The exception is `done` and `emergency`, which also go to the group when addressed to the owner.
    - It has no `channel` yet.
  - It is posted as `{ channel: "group", audience: groupAudience(), to: cleaner ?? audience[0] }`.
  - The body passes through `namedAsk(nameOf(draft.to), body)` when `draft.to` is a group member; the offer keeps `groupOfferBody`.
  - When the same body was already posted to the group for the same job, the duplicate copy is skipped. Example: the owner's and the cleaner's `done` lines become one group post when their bodies match; when they differ, both are posted.
  - The id is `{draft.id}:group`.
  - It falls back to the existing one-to-one path only when the group post is dropped as `GroupNotConfirmed` (status undefined), as `emitGroupOffer` does today.
  - `stop`, `help`, `start`, and `opt-in` never route to the group.

- [ ] **Step 1: Write the failing tests** (`describe("group-first: routing")`). Run the offer, Mike's YES, `guests have left`, START, a reminder (`runReminders` at the reminder time), a checkout move (`pollFeed` with a moved feed), and DONE, recording every text.
  - Every recorded text of kind `offer`, `corrected`, `reminder`, `confirm`, `started`, and `done` has `channel: "group"` and `audience: [OWNER, MIKE]`.
  - The `corrected` body contains `Mike, reply YES to keep the cleaning`. The reminder body ends `Mike, what time do you plan to arrive?`.
  - Mike's STOP produces exactly one text to Mike, `kind: "stop"`, with no `channel`.
  - HELP from Mike produces its reply with no `channel`.
  - An injury text from Mike posts the 911 line to the group (`kind: "emergency"`, `channel: "group"`).
  - With a sink that throws `GroupNotConfirmed` for group texts, the same flow sends those kinds one-to-one to Mike, and `hostNotes()` contains a `groupUnconfirmedLine` note.
- [ ] **Step 2: Run** `npx vitest run test/cleanerGroupFirst.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement the routing step** at the top of `emit()`, folding `emitGroupOffer`/`groupOfferOpen` into it. Add topics to `GROUP_SEND_TOPICS`: `corrected` → `time change`, `cancel-update` → `cancellation`, `started` → `start note`, `done` → `done note`, `emergency` → `injury alert`, `intro` → `intro`.
- [ ] **Step 4: Run** `npx vitest run test/cleaner` and `npm run typecheck`. Update older tests that pin one-to-one job texts in a group setup so they expect the group post. Keep each test's intent: who gets it, that the door code isn't in it, and that it isn't sent twice. Re-run until green.
- [ ] **Step 5: Commit** `feat(cleaner-core): keep job texts in the group`.

### Task 5: The door code rule, in code and in the safety docs

**Files:**
- Modify: `src/cleaner-core/core.ts`:
  - `CleanerCoreOptions.groupChat` gets `doorCodeTo?: "group" | "cleaner"`.
  - The pin send (~1782) picks the channel.
  - The `pin` guard in `emitOne` (~2255) allows the group only under the rule.
  - `GroupNotConfirmed` on a group pin falls back to the cleaner one-to-one.
- Modify: `AGENTS.md`. Replace the line `The door code goes only in a private text to the approved cleaner. The proof for that gate is [docs/cleaner-core-safety-gates.md](docs/cleaner-core-safety-gates.md).` with `The door code goes only to the approved cleaner: in the group when it holds only the landlord and the approved cleaner, or as the landlord chose when the group holds anyone else. The proof for that gate is [docs/cleaner-core-safety-gates.md](docs/cleaner-core-safety-gates.md).`
- Modify: `docs/cleaner-core-safety-gates.md`, row `Door code`. Change it to `Only to the opted-in approved cleaner after clearance: in the group when its members are exactly the landlord and that cleaner, otherwise as the landlord chose (the whole group, or privately to the cleaner). Never to an unapproved number. A code-like inbound opens one exposure review and the digits are not stored. Backups and logs keep the sealed reference only.` Add `test/cleanerGroupFirst.test.ts` to its evidence cell.
- Test: `test/cleanerGroupFirst.test.ts`. Update the old "never puts the door code in the group" tests (`cleanerGroupMms`, `cleanerCoreGroup`, `cleanerHostGroupSeat`, `cleanerOptionalObserver`, `cleanerFullSetup`) to the new rule.

**Interfaces:**
- Produces: `private pinChannel(): "group" | "private"`.
  - It returns `"group"` when `groupRouted()` and the `in` audience set equals exactly {owner, approved cleaner}.
  - It returns `"group"` when `groupRouted()`, the audience has anyone else, and `doorCodeTo === "group"`.
  - Otherwise it returns `"private"`.
  - `codeRoute()`'s `"held"` result still blocks the send entirely.

- [ ] **Step 1: Write the failing tests** (`describe("group-first: door code")`). Each starts with Mike's YES, then `guests have left`.
  - With just the owner and Mike, there is one `pin` text with `channel: "group"`, `audience: [OWNER, MIKE]`, and a body containing the made-up code. No `pin` text goes without a channel.
  - Ana is `in` and `doorCodeTo: "cleaner"`. One `pin` goes to Mike with no channel, and no group text contains the code.
  - Ana is `in` and `doorCodeTo: "group"`. One `pin` goes to the group with audience `[OWNER, MIKE, ANA]`.
  - **Review Focus 4:** Ana is `in`, `doorCodeTo: "cleaner"`, then Ana sends STOP before guests leave. The `pin` goes to the group with audience `[OWNER, MIKE]`.
  - **Review Focus 5:** with a sink that throws `GroupNotConfirmed` for group texts and just the owner and Mike, the `pin` goes one-to-one to Mike. No text with the code goes to the owner or to Ana.
  - Before `guests have left`, no text contains the code. `outbox()` and `transcript()` never contain the code.
- [ ] **Step 2: Run** `npx vitest run test/cleanerGroupFirst.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `pinChannel()`, the pin send, the `emitOne` guard (throw `The door code only goes to the approved cleaner.` when a group pin fails the rule), and the fallback.
- [ ] **Step 4: Edit `AGENTS.md` and the safety gates row** exactly as listed under Files.
- [ ] **Step 5: Run** `npx vitest run test/cleaner` and `npm run typecheck`. Update the old door-code tests to the new rule, keeping their checks that the code never reaches an observer, a contact under `doorCodeTo: "cleaner"`, a log, or a note. Re-run until green.
- [ ] **Step 6: Commit** `feat(cleaner-core): door code in the group under the landlord's rule`.

### Task 6: The live desk and Grok's tools

**Files:**
- Modify: `src/cleaner-core/liveDesk.ts`:
  - `PeopleInput` and `LiveFile` get `doorCodeTo?: "group" | "cleaner"`.
  - `savePeopleNow` refuses without it when `groupChat` is `everyone` or unset and at least one contact (or an observer) is saved.
  - `openEngine` passes it in `groupChat`.
  - `recipientOf` / `sendMessageNow` are group-only while `groupOn()`.
- Modify: `src/cleaner-core/mcp.ts`:
  - The `save_people` schema gets `doorCodeTo: z.enum(["group","cleaner"]).optional()`.
  - Its description adds: `When contacts are in the group, also doorCodeTo: group (the whole group gets the door code) or cleaner (only the cleaner, privately).`
  - The `send_message` description says that with a group, messages go only to the group.
- Modify: `CLEANER_CORE_BOOTSTRAP.md`. Step 4 mentions `doorCodeTo`, and the Messages section says `send_message` posts to the group. It must stay under 80 lines.
- Test: `test/cleanerGroupFirst.test.ts`, using the wired app (`startWiredApp({ groupChat: true })`, `useFake()` from `test/cleanerGroupMms.test.ts` patterns).

**Interfaces:**
- Consumes: `groupChat.doorCodeTo` (Task 5).
- Produces: the refusal copy from Global Constraints, and a `send_message` with `to` other than `group` refused with `Messages go to the group. Send it with to: group.` while the group is on.

- [ ] **Step 1: Write the failing tests** (`describe("group-first: Grok's tools")`).
  - `save_people` with `groupChat: "everyone"`, one contact, and no `doorCodeTo` is an error whose text is the exact door-code question. The same call with `doorCodeTo: "cleaner"` succeeds.
  - `save_people` with `cleaner-and-host` and no `doorCodeTo` succeeds.
  - With the group on, `send_message` `{ to: "Mike", text: "Running late" }` is an error with the exact refusal. `{ to: "group" }` returns a preview and code, and posts to the fake group only after the confirmation call.
  - **End to end:** the wired app runs setup, the landlord is seated, and Mike's YES comes in by SMS webhook. The fake has exactly one conversation, and its first post is the intro naming the business (no `hostName` saved).
    - After Mike's YES in the group (conversation webhook) and `mark_guests_left`, the reply's `next` is the existing `PIN_SENT` line.
    - Exactly one fake post contains the made-up code, to `[HOST, CLEANER]`, and no `wired.cleanerSent` SMS contains it.
- [ ] **Step 2: Run** `npx vitest run test/cleanerGroupFirst.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the desk and tool changes above.
- [ ] **Step 4: Run** `npx vitest run test/cleaner` and `npm run typecheck`. Update `send_message` tests that texted the cleaner or a contact directly in group setups (`test/cleanerFullSetup.test.ts` "send_message" block) to the group-only rule. Re-run until green.
- [ ] **Step 5: Commit** `feat(cleaner-core): save the door-code choice; send_message posts to the group`.

### Task 7: Whole-branch check and PR

**Files:** none new.

- [ ] **Step 1: Run** `npm run typecheck`, `npm run build`, and `npx vitest run`. Expected: all pass.
- [ ] **Step 2: Grep check.** Run `grep -rn "Cory" src/cleaner-core/liveDesk.ts src/cleaner-core/core.ts`. Expected: no hits outside comments.
- [ ] **Step 3: Get a fresh whole-branch review** against the spec. Fix what it finds, re-running Step 1.
- [ ] **Step 4: Push and open a PR** to `master`, following `.github/PULL_REQUEST_TEMPLATE.md`.
  - State that it changes the door-code rule in AGENTS.md and the safety gates doc with Saad's approval, and ask for QA bot review.
  - List the copy changes for a design pass.
  - Note that existing setups get the intro on their next engine step after deploy.
