# Cleaner Core for Muse (v0.1.0, draft)

Everything Meta's Muse needs to set up and run Cleaner Core. Muse is the host's
chat. Cleaner Core is the hosted service that keeps the records and sends the
texts. The Grok Bot version in [`cleaner-template/`](../cleaner-template/), the
Claude version in [`claude-template/`](../claude-template/), and the ChatGPT
version in [`chatgpt-template/`](../chatgpt-template/) connect to the same
service.

```
Host ─► Muse ─► hosted Cleaner Core (/mcp/cleaner-core) ─► the cleaner's phone
         │            ▲
         │            └─ private pages, opened and filled in Muse's own browser
         └─ Muse's Google Calendar connector, an hourly recurring task, and its browser
```

**Status: draft.** The guide, the task, and the server's Muse profile are
built. The open questions below need a live re-test on the deployed server
before a host uses it. See [Before a host uses this](#before-a-host-uses-this).

## How a host starts

1. Open a new Muse chat and paste the prompt in
   [`SETUP_PROMPT.md`](SETUP_PROMPT.md).
2. When the Cleaner Core page opens, type the invite code from Saad and click
   **Allow**.
3. In **Settings → Connectors → Cleaner Core**, let Muse use it without asking
   each time, so the hourly task can run.

Muse has no shareable bot templates like Grok's, so the paste-in prompt is the
way in. Muse clones the repository on its cloud computer only to save
[`skills/cleaner-core`](skills/cleaner-core/SKILL.md) as a skill, so later
chats and the hourly task already know the guide. Everything else happens in
the chat.

## What's different from the other chats

| | Grok Bot | Claude, ChatGPT | Muse |
| --- | --- | --- | --- |
| Entry | Team template, or a paste-in prompt | Add the connector in settings | A paste-in prompt. Muse creates the connector itself |
| Guide | Cloned `CLEANER_CORE_BOOTSTRAP.md` | The connector's instructions (and Claude's skill) | The `cleaner-core` skill Muse saves from the clone |
| Questions with options | Choice cards | A short list | Choice cards, or a short list if Muse can't show one |
| Door code | Grok's secure card, posted from its cloud computer | The host types it on Cleaner Core's private page from a link | Muse opens the private page in its own browser and hands it to the host, who types the code there |
| Calendar links | Grok's secure card | The host pastes it on the private page | The host picks: they have the link (as above), or Muse finds it on the booking site in its browser after the host signs in |
| Routines | Check (scheduled) and Alerts (webhook) | Claude: hourly plus API trigger. ChatGPT: hourly only | One hourly recurring task. Nothing can wake it |
| When the cleaner texts | The webhook wakes the bot | Claude: the API trigger. ChatGPT: the next hourly run | The host sees it in the group text right away. Muse reads it on the next hourly run, or at once when the host asks |
| Cleaning photos | Signed links | Claude: images. ChatGPT: links | Muse opens the signed links in its browser and looks at them |
| Texts to the host | "Tell your Grok Bot…" | "Tell Claude…", "Tell ChatGPT…" | "Tell Muse…" |

Everything else is the same server and the same gates: the setup steps, the
questions, the approval codes, who gets the door code and when, and every
safety rule in [`docs/cleaner-core-safety-gates.md`](../docs/cleaner-core-safety-gates.md).

## Why cards for some things and the browser for others

A Muse choice card is fine for any answer that isn't secret: the address, the
usual times, names, and every question with options. Whatever goes in a card
lands in the conversation, where the model reads it. So the door code, the
calendar links, and the invite code never go in a card.

For those, Muse uses its computer use. It opens Cleaner Core's one-time page
in its own cloud browser and hands the browser to the host, who types the
value there. Meta says a password the host types into Muse's browser is kept
from the model like one on its login screen. The door-code field on Cleaner
Core's page is already a password field
([`src/cleaner-core/uploadPage.ts`](../src/cleaner-core/uploadPage.ts)).
Muse's secure credential prompt isn't used: it holds only a sign-in
(username and password) or an API key, so it can't take a door code or a
link (probe, 2026-10-29).

**Find it for me.** Finding a calendar's export link is the hardest step for
most hosts. When the host doesn't have it, Muse opens the booking site in its
browser and hands it to the host to sign in. Then it finds the listing's
export link and pastes it into the private page. Muse sees that link while it
works. Saad chose that trade for ease: Muse never writes it in chat, a tool
argument, its memory, or a skill.

The browser never stands in for the host. Muse never clicks **Allow**, never
types the invite code or an approval code, never signs in with a password it
knows, and never messages anyone itself. The skill spells this out under
"Your browser".

## Which Muse accounts work

As of October 2026, Muse is US-only (some reports add Canada) and adults-only.
It needs a payment card even on the free tier, and every run counts against
usage, including the hourly check. Custom connectors and recurring tasks are
reported on the web, the iOS and Android apps, and WhatsApp. That still needs
checking for this connector.

## Before a host uses this

### Server work (built)

A sign-in from `agent.meta.ai` is Muse (`assistantForRedirect` in
[`src/cleaner-core/assistant.ts`](../src/cleaner-core/assistant.ts)), and the
multi-tenant service allows that host with no extra config, so
`TOURCORE_OAUTH_REDIRECT_HOSTS` doesn't need it. Muse's profile:

