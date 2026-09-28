# Tour Core Grok Bot template (v0.2.0)

Everything that belongs in the **Tour Core** Grok Bot team template, versioned
with the code. Grok Bot is the operator console; Tour Core stays the system of
record and policy authority; Durin carries out approved access.

```
Operator ─► Tour Core Bot (Grok Bot) ─► Tour Core tools (/mcp) ─► Tour Core ─► Durin
                                          same actions as the browser app and terminal
```

## What's in the template

| Part | File(s) | How it gets into Grok Bot |
| --- | --- | --- |
| Profile (name, title, description, standing instructions, starting prompts) | `bot-profile.md` | Bot actions → Edit Profile, and the Bot's instructions |
| Reusable context | `context/*.md` | Attach or paste into the Bot conversation and ask it to remember them |
| Six operator skills | `../.grok/skills/*/SKILL.md` (canonical, not copied) | Ask the Bot to save each as a private skill |
| Safe examples | `examples/*.md` | Context for the Bot; made-up data only |
| Integration | `integrations/tour-core-tools.md` | Custom MCP server; reconnected by every installer |
| Manifest | `template.json` | For reviewers; lists every item and what's never included |

No routines: every P0 operator workflow is started by the operator.

## What's never in the template

Sendblue keys or secrets, the webhook secret, Tour Core connector or OAuth
tokens, Durin credentials, visitor names or phone numbers, live property records, tour
history, or any canonical Tour Core state. `test/grokTemplate.test.ts` fails if
any of these patterns show up in this folder or the skills.

Custom MCP servers don't travel with a Grok Bot template (xAI: templates carry
instructions, memories, skills, routines and first-party integrations, not
custom code, custom MCP servers or credentials). After adding the Bot, each
installer connects their own Tour Core.

Install and publishing steps: [`docs/grok-template-setup.md`](../docs/grok-template-setup.md).
Manual test: [`docs/grok-manual-test.md`](../docs/grok-manual-test.md).
