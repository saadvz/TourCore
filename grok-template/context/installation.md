# Installing Tour Core (context)

## Who does what

- **You (the Bot)** install and run Tour Core on your own cloud computer, open
  its pages in your cloud browser, run its checks, and explain each step.
- **Tour Core** decides the installation order and keeps every record and
  setting. Its installation tools are the source of truth.
- **The operator** makes decisions and does the steps only a person can do:
  create or sign in to provider accounts, pass MFA, accept provider terms,
  approve Grok's connection, and say yes to publishing. API credentials stay
  in Grok's secure secret input. You submit them. The operator does not open
  a setup page unless that input cannot be used.

Setup is not zero-click. Be clear about which steps need the operator.

## Deployment modes (for your understanding; don't use these words with the operator)

- **Hosted product:** `hostedTourCoreUrl` names one Tour Core service. Connect
  to it. The operator does not create a hosting account. This demo is one
  installation; a second landlord is not supported until tenant isolation
  exists.
- **Grok-managed (open-source demo):** Tour Core runs on your cloud computer.
  It stays up while your computer does. The public address is a temporary
  tunnel that changes if the tunnel restarts; Tour Core notices and says what
  needs reconnecting.
- **Self-hosted:** Tour Core already runs at a stable https address the
  operator runs. Don't install anything; connect and configure.
- **Developer computer:** a developer runs it locally. Treat it like
  self-hosted.

## Components, in the order Tour Core works through them

Call `get_state` first and follow its next step. This table only explains that step.

`initialize` returns a short instructions pointer. `get_state` returns the playbook. The client name picks wording only. A name containing `grok` (`Grok`, `grok`, `grok-bot`, `grok-sim`, `Grok (SDK test)`), or Cursor's MCP client (`Cursor`, `cursor-vscode`), gets the full Grok playbook, including when no capabilities are sent. A declared capability set that does not include elicitation, sampling, or roots does not unlock that playbook. That client gets the baseline. Declaring only tools is that set. `prompts` and `resources` are server capabilities and are ignored. Claude is full when it reports `elicitation`, `sampling`, or `roots`, otherwise tools-only. ChatGPT and an unknown name are tools-only. The name never changes a tool or a gate. The name is stored per MCP session or signed-in caller. On a call after initialize, the cached initialize wins when it selects a playbook, capabilities included. The stored OAuth name is used only when that cache is missing, nameless, or baseline. After a restart, with no new initialize, the stored name still applies. A baseline or nameless entry never overrides a name that selects a playbook. A missing registration name is taken from the client name or the redirect URIs for that request and is not written back onto the grant.

Before a yes on a flagged answer, read `visitorWillReceive`. It is the exact visitor text, including any closing line. A save asks `Send this to {name} and save it for anyone who asks the same thing later? "{visitorWillReceive}"`. A handler-failed reply saves nothing and stays `Send this to {who}? "{reply}"`. The first call does not send. A fair-housing flag has `proposeDraft` false and refuses with `This one touches on fair housing, so I won't draft an answer. Reply to them yourself, then mark it handled.` After that no-draft flag is saved, the visitor gets `Good question for the {team}. I've passed it along, and they'll text you back here.` They never hear fair housing. If the flag cannot be saved, the team is texted first. The visitor gets `I can't open the doors for you right now. I've let the {team} know, and they'll text you here shortly.` only if that text went out, and `Sorry, I hit a snag with that. Could you text me again in a few minutes?` otherwise. When that team text does not go out, the landlord sees `I couldn't text you about {who}, so I asked them to text me again in a few minutes.`

Grok's tour-updates ask is only: "Want me to text you when someone books, starts, or finishes a tour, and ping you the moment something needs you?" One alert address per install. A new save replaces the old one. The custom-time wake is Grok-only and uses `place` from `get_inbox` when that field is present.

Tool annotations are hints. Destructive landlord tools are `remove_property`, `cancel_tour`, and `restore_records`. `reset_hosted_demo` is for the hosted owner and is also destructive.

If a step keeps failing, give the landlord the setup help link (`docs/setup-help.md`) as one plain link. Never put it in a visitor text.

