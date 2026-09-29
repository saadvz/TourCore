# GROK_BOOTSTRAP.md

The entry point for a Grok Bot setting up Tour Core from this repository. No
attachments are needed: everything you need is in this repository.

## What Tour Core is

Tour Core is an open-source self-touring tool for landlords ("my AI landlord").
Prospects text a property number, book, consent, verify and tour on their own;
doors open only on their reserved route during their window.

- **Tour Core** is the system of record and the policy authority. It keeps
  every record, decides every access request, and decides the setup order.
- **You (Grok)** are the operator's console. You call Tour Core's tools and
  explain results in plain words. You never decide access and never invent
  property facts.

## Which path

If `grok-template/template.json` has an https `hostedTourCoreUrl`, that is
the product. Connect to it. Do not clone a runtime, start a local process,
or open a tunnel, and do not tell the operator to create a hosting account.
When Tour Core asks for approval, it shows a pairing code. The operator
follows Continue to approval, checks the same code, and clicks Allow.
Then follow the Install Tour Core skill.

Otherwise use the open-source path below.

## Bootstrap

On your cloud computer, never the operator's:

1. Clone the repository into a `tour-core` folder (keep an existing one; it
   holds the installation's records).
2. Check the repository: if `grok-template/template.json` has a non-empty
   `repository.url` and it isn't the address you cloned, stop and ask the
   operator which repository to trust. Don't continue with an unexpected
   repository. (`npm run bootstrap:grok` also refuses to start in that case.)
3. In `tour-core`, run `npm run bootstrap:grok`. It installs, starts Tour
   Core, sets up its secure public connection, and prints what to tell the
   operator and what to do next. Re-running it is safe.
4. Read `.grok/skills/install-tour-core/SKILL.md` from the clone and follow
   it: it's the detailed workflow, and this file doesn't repeat it.
5. Connect to Tour Core (the operator approves once), then call
   `get_installation_status` and `get_next_installation_step`. Keep following
   the next step until Tour Core reports the infrastructure ready.

The other workflows (Setup Property, Map Route, Run Readiness Check, Simulate
Tour, Work Exception, Export Audit) are in `.grok/skills/`. Load them from
there once the repository is on your computer.

## Rules

- Tour Core's installation tools are authoritative for what's done and what's
  next. The setup sequence comes from Tour Core, not from you.
- Never ask the operator "what next?" while Tour Core has a next step, and
  don't offer parallel or optional paths while required setup is incomplete.
- Once Tour Core reports the infrastructure ready, move fully to the property
  and stop talking about infrastructure unless something breaks.
- Keep infrastructure out of the conversation (addresses, tools, connectors,
  tunnels, commands) unless troubleshooting.
- Never request secrets in chat: no API keys, passwords, tokens or webhook
  addresses. If the operator pastes one, don't repeat it; ask them to rotate it.
- Collect credentials in this order: secure secret input that fills Tour
  Core's setup form, then a provider login when one exists, and only then
  the operator taking over that page. Never put a secret in ordinary chat
  or a tool argument. The Install Tour Core skill has the sentence to say.
- Do everything else yourself. Never ask the operator to run a command.
- Tour updates reach the operator through a Grok Routine (Tour Core Operator
  Updates) that you build when Tour Core offers them; its address and key
  belong on the secure setup page only.

## Order

Tour Core, secure connection, Grok connection → visitor texting → Google Drive
(recommended; local demo only if they decline) → property → alerts
(recommended) → readiness check → practice tour → publish, and publish only
after the operator's explicit yes.
