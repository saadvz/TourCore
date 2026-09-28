---
name: install-tour-core
description: Install, start and configure Tour Core on your own cloud computer, then walk the operator through only the steps that need a person (provider sign-in, credentials on Tour Core's secure setup page, approving the connection, publish), using Tour Core's installation tools as the source of truth.
when-to-use: "set up Tour Core", "install Tour Core", "what's left to set up", "check my Tour Core installation", "is Tour Core running", "restart Tour Core", "test operator alerts", "connect texting", "connect alerts"
allowed-tools: get_installation_status get_next_installation_step get_installation_component check_runtime_health check_public_endpoint test_visitor_messaging test_operator_alerts test_storage test_access get_secure_setup_url
argument-hint: "[what to check or connect]"
user-invocable: true
metadata:
  author: Tour Core
  short-description: Grok-managed install, installation status and secure credential setup
  version: "0.3.0"
---

# Install Tour Core

You install and run Tour Core yourself, on your own cloud computer, and use
its installation tools to learn what's left. Tour Core decides the order of
installation steps and keeps every record; you do the terminal and browser
work you're able to do, and ask the operator only for decisions and for
things only a person can do.

The operator never needs their own computer, a terminal, `.env`, or to know
what MCP or OAuth is. Never ask them to run a command.

## When to use

The operator says "Set up Tour Core", asks what's left to set up, asks you to
check the installation, or asks whether Tour Core is running. Also when a
Tour Core tool stops answering (Tour Core may have stopped).

## Required inputs and access

- Nothing from the operator to start. No attached files: the repository's
  `GROK_BOOTSTRAP.md` is the entry point and this skill is the detailed
  workflow.
- Your cloud computer, with a terminal and a browser.
- The Tour Core repository address, first found of: the canonical
  `repository.url` in `grok-template/template.json` (once published, an
  installed template already knows it), the address in the operator's
  message, or `TOURCORE_REPO_URL` on your computer. If none is available, ask
  the operator for the public Tour Core repository link. That's the only thing
  you may ask for before installing.
- If the address you were given and the canonical `repository.url` disagree,
  stop and ask the operator which to trust. Never continue with an unexpected
  repository; `npm run bootstrap:grok` refuses to start one.

## Sequence

### 1. Status first

If the Tour Core connector is already working, call `get_installation_status`
before doing anything else, and skip to step 5. Don't reinstall something
that's running.

### 2. Install and start on your cloud computer (only when Tour Core is absent or not answering)

Do this yourself in your computer's terminal:

1. If a `tour-core` folder doesn't exist yet, clone the repository address
   from "Required inputs" into it. If it exists, keep it (it holds the
   installation's records). Once cloned, load the other skills from
   `.grok/skills/` in that folder.
2. In that folder run `npm run bootstrap:grok`. It installs dependencies,
   creates or repairs the one installation, starts Tour Core in the
   background, checks its health, opens a public https address, checks that
   address from outside, and prints the installation status. Running it again
   is safe: it repairs instead of creating a second installation.
3. Read what it printed: the Grok connector address, a secure setup link for
   this computer's browser, and the next step. If it says cloudflared needs
   installing and you can install it on your computer, do so and run the
   bootstrap again. Otherwise tell the operator plainly what's blocking.

If Tour Core stopped later, run `npm run bootstrap:grok` again (or
`npm run service:restart`). If `npm run service:status` says it's healthy,
leave it alone.

### 3. Connect to Tour Core

Add Tour Core as a custom connector at the connector address the bootstrap
printed, with OAuth (leave token fields empty). Tour Core shows an approval
request on its connection page. Open `http://localhost:4321/grok` in your
computer's browser and ask the operator to take over the browser, check that
the code matches, and click Allow. Approving a connection is always the
operator's decision.

### 4. Check status again

Call `get_installation_status`. If it says the public address changed, Grok
must reconnect at the new connector address (step 3) and visitor messaging
needs the new address (`test_visitor_messaging` updates it).

### 5. Work through components one at a time

Call `get_next_installation_step` and follow `performedBy`:

- **GROK**: do it yourself. Call the named `tool`, or run the named `command`
  in your computer's terminal. Then call `get_next_installation_step` again.
- **OPERATOR_IN_SECURE_SETUP**: credentials are needed. Call
  `get_secure_setup_url` with its `secureSetupStep`, open the link in your
  computer's browser, and say something like:
  > Visitor texting isn't connected yet. I've opened Tour Core's secure setup
  > page. Please take over the browser and enter your Sendblue details there,
  > not in chat. Tell me when you're done.

  For operator alerts, first create the **Tour Core Exception Alert** routine
  from this template (webhook trigger), then:
  > I created the Tour Core Exception Alert routine. It needs to be connected
  > to Tour Core. I've opened Tour Core's secure setup page so you can enter
  > the routine's webhook address and a newly rotated key without putting them
  > in chat.

  Don't type values yourself, don't read them off the screen, and don't ask
  for them in chat. When the operator says they're done, call
  `get_installation_status`.
- **OPERATOR**: a person must do it (sign in to a provider, pass MFA, accept
  terms, approve the connection). Say exactly what to do, then wait.
- **OPERATOR_DECISION**: ask the question in everyday words and wait for
  their answer.

Records and access need no setup today: say "Your tour records are stored with
this Tour Core installation" and "Access system: Demo". If a component lists
`optionalActions` (for example a more portable place to keep records, once
available), offer it once with the recommended choice.

### 6. Property, readiness, practice tour, publish

Only once `infrastructureReady` is true and the next step is PROPERTY, move to
property setup with the Setup Property skill (and Map Route for routes). Then
run the readiness check (Run Readiness Check), the practice tour (Simulate
Tour), and ask for an explicit yes before publishing.

## Validate

- After every step, call `get_installation_status` or
  `get_installation_component` and report the component's new state as-is.
- Never say something is connected or ready unless the tool says READY.
- If a test fails, say what the tool said in plain words and follow its next
  step. Don't invent workarounds.

## Return

A short, friendly checklist, for example:

> Tour Core is running.
>
> ✓ Grok connection
> ✓ Visitor messaging
> ✓ Operator alerts
> ✓ Demo access
>
> Tour records are currently stored with this Tour Core installation.
>
> No property is configured yet. Want to set one up?

## Requires approval

Approving Grok's connection (operator clicks Allow), entering credentials on
the secure setup page (operator only), and publishing (explicit yes, through
the publish tool's confirmation question).

## Stop when

- Tour Core reports `DONE`, or the operator has what they asked for.
- A person has to act (sign-in, MFA, provider terms, the secure setup page,
  approving the connection): explain the step and wait.
- A provider account is blocked or refuses the details: say so plainly.
- Your cloud computer can't run it (no Node.js 20+, no network, no way to get
  a public address): report the one blocking step.
- The setup looks unsafe (a tool refuses, or status reports an error you can't
  resolve with its next step).
- The operator declines a required step.

## Never

- Ask for, accept, repeat or store passwords, API keys, secrets, tokens or
  webhook addresses in chat. If the operator pastes one anyway, don't repeat
  it; tell them to rotate it and use the secure setup page instead.
- Put credentials in commands, files or tool arguments. There is no tool for
  that on purpose.
- Ask the operator to run commands on their own computer.
- Move Tour Core's decisions (installation order, readiness, access) into your
  own judgment. Tour Core's tools decide; you carry out and explain.
- Claim setup is zero-click. Some steps always need the operator.
