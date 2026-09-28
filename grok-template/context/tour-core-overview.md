# Tour Core overview (reusable context)

Tour Core is an open-source self-touring tool. A prospect texts the property's
number, books a time, agrees to texts and tour records, confirms who they are,
and tours one unit on their own. The text thread stays live through the tour:
Tour Core guides them door by door and answers questions only from facts the
property team approved. Afterwards it sends a recap and one follow-up question.

## Who does what

| Part | Job |
| --- | --- |
| Operator (you) | Decides setup, answers, and anything consequential |
| Grok Bot (Tour Core Bot) | Understands the operator and calls Tour Core's tools |
| Tour Core | Keeps every record, applies policy, writes the audit |
| Durin | Carries out access Tour Core has already approved |

## The access rule

A door opens only when all of these hold for the visitor asking: their records
are valid (reservation, consent, identity check), it's their tour time, the
door is on their exact reserved route, and the system is healthy with no
conflict, provider failure or operator hold. Anything else is a safe denial,
decided before Durin is contacted.

## What an operator does with the Bot

0. **Set up Tour Core**: the Bot installs and starts Tour Core on its own cloud
   computer, then asks the operator only for what needs a person (see
   `installation.md`).
1. **Set up a property**: address, units, doors, routes, tour hours, visitor
   verification, messaging.
2. **Check readiness**: real checks against the pieces the setup uses.
3. **Run a practice tour**: a full pretend tour with safety checks. Nobody is
   texted and no real door opens.
4. **Publish for demo**: only after both pass, and only after the operator's yes.
5. **Watch active tours** and **work exceptions**: unanswered questions, help
   requests, door problems, paused tours, tours that couldn't be restored.
   Tour Core also wakes the Bot (Tour Core Exception Alert routine) when a
   visitor needs judgment, so the operator hears about it without asking.
6. **Export the audit**: a validated, provider-neutral record of the day.

## Current P0 demo configuration

- Tour Core runs on the Bot's cloud computer (a demo deployment) or at a
  stable self-hosted address.
- Visitor messaging: Sendblue (real texts and iMessages).
- Operator alerts: the Tour Core Exception Alert Grok Routine.
- Tour records: stored with the Tour Core installation. Google Drive is the next step.
- Door access: Durin demo mode. No physical door is controlled.
- Visitor verification: basic identity form (records claimed identity; it
  doesn't prove it).

"Published for demo" is not a production launch.
