# Phase 0.2: verified agent capabilities

The implementation plan asks for an AgentProfile schema, capability verification
checks, and a Grok-specific adapter. These are implemented in the isolated
Cleaner Core prototype. Local checks cover the profile and authenticated MCP
onboarding. The actual Grok profile still needs the live onboarding below.
Optional capabilities may remain explicitly unknown; they are not required to
complete the core onboarding.

## Profile and evidence contract

`src/agents/profile.ts` exports the stored `AgentProfile`, its TypeScript type,
and the derived `AgentProfileView` readiness response. Portable JSON schemas
are in [`schemas/agent-profile.schema.json`](schemas/agent-profile.schema.json)
and [`schemas/agent-profile-view.schema.json`](schemas/agent-profile-view.schema.json).
The backend also enforces uniqueness, ownership, freshness and probe invariants
that JSON shape validation alone cannot establish.
Regenerate schema exports with `node --import tsx scripts/export-agent-schemas.ts`.

Profiles bind tenant, agent and adapter identity to configured authentication;
MCP arguments cannot select a different tenant or agent. New installations
start unknown. Prior evidence from this repository is never silently applied
to every installation or agent. The prototype stores profiles in its dedicated
`agent-profiles.json`, atomically, with mode 0600 and the existing single-writer
volume lock. It stores credential digests and nonce hashes, not raw tokens,
private connector URLs, draft text or phone numbers. Corrupt data fails closed.

Each capability has a declaration and, separately, evidence with method,
scope, evidence ID, observation time and expiry. Verification lasts seven days
by default and is measured from the observation, rather than the import time.
Declaring availability never writes verification. Changing the configured
agent credential or adapter invalidates old evidence, declarations, grants and
in-flight probes; an old workflow cannot reverify that changed connection.

| Capability | Check | Meaning and limit |
| --- | --- | --- |
| `mcp_tools` | Authenticated start/complete challenge with a nonce | A real typed, read-only roundtrip through this connector |
| `generation_reasoning` | Structured answer/draft for a synthetic slot that either fits or overruns its window | Basic constraint/draft exercise; no live message, semantic safety guarantee or model benchmark |
| `background_runs` | Stored accepted notification plus agent claim, validation and completion, with owner-confirmed closed conversation | Webhook-triggered `cleaner.reschedule_requested` workflow only |
| `scheduled_runs` | Actual scheduled MCP acknowledgment and owner-reviewed run trace, with closed conversation | Scheduled execution; timing/polling SLA remains separate |
| `native_integrations` | Owner-granted read-only fixture, native connector exercise, MCP acknowledgment and reviewed artifact | Only the named extension/resource/read scope; no provider write permission |
| `files_images` | Controlled file/image exercise and owner-reviewed artifact | Recorded operation is `file_read` or `image_inspection`; one does not prove the other |
| `reminders_notifications` | Controlled read-only reminder exercise and owner-reviewed artifact | `reminders_read`; does not verify creating or delivering notifications |

States are `unknown`, `declared`, `unavailable`, `verified`, `failed` and
`expired`. Evidence provenance remains visible: `server_probe`,
`engine_workflow`, or `operator_review`. Background/scheduled evidence explicitly records the owner's closed-conversation
confirmation; the backend cannot observe whether a browser conversation is open.
For external native abilities the backend cannot independently inspect an agent's private connector trace. The
owner must review an actual exercised fixture before attesting; a declaration
or MCP acknowledgment alone leaves it unverified. Store only a sanitized
artifact ID, and keep credentials/personal content out of evidence.

## Readiness and authorization

- Without fresh verified MCP, readiness is `unavailable`.
- Verified MCP enables `interactive` readiness.
- Verified MCP and a reviewed scheduled run enable `scheduled` readiness.
- Verified MCP and fresh background workflow evidence within the configured
  deadline enable `autonomous` readiness for `cleaner.reschedule_requested`.
- Default deadline is 120 seconds. A tighter deadline can downgrade autonomous
  readiness; expired evidence cannot silently retain it.

The report always identifies `fallback=engine_owned` and
`productionReady=false`. Capabilities do not authorize booking, messaging,
access, payment or publication changes. Existing lease/version/policy checks
continue to validate every prototype proposal, and the engine owns sending.
Phase 0.2 adds discovery/readiness; it does not retroactively switch off the
existing trial receiver or introduce the Phase 1 capability-based event router.

## Grok-specific adapter

