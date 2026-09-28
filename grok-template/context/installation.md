# Installing Tour Core (context)

## Who does what

- **You (the Bot)** install and run Tour Core on your own cloud computer, open
  its pages in your cloud browser, run its checks, and explain each step.
- **Tour Core** decides the installation order and keeps every record and
  setting. Its installation tools are the source of truth.
- **The operator** makes decisions and does the steps only a person can do:
  create or sign in to provider accounts, pass MFA, accept provider terms,
  approve Grok's connection, type credentials into Tour Core's secure setup
  page, and say yes to publishing.

Setup is not zero-click. Be clear about which steps need the operator.

## Deployment modes (for your understanding; don't use these words with the operator)

- **Grok-managed (demo):** Tour Core runs on your cloud computer. It stays up
  while your computer does. The public address is a temporary tunnel that
  changes if the tunnel restarts; Tour Core notices and says what needs
  reconnecting. Good for demos, not 24/7 production.
- **Self-hosted:** Tour Core already runs at a stable https address. Don't
  install anything; connect and configure.
- **Developer computer:** a developer runs it locally. Treat it like
  self-hosted.

## Components, in the order Tour Core works through them

| Component | Operator words |
| --- | --- |
| RUNTIME | "Tour Core is running" |
| PUBLIC_ENDPOINT | "Tour Core's public address" |
| GROK_OPERATOR | "Grok connection" |
| VISITOR_MESSAGING | "Visitor texting" |
| OPERATOR_ALERTS | "Alerts when a visitor needs you" |
| STORAGE | "Where tour records are kept" (today: with this Tour Core installation) |
| ACCESS | "Access system: Demo" (later "Access system: Connected"); never name the lock provider |
| PROPERTY, READINESS, PRACTICE_TOUR, PUBLISH | the usual property setup, check, practice tour and publish |

States: READY, ACTION_REQUIRED, CONFIGURING, NOT_CONFIGURED, DEGRADED, ERROR.
Only READY means done.

## Credentials

Sendblue's API key, API secret and number, and the Grok Routine's webhook
address and key, are entered by the operator on the secure setup page in your
cloud browser. They go straight to Tour Core. You never see them, never type
them, and never put them in chat, commands or tool arguments.

## Later components

When Tour Core adds a new component or provider (for example a portable place
to keep tour records), it shows up in the installation status and next step.
Follow the status; don't expect this skill to change.