| Component | Operator words | Required? |
| --- | --- | --- |
| RUNTIME | "Tour Core is running" | before the first property |
| PUBLIC_ENDPOINT | "Tour Core has a secure public connection" | before the first property |
| GROK_OPERATOR | "Grok connection" | before the first property |
| VISITOR_MESSAGING | "Visitor texting" | before the first property |
| STORAGE | Hosted: "Operational records: Stored by hosted Tour Core" and "Portable backup: Google Drive connected" or "not connected". Open-source: "Tour records: Stored locally" or "Tour records: Google Drive connected" when optional direct Drive is on | before the first property. On the hosted product, Drive is a recommended backup, not a second Google approval. Declining it does not stop property setup. If the ops connector's `check_runtime_health` shows `persistentVolume` false on the hosted product, records aren't saved anywhere permanent yet, so the next update could erase them. Whoever set up your Tour Core hosting needs to attach permanent storage. Until then, hold off on updating Tour Core. Never set the ephemeral-storage escape hatch on a live service |
| ACCESS | "Access system: Demo" (later "Access system: Connected"); never name the lock provider | nothing to do |
| PROPERTY | the first property: its address, property type, and each unit's bedrooms, bathrooms, rent and availability. The first install asks "How should people text you about a tour?" A later property uses that texting and is not asked again | to publish |
| OPERATOR_ALERTS | "Tour updates": bookings, tour starts, completions and anything that needs your attention | recommended, offered only after the first property is set up; the operator may say no |
| READINESS, PRACTICE_TOUR | the readiness check and practice tour, run automatically | to publish |
| PUBLISH | publish for demo, only after an explicit yes | |
| (after publish) | `ADD_ANOTHER_PROPERTY`: "Would you like to set up another property?" (`save_property`). The published property stays published. If they say no, stop | optional |

Alerts are never required and never come before the first property. When the
operator says yes, you save their choice (`save_settings`),
create the Tour Core Operator Updates routine yourself, and connect it with
the same secure secret input (`routines/operator-updates.md`). If preferences are
chosen but the routine isn't connected, the next step is
CONNECT_OPERATOR_ALERTS.

States: READY, ACTION_REQUIRED, CONFIGURING, NOT_CONFIGURED, DEGRADED, ERROR.
Only READY means done. DEGRADED counts a missed tour update only since the last passing test. A later ordinary delivery does not clear a miss. The next step says "A tour update didn't reach you. Check your inbox for anything new. I'm sending a test so the next ones get through." That line waits until an open public-connection check or Grok connection is finished. Send the test that step names. Do not offer first-time setup, do not create a routine, and do not ask for a new address or key. A test that gets through returns to "I'll keep you posted on" what they chose. A test that does not get through is ERROR. When an alert address is already saved, say "Tour updates aren't reaching you. I'll send you a secure link to reconnect them. Nothing you type there shows in chat." The secure page overwrites the saved address and key with no history, so re-enter the existing routine's address and key there. Never create a new routine or use a new routine's address or key. When no address is saved, use the first-time setup. Landlord status and the installation status use that same count.

## Credentials

Visitor texting starts by asking which provider to use. Do not assume
Sendblue. After the operator chooses, collect only that provider's fields
with Grok's secure secret input, fill Tour Core's form, and submit it. Then
follow the next step. Do not ask what to do next. The `local` provider is a
QA loopback (no credentials, no real texts). A building can use local test
texts while the installation stays on live visitor texting. Use the QA connector (`inject_local_sms` and `read_local_outbox`) only on a building that is on
local. Do not switch the whole installation to local when another building
is already published and receiving real texts. Switching the installation's
provider keeps saved credentials and attached lines for other providers. If
that provider was already set up, follow the next step (usually a connection
test) and do not ask the operator to re-enter those details.

A routine webhook address and key use the same secure input. If the routine
panel's copy buttons keep both values hidden on screen, those hidden values
may be pasted into the matching masked fields. If a value is shown on screen,
don't read it into chat.

The operator leaves the conversation only for OAuth, login, or MFA. Opening
the setup page is a fallback when secure input cannot be used. Never put a
secret in ordinary chat, a command, a file, or a tool argument.

## Later components

When Tour Core adds a new component or provider (for example a portable place
to keep tour records), it shows up in the installation status and next step.
Follow the status; don't expect this skill to change.
