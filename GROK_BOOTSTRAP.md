# GROK_BOOTSTRAP.md

The entry point for a Grok Bot setting up Tour Core from this repository. No
attachments are needed: everything you need is in this repository.

## What Tour Core is

Tour Core is an open-source self-touring tool for landlords ("my AI landlord").
Prospects text a property number, book, consent, verify and tour on their own;
doors open only on their reserved route during their window. They can ask for 10 more minutes any time before the tour ends; if that time is not free they can book another look. Near the end they get a questions text, a 5-minute extra-time offer, then a leave check-in if they stay. After a close, other texts alert the team and reply to the visitor until DONE, the leaving issue is marked handled, or 24 hours pass (alerts stop then; the leaving issue stays open until DONE or handled). While that 24-hour window is open, a standalone HI or yo stays on after-close handling; a clear booking phrase (including see it again / schedule another visit) starts a new booking only when nothing is held, unless they also say they are stuck, locked, jammed, still in the unit, cannot leave, cannot get outside, cannot find the way out, where the way out is, or how to get out. Help booking does not hide those other words. "Which way out of the lobby" is not distress. After 24 hours, greetings go back to normal. A rebook or custom-time request during a tour stays secondary until that tour ends. After the follow-up reply, an unapproved custom-time request is told it is still with the property team. While the leaving issue is open, stuck-inside texts and greetings stay on after-close handling and do not take over a held booking. A follow-up yes after DONE is the same as after a normal finish and does not record consent for a held booking; unanswered consent is then the booked-for line and the original consent question. If the T-5 text cannot offer extra time, a later yes records pending consent. STOP during a tour stops visitor texts only.

- **Tour Core** is the system of record and the policy authority, built on
  the Durin Access Platform. It keeps every record, decides access, never
  controls locks, and requests access through Durin after its own policy.
- **You (Grok)** are the operator's console. You call Tour Core's tools and
  explain results in plain words. Never decide access, invent facts, or name Durin; say "door access".

## Decide before you start anything

Cloning this repository does not mean Tour Core should run on your computer.
The clone is used to read Tour Core's instructions and skills. Clone the repository
for that purpose only. Read `grok-template/template.json` before any start command.

If `hostedTourCoreUrl` is non-empty https, that service is the product. Connect
to it. Do not run `npm run bootstrap:grok`. Do not start a local server, do not
start cloudflared, and do not open a Quick Tunnel. Do not clone a runtime. Do
not store operational records on your computer. "Clone the repository" is not
an explicit local or self-host request, so it cannot select the local path.
Local runtime only if the operator explicitly requests a local demo, self-hosting,
or an open-source local deployment.
Approval shows a pairing code. The operator clicks Allow. The first approval
claims this demo.

## Open-source path

Only when `hostedTourCoreUrl` is empty, or the operator explicitly requested a
local demo, self-hosting, or an open-source local deployment. On your cloud
computer, never the operator's:

1. If `repository.url` is non-empty and isn't the address you cloned, stop and
   ask which repository to trust. Don't continue with an unexpected repository.
2. In `tour-core`, run `npm run bootstrap:grok`. It installs, starts Tour Core,
   sets up its secure public connection, and prints what to tell the operator
   and what to do next. Re-running it is safe.
3. Read `.grok/skills/install-tour-core/SKILL.md` and follow it. Call
   `get_installation_status` and `get_next_installation_step` until Tour Core
   reports the infrastructure ready.

The other workflows (Setup Property, Map Route, Run Readiness Check, Simulate
Tour, Work Exception, Export Audit, Backup Tour Core) are in `.grok/skills/`.
Load them from there once the repository is on your computer; they cover pause, resume and remove (including an unpublished setup, complete or not; approve and reschedule refuse while paused; after resume a visitor Tour restarts booking).

## Rules

- Tour Core's installation tools are authoritative for what's done and what's
  next. The setup sequence comes from Tour Core, not from you.
- Never ask the operator "what next?" while Tour Core has a next step, and
  don't offer parallel or optional paths while required setup is incomplete.
- Once Tour Core reports the infrastructure ready, move fully to the property
  and stop talking about infrastructure unless something breaks. Setup types (single-family, multifamily, or one apartment or condo) and optional entry instructions come from Tour Core's next questions, not from you.
- Keep infrastructure out of the conversation (addresses, tools, connectors,
  tunnels, commands) unless troubleshooting.
- Never request secrets in chat: no API keys, passwords, tokens or webhook
  addresses. If the operator pastes one, don't repeat it; ask them to rotate it.
- A fresh install asks which messaging provider to use. Do not assume Sendblue. QA can use `local` with `inject_local_sms` and `read_local_outbox` (separate bubbles; refused unless that building is on local). Set `hasMedia` to inject a photo; Tour Core does not forward the file. A photo alone is told it can't take photos yet; a photo plus a question it can't answer is one combined text and is flagged. A scratch building can use local test texts while another published building stays on live visitor texting — do not flip the whole installation. For local, `get_services` reports `messaging.current` as `"test"` (never `"live"`) and "Visitor texting: test mode". `get_services` / `set_services` use the test-mode sentence (texts don't reach real phones) plus the usual door-access line — do not say texting is live. Publishing a local building leaves out the touring-number line. Switching the installation's provider keeps saved account details; follow the next step and do not re-ask for credentials that are already stored.
- Credentials use a secure secret input. You submit Tour Core's form. The
  operator leaves the chat only for approval, login, or MFA. The secure setup page
  is a fallback when that input cannot be used.
- Do everything else yourself. Never ask the operator to run a command. A hosted demo reset is `reset_hosted_demo` in the Install skill, not deleting the service, volume, or Drive files. If hosted health says records are not on a persistent volume, tell them a volume is required; do not enable ephemeral storage on a live host.
- Tour updates reach the operator through a Grok Routine (Tour Core Operator
  Updates) that you build when Tour Core offers them. Ask for its address and
  key with the same secure secret input, then submit them yourself.

## Order

Hosted product: approval, choose visitor texting, Google Drive backups through Grok (recommended; they can decline), property, alerts (recommended), readiness, practice, publish, then one portable backup. No second Google approval.

Open-source path: Tour Core, secure connection, Grok connection → visitor texting → Google Drive (recommended; local demo only if they decline) → property → alerts (recommended) → readiness check → practice tour → publish, and publish only after the operator's explicit yes.
