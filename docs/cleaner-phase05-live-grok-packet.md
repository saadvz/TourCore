# Phase 0.5 live Grok packet — same Cleaner Core URL

Status: prepared; live execution is pending deployment and account-side runs.
Use `https://tourcore-production-72ec.up.railway.app`, with the existing dedicated
Cleaner Core receiver and connector. One `/mcp` URL serves both tenants through
separate credentials. If Grok only permits one connection per URL, run A and
then B, reconnecting the same Cleaner Core test connector between stages.
Do not change Tour Core's separate connector, existing receiver URL/key/instructions,
real provider settings, calendars or doors. All replies are simulated.

## Existing-service update

The repository branch is `cleaner-core/phase05-multitenant`. Keep the current
Cleaner Core service/domain, Dockerfile (`Dockerfile.cleaner-test`), volume and
existing A credentials (`CLEANER_TEST_ADMIN_TOKEN`, `CLEANER_TEST_AGENT_TOKEN`).
Add these settings privately in that service's Railway variables:

| Setting | Value |
| --- | --- |
| `CLEANER_TEST_RUNTIME` | `phase05` |
| `CLEANER_PHASE05_TENANT_B_ADMIN_TOKEN` | New random secret, at least 32 characters |
| `CLEANER_PHASE05_TENANT_B_AGENT_TOKEN` | Another new random secret, at least 32 characters |

All four A/B owner/agent values must differ. Preserve existing public URL,
webhook URL/auth and real-provider variables; the Phase 0.5 runtime ignores real
SMS settings and creates no real SMS/access adapter. Use the existing service's
branch selector to deploy this branch. Do not apply `.railway/railway.ts`: that
file describes a different original Tour Core setup. Existing JSON proof records
remain untouched. New records use `CLEANER_TEST_HOME/phase05/cleaner.sqlite`.

Before updating, use Grok's existing connector to check for pending work; do not
claim it. Stop and resolve the handoff if any real SMS work is pending. The code
update alone does not activate Phase 0.5 until the runtime variable is set.
After deployment `/healthz` must report `runtimeVersion=phase05-indexed-v1`,
`tenantCount=2`, `ready=true`. Owner GET `/test/runtime` must report `mode=synthetic`
and `realSmsEnabled=false`. Stop if either check fails; the old `sms-proof`
endpoint is not sufficient evidence for this new branch.

Bootstrap agent credentials last one hour and are not resurrected after expiry
or revocation. Prefer minting a fresh grant immediately before each connection:
owner POST `/owner/grants` with only `{"agentId":"grok_test_agent"}`. Keep its
returned bearer and grant ID private. The owner credential determines A or B;
never include a tenant field in a business request.

## Copy into the Grok account after the update

