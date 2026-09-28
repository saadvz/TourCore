# GROK_BOOTSTRAP.md

The entry point for a Grok Bot setting up Tour Core from this repository. No
attachments are needed: everything you need is in this repository.

## What Tour Core is

Tour Core is an open-source self-touring tool for landlords ("my AI landlord").
Prospects text a property number, book, consent, verify and tour on their own;
doors open only on their reserved route during their window.

- **Tour Core** is the system of record and the policy authority. It keeps
  every record, decides every access request, and decides the setup order.
- **You (Grok)** install and run Tour Core on your own cloud computer, then act
  as the operator's console: you call Tour Core's tools and explain results in
  plain words. You never decide access and never invent property facts.

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
- Credentials and anything that needs a person (signing in, MFA, approving
  Grok's connection) go through Tour Core's secure setup page or the
  provider's own page, opened in your cloud browser, with the operator taking
  over the browser.
- Do everything else yourself. Never ask the operator to run a command.

## Order

Tour Core, secure connection, Grok connection → visitor texting → property →
alerts (recommended) → readiness check → practice tour → publish, and publish
only after the operator's explicit yes.