- Helper `Muse` and the approval page "Connect Muse".
- Private pages, which Muse opens in its own browser for the host. On Muse the
  calendar-link field is a password field too.
- Choice cards, as on Grok.
- Upload replies that only describe the host's private page. Muse's safety
  check refuses a tool that tells it to send, post, or fill a value.
- The hourly task, connected with `save_alert_routine` and no values, with
  ChatGPT's no-wake-up alert sink and 2.5-hour check warning, in Muse's words.
- Photos as links. Muse opens them in its browser.

`test/cleanerMuseDeployment.test.ts` drives it end to end, on one deployment
and on the multi-tenant service. Grok's, Claude's, and ChatGPT's tests are
unchanged.

### Live probe

Run it with a Muse account, a scratch tenant, and a made-up door code. It
sends no texts.

- [x] Muse creates the connector from the chat. Its OAuth callback is
      `https://agent.meta.ai/api/hatch/oauth/callback`, so the host is
      `agent.meta.ai` (probe, 2026-10-29). Muse builds its own connect page
      from a spec with our discovered addresses and registers itself. On the
      first try it mistyped the registration address, so the skill now lists
      the exact addresses.
- [x] With `agent.meta.ai` in `TOURCORE_OAUTH_REDIRECT_HOSTS`, Muse
      registers as "Muse", the host types the invite code on the Cleaner Core
      page, and the connector connects (probe, 2026-10-29). The page still says
      Grok until the server has the Muse profile.
- [x] The sign-in opens Muse's own connect page, then the Cleaner Core page,
      where the host types the invite code (probe, 2026-10-29).
- [x] Muse saves `skills/cleaner-core` from the clone (probe, 2026-10-29).
- [ ] A new Muse chat loads the saved skill.
- [x] Muse shows choice cards for `options`, and asks one question at a time
      (probe, 2026-10-29).
- [x] Muse's safety check refuses a tool reply that tells it to send a secret
      somewhere. With the server still treating Muse as Grok, `save_sources`
      answered "POST JSON {url} … to uploadUrl", and Muse stopped and wouldn't
      follow it (probe, 2026-10-29). So Muse's upload replies must carry only
      data, `uploadUrl` and `expiresInMinutes`, with no instruction to send
      anything. What to do with the page comes from the skill and the host.
- [x] Muse's secure credential prompt takes only a username and password or
      an API key, so it can't hold a door code or a link (probe, 2026-10-29).
- [x] Muse opens the private page in its browser, but with the Grok profile
      the page is "Not found", because a Grok link has no page. Expected until
      the Muse profile has `privatePages: true` (probe, 2026-10-29).
- [x] With the Muse profile deployed and Muse reconnected, setup ran to the
      end: the host typed the calendar link and the door code into the private
      page in Muse's browser, and the cleaner's texts and a group reply went
      through (re-test, 2026-10-29).
- [ ] Muse never sees what the host types on the private page. Meta says so;
      not checked yet.
- [ ] Find it for me reaches an Airbnb or Guesty Lite export link after the
      host signs in.
- [x] Muse creates the recurring task from the chat, and it can run as often
      as every minute, so the cleaner's texts reach Muse in about a minute
      instead of an hour. Each run uses Muse's usage meter (re-test,
      2026-10-29).
- [x] A photo the cleaner sent before a cleaning reached Muse only as
      `[photo]`, in every chat: Cleaner Core kept photos only during a
      cleaning. Fixed: a photo from the cleaner or a contact is now kept with
      its message for 7 days, and `check_now` links it (re-test, 2026-10-29).
- [ ] Muse opens a message's photo link in its browser and describes the
      photo.

## What Muse does itself

- Creates the Cleaner Core connector and the hourly task from the chat.
- Fills each private page in its own browser, and confirms with `get_state`.
- Finds a calendar's export link when the host doesn't have it.
- Reads only the Google calendar the host says holds the bookings.
- Looks at the cleaner's photos and summarizes the cleaning in its own words.

Muse never texts anyone. Cleaner Core sends every text, after the host's yes
when a person wrote it.

## What's never in this template

The door code, Cleaner Core or Google tokens, Twilio details, phone numbers,
calendar links, booking-site passwords, or any live booking or cleaning
record. `test/cleanerMuse.test.ts` fails if a secret pattern, a phone number
outside the 555 test range, or a door code shows up here.

## Files

| File | What it is |
| --- | --- |
| [`SETUP_PROMPT.md`](SETUP_PROMPT.md) | The paste-in prompt, pinned by `test/cleanerMuse.test.ts` |
| [`skills/cleaner-core/SKILL.md`](skills/cleaner-core/SKILL.md) | The guide Muse saves as a skill: connect, private pages, calendar links, setup order, every booking, messages, the browser's limits, and rules |
| [`skills/cleaner-core/references/cleaner-core-task.md`](skills/cleaner-core/references/cleaner-core-task.md) | The hourly recurring task: how Muse makes it and its prompt |
| [`template.json`](template.json) | Manifest: the deployment, the connectors, the task, and what's never included |
