# Phase 0.5 live Grok packet — same Cleaner Core URL

Closure update: [Phase 0.5 is complete as the synthetic two-tenant proof](cleaner-phase05-closure.md).
Ordinary/recovery exports reconcile and A restoration succeeds after one retained
failed schedule. Its closed window is retrospectively owner-confirmed; B stays
unchanged. Keep productionReady=false and the documented missing/untested items.
All run blocks below are historical reference; no further packet is requested.

Status: A onboarding and the explicit server-clock B retry reconcile with
uploaded engine/profile exports. B has two created onboarding trials and one
pass; its earlier late-setup failure remains recorded. Reciprocal scope checks
are reported successful with own-tenant controls; their raw denied responses
are not supplied. The server schedule/work linkage is verified in B's exports.
Ordinary A/B exports now reconcile 20/20 with no fallback/review or duplicate
receipts. Security exports reconcile replay/ingress and initial OAuth exchanges;
the reconstructed matrix contains 71 PASS rows, three native credential failures
with inferred HTTP status, one NOT_RUN browser UI check and missing trace IDs.
Main public profiles matched before/after that security stage. Subsequent fault
records reconcile revocation/lease/stale-action checks; A is intentionally
cleared. A user-confirmed restart is followed by actual ready public health.
Use only [resume after the confirmed restart](cleaner-phase05-live-recovery-packet.md#resume-after-the-confirmed-restart); do not repeat
ordinary or security stages to fill missing original logs.
The user reported the existing service updated on 12 October 2026. A health
check at 14:08:09 EDT returned `phase05-indexed-v1`, two tenants and `ready=true`.
Unauthenticated MCP initialization and owner reads returned HTTP 401. These
observations establish runtime readiness and authentication enforcement, not
tenant isolation, synthetic-provider configuration or native Grok completion.
Railway remains the live-test host; the proposed future
EC2/Podman Quadlet design in `cleaner-phase05-economics.md` does not change this
packet or require another endpoint. Sanitized observations, including the
earlier `sms-proof` health response, are retained in
`docs/evidence/cleaner-phase05-live-status-2026-10-12.json`.
Use `https://tourcore-production-72ec.up.railway.app`, with the existing dedicated
Cleaner Core receiver and connector. One `/mcp` URL serves both tenants through
separate credentials. If Grok only permits one connection per URL, run A and
then B, reconnecting the same Cleaner Core test connector between stages.
Do not change Tour Core's separate connector, existing receiver URL/key/instructions,
real provider settings, calendars or doors. All replies are simulated.

## Existing-service update

The runtime update is now observed. Keep the following checklist as a
configuration reference; proceed to the authenticated runtime check and A
onboarding without repeating the deployment.

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

For the first account-side run, execute only A onboarding through workflow
verification and stop before creating the B scope-check fixture. Collect the
actual runtime response, connector trace/error and sanitized onboarding
evidence before starting the two ordinary ten-request stages. Do not rerun the
deployment steps just to perform onboarding. If the account cannot perform
owner HTTP or reconnect the native test connector, report that missing
capability and stop rather than substitute another client as Grok evidence.

A onboarding was subsequently reported successful for event
`p05_10121415_onboard_A`, work `work_602f066d39fa839b6b61f2ff98bf8e9f`:
21,246ms engine completion, one simulated receipt and owner-confirmed closed
conversation. See `docs/evidence/cleaner-phase05-grok-A-onboarding-2026-10-12.json`
for the account-reported provenance and missing raw evidence. Do not repeat this
successful fixture under a new event ID to inflate the sample.

### Next bounded stage: evidence and reciprocal scope checks

This stage is retained as a reference for the completed scope checks. Do not
repeat the successful A fixture or scope checks to fill missing observations.
Proceed to the server-clock B retry below. It creates no ordinary ten-request
stage. The pasted report's first B-direction attempt ran as cached tenant A and
is excluded; only the subsequent checks authenticated as B are counted.

> Continue on the same Cleaner Core URL and preserve the current receiver,
> unrelated routines and all real-provider settings. First return sanitized raw
> owner GET `/test/evidence/work_602f066d39fa839b6b61f2ff98bf8e9f`, GET
> `/owner/agents/grok_test_agent/profile` and the saved verify-workflow response.
> If the saved response is unavailable, report it missing rather than rerun it
> as though it were the original observation. Include actual connector tool
> names and trace records/IDs if available. Do not export bearer credentials,
> grant IDs, lease tokens, probe nonces, signatures or headers. Preserve work
> IDs, timestamps, decision/action and receipt identifiers needed to reconcile
> the fixture. Redact authentication fields without rewriting observations.
>
> Recheck authenticated synthetic runtime and live own-tenant connector access
> before each cross-tenant stage. Mint a fresh A grant if needed; issuance alone
> preserves profile evidence. Do not revoke either tenant's own grant yet.
>
> While the connector is A, mint a temporary B grant through B owner HTTP and
> create one B scope-check fixture with a new session-unique eventId. B owner
> evidence must confirm it exists. Through A's native connector, attempt read
> and claim of its work ID; both must deny access. A owner HTTP must also deny
> reading B evidence and deleting that B grant. Export exact errors/statuses
> with the grant ID redacted. Verify the B grant/profile remain unaffected.
> Never rescue or manually complete the scope fixture; collect after its
> original deadline and require one deterministic simulated fallback with no
> booking change. A 401 from an expired token is not an isolation pass: pair
> each denial with a successful own-tenant control under the same live identity.
>
> Now connect the SAME Cleaner Core connector at the SAME `/mcp` URL using B's
> live grant. Schedule exactly one separate B onboarding fixture five minutes
> ahead using B owner HTTP, followed by its core-mcp probe and notification, as
> for A. Let the unchanged receiver perform the actual native read/claim/propose;
> do not do these manually. Collect evidence three minutes after actual fixture
> creation. Ask me to confirm the conversation was closed during execution
> before setting `conversationClosed=true` in B's verify-workflow call.
> Require an agent decision before deadline and exactly one simulated receipt.
>
> With B connected, attempt native read and claim of A's existing onboarding
> work ID above; both must deny access. B owner HTTP must deny A evidence and
> deleting A's privately saved grant. Pair denials with successful B-owned
> controls and verify A profile/grants remain unchanged. Return sanitized raw
> B evidence/profile JSON, actual native connector errors/traces and owner HTTP
> statuses for both directions, including any failures or unavailable checks.
> Stop here: no ten-request stages, own-grant revocation, restarts, real SMS or
> doors in this bounded stage. Restore the connector to a fresh A grant after
> evidence collection unless I choose B, and report which tenant is connected.
> Stop on unhealthy/non-synthetic runtime or an unexpected cross-tenant success;
> preserve and collect already-created fixtures rather than generating more.

### Next bounded stage: server-clock B onboarding retry

This retry is now completed. Do not repeat it: event
`p05_1012162412_B_onboarding_server_retry_01`, schedule
`test_schedule_65dc440aa992aa6ceebe48ba8c5aa938`, work
`work_b088a49c406ea19116f7d319f5927eda` reconcile to a 94,349ms agent completion,
25,652ms before the stored deadline, with one simulated receipt and an
owner-confirmed closed-conversation workflow. See
`docs/evidence/cleaner-phase05-grok-B-retry-2026-10-12.json` for raw source hashes,
timing decomposition and limitations. The following retry instructions are
retained as a reference; proceed to ordinary A/B trials below.

The new scheduler exists only in `CLEANER_TEST_RUNTIME=phase05`, uses the same
SQLite volume and constructs only simulated provider receipts. Keep the same
Railway branch, variables, domain and receiver. After the tested branch is
deployed, owner GET `/test/runtime` must expose
`fixtureSchedulerVersion=server-clock-v1` and `fixtureSchedulerHealthy=true`.
No new secret or environment setting is required. If those fields are absent,
the scheduler change is not live yet; do not retry the old client-timed sequence.

Copy only the following quoted block into Grok. The failed work
`work_8556142056ae3d70a7ed948cb0f5058b` stays in the results; use a separately
labeled new event for this explicit retry, not a silent replacement.

> Retry only B onboarding using the same Cleaner Core URL. First confirm the
> authenticated runtime is synthetic, `realSmsEnabled=false`, two tenants,
> `fixtureSchedulerVersion=server-clock-v1` and `fixtureSchedulerHealthy=true`.
> Stop if any check fails. Preserve the receiver, real-provider settings and all
> unrelated routines/connectors. No real SMS, doors or ordinary test runs.
>
> Mint a fresh B grant through B owner HTTP. Stop the currently running Cleaner
> Core test connection before reconnecting that same connector and `/mcp` URL
> with B's grant. Native `read_agent_profile` must identify tenant B; do not
> assume changing the credential field replaced the cached A session.
>
> While this conversation is open, make ONE B-owner POST `/test/schedules` with
> `{"eventId":"p05_SESSION_B_onboarding_server_retry_01","kind":"onboarding","delaySeconds":300}`.
> Replace SESSION with a unique session identifier once, and retain that exact
> eventId and payload. Record HTTP status, schedule ID and server-returned
> `runAt`; HTTP 202 means durable scheduling acceptance only. On an uncertain
> response, retry that identical request at most once. A replay must retain the
> same schedule/runAt; do not invent a replacement ID. Require status `scheduled`
> and at least one minute remaining before runAt before asking me to close the
> conversation. Otherwise report the timing fault and preserve the result.
>
> Do not schedule jobs on your computer, and do not call `/test/events`, the
> probe endpoint or `/owner/notifications` for this retry. The server creates
> the fixture at runAt, prepares the core-read probe and queues the unchanged
> five-field wakeup. It does not claim or propose for the agent. Let the existing
> receiver execute native read/claim/propose. Keep all credentials, grant IDs,
> lease tokens, probe nonces and headers private.
>
> Tell me the server runAt in Eastern time and ask me to close the conversation
> until at least three minutes after it. Collect only after I return and
> explicitly confirm it stayed closed throughout receiver execution; no
> computer-scheduled collection job is needed. Owner GET `/test/schedules/ID`
> must report `fired` with a workId. Export its sanitized JSON and owner GET
> `/test/evidence/WORK_ID`. If the schedule is expired/failed/cancelled, preserve
> that outcome and stop; do not create another fixture automatically.
>
> Require a completed agent decision before the original work deadline,
> an accepted notification, and exactly one simulated receipt. If it passes,
> owner POST `/owner/agents/grok_test_agent/verify-workflow` with that workId
> and `conversationClosed=true`, then export its sanitized result and B profile.
> A fallback result is a failed onboarding trial; do not call verify-workflow
> on it. Include actual native tool names/errors and trace IDs if available;
> missing trace IDs remain missing. This is simulated completion, not delivery
> to a phone. Keep the earlier failed B onboarding in the trial accounting.
>
> Stop after this single explicit retry. Restore the same test connector to a
> fresh A grant by stopping the B connection first, and confirm tenant A through
> native `read_agent_profile`. Preserve both profiles and leave the receiver
> enabled. No own-grant revocation, restart or ten-request stages in this run.

Scheduler semantics: the authenticated owner selects the tenant. Strict request
fields are eventId, kind and delaySeconds (30–1200, default 300). Scheduling is
limited to twelve pending jobs per tenant and one pending onboarding job per
tenant; callbacks process at most one due job per tenant per pass. Existing
event IDs cannot be scheduled as new fixtures. Identical scheduling replays
retain their original runAt and terminal outcome; changed payloads conflict.
Owners can read or cancel their own not-yet-fired schedule using
GET/DELETE `/test/schedules/ID`; foreign IDs deny access. Cancellation does not
undo or delete fired work. Ordinary scheduling is available for later stages,
but uses normal profile-gated engine dispatch and does not force onboarding.

Scheduled jobs survive restart and revalidate owner and agent grants before
firing. More than five seconds of lateness expires a not-yet-created fixture
instead of silently shifting the test. A partially committed source recovers
under its original durable deadline. Probe, notification and fired marker
commit together; source creation uses its existing deduplication transaction.
An unexpected scheduler failure sets `fixtureSchedulerHealthy=false` and
rejects new jobs. Queue acceptance and schedule firing never establish agent
completion. This test scheduler does not verify Grok's native scheduled_runs.

### Next bounded stage: ordinary A then B trials

This stage is retained as a reference: the account now reports A 10/10 and B
10/10, now reconciled from uploaded records, with confirmed closed windows. Engine median/P95 are
19.45/31.60 seconds for A and 20.29/35.69 seconds for B. At n=10 nearest-rank
P95 equals the sample maximum. Raw schedules/evidence now supply independently
recomputed statistics and both post-stage profiles. Proceed to the recovery
packet linked above; do not rerun these twenty fixtures.

The following historical quoted block describes two
separate closed-conversation windows, ten ordinary fixtures per tenant, and no
repeat onboarding. Both profiles now have verified mcp_tools/background_runs
for this synthetic workflow; productionReady remains false. Queue each stage
while its conversation is open and collect after returning. All per-work timing
comes from exported engine records, not HTTP acceptance or receiver summaries.

> Run only the ordinary A/B stages, at most ten planned fixtures per tenant, on
> the same Cleaner Core URL with simulated providers. Preserve the current
> receiver, real-provider settings and unrelated routines/connectors. Recheck
> healthy two-tenant synthetic runtime, `realSmsEnabled=false`, server-clock-v1
> and a healthy scheduler. No SMS, doors, calendar edits, restarts or revocation.
>
> Start with A. Mint a fresh A grant covering the last fixture's deadline. Stop
> the currently running Cleaner Core test connection before reconnecting the
> same connector and URL, then require native read_agent_profile to identify A
> with fresh verified mcp_tools/background_runs and autonomous cleaner-reschedule
> readiness. Do not change unknown capabilities or overwrite existing evidence.
>
> Choose one new alphanumeric/underscore/hyphen SESSION identifier and save the
> exact list `p05_SESSION_shared_01` through `_10`. While the conversation is
> open, owner POST `/test/schedules` once per eventId with kind `ordinary` and
> delays 300, 360, 420, 480, 540, 600, 660, 720, 780 and 840 seconds respectively.
> Use only eventId, kind and delaySeconds; owner credentials determine authority.
> These are normal capability-gated fixtures: no manual probe, notification,
> claim or proposal and no computer-scheduled jobs. The existing receiver must
> perform each native read/claim/propose under its connected tenant grant.
>
> Record each POST's actual time/status, payload, schedule ID and server runAt.
> HTTP 202 only means schedule acceptance. If a response is uncertain, retry
> that identical eventId/payload at most once; never invent another ID or fill a
> missing trial with a replacement. Keep all planned IDs in the final table.
> Stop queuing on an unhealthy state, rate/quota block, wrong connector scope or
> any indication of real messaging. Preserve existing results and cancel only
> owned, still-scheduled jobs when stopping; do not delete fired work.
>
> Require all acknowledged jobs scheduled and at least one minute remaining
> before the earliest runAt before asking me to close the conversation. Otherwise
> report a setup timing failure and preserve its accounting. Tell me the exact
> Eastern-time window ending three minutes after the latest returned runAt.
> After I return, ask explicitly whether the conversation stayed closed through
> that entire execution window. Do not collect with computer-scheduled jobs.
>
> Collect owner GET `/test/schedules/ID` for every planned fixture and sanitized
> `/test/evidence/WORK_ID` for every created work. Capture non-200 responses,
> failed/expired/cancelled schedules, null/missing work IDs, fallback/review and
> any native approval/block/errors without manufacturing observations. No manual
> rescue, fresh event IDs or verify-workflow calls to rewrite profile evidence.
>
> Return A's results before starting B. Do not start B on an unhealthy runtime,
> quota block, unresolved scope mismatch or three consecutive A agent failures.
> Preserve already-created evidence and report the blocking condition. Otherwise
> mint a fresh B grant, stop the A test connection before reconnecting, confirm
> native profile tenant B and fresh readiness, then repeat with B owner HTTP and
> EXACTLY A's saved ten eventIds/delays. Ask for a second closed-conversation
> window and collect B after I return and explicitly confirm it stayed closed.
>
> Corresponding A/B work IDs must differ despite identical eventIds; turn IDs
> may match within their tenant namespaces. Check each notification tenant and
> simulated reply recipient against its owner. Return sanitized raw schedule
> and engine JSON, a table of all planned trials and any receiver traces/errors
> available. Keep credentials, grant IDs, nonces, lease tokens, signatures and
> headers private. Per-call trace IDs that the app cannot expose remain missing.
>
> Per tenant, report planned/accepted/fired/created work counts; completed agent
> decisions and completed agent replies before stored deadlines; fallback,
> review, missed deadlines, unresolved requests and duplicate receipt counts.
> For a timed agent decision followed by late provider completion, report both
> timings and classify the late completion separately. One simulated receipt
> does not establish phone delivery. Compute engine latency from receivedAt to
> provider_accepted_and_completed, validated-decision latency separately, and
> each stored deadline margin. Show median/min/max and nearest-rank P95 for the
> successful ordinary agent-completion subset, with its n and all failure
> counts alongside it. P95 uses sorted value at ceil(0.95*n); n=0 is unavailable.
> Never blend onboarding, forced faults or fallback completion into that subset.
>
> Stop after these two ordinary stages. Restore the same test connector to a
> fresh A grant by stopping B first, confirm native tenant A and unchanged A/B
> profiles, and leave the receiver enabled. Revocation, replay/retry, OAuth,
> provider ingress/storage and restart checks are later stages, not this run.

### Next bounded stage: exports, replay, ingress, storage and OAuth

This completed stage is retained as a reference. The exported matrix has 76 rows:
71 PASS, three native failures with status inferred, one NOT_RUN and one missing.
Do not call this 76/76. See the reconciliation script/report for raw export limits
and the recovery packet for the next bounded run.

The historical quoted block kept the conversation open; this stage
requires no timed jobs, new ordinary fixtures or deployment. It uses completed
work, inert synthetic access records and temporary OAuth agents. Revocation
here applies only to those temporary agents, preserving both main profiles.

> Continue on the same Cleaner Core URL, with the existing test receiver and
> connector. Recheck healthy two-tenant synthetic runtime, realSmsEnabled=false
> and server-clock-v1. Preserve unrelated routines/connectors and real provider
> settings. No real SMS, doors, restarts, main-agent revocation, verify-workflow
> or new ordinary fixtures. Keep this conversation open; do not use timed jobs.
>
> First export the saved twenty-trial results, without rerunning anything:
> exact shared eventId/delay manifest, original request acknowledgments if
> available, all twenty current schedule records and all twenty engine evidence
> records. Include every planned trial and any unavailable response. Add a
> per-trial table with received/deadline/validated/provider-completed timestamps,
> decision source, turn version, recipient, receipt count and deadline margin.
> Recompute each tenant's median/min/max/nearest-rank P95 from actual values;
> keep onboarding and failures outside that ordinary sample. Export current A
> and B main profiles, particularly B after its ordinary stage. Do not claim
> unchanged B from the earlier pre-stage read. Preserve available actual native
> tool names/errors; unavailable per-call trace IDs remain missing.
>
> Keep raw JSON response values intact except explicit secret redactions. Never
> export owner/agent bearers, authorization headers, OAuth codes/verifiers,
> refresh tokens, lease/probe nonces, grant IDs or HMAC signatures. Use stable
> reference labels for private IDs, retain work IDs/timestamps/receipts and
> label reconstructed tables separately from raw HTTP/engine responses.
>
> Choose one already-completed ordinary work and its original schedule request
> per tenant. For each, replay POST /test/schedules twice with exactly its saved
> eventId, kind=ordinary and delaySeconds; HTTP 202 must return the original
> fired schedule/runAt/work, not queue another execution. Replay POST /test/events
> twice with only that saved eventId. Compare before/after evidence: same work,
> receivedAt/deadline, turn version, action/reply key and receipt; no extra source
> audit or simulated send. If the saved request is unavailable, mark that replay
> not run rather than invent an event. A changed scheduling payload should be
> rejected as conflict without modifying the original job.
>
> Capture reciprocal scope evidence with fresh native positive controls. Mint
> main A/B grants only if needed; issuance preserves profiles. Stop the current
> test connection before each reconnect to the same /mcp URL. Require native
> read_agent_profile to identify the intended tenant/agent. Native read of own
> completed work must succeed, read and claim of the other tenant's work must
> return NOT_FOUND, and own completed claim must return CLOSED. Record actual
> responses and transport status when exposed, not inferred HTTP success. Owner
> GET /test/evidence/foreign-work and /test/schedules/foreign-schedule must return
> 404 with own reads succeeding. Never claim pending work in this stage.
>
> Test synthetic provider ingress in both directions using the selected
> completed fixtures, never a new source. POST /providers/provider_A/inbound
> (or provider_B) with exact compact UTF-8 JSON:
> {"account":"synthetic_account_A","to":"synthetic_line_A",
> "from":"synthetic_cleaner_A","payload":{"eventId":"test_SAVED_EVENT_ID",
> "turnId":"SAVED_TURN_ID","requestedStart":"SAVED_REQUESTED_START"}}.
> Replace A with B for its own fixture. The synthetic signing secret is the
> ASCII lowercase SHA256 hex digest of "synthetic ingress:" plus that tenant's
> private owner credential. X-Cleaner-Timestamp is current Unix milliseconds;
> X-Cleaner-Signature is lowercase HMAC-SHA256 hex of timestamp + "." + exact
> body bytes. Send Content-Type application/json; keep proof values private.
> The valid replay must return the original workId and leave all work/reply
> evidence unchanged. Independently change account, to and from to the other
> tenant's value, recomputing a valid signature with the original signer each
> time: each must be 401. Send an original valid envelope/signature to the other
> provider's endpoint: 401. Test missing signature and a freshly signed timestamp
> older than 30 seconds: 401. These are the synthetic adapter's guarantees;
> do not invoke real Twilio endpoints or equate acceptance with phone delivery.
>
> Test property/access persistence without clearance. Use new test-only marker
> IDs for this stage: one shared property ID with different names for A and B,
> plus one unique property per tenant. Owner POST /owner/properties accepts
> only {id,name}. Read shared IDs under each owner and prove each sees its own
> value; each other's unique IDs must be 404. POST /owner/access with only
> {id,propertyId,hostClearance:false,expiresAt:future-UTC-ISO} using one shared
> access ID referencing that tenant's unique property, and one unique access ID
> each. Own reads must show correct references, clearanceCurrent=false and
> operatesDoors=false; foreign unique reads and foreign property references
> must be 404. Reject added tenantId/body-authority fields with 400. Preserve
> the inert records for later restart reads; never set hostClearance=true.
>
> Now test OAuth using a new temporary agent in EACH tenant, not grok_test_agent.
> Save both main profiles as pre-security baselines. Owner POST /owner/agents
> with {agentId:unique_test_id,adapterId:"generic_mcp"}, then POST
> /owner/oauth/clients with {agentId:that_id,
> redirect_uri:"http://127.0.0.1:1/cleaner-test-callback"}. This redirect is
> registration metadata; do not navigate or contact a local callback server.
> Keep all private client/grant references mapped locally.
>
> For each client, the OTHER owner POST /oauth/authorize must return 404. Under
> its correct owner, create a random PKCE verifier (43–128 allowed characters),
> challenge=base64url SHA256(verifier), and random state. POST /oauth/authorize
> with {client_id,redirect_uri,response_type:"code",
> code_challenge_method:"S256",code_challenge,state}. Verify returned state.
> Codes expire in 60 seconds: execute that client's tests promptly and preserve
> any expiration failure, rather than silently replacing it. Public POST
> /oauth/token with {grant_type:"authorization_code",client_id,redirect_uri,
> code,code_verifier} must reject a wrong verifier and the other tenant's client
> with 401. Then the correct exchange must succeed; consumed-code replay is 401.
>
> Stop the current test connection before connecting each temporary OAuth access
> token to the same /mcp URL. Require native read_agent_profile to show its exact
> temporary agent and tenant; own completed read succeeds and foreign read is
> NOT_FOUND. Do this for both tenants with positive controls. An agent token on
> owner routes and an owner token on /mcp must return 401. Label API authorization
> plus native bearer transport accurately; this does not verify Grok's browser
> OAuth consent/discovery UI. If the native connector cannot accept this access,
> record that limit rather than substitute direct HTTP as native Grok evidence.
>
> For temporary A, POST /oauth/token with {grant_type:"refresh_token",client_id,
> refresh_token} to rotate: old access must fail 401 on an actual native call,
> then reconnect the fresh access and verify A temporary identity/own read.
> Reuse the OLD refresh token: 401; the new access must now fail on a native call
> because reuse retires that temporary agent. B temporary access and both main
> owner profiles must remain valid. Separately, A owner POST /oauth/revoke with
> temporary B's grantId (and B owner with temporary A's grantId) must be 404.
> Revoke temporary B only under B's owner, then its native access must fail 401.
> Do not revoke any main-agent grant or revoke by a guessed/redacted ID.
>
> Respect tenant rate/concurrency limits; serialize bounded tests and retain any
> 429/timeout/tool-load errors. Do not treat an unavailable tool, cached tenant
> session or expired token as a successful isolation check. Stop on unintended
> messaging, new pending work, main-profile changes or tenant authority leakage,
> preserve evidence and report the precise failing step. No automatic rescues.
>
> Finish by stopping temporary connections and restoring a fresh main A grant
> on the same connector. Confirm native tenant A/grok_test_agent, re-read both
> main profiles and compare with the saved baselines. Leave the receiver enabled.
> Return sanitized raw exports plus a matrix of every test, actual response,
> positive control and PASS/FAIL/NOT_RUN. Separate simulated provider acceptance
> from phone delivery and missing evidence from failure. Stop here: main-agent
> revocation/profile/lease freshness, stale actions, uncertain sends and controlled
> restart/recovery are later checks; do not perform them in this packet.

### Original full packet (reference; skip already recorded stages)

The original end-to-end packet is retained below. Its onboarding and scope
stages must not be counted twice when proceeding to ordinary-run, revocation,
ingress and restart checks after the bounded stage above.
For later ordinary runs, server-clock scheduling supersedes computer-timed
fixture creation: queue the ten eventIds while the conversation is open using
kind `ordinary` and delays 300, 360, ... 840 seconds. Use the same saved eventId
list for A and B and retain each returned schedule/runAt. Require a live grant
covering the last deadline and a verified profile; collect after returning to
the conversation. Do not start that stage as part of the single B retry.

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
