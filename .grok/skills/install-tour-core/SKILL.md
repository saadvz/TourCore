---
name: install-tour-core
description: Install and run Tour Core on your own cloud computer, then take the operator from a blank setup to a published property by following Tour Core's own next steps, asking only for approvals, logins, credentials on Tour Core's secure setup page, property information and decisions.
when-to-use: "set up Tour Core", "install Tour Core", "what's left to set up", "check my Tour Core installation", "is Tour Core running", "restart Tour Core", "test alerts", "connect texting", "turn on alerts", "tour updates", "change my notifications"
allowed-tools: get_installation_status get_next_installation_step get_installation_component skip_optional_setup check_runtime_health check_public_endpoint test_visitor_messaging get_notification_preferences set_notification_preferences get_operator_update test_operator_alerts test_storage test_access get_secure_setup_url
argument-hint: "[what to check or connect]"
user-invocable: true
metadata:
  author: Tour Core
  short-description: Grok-managed install and guided onboarding, in Tour Core's order
  version: "0.4.0"
---

# Install Tour Core

You do the technical work yourself on your own cloud computer. Tour Core
decides the order of everything that follows and tells you, one step at a
time, through `get_next_installation_step`. The operator only approves,
signs in, enters credentials on Tour Core's secure setup page, gives property
information and makes decisions.

## When to use

The operator says "Set up Tour Core", asks what's left to set up, asks you to
check the installation or whether Tour Core is running, or a Tour Core tool
stops answering.

## Required inputs and access

- Nothing from the operator to start. No attached files: the repository's
  `GROK_BOOTSTRAP.md` is the entry point and this skill is the detailed
  workflow.
- Your cloud computer, with a terminal and a browser.
- The Tour Core repository address, first found of: the canonical
  `repository.url` in `grok-template/template.json` (an installed template
  already knows it), the address in the operator's message, or
  `TOURCORE_REPO_URL` on your computer. If none is available, ask the operator
  for the public Tour Core repository link; that's the only thing you may ask
  before installing.
- If the address you were given and the canonical `repository.url` disagree,
  stop and ask the operator which to trust. `npm run bootstrap:grok` refuses
  to start an unexpected repository.

## How you talk

Say what's happening, in plain words. Say `operatorMessage` (in your own
words if you like) and nothing technical. Credentials go on Tour Core's
secure setup page, not in chat.

| Instead of | Say |
| --- | --- |
| "Your MCP server is https://.../mcp and exposes 42 tools." | "Tour Core is installed and running." |
| "The Cloudflare quick tunnel is connected." | "Tour Core has a secure public connection." |
| "The OAuth MCP connector needs approval." | "I need your approval to connect to Tour Core." |
| "I'm creating a Grok Routine with an authenticated trigger." | "I'm setting up your tour updates." |
| "Everything runs in demo mode." | "Visitor texting is live. Door access is still in demo mode, so no physical locks will open." |

In normal conversation never mention addresses or links, `/mcp`,
`trycloudflare`, tool counts, connectors, OAuth, environment variables, ports,
package or command names, process ids, adapters or tunnels. `grokInstructions`
and anything under `technical` are for you only. Share technical details only
if the operator asks for them or you're troubleshooting with them.

## Sequence

Seven phases, always forward. Go back only when Tour Core's status changes
(for example its connection changed or Tour Core stopped). Never skip a phase.

### Phase 1: Bootstrap (you, alone)

Say: "I'll handle the technical setup and only ask when I need a login,
approval or decision."

If Tour Core's tools already answer, call `get_installation_status` and go to
the phase it reports: don't reinstall a running Tour Core. Otherwise, on your
cloud computer:

1. Clone into `tour-core` unless that folder already exists (it holds the
   records). Load the other skills from its `.grok/skills/`.
2. Run `npm run bootstrap:grok` in that folder. Its output ends with the line
   to tell the operator and your own next step. It's safe to repeat; if Tour
   Core stops later, run it again.
