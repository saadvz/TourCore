# Isolated Cleaner Core test service

This package runs the delegation prototype as a persistent **development test**
process. By default replies are written to `replies.json`. The separate
[opt-in SMS proof](cleaner-sms-proof.md) can send to one configured test phone;
synthetic `/test/events` requests continue to use the local ledger.
It neither reads nor changes your existing Tour Core installation.

## Start locally

Node.js 20 or newer and this package's dependencies are required:

```sh
npm ci --cache .npm-cache --no-audit --no-fund
node --import tsx scripts/serve-delegation.ts
```

The default address is `http://127.0.0.1:4332`. Check `/healthz` for readiness.
`CLEANER_TEST_PORT` (or `PORT`) changes the port; `CLEANER_TEST_HOME` selects a separate
storage directory. The default is `tourcore-data/cleaner-core-test`.
One process may use each storage directory. A lock blocks accidental concurrent
startup. After a crash, confirm the saved process is stopped before removing
`service.lock`. Ordinary SIGINT/SIGTERM shutdown removes the lock.

The first local start saves separate, random agent and administrator tokens to
`credentials.json`, permission 0600. They persist across restart and are never
printed. Alternatively, set both `CLEANER_TEST_AGENT_TOKEN` and
`CLEANER_TEST_ADMIN_TOKEN`. Public listeners require these explicit credentials.
Transfer credentials only through supported masked setup controls;
do not paste them into chat or include the runtime directory in a source bundle.

## Public access prerequisite

By default the service listens on loopback. A separate HTTPS reverse proxy or supported
secure tunnel must reach it. Before public use, set `CLEANER_TEST_PUBLIC_URL`
to the HTTPS origin and restart. Host validation permits only that hostname
and local hostnames. There is no tunnel installer or public deployment in this
package. The default local launch is not reachable from a remote Grok Bot.
The Railway container binds `0.0.0.0` and obtains its public origin from
`RAILWAY_PUBLIC_DOMAIN`; its reverse proxy supplies HTTPS. See the separate
[Railway instructions](cleaner-railway-setup.md).

`/mcp` exposes the four delegation tools with the **agent** bearer token.
This service has no OAuth authorization flow. First confirm that your Grok
custom connector supports securely supplied static bearer authentication for
an isolated test. If it requires OAuth, this package cannot be connected yet;
OAuth must be implemented before attempting the live proof.

## Controlled requests and evidence

An operator adapter can call these routes using the **administrator** bearer
token. Never give that credential to the agent connector:

- `POST /test/events` with JSON `{ "eventId": "unique_test_name" }` creates
  a synthetic request with a valid proposed time roughly one day ahead.
  Replaying the same event ID returns the existing work; no second request is
  created. Extra inputs such as recipients or tenant IDs are refused.
- `GET /test/evidence/WORK_ID` returns current work, timestamped engine audit, simulated replies, and
  notification transport status.
  It does not expose authentication values.
- With SMS proof enabled, `GET /test/sms/evidence` returns sanitized provider
  input/send/delivery evidence. Work evidence includes its `sms` records and
  identifies real SMS work as `mode: "sms-proof"`.

The background worker sends a fallback to the local ledger after the two-minute
agent deadline, independently of agent requests. A healthy HTTP listener does
not demonstrate Grok completion; verify `decisionSource: "agent"` and
`status: "completed"` for the live agent trial. `decisionSource: "fallback"`
demonstrates the independent timeout path instead.

To enable authenticated HTTPS wakeups, create a dedicated Grok test routine and
set both `CLEANER_TEST_WEBHOOK_URL` and `CLEANER_TEST_WEBHOOK_AUTH` in the hosting
service's private variables. The authorization setting is the **complete header
value**, including `Bearer ` if the routine panel supplies it. Leave both unset
to disable notifications. The service never logs these values.

The separate notification worker reconciles pending durable work after restart,
persists each attempt before sending, and posts only schema version, event type,
work/event ID, and deadline. It uses a five-second timeout, at most three attempts,
and exponential backoff for network errors, 408, 429, and 5xx responses. Redirects
are refused. Retries reuse the same work ID. HTTP 2xx means receiver acceptance,
not agent completion. An interrupted send can be repeated after restart; the
routine must use the stable action key and authoritative completion status.
`notifications.json` stores attempt/status/timing metadata, with no destination,
credentials, or response bodies. Damaged records fail closed.

See [the live trial instructions](cleaner-grok-delegation-trial.md). Do not create a request until that routine and
connector are ready; the two-minute deadline starts when the event is saved.
Scheduled polling can exercise the tools but does not prove webhook delegation.

## Handoff to a computer that can host the test

Unpack the source bundle in a **new** directory, install its pinned dependencies,
and verify local health. Leave the existing Tour Core process, credentials,
connector, and Operator Updates routine untouched. Use supported controls for
the tunnel and connector credentials. Temporary hosting runs only while that
computer and its tunnel run; it is not an always-on production deployment.

Report only the public connector address, authentication support, local health,
and non-secret test results. Keep tokens, authorization headers, and webhook
addresses out of chat. Do not substitute the existing Tour Core MCP endpoint;
it does not expose these new prototype tools.
