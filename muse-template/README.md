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

**Status: draft.** The guide and the task are written, but a host can't use
them yet. The server doesn't know Muse, and the open questions below need a
live test first. See [Before a host uses this](#before-a-host-uses-this).

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
| Door code | Grok's secure card, posted from its cloud computer | The host types it on Cleaner Core's private page from a link | Muse opens the private page in its own browser. It fills the code from its secure credential prompt, or the host types it into that browser |
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
in its own cloud browser, so the host never has to open a link. Muse's secure
credential prompt is a system dialog outside the chat, and Muse keeps the real
value out of the model and fills it in at the boundary. A password typed by
the host into Muse's browser is handled the same way. The door-code field on
Cleaner Core's page is already a password field
([`src/cleaner-core/uploadPage.ts`](../src/cleaner-core/uploadPage.ts)).

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

### Server work

Today the service refuses Muse's sign-in, because `DEFAULT_REDIRECT_HOSTS` in
[`src/mcp/oauth/clients.ts`](../src/mcp/oauth/clients.ts) allows only Grok's
hosts. If Muse's host were added there, `assistantForRedirect` in
[`src/cleaner-core/assistant.ts`](../src/cleaner-core/assistant.ts) would still
treat Muse as Grok: Grok's words, no private pages, and a webhook Muse can't
receive. The Muse version needs:

1. `"muse"` as a `CleanerAssistant`, with a profile: helper `Muse`, Muse's
   redirect host `agent.meta.ai`, `privatePages: true`, `photoImages: false`,
   and consent wording "Connect Muse".
2. Muse's MCP initialize instructions, short like ChatGPT's, pointing at the
   skill. The upload replies carry only `uploadUrl` and `expiresInMinutes`
   and a neutral `next` such as "This is the host's private page for the
   door code. Call get_state once it's saved." Never an instruction to send,
   post, or fill a value: Muse's safety check refuses that from a tool.
3. The hourly task in `get_state`'s `routine`, connected with
   `save_alert_routine` and no values, with the same no-wake-up alert sink and
   2.5-hour check warning as ChatGPT. That code path is shared, not copied.
4. The cleaner-only group option's hourly note, as ChatGPT has.
5. On Muse, the calendar-link field on the private page as a password field,
   so Muse treats a pasted link as a secret.
6. `test/cleanerMuse.test.ts` grown into an end-to-end test like
   `test/cleanerChatGpt.test.ts`, with Grok's, Claude's, and ChatGPT's tests
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
- [ ] The sign-in page opens where the host can type the invite code, in the
      app or in Muse's browser.
- [ ] Muse saves `skills/cleaner-core` from the clone, and a new chat loads it.
- [x] Muse shows choice cards for `options`, and asks one question at a time
      (probe, 2026-10-29).
- [x] Muse's safety check refuses a tool reply that tells it to send a secret
      somewhere. With the server still treating Muse as Grok, `save_sources`
      answered "POST JSON {url} … to uploadUrl", and Muse stopped and wouldn't
      follow it (probe, 2026-10-29). So Muse's upload replies must carry only
      data, `uploadUrl` and `expiresInMinutes`, with no instruction to send
      anything. What to do with the page comes from the skill and the host.
- [ ] The secure credential prompt fills the private page's door-code field,
      and the model never sees the value. If not, the host can type it into
      Muse's browser.
- [ ] Find it for me reaches an Airbnb or Guesty Lite export link after the
      host signs in.
- [ ] Muse creates an hourly recurring task, and the task runs with the
      connector set to run without asking.
- [ ] Muse opens a signed photo link in its browser and describes the photo.

Update this README and the skill with what the probe finds, then build the
server work.

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
