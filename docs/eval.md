# Baseline eval

This is the phase 0 snapshot of today's landlord connector. Later phases diff against it. It does not change tools, visitor copy, or the demo flow.

The harness calls the real MCP tool handlers in-process, on a throwaway hosted install, with local test texting. Nothing here texts a real phone.

## Run it

```bash
npm run test:eval
npm run eval:baseline
```

`npm test` does not include this harness. `npm run test:eval` runs the guard, the config diff, and the full baseline. `npm run eval:baseline` runs the same baseline and exits non-zero if it drifted from `eval/baseline/`.

## What it records

- **Config diff** (`eval/baseline/config-diff.md`). Ten equivalent duplex setups (2 units, a shared front door, each unit's own door, weekday hours). Inputs vary the way a landlord might: order, casing, `9-5` versus `9am to 5pm`, door wording. Ids and timestamps are removed. Array order is kept. Today's diffs are expected. Phase 2's done-bar is zero fields differing.
- **Golden tasks** (`eval/baseline/golden-tasks.md`). Full setup to publish, book a one-off, answer a flagged question, pause a unit, export a day. Each row is the tools, the call count, and pass/fail on the end state. `eval/fixtures/golden-prompts.json` is the same five tasks in plain language for a later model-driven run. This harness does not call a model.
- **Out-of-chat exits** (`eval/baseline/exits.md`). Each place a task sends the landlord out of the chat. `key` means entering an API key or similar secret. A Google sign-in or an Allow click is `not key`. The checked-in path chooses local test texting, declines backups, and skips alerts, so those exits are not taken. A separate in-process Sendblue probe records the texting secure-setup exit without storing the link.
- **Demo click path** (`eval/baseline/click-path.md`). Ordered tool calls from texting setup through publish, with the milestone each `get_next_installation_step` returns.

Upper/Lower is a different duplex shape and is not mixed into the A/B runs.

## Re-baseline

When today's behavior is supposed to change:

```bash
npm run eval:rebaseline
```

or `EVAL_REBASELINE=1 npm run test:eval`, or `npm run eval:baseline -- rebaseline`.

That rewrites `eval/baseline/`. Review the diff before committing it.

## Live Scratch

```bash
npm run eval:live
```

Set `TOURCORE_MCP_URL` and `TOURCORE_MCP_TOKEN` (or `TOURCORE_OPERATOR_TOKEN` with the URL). If either the URL or the token is missing, the script prints a skip message and exits 0. A token without a URL does not run.

The hosted install also has real properties on the real texting line, including 145 Tenafly Road and 914B. The live script is built so a run cannot touch them:

1. It only operates on properties that same run created. Names start with `eval-` plus the run id, and the address includes the run id. Ids are tracked. A property that already existed is not adopted.
2. It keeps those properties on local test texting. It never selects the live line.
3. It removes every property it created when the run finishes, including when a step fails (`try/finally`).
4. A guard wraps every tool call and hard-stops, before the call, if the target property id is not one this run created.

It does not call install-wide writes. That includes texting provider or line changes, `reset_hosted_demo`, `set_services` with live texting, backup and storage changes, and tour-update preference changes. The in-process demo path uses some of those (choose local texting for the empty install, decline backups, skip alerts). Live mode skips them and lists the skips in its report. The live run is not the source of the checked-in baseline: its addresses are namespaced so they do not collide with 18 Maple Street.

`test/eval/guard.test.ts` checks that a foreign property id is refused before the tool runs.