> Run a bounded Phase 0.5 test against the existing Cleaner Core URL above.
> Use only the dedicated Cleaner Core receiver/connector; preserve all unrelated
> routines and connectors. No SMS, doors, calendar edits, paid-quota exhaustion
> or production records are authorized. The new runtime must identify itself as
> `phase05-indexed-v1`, two tenants, synthetic provider only. Stop on a mismatched
> version, unhealthy runtime, wrong scope, or any indication of real messaging.
>
> Keep the A/B owner credentials, minted agent grants, webhook authorization,
> grant IDs, probe nonces and lease tokens private. Use owner HTTP for fixture
> creation/evidence. Use the actual configured connector for agent read/claim/
> propose; do not substitute direct JSON-RPC or an HTTP bridge script as proof
> of Grok's native connector execution. Record actual app tools and any approval
> or blocking prompt. Missing observations stay missing.
>
> Test A first. Mint its fresh agent grant privately, and reconnect the Cleaner
> Core test connector to the same `/mcp` URL with that grant. If the app still
> exposes only four core tools, retain that observation: the owner-issued core
> read challenge below is the supported verification path.
>
> Create one A onboarding fixture using owner POST `/test/events` with only an
> eventId unique to this session. Save its work ID and absolute deadline. Owner
> POST `/owner/agents/grok_test_agent/probes/core-mcp` with `{"workId":"..."}`,
> then POST `/owner/notifications` with that work ID and agentId `grok_test_agent`.
> Schedule this sequence five minutes ahead so I can close the Grok conversation
> during receiver execution. Do not manually claim/propose the onboarding work.
> The service sends the unchanged five-field wakeup to the existing receiver.
> Three minutes after actual creation, collect owner GET `/test/evidence/WORK_ID`.
> Require an actual connector read/claim/proposal, completed agent decision and
> exactly one simulated provider receipt. HTTP acceptance alone does not pass.
> After I explicitly confirm the conversation was closed, owner POST
> `/owner/agents/grok_test_agent/verify-workflow` with only that work ID and
> `conversationClosed=true`. Record profile methods/scopes/expiry and readiness.
>
> With A connected, create a B scope-check fixture using B's owner credential.
> Through A's actual connector, attempt read and claim of B's returned work ID.
> Both must deny access. Through owner HTTP, A must also be unable to retrieve
> B's evidence or revoke a B grant. Save actual errors/statuses; do not guess.
> Never manually complete or rescue the scope-check fixture; its engine fallback
> remains active and produces only a simulated reply.
>
> After A onboarding passes, schedule ten ordinary A fixtures at one-minute
> intervals, beginning five minutes ahead. Use event IDs such as
> `p05_SESSION_shared_01` through `_10`, and save this exact list for B.
> I will keep the Grok conversation closed during the execution window.
> For each POST, record actual timestamp, HTTP status and work ID. If receipt is
> uncertain, retry that same eventId at most once; never replace an unresolved
> attempt with another ID. Collect owner evidence after each deadline and once
> three minutes after the last actual POST. Collectors cannot claim/propose.
> Stop additional generation on unhealthy state, a rate/quota block, or three
> consecutive agent failures; preserve all already-created results.
>
> After collection, replay one completed A fixture twice with its original
> eventId. Require the same work/deadline, unchanged turn/version/audit and one
> simulated reply. An optional direct duplicate wakeup uses only the original
> five-field envelope and privately stored receiver auth; record its transport
> outcome and verify the receiver stops on completed state.
>
> Revoke A's connected grant through A's owner DELETE `/owner/grants/GRANT_ID`.
> Through the still-configured native connector, try reading a completed A work.
> It must reject the old credential. Capture the actual connector error; do not
> bypass it with an owner read. A profile must lose its evidence; B's grants and
> profile must remain unchanged. To exercise lease revocation, mint/reconnect
> a fresh A grant while its profile is unverified, create one extra A fixture,
> read and claim through the connector without proposing, then revoke that
> fresh grant. Its proposal must be rejected and the engine must eventually
> send one fallback without changing the booking. Collect after the deadline.
> Keep these forced faults outside the ten ordinary-run latency observations.
>
> Now mint a fresh B grant and reconnect the SAME Cleaner Core connector to the
> SAME URL. Repeat onboarding and ten ordinary fixtures as B, using exactly A's
> saved ten event IDs. Corresponding work IDs must differ, while booking IDs
> can match across the tenant namespace. B must deny read/claim of A work and
> owner reads/revocation of A resources. Keep the conversation closed during
> ordinary receiver execution, and collect both stages without hiding failures.
>
> Also use owner HTTP to create/read distinct A/B values under the same synthetic
> property/access IDs, with hostClearance=false and future expiry. Foreign unique
> property/access IDs must deny access. Do not operate doors. Signed synthetic
> ingress negative checks may use each owner's derived test HMAC secret
> the lowercase SHA256 hex string of "synthetic ingress:" + its private owner
> credential, used as an ASCII HMAC key, configured account
> `synthetic_account_A/B`, destination `synthetic_line_A/B` and sender
> `synthetic_cleaner_A/B`. Sign timestamp + "." + exact JSON body with HMAC-SHA256;
> POST to `/providers/provider_A/inbound` or `/providers/provider_B/inbound`
> with JSON `{account,to,from,payload:{eventId,turnId,requestedStart}}` and headers
> `X-Cleaner-Timestamp` (current Unix milliseconds) and `X-Cleaner-Signature`
> (lowercase hex). Use an owned fixture turn; changing to the other tenant's
> endpoint/account/number must fail. Export only
> statuses and sanitized payload identifiers, never signatures or credentials.
>
> If supported, restart only this updated test service between completed stages
> and repeat an existing event after restart. Keep its volume and variables;
> verify stable ID/deadline, revoked A token still denied and no second receipt.
> Do not restart a separate Tour Core installation. Label an unavailable restart
> control as untested rather than substituting a fabricated crash observation.
>
> Return sanitized raw `/test/evidence` JSON for each work and a per-trial table:
> tenant, eventId/workId, receipt/deadline, claim/validated/provider-accepted times,
> final source/status, notification status/attempts, reply count, native receiver
> trace IDs/start/end if available, and approvals/blocks. Include failures,
> unresolved POSTs, fallback/review cases and reciprocal denial results. Report
> successes/created work, missed deadlines, duplicate replies and nearest-rank
> P95 alongside median/min/max, with each sample size. This is simulated-provider
> completion, not phone delivery. Ask me to confirm closed-conversation windows
> before claiming background execution. Leave the existing receiver enabled.
> Restore the Cleaner Core connector to the owner's desired fresh tenant grant
> after collecting evidence; do not recreate unrelated routines or connectors.

The two ordinary stages total at most twenty requests. Onboarding, scope-check,
replay and revocation fault cases are separately labeled. New fixture attempts
must not be silently created to fill missing trials. Returned reports remain
account-reported until independently reconciled with hosted engine evidence.
