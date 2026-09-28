# Tour Core Grok Bot template (v0.3.0)

Everything that belongs in the **Tour Core** Grok Bot team template, versioned
with the code. Grok Bot is the installer and operator console; Tour Core stays
the system of record and policy authority; Durin carries out approved access.

```
Operator ─► Tour Core Bot (Grok Bot) ─► Tour Core tools (/mcp) ─► Tour Core ─► Durin
               │                          same actions as the browser app and terminal
               └─ its own cloud computer: installs, starts and repairs Tour Core
                  (npm run bootstrap:grok), opens Tour Core's secure setup page
```

First run: the operator says **"Set up Tour Core."** The Bot installs Tour
Core on its own cloud computer and walks the operator through only the steps
that need a person. See [`docs/deployment.md`](../docs/deployment.md).

## What's in the template

| Part | File(s) | How it gets into Grok Bot |
| --- | --- | --- |
| Profile (name, title, description, standing instructions, starting prompts) | `bot-profile.md` | Bot actions → Edit Profile, and the Bot's instructions |
| Reusable context | `context/*.md` | Attach or paste into the Bot conversation and ask it to remember them |
| Seven skills: Install Tour Core plus the six operator skills | `../.grok/skills/*/SKILL.md` (canonical, not copied) | Ask the Bot to save each as a private skill |
| Routine: Tour Core Exception Alert | `routines/exception-alert.md` | Create a routine with an authenticated webhook trigger and these instructions |
| Safe examples | `examples/*.md` | Context for the Bot; made-up data only |
| Integration | `integrations/tour-core-tools.md` | Custom MCP server; connected by every installation |
| Manifest | `template.json` | For reviewers; lists every item, the repository setting, and what's never included |

The repository address is https://github.com/saadvz/TourCore
(`template.json` → `repository.url`). `TOURCORE_REPO_URL` on the Bot's cloud
computer overrides it.

## What's never in the template

Sendblue keys or secrets, the webhook secret, the Grok Routine's webhook
address or key, Tour Core connector or OAuth tokens, Durin credentials,
visitor names or phone numbers, live property records, tour history, any
canonical Tour Core state, or a private repository address.
`test/grokTemplate.test.ts` fails if any of these patterns show up in this
folder or the skills.

Custom MCP servers and credentials don't travel with a Grok Bot template.
After adding the Bot, each installation gets its own Tour Core, its own
connection, and its own routine credentials (entered on Tour Core's secure
setup page).

Install and publishing steps: [`docs/grok-template-setup.md`](../docs/grok-template-setup.md).
Manual test: [`docs/grok-manual-test.md`](../docs/grok-manual-test.md).
