# Cleaner Core Grok Bot template (v0.1.0)

Everything a Grok Bot needs to set up and run Cleaner Core, versioned with the
code. The Grok Bot is the host's chat. Cleaner Core is the hosted service that
keeps the records and sends the texts.

```
Host ─► Grok Bot ─► hosted Cleaner Core (hostedCleanerCoreUrl/mcp/cleaner-core) ─► the cleaner's phone
            │
            └─ Grok's own Google Calendar connector, secure card, routines, and vision
```

## How a host starts

1. Open a new Grok Bot.
2. Paste the prompt in [`SETUP_PROMPT.md`](SETUP_PROMPT.md).
3. Click Allow when the connection asks.

Grok clones the repository only to read
[`CLEANER_CORE_BOOTSTRAP.md`](../CLEANER_CORE_BOOTSTRAP.md). Then it asks the
setup questions one at a time. The host never leaves the chat.

## What's in the template

| Part | File | How it gets into Grok Bot |
| --- | --- | --- |
| The paste-in prompt | `SETUP_PROMPT.md` | The host pastes it into a new Grok Bot |
| Profile and standing instructions | `bot-profile.md` | Bot actions → Edit Profile, and the Bot's instructions |
| Routine: Cleaner Core Check | `routines/cleaner-core-check.md` | Grok creates it after Activate (scheduled trigger) |
| Routine: Cleaner Core Alerts | `routines/cleaner-core-alerts.md` | Grok creates it after Activate (authenticated webhook trigger) |
| Manifest | `template.json` | For reviewers. It lists every item and what's never included |

`SETUP_PROMPT.md` is pinned by `test/cleanerTemplate.test.ts`. Change it only
on purpose, and update the pin in the same change.

## What Grok does itself

- Reads only the Google calendar the host says holds the bookings, with its
  own connector, and passes those events to Cleaner Core.
- Takes the door code on its secure card. Sends the Alerts routine's address
  and key to a one-time upload link from its own cloud computer.
- Runs its own scheduled and webhook routines.
- Looks at the cleaner's photos and summarizes the cleaning in its own words.

Grok never texts anyone. Cleaner Core sends every text, after the host's yes
when a person wrote it.

## What's never in the template

The door code, the Alerts routine's webhook address or token, Cleaner Core or
Google tokens, Twilio details, phone numbers, calendar links, or any live
booking or cleaning record. `test/cleanerTemplate.test.ts` fails if a secret
pattern, a phone number outside 555-01xx, or a door-code-like number shows up
here or in `CLEANER_CORE_BOOTSTRAP.md`.

Custom MCP servers and credentials don't travel with a Grok Bot template. Each
host connects with their own Allow and creates their own routines.

## Admin prep (the operator, once)

The host must run in deployment mode `HOSTED_RAILWAY_P0` with OAuth on
(`TOURCORE_MCP_AUTH_MODE` unset or `oauth`, never `static`), or the Allow
button never appears.
