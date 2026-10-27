# Cleaner Core for ChatGPT (v0.1.0)

Everything ChatGPT needs to set up and run Cleaner Core. ChatGPT is the host's
chat. Cleaner Core is the hosted service that keeps the records and sends the
texts. The Grok Bot version in [`cleaner-template/`](../cleaner-template/) and
the Claude version in [`claude-template/`](../claude-template/) are unchanged
and keep their own deployments.

```
Host ─► ChatGPT ─► ChatGPT deployment of Cleaner Core (/mcp/cleaner-core) ─► the cleaner's phone
          │
          └─ ChatGPT's Google Calendar app and an hourly scheduled task
```

## What's different from Grok and Claude

| | Grok Bot | Claude | ChatGPT |
| --- | --- | --- | --- |
| Door code, calendar links | Grok's secure card | Cleaner Core's private page | Cleaner Core's private page, same as Claude |
| Routines | Check (scheduled) and Alerts (webhook) | One task: hourly schedule plus API trigger | One hourly task. Nothing can wake it. |
| When the cleaner texts | The webhook wakes the bot | The API trigger wakes the task | The host sees it in the group text right away. ChatGPT reads it on the next hourly run, or at once when the host asks. |
| Cleaning photos | Signed links | Links plus the photos as images | Signed links |
| Texts to the host | "Tell your Grok Bot…" | "Tell Claude…" | "Tell ChatGPT…" |

Everything else is the same server and the same gates: the setup steps, the
questions, the approval codes, who gets the door code and when, and every
safety rule in [`docs/cleaner-core-safety-gates.md`](../docs/cleaner-core-safety-gates.md).

### Why the group text matters here

ChatGPT runs a scheduled task at most once an hour, and has no webhook, so
Cleaner Core can't tell ChatGPT the moment the cleaner writes. The group text
(the default answer at setup, "A group text with me and the cleaner") puts the
cleaner's message on the host's phone right away. The host then says "Maria
texted, draft a reply", and ChatGPT calls `check_now` first to read the actual
message. A host who picks texts to the cleaner alone is told at setup that
those messages can take up to an hour to reach them.

### If the hourly task stops

A ChatGPT task can pause itself. Once Cleaner Core is live, `get_state` warns
when no check has come in for more than two and a half hours, and ChatGPT
tells the host to turn the task back on. The task's prompt also tells it never
to pause, edit, or delete itself.

## Deploy (the operator, once)

A hosted Cleaner Core has one owner, so ChatGPT gets its own service. It runs
the same build as the Grok and Claude ones.

1. Create a Railway service from this repository, the same way as the Grok
   service: deployment mode `HOSTED_RAILWAY_P0`, its own volume, its own
   public address, and OAuth on (`TOURCORE_MCP_AUTH_MODE` unset or `oauth`,
   never `static`).
2. Set the same Cleaner Core variables as the Grok service, plus one:
   `CLEANER_CORE_ASSISTANT=chatgpt`. Give it its own Twilio number for the
   cleaner texts. A number has one incoming-message webhook, so on a shared
   number one service never hears the cleaner's YES, DONE, or STOP, and a STOP
   to the number blocks both. The full list:

   | Variable | Value | Without it |
   | --- | --- | --- |
   | `CLEANER_CORE_ENABLED` | `1` | Cleaner Core is off |
   | `CLEANER_CORE_ASSISTANT` | `chatgpt` | The service talks to Grok: ChatGPT's sign-in is refused, and setup asks for Grok's secure card |
   | `CLEANER_CORE_LIVE_SMS` | `1` | Every text is held and nothing reaches Twilio |
   | `CLEANER_CORE_TWILIO_ACCOUNT_SID`, `CLEANER_CORE_TWILIO_AUTH_TOKEN`, `CLEANER_CORE_TWILIO_PHONE_NUMBER` | This service's own Twilio account and number | No text can go out |
   | `CLEANER_CORE_SMS_ALLOWLIST` | The host's and the cleaner's numbers, comma-separated in `+1XXXXXXXXXX` form, or `*` for any number | Activate is refused: "only after those numbers are approved for texts" |
   | `CLEANER_CORE_GROUP_CHAT` | Leave unset | `0` or `false` turns off the group text, the fast way the host hears from the cleaner |

   Leave `TOURCORE_MCP_AUTH_MODE` unset. Don't set `CLEANER_CORE_PIN_KEY` or
   `CLEANER_CORE_PHOTO_KEY`: the service makes and keeps its own. Secret values
   go in Railway's variables, never in a chat or this repository.
