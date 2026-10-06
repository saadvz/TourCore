# GROK_BOOTSTRAP.md

The entry point for a Grok Bot setting up Tour Core from this repository. No
attachments are needed: everything you need is in this repository.

## What Tour Core is

Tour Core is an open-source self-touring tool for landlords ("my AI landlord").
Prospects text a property number, book, consent, verify and tour on their own;
doors open only on their reserved route during their window. They can ask for 10 more minutes any time before the tour ends; if that time is not free they can book another look. Near the end they get a questions text, a 5-minute extra-time offer, then a leave check-in if they stay. After a close, other texts alert the team and reply to the visitor until DONE, the leaving issue is marked handled, or 24 hours pass (alerts stop then; the leaving issue stays open until DONE or handled). While that 24-hour window is open, a standalone HI or yo stays on after-close handling; a clear booking phrase (including see it again / schedule another visit) starts a new booking only when nothing is held, unless they also say they are stuck, locked, jammed, still in the unit, cannot leave, cannot get outside, cannot find the way out, where the way out is, or how to get out. Help booking does not hide those other words. "Which way out of the lobby" is not distress. After 24 hours, greetings go back to normal. A rebook or custom-time request during a tour stays secondary until that tour ends for any reason (done, closed, called off, cancelled, or expired). A bare yes or no answers the latest question asked. While they are touring, operator tools act on the running tour; the later booking is their next booking. A one-off overlap check sees the running tour and every future or held booking. `reschedule_tour` will not move a tour in progress (`{who} is touring right now, so I can't move this tour. Once it ends, you can book them another time.`; if they have a later booking it asks `Want me to move their {oldTime} on {oldDay} booking to {newTime} on {newDay} instead?` and a yes is `Moved {who}'s later booking to {time} on {day}.`). Calling off describes the tour that was called off; the later booking is `nextBooking`. Cancelling a later booking while they are touring tells them their tour right now isn't affected. A visitor who texts to cancel while touring, when a later booking is held, is asked `Cancel your later tour at {time} on {day}? Your tour right now isn't affected. Reply YES or NO.` YES: `Done, I've cancelled your later tour at {time} on {day}. Your tour right now isn't affected.` NO: `Okay, your later tour at {time} on {day} stays booked.` Visitors who aren't touring keep the usual cancel lines. After the running tour ends, texts and operator actions move to that later booking, or a greeting starts a new conversation if nothing is held. After the follow-up reply, an unapproved custom-time request is told once that it is still with the property team; a day reply for a regular time is only when they have no held or booked regular tour. A held rebook taking over gets booked-for, then the original consent question, then Reply YES or NO. Later texts use the normal booking flow; a regular-time book withdraws the request (They booked a regular time instead.). Replacing a held or booked future tour also sends That replaces your {time} tour on {day}. Asking for a regular open time moves a held or confirmed booking right away. A taken regular slot keeps the current booking, says Sorry, {time} on {day} is already taken (and You're still booked for {curTime} on {curDay} only for a held or future booking, never the tour in progress), then remaining times that day or If you'd like another time, just reply with a day. A numbered pick from that menu books it only when the menu was shown after the current booking, including after the operator moves it; a leftover number, time, or bare later/earlier/sooner does not move it. On hold, a taken slot gets the taken line and no menu. Farewells and arrival remarks (yes, see you later; yes, I'll arrive earlier; yes, no need to switch) record consent; later/earlier/sooner is a change only when it is an actual ask (make it later, later in the week, can we do it later, anything later, sooner would be better, can we do it sooner, sooner?). yes, the sooner the better or anything earlier is fine too records consent. A named day (tuesday works better) shows that day's times. If a visitor text cannot be handled, they get Sorry, I hit a snag with that. I've let the property team know, and they'll reply here as soon as they can. when a landlord record exists, or Sorry, I hit a snag with that. Could you text me again in a few minutes? when it does not. That opens a handler-failed issue, not a flagged question. The team is told {who} texted "{their message}" and I couldn't handle it, so they're waiting on you. I told them you'd reply as soon as you can. After a partial reply: {who} texted "{their message}" and I couldn't finish handling it. They got part of a reply, so they may still be waiting on you. Empty text: {who} sent a text I couldn't handle, so they're waiting on you. I told them you'd reply as soon as you can. answer_flagged_question on that issue texts the visitor and does not save a fact (Send "{reply}" to {who}? then Sent to {who}. If they cannot be texted: I couldn't text {who}, so nothing was sent and this is still open. If you can reach them another way, do that, then mark it handled. Repeat: That's already been handled. / That question has already been handled.). If the requested time has already passed, the visitor is texted once (couldn't get to the request in time, then still-booked or reply-with-a-day). Approve and decline tell the operator That time has already passed, so I've let {who} know their request ran out. You can still book them a one-off time. Then use schedule_one_off_tour or reschedule_tour. Propose tells the operator That request ran out because its time already passed, so your offer of {newTime} on {newDay} didn't go out. I've let {who} know, and you can still book them a one-off time, and does not send the proposal. Already expired: That request already ran out because its time passed, and {who} has been told. You can still book them a one-off time. Already approved or declined: That request has already been handled. Approving a custom time that moves an unconfirmed held booking uses that same booked-for line, then the original consent question, then Reply YES or NO — not moved wording. While the leaving issue is open, stuck-inside texts and greetings stay on after-close handling and do not take over a held booking. A follow-up yes after DONE is the same as after a normal finish and does not record consent for a held booking; unanswered consent is then the booked-for line and the original consent question. If the T-5 text cannot offer extra time, a later yes records pending consent. STOP during a tour stops visitor texts only.

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
  and stop talking about infrastructure unless something breaks. Setup types (single-family, multifamily, or one apartment or condo) and optional entry instructions come from Tour Core's next questions, not from you. A single-family home with no unit yet: `set_unit_details` says "Add the house as a unit first, then I'll save these details." If visit records can't be confirmed before unlock, alert "Tour Core couldn't save the visit record, so {door} stayed locked." (booking stays ready; no issue). If the grant can't be saved after unlock, the tour is paused and the alert is "Tour Core couldn't save the visit record, so the tour was paused."
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
