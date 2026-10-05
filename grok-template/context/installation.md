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

Always follow `get_next_installation_step`; this table only explains it.

| Component | Operator words | Required? |
| --- | --- | --- |
| RUNTIME | "Tour Core is running" | before the first property |
| PUBLIC_ENDPOINT | "Tour Core has a secure public connection" | before the first property |
| GROK_OPERATOR | "Grok connection" | before the first property |
| VISITOR_MESSAGING | "Visitor texting" | before the first property |
| STORAGE | Hosted: "Operational records: Stored by hosted Tour Core" and "Portable backup: Google Drive connected" or "not connected". Open-source: "Tour records: Stored locally" or "Tour records: Google Drive connected" when optional direct Drive is on | before the first property. On the hosted product, Drive is a recommended backup, not a second Google approval. Declining it does not stop property setup |
| ACCESS | "Access system: Demo" (later "Access system: Connected"); never name the lock provider | nothing to do |
| PROPERTY | the first property: its address, property type, and each unit's bedrooms, bathrooms, rent and availability; it uses the installed visitor texting automatically | to publish |
| OPERATOR_ALERTS | "Tour updates": bookings, tour starts, completions and anything that needs your attention | recommended, offered only after the first property is set up; the operator may say no |
| READINESS, PRACTICE_TOUR | the readiness check and practice tour, run automatically | to publish |
| PUBLISH | publish for demo, only after an explicit yes | |

Alerts are never required and never come before the first property. When the
operator says yes, you save their choice (`set_notification_preferences`),
create the Tour Core Operator Updates routine yourself, and connect it with
the same secure secret input (`routines/operator-updates.md`). If preferences are
chosen but the routine isn't connected, the next step is
CONNECT_OPERATOR_ALERTS.

States: READY, ACTION_REQUIRED, CONFIGURING, NOT_CONFIGURED, DEGRADED, ERROR.
Only READY means done.

## Credentials

Visitor texting starts by asking which provider to use. Do not assume
Sendblue. After the operator chooses, collect only that provider's fields
with Grok's secure secret input, fill Tour Core's form, and submit it. Then
follow the next step. Do not ask what to do next. The `local` provider is a
QA loopback (no credentials, no real texts). Use `inject_local_sms` and
`read_local_outbox` only on a property that is on local. Switching providers
keeps saved credentials and attached lines for other providers. If that
provider was already set up, follow the next step (usually a connection test)
and do not ask the operator to re-enter those details.

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
