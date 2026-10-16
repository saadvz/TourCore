# Cleaner Core: the group comes first

Date: 2026-10-16. Approved in conversation with Saad, section by section.

## Goal

Cleaner Core talks to the landlord, the cleaner, and any contacts in one group text. It starts that group as soon as the cleaner says YES, with an intro, and then keeps every text in it. The only one-to-one texts are the ones that can't go to a group (below).

Today the group is built only when the first offer is posted, there is no intro, and most job texts (time changes, confirmations, reminders, the door code) still go one-to-one. #110 moved only the offer into the group.

## What the landlord said

- The landlord joins through the Grok setup, as now. They are not texted an invite.
- Each number that never said YES before gets an invite. Anyone who already said YES is not asked again.
- When the cleaner says YES, the group starts right away with an intro text. It doesn't wait for contacts (choice A).
- A contact who says YES later gets a new group that includes them, with a fresh intro.
- Everything goes in the group, the door code included, under the rule in "The door code" below.
- Grok posts the landlord's own messages in the group, after the landlord approves the exact text.

## Joining and starting the group

1. **Setup.** `set_up_texting` seats the landlord in the group, as now. When `groupChat` is `everyone` and at least one contact is saved, `save_people` also needs `doorCodeTo`: `group` (the whole group) or `cleaner` (privately to the cleaner). Without it, `save_people` refuses with a question Grok asks the landlord: "You added other people to the group. Should the door code go to the whole group, or only privately to the cleaner?" The choice is saved with the property. With `cleaner-and-host`, there is no question.
2. **Invite.** Each saved cleaner or contact whose consent isn't `in` gets one text, one-to-one:
   `{landlord_name} wants to set up a group chat with you for cleaner services at {property address}. Reply YES to join, or STOP to opt out.`
   `{landlord_name}` is `hostName`, or the business name when none is saved. This replaces `groupOptInBody` for group setups. Cleaner-only setups keep their one-to-one opt-in text.
3. **Start.** When the cleaner's consent becomes `in` (and the landlord is seated), the next engine step posts the intro into a new group. This happens even with no cleaning booked.
4. **Intro.** `Hi {names}! This is the cleaning group for {property address}. I'm {landlord_name}'s cleaning assistant, and I'll post cleaning times and updates here. Reply STOP anytime to leave.`
   `{names}` is the landlord first, then the cleaner, then contacts in saved order. Two names read "A and B", and three or more read "A, B and C". The intro is a new text kind, `intro`, sent once per group membership (its id holds the sorted member phones, so the same people never get it twice).
5. **Late contacts.** A contact's YES changes the membership, so the next post builds a new group (as #110 already does) and posts a fresh intro first. The old group is cleared on Twilio.
6. **Leaving.** STOP takes that person out. Their opt-out confirmation goes to them one-to-one. The next post builds a new group without them, with a fresh intro. When fewer than two people would be left, there is no group, and the one person left gets one-to-one texts (as #110 already does).
7. **Existing setups.** A property whose landlord and cleaner are already `in` (Saad and Mike today) gets the intro on its next engine step after the deploy: the next `check_now`, inbound text, or tool call. It is never sent from server start alone. That first post also clears the old saved group on Twilio, as #110 does.

## Where each text goes

**Into the group.** A text that asks one person to reply starts with their name ("Mike, reply YES…", "Mike, what time do you plan to arrive?").
- offer, time changes (`corrected`), cancellations (`cancel-update`), reminder, confirmation, declined, started, done, the next-step reply (`next`), checklist, hold notes to the cleaner (`held`)
- the injury 911 line (`emergency`), so everyone knows at once
- the landlord's own messages (`send_message`). With a group on, `to` must be `group`. Any other `to` is refused with "Messages go to the group. Send it with to: group." The preview and the approval code stay: Grok shows the landlord the exact text and posts only after they say yes.

**The door code** (`pin`), still only after the landlord says the guests have left, and only to an approved cleaner:
- If the group's members are exactly the landlord and the approved cleaner, both `in`: into the group.
- If the group has anyone else: the saved `doorCodeTo`. `group` posts it to the group, and `cleaner` sends it one-to-one to the cleaner.
- If the group can't be made: one-to-one to the cleaner, never to anyone else.
- A group post that Twilio accepts counts as sent. There is no per-phone delivery report for group posts, so `PIN_SENT` reads as today and no failure follows from a missing report.

**Still one-to-one.** These are the only exceptions:
- the invite (the person isn't in a group yet)
- STOP and HELP replies, only to whoever sent STOP or HELP (carrier rules)
- any group text when the group can't be made: offers and updates fall back one-to-one and the landlord gets the note "I couldn't send … to the group.", as in #110

**Not texted.** Questions and notes for the landlord (checkout and check-in times, delivery problems, reviews, holds) keep going to Grok through `get_state` and `check_now`. They never go to the group.

**Replies.** A text to the Cleaner Core number one-to-one from a group member is handled the same way as one in the group, and any answer goes to the group.

## Safety rules

This PR changes the door-code rule. Saad approved the change, so the PR updates AGENTS.md, the safety gates doc, and the code, and QA bot reviews it.

- `AGENTS.md`: "The door code goes only in a private text to the approved cleaner." becomes "The door code goes only to the approved cleaner: in the group when it holds only the landlord and the approved cleaner, or as the landlord chose when the group holds anyone else."
- `docs/cleaner-core-safety-gates.md`: the same rule, with links to the new tests.
- `core.ts` `emitOne`: the check that throws on `pin` with `channel === "group"` allows it only when the rule above holds, and checks the audience on every send.

Unchanged:
- The code is never in logs, notes, Grok's replies, or saved files except the sealed pin.
- It is never sent before "guests have left".
- It never goes to someone who isn't approved.

## Code shape

- `core.ts`: one routing step in `emit` decides, for each draft, whether it goes to the group (when at least two members are `in`), one-to-one, or as an exception. It also handles the cleaner-name prefix and the door-code rule. The intro is drafted when the membership changes. `groupOptInBody` gives way to a new `groupInviteBody` in `cleanerTexts.ts`.
- `liveDesk.ts`: `save_people` takes `doorCodeTo` and refuses without it when contacts are in the group. `send_message` is group-only with a group on. The engine gets `doorCodeTo` through `groupChat`.
- `liveSms.ts`: no change in how a group is built. #110 already reuses, replaces, and clears groups by membership.

## Tests

All tests use the fake Conversations API (`test/fakeConversations.ts`), 555 numbers, and made-up codes:

- **Invites:** the invite text, landlord name or business, and a person who already said YES is not asked.
- **Group start:** the cleaner's YES creates the group and the intro with no booking, the intro is not sent twice, and nothing is sent from server start alone.
- **Membership changes:** a late contact gets a new group, a fresh intro, and the old group cleared. STOP gets a one-to-one opt-out confirmation, a new group without that person, and a fresh intro. A group of one goes one-to-one.
- **Routing:** each text kind goes where "Where each text goes" says, including the name prefix.
- **`send_message`:** group-only with the approval step kept.
- **The door code:**
  - in the group for landlord and cleaner only;
  - with contacts, `doorCodeTo: group` posts to the group and `cleaner` sends one-to-one;
  - `save_people` refuses without `doorCodeTo` when contacts are in;
  - never before "guests have left";
  - one-to-one to the cleaner when the group can't be made.
- **Existing tests:** tests that pin the old one-to-one routing move to the group expectations, as in #110.

## Out of scope

- `reset_scratch` for setups saved with real phones (it still needs 555 numbers).
- Letting Grok post without the landlord's approval.
- `confirm_times` naming which job it sets.
