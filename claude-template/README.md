# Cleaner Core for Claude (v0.1.0)

Everything Claude needs to set up and run Cleaner Core. Claude is the host's
chat. Cleaner Core is the hosted service that keeps the records and sends the
texts. The Grok Bot version in [`cleaner-template/`](../cleaner-template/) is
unchanged and keeps its own deployment.

```
Host ─► Claude ─► Claude deployment of Cleaner Core (/mcp/cleaner-core) ─► the cleaner's phone
          │
          └─ Claude's Google Calendar connector, a scheduled task, and vision
```

## What's different from Grok

| | Grok Bot | Claude |
| --- | --- | --- |
| Door code, calendar links, alert key | Grok's secure card, posted from Grok's cloud computer | The host types them on Cleaner Core's own private page, from a one-time link Claude sends |
| Routines | Cleaner Core Check (scheduled) and Cleaner Core Alerts (webhook) | One scheduled task with an hourly schedule and an API trigger ([`routines/cleaner-core-task.md`](routines/cleaner-core-task.md)) |
| Where alerts land | The bot's chat | The scheduled task's run, a session the host can reply in |
| Cleaning photos | Signed links | The same links, plus the photos themselves as images |
| Texts to the host | "Tell your Grok Bot…" | "Tell Claude…" |
| Guide | Cloned from the repo (`CLEANER_CORE_BOOTSTRAP.md`) | The connector's own instructions, plus the `cleaner-core` skill |

Everything else is the same server and the same gates: the setup steps, the
questions, the approval codes, who gets the door code and when, and every
safety rule in [`docs/cleaner-core-safety-gates.md`](../docs/cleaner-core-safety-gates.md).

## Deploy (the operator, once)

A hosted Cleaner Core has one owner, so Claude gets its own service. It runs
the same build as the Grok one.

1. Create a second Railway service from this repository, the same way as the
   Grok service: deployment mode `HOSTED_RAILWAY_P0`, its own volume, its own
   public address, and OAuth on (`TOURCORE_MCP_AUTH_MODE` unset or `oauth`,
   never `static`).
2. Set the same Cleaner Core variables as the Grok service, plus one:
   `CLEANER_CORE_ASSISTANT=claude`. Give it its own Twilio number for the
   cleaner texts, with that number's incoming-message webhook set to this
   service's `/webhooks/twilio/cleaner-core`. A number has one webhook, so on
   a shared number one service never hears the cleaner's YES, DONE, or STOP,
   and a STOP to the number blocks both. Group chats are not affected: each
   group conversation sends replies to the service that made it.
3. Put its https address in `hostedCleanerCoreUrl` in
   [`template.json`](template.json) and share it with hosts.

`CLEANER_CORE_ASSISTANT=claude` changes only words and formats: the connector
instructions, the setup `how` lines, the texts to the host, the approval page,
the private upload pages, the alert format, and photos as images. It also
allows claude.ai's connector callback without setting
`TOURCORE_OAUTH_REDIRECT_HOSTS`. Leave it unset on the Grok service.

To demo again with a new Claude account, set `CLEANER_CORE_HOSTED_OWNER_RESET`
to `reset-cleaner-owner` for one deploy on the Claude service, then remove it.
The next Allow becomes the owner.

## How a host starts

1. In claude.ai, open **Settings → Connectors → Add custom connector**. Name
   it **Cleaner Core** and enter `<hostedCleanerCoreUrl>/mcp/cleaner-core`.
2. Click **Connect**, then **Allow** on the Cleaner Core page.
3. Connect Claude's **Google Calendar** connector too, if the bookings are in
   Google Calendar.
4. Optional, for the fullest guide: add the `cleaner-core` skill (below).
5. Say "Set up Cleaner Core".

The connector is shared by claude.ai, the desktop and mobile apps, Cowork,
Claude Code, and the scheduled task. Add it only once: a second connection to
the same Cleaner Core, such as `claude mcp add` in Claude Code, is refused.

## The skill

[`plugin/skills/cleaner-core/SKILL.md`](plugin/skills/cleaner-core/SKILL.md)
is the Claude version of `CLEANER_CORE_BOOTSTRAP.md`. Claude works without it,
because the connector's instructions carry the essentials, but the skill holds
the full guide.

- **Claude Code:** `/plugin marketplace add saadvz/TourCore`, then
  `/plugin install cleaner-core@tour-core`.
- **claude.ai, desktop, Cowork:** zip the `plugin/skills/cleaner-core` folder
  and upload it in **Settings → Capabilities → Skills**.

The plugin carries only the skill, not a connector, for the reason above.

## What Claude does itself

- Reads only the Google calendar the host says holds the bookings, and passes
  those events to Cleaner Core.
- Sends the host each private upload link, and confirms with `get_state` once
  the host has saved the value there.
- Walks the host through the scheduled task, then reads its runs.
- Looks at the cleaner's photos and summarizes the cleaning in its own words.

Claude never texts anyone. Cleaner Core sends every text, after the host's yes
when a person wrote it.

## What's never in this template

The door code, the scheduled task's Fire URL or token, Cleaner Core or Google
tokens, Twilio details, phone numbers, calendar links, or any live booking or
cleaning record. `test/cleanerClaude.test.ts` fails if a secret pattern, a
phone number outside the 555 test range, or a door code shows up here.

## Files

| File | What it is |
| --- | --- |
| [`template.json`](template.json) | Manifest: the deployment, the connectors, the task, and what's never included |
| [`routines/cleaner-core-task.md`](routines/cleaner-core-task.md) | The scheduled task: how to make it, its prompt, and what Cleaner Core sends it |
| [`plugin/`](plugin/) | The Claude plugin, listed by [`/.claude-plugin/marketplace.json`](../.claude-plugin/marketplace.json) |
| [`plugin/skills/cleaner-core/SKILL.md`](plugin/skills/cleaner-core/SKILL.md) | The skill: setup order, every booking, messages, and rules |

The code side is [`src/cleaner-core/assistant.ts`](../src/cleaner-core/assistant.ts)
(the Claude wording and the switch) and
[`src/cleaner-core/uploadPage.ts`](../src/cleaner-core/uploadPage.ts) (the
private page). `test/cleanerClaude.test.ts` pins both, and pins Grok's
connector instructions byte for byte.