3. If it reports a blocker you can fix on your computer (for example
   installing cloudflared), fix it and run it again. Otherwise tell the
   operator in one plain sentence what's blocking.

### Phase 2: Connect (the operator approves, once)

For a fresh install there's no existing Tour Core connection. Add Tour Core
yourself using the details the bootstrap printed, open Tour Core's approval
screen in your cloud browser, and hand control to the operator:

> Tour Core is installed and running. I need your approval to connect to it.
> I've opened the approval screen. Check that the codes match and click Allow.

As soon as it's approved, without waiting to be asked:

> Connected. I'm checking the rest of the setup now.

and call `get_installation_status`. An old Tour Core connection left over from
before is an exception: remove it and connect again the same way.

### Phase 3: Infrastructure (follow Tour Core's order)

Call `get_next_installation_step` and do exactly that step. Repeat after each
one. While `infrastructureReady` is false:

- follow the step Tour Core gives you, even if something else seems possible;
- don't offer other setup, alternatives or shortcuts;
- don't ask the operator what to do next or which order they prefer;
- don't start property setup.

By `performedBy`:

- **GROK**: do it yourself (the `tool`, or the `command` on your computer),
  then say briefly what happened ("Visitor texting is connected and working.").
- **OPERATOR_IN_SECURE_SETUP**: call `get_secure_setup_url` with its
  `secureSetupStep`, open the link yourself in your cloud browser, hand control
  to the operator, and say `operatorMessage`. Don't show the link, don't type
  or read the values, and don't ask for them in chat. When they're done, call
  `get_next_installation_step` (Tour Core then has you test it).
- **OPERATOR**: say `operatorMessage` and wait (a login, MFA, provider terms,
  an approval).
- **OPERATOR_DECISION**: ask `operatorMessage` and wait for the answer.

Visitor texting is part of this phase: it's connected and tested before any
property. Tour records ("stored with this Tour Core installation") and the
access system ("Demo") need nothing from the operator.

### Phase 4: Property

When Tour Core reports the infrastructure ready (visitor texting connected and
tested), it offers the first property. Alerts are not part of this: they come
later and are never required. Close the technical part and say:

> Everything needed to start is connected and tested. Would you like to add
> your first property?

If yes, use the Setup Property skill (Map Route for routes), in plain words:
"What's the property address?" (then confirm the address as Tour Core saved
it), "What type of property is this?" (single-family home, multifamily home,
apartment building or other), then the question Tour Core returns about the
spaces people tour, each unit's bedrooms, bathrooms, rent and availability,
"Which door do visitors come in through?", "When can people tour?", "How
carefully do you want to verify visitors?". Never show field names and never
invent a building name: the address is the property's name unless the
operator gives one.

Visitor texting was connected in Phase 3, so the new property uses it on its
own and the review reads "Visitor texting: Connected" and "Door access: Demo".
Don't ask how to text people. From here on, don't talk about infrastructure
unless something breaks.

Once the property is saved (with its unit details), Tour Core offers tour
updates (recommended, not required):

> Your property is configured. Would you like me to keep you updated when
> someone books, starts or finishes a tour, and alert you if something needs
> your input?

- **Yes.** If it helps, confirm the defaults:

  > I recommend alerts for bookings, tour starts, completions and anything
  > that needs your attention. Want to use those defaults?

  Call `set_notification_preferences` (`preset: recommended`, `problems-only`
  if they only want problems, or the exact `updates` they asked for). Then:

  > I'm setting up your tour updates.

  Connect the updates yourself, in this order:

  1. Create the Tour Core Operator Updates routine yourself (authenticated
     webhook trigger; instructions in `grok-template/routines/operator-updates.md`).
  2. Call `get_secure_setup_url` with step `operator-alerts` and open it in
     your cloud browser next to the routine's trigger panel.
  3. If that panel has copy buttons and both the address and the key stay
     hidden on screen, copy each one into the matching Tour Core field
     yourself (both fields are masked), without reading, repeating or storing
     it.
  4. If either value is shown on screen, don't move it. Hand control of the
     browser to the operator:

     > I've opened Tour Core's secure setup page next to the update settings I
     > created. Please copy the two connection details across, or put the
     > whole example into the box on Tour Core's page. They go straight to
     > Tour Core, not in chat.

  5. Never put the address or key in chat, tool arguments, files or commands.

  Then call `get_next_installation_step`: Tour Core has you send a test update
  (`test_operator_alerts`), and the routine posts "Tour updates are connected."
  If preferences are saved but the connection isn't finished, the next step is
  `CONNECT_OPERATOR_ALERTS`: pick up at step 2.