`src/agents/grok.ts` documents and validates the reference adapter:

- Stateless Streamable HTTP MCP, using the connector's bearer header.
- Authenticated webhook-only routine, using its complete Authorization value.
- Exact five-field event: `schemaVersion`, `eventType`, `eventId`, `workId`,
  `deadlineAt`. The event and work IDs match.
- Read → stop if closed/expired → claim → propose with lease/version and stable
  `grok_<workId>` key → read authoritative completion. HTTP acceptance and an
  accepted proposal are separate from completion.
- The existing token-forwarding bridge must work during background execution.
  Credentials remain in supported private controls.
- Approval behavior is observed per probe; prior success is not a blanket
  permission guarantee. Account-reported routine/scheduler delays and the
  inability of a routine to resume another remain documented operational limits.

The four existing delegation tools remain intact. The hosted test service adds:

| Tool | Action |
| --- | --- |
| `read_agent_profile` | Inspect this authenticated identity's capabilities and readiness |
| `declare_agent_capabilities` | Declare availability/native extensions without granting or verifying anything |
| `begin_agent_probe` | Issue a nonce-bound read-only probe with a ten-minute lifetime |
| `complete_agent_probe` | Complete the probe; external capabilities remain awaiting owner review |

The standalone Phase 0.1 demo exposes its original four tools. The hosted
service exposes eight when this update is deployed. Refresh existing connector
tool discovery using supported controls; keep its authentication unchanged.

## Live Grok onboarding, with no new SMS

Use the current Railway deployment and existing Cleaner Core connector,
receiver and tokens. No new environment, provider variable, routine, cleaning
event or phone message is needed. Existing `/healthz` keeps its SMS-proof mode.

Ask Grok:

> Check https://tourcore-production-72ec.up.railway.app/healthz for ready=true.
> Refresh tool discovery for the existing Cleaner Core connector and confirm
> the four delegation tools plus read_agent_profile, declare_agent_capabilities,
> begin_agent_probe and complete_agent_probe.
>
> Read the current profile. Declare capabilities you can actually claim, using
> the tool's schema; leave optional native/file/image capabilities unknown if
> you cannot inspect them reliably. Declarations are not verification. Include
> no credentials or private URLs and do not grant yourself native permissions.
>
> Begin and complete an mcp_tools probe using its returned probeId and nonce.
> Begin a generation_reasoning probe, reason from its synthetic window and
> minimum duration, and complete it with the requested structured decision and
> draft. The draft is an exercise only; send nothing. Do not show the nonce.
>
> Reuse the completed SMS proof work
> work_e9935dc0acb6f9e0b7fa55306a21e656. The user already confirmed the
> conversation stayed closed throughout that run. Using the separately saved
> admin token, POST to
> https://tourcore-production-72ec.up.railway.app/test/agent/profile/verify-workflow
> with only {"workId":"work_e9935dc0acb6f9e0b7fa55306a21e656","conversationClosed":true}.
> Request the token through a masked field only if missing. The backend reads
> the existing engine and notification evidence; do not supply timing or
> verification claims yourself.
>
> Read read_agent_profile again and save the sanitized result. Report each
> capability's declaration, verification status, method, scope and expiry;
> execution mode, missing requirements and fallback. Report errors/approval
> blocks without bypassing them. Do not create /test/events work, send webhooks,
> call claim/propose, send SMS, alter routines, or touch Tour Core. Do not attest
> optional external probes until the owner has reviewed actual fixture evidence.

Expected core result: MCP and the synthetic draft probe verified; background
workflow verified through local engine records plus the existing user
confirmation; autonomous readiness scoped to the tested reschedule workflow;
engine fallback retained. Optional capabilities may be unknown or declared.
The background metric uses the work's first durable `receivedAt`; it can differ
slightly from the later `received` audit timestamp used in the earlier report.
Importing an expired/missing/revoked connection's old work cannot pass readiness.

## Owner-only APIs and optional extensions

All `/test/agent/…` routes require the separate administrator bearer token and
bind the configured test identity. No grant/review endpoint is exposed as an
agent MCP tool.

