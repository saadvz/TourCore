# Baseline eval

This is the checked-in snapshot of the landlord connector. The demo order is unchanged. Phase 2 adds milestone writes that store the same config as the older tools.

The harness calls the real MCP tool handlers in-process, on a throwaway hosted install, with local test texting. Nothing here texts a real phone.

## Run it

```bash
npm run test:eval
npm run eval:baseline
```

`npm test` does not include this harness. `npm run test:eval` runs the guard, the config diff, and the full baseline. `npm run eval:baseline` runs the same baseline and exits non-zero if it drifted from `eval/baseline/`.

## What it records

- **Config diff** (`eval/baseline/config-diff.md`). Ten equivalent duplex setups (2 units, a shared front door, each unit's own door, weekday hours) through the older tools. Inputs vary the way a landlord might: order, casing, `9-5` versus `9am to 5pm`, door wording. Ids and timestamps are removed. Stored order is deterministic. The done-bar is zero fields differing.
- **Milestone config diff** (`eval/baseline/config-diff-milestones.md`). The same ten duplexes through `set_up_texting`, `save_property`, `save_units`, `save_doors_and_routes`, `save_hours`, `save_settings`, `run_checks`, and `publish`. That report is also zero, and each run matches the older-tool canonical config. CI fails if either report is non-zero.
- **Milestone path** (`eval/baseline/milestone-path.md`). One duplex walked in demo order through those tools, including a blocked practice check before any route and the recovery.
- **Golden tasks** (`eval/baseline/golden-tasks.md`). Full setup to publish, book a one-off, answer a flagged question, pause a unit, export a day. Each row is the tools, the call count, and pass/fail on the end state. `eval/fixtures/golden-prompts.json` is the same five tasks in plain language for a later model-driven run. This harness does not call a model.
- **Out-of-chat exits** (`eval/baseline/exits.md`). Each place a task sends the landlord out of the chat. `key` means entering an API key or similar secret. A Google sign-in or an Allow click is `not key`. The checked-in path chooses local test texting, declines backups, and skips alerts, so those exits are not taken. A separate in-process Sendblue probe records the texting secure-setup exit without storing the link.
- **Demo click path** (`eval/baseline/click-path.md`). Ordered tool calls from texting setup through publish, with the milestone each `get_next_installation_step` returns. `get_state` is not on this path. Playbook selection is covered by `test/eval/getState.test.ts`.

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

Run one live eval at a time. Two overlapping runs are not safe: each run's end sweep only removes its own name, and a leftover from a run that stopped early is not cleaned up automatically.

Hosted `eval:live` needs two environment variables:

- `TOURCORE_MCP_URL` — the hosted MCP address, the public origin plus `/mcp`.
- `TOURCORE_MCP_TOKEN` — the one-hour access token from the hosted OAuth sign-in. The live script does not perform that sign-in. It sends the token as `Authorization: Bearer`.

`TOURCORE_OPERATOR_TOKEN` is the dev static-token mode credential. It does not sign in to the hosted install, and the live script does not accept it in place of `TOURCORE_MCP_TOKEN`. If the URL or the sign-in token is missing, the script prints a skip message and exits 0. Nothing is called.

### Getting the one-hour token

Hosted Tour Core (`HOSTED_RAILWAY_P0`) issues that token only through its OAuth flow. The Allow page does not show the token. The client that finishes the flow receives it from `POST /token`. These are the steps that flow actually takes:

1. A call to `/mcp` with no `Authorization` header returns `401`. The `WWW-Authenticate` header points at `/.well-known/oauth-protected-resource/mcp` and names the scope `tourcore.operator`.
2. That document's `authorization_servers` is this Tour Core's origin. `/.well-known/oauth-authorization-server` lists `/register`, `/authorize`, `/token`, and `/revoke`. The code challenge is S256. The only scope granted is `tourcore.operator`.
3. The client registers with `POST /register` (or presents a client-id metadata document). A redirect URI has to be https on an allowed host (`grok.com`, `x.ai`, `x.com`, plus any host in `TOURCORE_OAUTH_REDIRECT_HOSTS`). An `http` loopback address (`localhost`, `127.0.0.1`, or `[::1]`) is allowed unless the client registered `application_type` `web`. On the hosted demo the two exact Grok legacy callbacks are also accepted unless `TOURCORE_GROK_LEGACY_OAUTH_COMPAT=false`: `cursor://anysphere.cursor-mcp/oauth/callback` and `https://www.cursor.com/agents/mcp/oauth/callback`.
4. The client sends the owner to `/authorize` with a 43-character S256 `code_challenge`. Tour Core answers with the consent page titled "Connect to Tour Core". It names the client, lists what the client can and cannot do, and shows a six-digit match code. On the hosted demo that page has an **Allow** button. The first Allow on an unclaimed demo makes that client the owner. A second, different client is refused.
5. Allow posts the match code to `POST /oauth/requests/<id>/approve` with no `Authorization` header. A bearer token on that request is refused. **Deny** posts to `POST /oauth/requests/<id>/deny`. After Allow, the page loads `GET /oauth/requests/<id>/continue`, which redirects once to the client's redirect URI with a single-use `code` and `iss`.
6. The client posts that code and the PKCE verifier to `POST /token`. The JSON includes `access_token` (it starts with `tca_`), `token_type` `Bearer`, `expires_in` `3600`, and `scope` `tourcore.operator`. A refresh token is included only when the client registered the `refresh_token` grant. Put `access_token` in `TOURCORE_MCP_TOKEN`. It lasts one hour (`ACCESS_TOKEN_SECONDS`).

The hosted install also has real properties on the real texting line, including 145 Tenafly Road and 914B. The live script is built so a run cannot touch them:

1. It only operates on properties that same run created. Names are `eval-` plus the run id (`eval-` and `r` and 8 hex characters), and the address includes the run id. Ids are tracked. A property that already existed is not adopted.
2. It keeps those properties on local test texting. It never selects the live line.
3. It removes every property it created when the run finishes, including when a step fails (`try/finally`).
4. A guard wraps every tool call and hard-stops, before the call, if the target property id is not one this run created.
5. If a create reply is lost, that property would otherwise stay untracked. At the end of the run, a cleanup sweep lists properties and removes only those whose name is exactly `eval-` plus this run's id. Another run's `eval-r` name is ignored. There is no start-of-run sweep: a leftover from an earlier run might belong to a run that is still going, so it is left in place. When no live eval is running, that leftover can be removed with `remove_property` only if its listed name is exactly `eval-` plus `r` and 8 hex characters. A name that only resembles that prefix (different casing such as `EVAL-r…`, a shorter name, a malformed property id, or a harness-shaped name on 145 Tenafly Road) aborts the sweep, and nothing is removed.

Removing a property hides it from the operator's list. The record stays in storage. One live run can leave about 10 of those hidden `eval-` properties, one for each duplex.

The live allowlist does not include `get_next_installation_step`. That read persists the messaging selection and can rewrite the saved texting-provider choice. The in-process click path still calls it, on an empty local install, to record milestones. That path is not the live script.

It does not call install-wide writes. That includes texting provider or line changes, `reset_hosted_demo`, `set_services` with live texting, backup and storage changes, and tour-update preference changes. The in-process demo path uses some of those (choose local texting for the empty install, decline backups, skip alerts). Live mode skips them and lists the skips in its report. The live run is not the source of the checked-in baseline: its addresses are namespaced so they do not collide with 18 Maple Street.

`test/eval/guard.test.ts` checks that a foreign property id is refused before the tool runs, that the cleanup sweep's filter never selects a non-eval property, and that the end-of-run sweep ignores another run's `eval-` name.