- **No.** Call `skip_optional_setup` with `OPERATOR_ALERTS` and continue. They
  can turn updates on any time later.

To see or change what they get later, use `get_notification_preferences` and
`set_notification_preferences`. Missed tours (no-shows) aren't detected yet;
don't promise them.

Never decide yourself whether a component is required: Tour Core marks each
one (`requirement`).

### Phase 5: Validate (automatic)

Tell the operator how visitors use it, then run the checks without asking
whether to skip them:

> Prospects can text your touring number to ask questions, choose a unit and
> time, verify their details, and complete the self-guided tour in the same
> conversation. I'll run a readiness check and a practice tour before we turn
> it on.

Use Run Readiness Check, then Simulate Tour. If something fails, say what in
plain words and fix it with the operator.

### Phase 6: Publish (explicit yes)

> Everything passed. Would you like me to publish this property for demo?

Publish only after a clear yes, through the publish tool's own confirmation
question. If publishing is refused because visitor texting is connected but
the property isn't using it yet, fix it yourself with Setup Property (its
`remediation`: switch the property to real texts, run the readiness check and
practice tour again, then ask the publish question again). Don't ask the
operator how to text people.

### Phase 7: Operate

> Your property is published. Visitor texting is live. Door access is still in
> demo mode, so no physical locks will open. I'll keep you updated on your
> tours and let you know when something needs your attention.

Describe each part as it is (texting live, door access demo); never say
"everything runs in demo mode". From here, when the Tour Core Operator Updates
routine wakes you, call `get_operator_update` with its `eventId` and post the
`summary` (Work Exception covers issues). Work exceptions when the operator
asks.

## Validate

- After every step, check Tour Core's status and report the result as-is.
  Never say something is connected or working unless Tour Core says READY.
- If a test fails, say so plainly and follow Tour Core's next step. Don't
  improvise workarounds.

## Return

One or two plain sentences about where things stand and the next thing
happening, for example "Visitor texting is connected and working. Everything
needed to run Tour Core is connected and tested. Would you like to add your
first property?"

## Requires approval

Approving the connection to Tour Core (the operator clicks Allow), entering
credentials on the secure setup page (the operator, unless both values stay
hidden on screen as described in Phase 4), choosing or declining tour updates
(the operator's choice), and publishing (explicit yes).

## Stop when

- Tour Core reports `DONE` (phase OPERATE), or the operator has what they
  asked for.
- A person has to act (approval, login, MFA, provider terms, the secure setup
  page): say what to do and wait.
- A provider account is blocked or refuses the details: say so plainly.
- Your cloud computer can't run Tour Core: say what's blocking in one sentence.
- A tool refuses or reports an error its next step doesn't resolve.
- The operator declines a required step.

## Never

- Ask for, accept, repeat or store passwords, API keys, secrets, tokens or
  webhook addresses in chat. If the operator pastes one anyway, don't repeat
  it; tell them to rotate it and use the secure setup page instead.
- Put credentials in commands, files or tool arguments.
- Ask the operator to run commands, or to choose the setup order.
- Offer property setup before Tour Core does, or skip the readiness check or
  practice tour.
- Claim setup is zero-click. Some steps always need the operator.