| Endpoint | Input or result |
| --- | --- |
| `GET /test/agent/profile` | Profile readiness plus Grok adapter metadata |
| `POST /test/agent/probes` | `{capability, extensionId?}` |
| `POST /test/agent/profile/verify-workflow` | `{workId, conversationClosed:true}`; accepted wakeup and completed agent audit are read by the server |
| `POST /test/agent/native-grants` | `{extensionId, permissions, resourceId}` for a declared read-only fixture |
| `DELETE /test/agent/native-grants/EXTENSION_ID` | Revoke that fixture grant |
| `POST /test/agent/probes/attest` | `{probeId, artifactId, outcome, operation, conversationClosed?}` after actual owner review |

Declarations allow up to 16 extensions with a stable ID, kind, and required
read permission: `calendar.read`, `guesty.read`, `files.read`,
`notifications.read`, or `native.read`. Unknown fields, duplicate IDs, mixed
kind/permission declarations and write scopes are rejected. Owner grants name
a controlled fixture resource and do not configure external credentials or
broaden that provider's own permissions. The agent's native connector must
also have appropriate provider authorization.

For an optional native connector, declare it, obtain the owner fixture grant,
begin `native_integrations` with its extension ID, execute the actual read-only
fixture through that connector, and complete the MCP acknowledgment. Review
its result and sanitized trace before posting owner attestation with operation
`native_fixture_read`. A grant change/revocation invalidates verification and
pending probes. Scope changes cannot inherit an earlier fixture's proof.

For scheduled runs use operation `scheduled_mcp_pickup` and explicit
`conversationClosed=true`. For files/images use a synthetic owner-controlled
fixture and the exact tested operation `file_read` or `image_inspection`.
For reminders use `reminders_read`; the probe does not authorize an outside
message. Native proofs are scoped to the latest verified extension/operation;
do not treat that record as proof of every connector or operation.

## Local verification and deployment

Run the profile and existing delegation/SMS suites plus TypeScript checking:

```sh
npm run typecheck
npx vitest run test/agentProfiles.test.ts test/agentProfileService.test.ts test/delegationPrototype.test.ts test/delegationTestService.test.ts test/delegationNotifications.test.ts test/delegationStartupConfig.test.ts test/delegationSmsProof.test.ts --maxWorkers=4
```

The SDK integration checks authenticate actual tool calls and prove that
profile probes create no work or reply. Other checks cover failed/expired
probes, cross-tenant access, credential changes, owner-only APIs, fallback
rejection, grant changes/revocation, scoped external review, replay and corrupt
storage. The existing SMS/delegation tests remain the regression baseline.

Both deployment Dockerfiles now copy `src/agents` into their build stage. The
application manifests/lockfile and production Tour Core tool registry remain
unchanged. The update is deployed on the existing isolated proof branch.
Live onboarding results belong in this document after the account report;
local SDK probes do not replace remote bridge verification.

Verified locally on 11 October 2026: TypeScript checking and 66 focused tests
passed (19 new profile/service checks plus 47 existing delegation/SMS checks).
Bundling and both Dockerfile build validations passed. The new entrypoint was
run with fictional credentials in the existing production-dependency container
image: eight-tool discovery, MCP/draft probes, zero created work, owner endpoint
authentication, restart preservation and graceful shutdown passed. This does
not claim a fresh full local image build or live Grok onboarding completion.

## Live discovery checkpoint, 11 October 2026

At 6:48 PM ET the user supplied Grok's report: health returned HTTP 200 with
SMS-proof readiness, and a direct server discovery query listed all eight
tools. The existing configured Cleaner Core connector still exposed its old
four-tool inventory after connector restart. Grok stopped before declarations,
probes or workflow verification and did not substitute raw HTTP probe calls.
Thus deployment/discovery at the server is supported by the account report,
while configured-connector onboarding remains pending.

The subsequent fresh-message retry and supported removal/re-addition of only
Cleaner Core did not resolve discovery. Grok reports that the exact saved
`mcp-remote` bridge command returns eight tools while the app exposes four.
The receiver resolves its connector by name and needed no association change;
its instructions, URL and key stayed unchanged. No declarations, probes,
workflow import, new work or SMS were performed. Tour Core was unchanged.

The expanded server catalog had still advertised software version `0.1.0`.
It now advertises `0.2.0` when profile tools are enabled; the original standalone
four-tool prototype remains `0.1.0`. This gives clients a distinct catalog
version but does not establish that Grok's app cache uses that field. After
deployment, inspect the server metadata and retry discovery once in a fresh
Grok message. Do not repeatedly delete/re-add connectors or use raw HTTP probe
calls to claim configured-connector verification. If the app still shows four,
preserve the limitation and use supported app discovery/session controls.