3. Set that Twilio number's incoming-message webhook to
   `<hostedCleanerCoreUrl>/webhooks/twilio/cleaner-core`.
4. Put the service's https address in `hostedCleanerCoreUrl` in
   [`template.json`](template.json) and share it with hosts.

`CLEANER_CORE_ASSISTANT=chatgpt` changes only words and formats: the connector
instructions, the setup `how` lines, the texts to the host, the approval page,
the private upload pages, and the routine step. It also allows ChatGPT's
`chatgpt.com` connector callback without setting
`TOURCORE_OAUTH_REDIRECT_HOSTS`, and has ChatGPT register its own client.
Leave it unset on the Grok service.

To demo again with a new ChatGPT account, set `CLEANER_CORE_HOSTED_OWNER_RESET`
to `reset-cleaner-owner` for one deploy, then remove it. The next Allow becomes
the owner.

## Which ChatGPT plans work

Cleaner Core needs a custom connector (Developer Mode) and an hourly scheduled
task. As of October 2026:

| Plan | Custom connector | Scheduled tasks | Cleaner Core |
| --- | --- | --- | --- |
| Free | No: directory apps only | Reported as 3 tasks, each at most once a day | Doesn't work |
| Plus | Yes | Hourly | Works. Setup, Activate, texting, and the hourly check were tested live on Plus. |
| Pro, Business, Enterprise, Edu | Yes. On Business, an admin turns on Developer Mode for themselves. | Hourly | Should work. Not tested yet. |

Published sources disagree on whether Plus and Pro get write tools in
Developer Mode, and OpenAI changes these limits often. Recheck before telling
a host which plan they need. A Free host can only use Cleaner Core once it is
a published app in ChatGPT's directory, and even then a once-a-day task can't
keep up with new bookings.

## How a host starts

The step-by-step version, with troubleshooting, is
[`SETUP_GUIDE.md`](SETUP_GUIDE.md).

1. On chatgpt.com (web only), open **Settings → Apps & Connectors →
   Advanced** and turn on **Developer Mode**. A custom connector needs it until
   Cleaner Core is published in ChatGPT's app directory.
2. Create a connector named **Cleaner Core** with the URL
   `<hostedCleanerCoreUrl>/mcp/cleaner-core` and OAuth, then click **Allow**
   on the Cleaner Core page.
3. Connect ChatGPT's **Google Calendar** app too, if the bookings are in
   Google Calendar.
4. In a new chat, add Cleaner Core from the **+** menu and say "Set up Cleaner
   Core". ChatGPT only calls a custom connector that is added to the chat.

## Known limits

- **Safety blocks.** ChatGPT's own safety check sometimes blocks a tool call
  before it reaches Cleaner Core ("This tool call was blocked by OpenAI's
  safety checks"). Asking again usually works. Cleaner Core never sees the
  blocked call.
- **Developer Mode.** Every host turns it on until Cleaner Core is a
  published ChatGPT app, which waits on hosted multi-tenancy
  ([`docs/hosted-multitenancy.md`](../docs/hosted-multitenancy.md)).
- **Photos.** They stay signed links until ChatGPT is shown to read images in
  a tool result.

## What ChatGPT does itself

- Reads only the Google calendar the host says holds the bookings, and passes
  those events to Cleaner Core.
- Sends the host each private upload link, and confirms with `get_state` once
  the host has saved the value there.
- Creates the hourly scheduled task, then reads its runs.
- Drafts a reply when the host asks, after reading the message with
  `check_now`.

ChatGPT never texts anyone. Cleaner Core sends every text, after the host's
yes when a person wrote it.

## What's never in this template

The door code, Cleaner Core or Google tokens, Twilio details, phone numbers,
calendar links, or any live booking or cleaning record.
`test/cleanerChatGpt.test.ts` fails if a secret pattern, a phone number
outside the 555 test range, or a door code shows up here.
