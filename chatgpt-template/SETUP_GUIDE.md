# Set up Cleaner Core with ChatGPT

ChatGPT runs Cleaner Core through one custom connector and one hourly
scheduled task. You add the connector yourself, and ChatGPT makes the task
during setup. It takes about 15 minutes.

```
You ─► ChatGPT ─► Cleaner Core ─► texts to you and the cleaner
         │            ▲
         │            └─ private pages: the door code and calendar links go here, never in the chat
         └─ the hourly scheduled task checks bookings and messages
```

You talk to ChatGPT. Secrets go straight from your browser to Cleaner Core.
Cleaner Core can't wake ChatGPT when the cleaner texts, so the group text is
how you hear from the cleaner right away (see [Day to day](#day-to-day)).

## Before you start

| What | Why | Where it comes from |
| --- | --- | --- |
| ChatGPT Plus or above | The Free plan has no custom connectors. Plus is tested. Pro, Business, Enterprise, and Edu should work. See [README.md](README.md#which-chatgpt-plans-work). | Your ChatGPT account |
| A computer with a web browser | Developer Mode and custom connectors are set up on chatgpt.com only, not in the apps | — |
| The ChatGPT Cleaner Core address, ending in `/mcp/cleaner-core` | The connector points here. The Grok and Claude services are different addresses. | The Cleaner Core operator (`hostedCleanerCoreUrl` in [template.json](template.json)) |
| Your phone and the cleaner's phone approved for texts | Activate is refused until both numbers are on the operator's list | The Cleaner Core operator |

Each Cleaner Core service has one owner: the first connection that clicks
Allow. Use the ChatGPT account you'll run it from.

## Step 1: Turn on Developer Mode

1. On chatgpt.com, open **Settings → Apps & Connectors** (on some accounts,
   **Connectors**).
2. Click **Advanced** and turn on **Developer Mode**.

On a Business plan, an admin turns it on for themselves; it can't be turned
on for other members.

## Step 2: Add the Cleaner Core connector

ChatGPT offers a plugin or a custom MCP server. Choose **custom MCP server**.
Cleaner Core's own instructions come with the connector, so no plugin is
needed.

| Field | Choose | Why |
| --- | --- | --- |
| Name | Cleaner Core | Any name works; this one matches the guide |
| URL | `<the address from the operator>/mcp/cleaner-core` | The ChatGPT Cleaner Core service |
| Authentication | OAuth | ChatGPT registers its own client, so only your connection owns this Cleaner Core |

Then:

1. Click **Create** (or **Connect**). A page titled **Connect ChatGPT to
   Cleaner Core** opens.
2. Click **Allow**.
3. If your bookings are in Google Calendar, also connect ChatGPT's **Google
   Calendar** app.

Add it only once. A second connection to the same Cleaner Core is refused as
a second owner.

## Step 3: Run setup in a chat

1. Open a new chat.
2. Click **+** in the message box and add **Cleaner Core** to the chat.
   ChatGPT only uses a custom connector that is added to the chat.
3. Say **Set up Cleaner Core**.

ChatGPT asks one question per message, with the choices as buttons:

1. What you want help with: pick scheduling cleaners.
2. The property: business name, address, usual checkout and check-in times.
3. Where bookings come from: Guesty Lite, Google Calendar, or another calendar link.
4. The people: you, the cleaner, and who's in the texts. Pick **A group text
   with me and the cleaner** (the default) to see the cleaner's texts the
   moment they arrive. With texts to the cleaner alone, their messages can
   take up to an hour to reach you.
5. The schedule: how far ahead the cleaner is offered each cleaning, the
   reminder, quiet hours.
6. The locks, then the door code.
7. Supplies, photos, a checklist, and any special instructions.

Secrets never go in the chat. For a calendar link and the door code, ChatGPT
sends a private Cleaner Core link instead. Open it, type the value, click
**Save**, and tell ChatGPT it's saved. Each link works once and expires in 10
minutes. Ask for a new one if it runs out.

ChatGPT may ask you to approve some Cleaner Core actions. Approve the ones
that match what you asked for.

## Step 4: The hourly scheduled task

After the preferences, ChatGPT creates one scheduled task named **Cleaner
Core** that runs every hour, a few minutes past the hour. You don't paste
anything: ChatGPT makes it in the chat, then connects it to Cleaner Core.
Activate is refused until it's connected.

Check it on ChatGPT's scheduled tasks page:

- There is exactly one **Cleaner Core** task, running hourly, and it's on.
- Its prompt matches [routines/cleaner-core-task.md](routines/cleaner-core-task.md).
- Delete any older test task that also calls Cleaner Core.

Before Activate, each run replies **Nothing new.**

## Step 5: Activate and confirm the times

1. ChatGPT summarizes your setup. Reply **Activate**.
2. Cleaner Core reads your calendar, and ChatGPT asks to confirm the times.
   Pick your usual times for all turnovers, or set them one at a time.
3. ChatGPT says what went out. With a group text, the cleaner gets one text
   asking them to reply YES to join. Offers start after they do, one at a
   time.

If ChatGPT says **Nothing was sent yet** and you expected a text, see
[Troubleshooting](#troubleshooting).

## Day to day

| You want to | Do this |
| --- | --- |
| Know when the cleaner writes | Read the group text. It arrives right away. |
| Answer the cleaner | Tell ChatGPT "Maria texted, draft a reply". It reads the message first, drafts, and sends only after your yes. |
| Send the door code | Tell ChatGPT "the guests have left". The code goes only to the approved cleaner. |
| Catch new bookings | Nothing. The hourly task does it. Or say "check my calendars". |
| See what happened overnight | Open the scheduled task's latest run. |

If the hourly task stops, ChatGPT warns you the next time you open a chat
with Cleaner Core: no check has come in for over two and a half hours. Turn
the task back on from the scheduled tasks page.

## Troubleshooting

Every row here came up while testing on ChatGPT Plus.

| What you see | Cause | Fix |
| --- | --- | --- |
| "This tool call was blocked by OpenAI's safety checks" | ChatGPT's own check stopped the call before it reached Cleaner Core | Say "try again". It usually goes through. |
| ChatGPT answers from general knowledge, or asks what Cleaner Core is | Cleaner Core isn't added to this chat | Click **+** and add Cleaner Core, or start a new chat with it added |
| The Allow page doesn't open, or sign-in fails with a redirect error | The service isn't set up for ChatGPT | Ask the operator to set `CLEANER_CORE_ASSISTANT=chatgpt` |
| "This Cleaner Core is already in use" | Another connection owns it, including your own earlier one you removed | The operator releases the owner for one deploy (`CLEANER_CORE_HOSTED_OWNER_RESET`), then you click Allow again |
| ChatGPT walks you through a Claude routine, with a Fire URL and token | The service is set up for Claude | Ask the operator to set `CLEANER_CORE_ASSISTANT=chatgpt` |
| Activate says the numbers aren't approved | A number isn't on the operator's list | Ask the operator to approve both, then say "run the checks" |
| Setup finished but no text arrived, or ChatGPT says "Nothing was sent yet" | Live texting is off, or the Twilio details are missing on the service | Tell the operator. They check `CLEANER_CORE_LIVE_SMS` and the Twilio variables ([README.md](README.md#deploy-the-operator-once)). |
| The scheduled task paused itself after an error | An older task prompt, or a task made before Cleaner Core was set up | Delete it and ask ChatGPT to create the Cleaner Core task again from setup |
| The cleaner said YES but no group started | Twilio didn't create the group text | The operator checks the deploy log for "Twilio refused … for the group text". The number must support group texts (local, MMS-capable, not toll-free). |
