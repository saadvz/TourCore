# Tour Core Grok Bot template (v0.5.0)

Everything that belongs in the **Tour Core** Grok Bot team template, versioned
with the code. Grok Bot is the installer and operator console; Tour Core stays
the system of record and policy authority; Durin carries out approved access.

```
Operator ─► Tour Core Bot ─► hosted Tour Core (hostedTourCoreUrl) ─► Durin
               │
               └─ open-source fallback: clone and run Tour Core on the
                  Bot's computer (npm run bootstrap:grok)
```

First run: the operator says **"Set up Tour Core."** When `hostedTourCoreUrl`
is set, the Bot connects to that service. It does not ask the operator to
host anything. See [`docs/deployment.md`](../docs/deployment.md).

Two ways in:

- **Final template experience:** add the Tour Core Bot from the template and
  say *"Set up Tour Core."* The template already knows the canonical
  repository and the bootstrap behavior.
- **Development / open-source fallback:** a completely blank Grok Bot, one
  prompt with the repository URL, no attachments. Grok clones the repository
  and follows [`GROK_BOOTSTRAP.md`](../GROK_BOOTSTRAP.md), which points it to
  the skills in `.grok/skills/`. The files in this folder aren't needed for
  that path. The prompt is in [`docs/grok-manual-test.md`](../docs/grok-manual-test.md), test B.

## What's in the template

| Part | File(s) | How it gets into Grok Bot |
| --- | --- | --- |
| Profile (name, title, description, standing instructions, starting prompts) | `bot-profile.md` | Bot actions → Edit Profile, and the Bot's instructions |
| Reusable context | `context/*.md` | Attach or paste into the Bot conversation and ask it to remember them |
| Eight skills: Install Tour Core, the six operator skills, and Backup Tour Core | `../.grok/skills/*/SKILL.md` (canonical, not copied) | Ask the Bot to save each as a private skill |
| Routine: Tour Core Operator Updates | `routines/operator-updates.md` | Grok creates it (authenticated webhook trigger, these instructions) when the operator turns on tour updates |
| Safe examples | `examples/*.md` | Context for the Bot; made-up data only |
| Integration | `integrations/tour-core-tools.md` | Custom MCP server; connected by every installation |
| Manifest | `template.json` | For reviewers; lists every item, the repository setting, and what's never included |

The repository address is https://github.com/saadvz/TourCore
(`template.json` → `repository.url`). An address in the operator's message or
`TOURCORE_REPO_URL` is only a fallback: if it differs, Grok asks the operator,
and `npm run bootstrap:grok` refuses to start a clone from another origin.

## What's never in the template

Sendblue keys or secrets, the webhook secret, the Grok Routine's webhook
address or key, Tour Core connector or OAuth tokens, Durin credentials,
visitor names or phone numbers, live property records, tour history, any
canonical Tour Core state, or a private repository address.
`test/grokTemplate.test.ts` fails if any of these patterns show up in this
folder or the skills.

Custom MCP servers and credentials don't travel with a Grok Bot template.
After adding the Bot, each installation gets its own Tour Core, its own
connection, and its own routine credentials (collected with a secure secret
input). `template.json` → `marketplace` spells out what ships
(instructions, skills, the routine definition, integration references) and
what never does.

## What the Bot does for the operator

- **Property identity and type.** The address is the property's name unless
  the operator gives one; the Bot never invents a building name. It asks
  "What type of property is this?" (single-family home, multifamily home,
  apartment building, other) and shapes the units question to match. A new
  property uses the installed visitor texting automatically.
- **Tour updates.** After the first property, the Bot offers to keep the
  operator posted on bookings, tour starts, completions and anything that
  needs their input, through the Tour Core Operator Updates routine.
- **Plain status.** "Visitor texting is live. Door access is still in demo
  mode, so no physical locks will open." Never "everything runs in demo mode".
- **Visitor questions at every stage.** Answered only from approved facts;
  anything unknown is flagged to the operator, and the visitor picks up where
  they left off once it's answered. A booked-tour cancel by text (any natural
  phrasing) is handled by Tour Core: it confirms, then YES cancels (`You're
  cancelled. Text me anytime if you want to book again.`) or NO keeps the
  booking (`Okay, your tour stays on {day} at {time}.`). A reply that isn't a
  clear yes or no is flagged. That is not a missing-fact flag.
- **One-off tours.** When the operator wants to set up a tour for someone who
  asked (including a visitor who hasn't texted in, or who only got a day or
  time menu and never booked), the Bot uses `schedule_one_off_tour` and asks
  the exact question Tour Core returns. Only a yes that they asked is enough.
  A leftover choosing menu is replaced; a booked tour, pending one-off, open
  tour window, or hold is refused. Tell the operator Tour Core's words
  (`They already have a booked tour. I can move it or call it off.`), then
  move with `reschedule_tour` or call off with `revoke_tour_access` (resume a
  hold with `clear_operator_hold`). If tours are paused, approve and
  reschedule refuse (`Tours at {property} are paused. Resume them first.`).
  While the visitor is confirming, a leftover
  menu number only re-prompts YES / NO / STOP; a real question is flagged.
  Confirmation questions end `Move it?`,
  `Book it?`, or `Save it?`.

Install and publishing steps: [`docs/grok-template-setup.md`](../docs/grok-template-setup.md).
Manual test: [`docs/grok-manual-test.md`](../docs/grok-manual-test.md).
