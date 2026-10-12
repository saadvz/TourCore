# Phase 0.5 live recovery packet

Closure update: **complete as the scoped synthetic proof**. The final exports
reconcile all five post-restart checks and the authorized restoration retry,
with retrospective owner confirmation of its full closed window. The initial
restoration UNAUTHORIZED/no-work failure is retained. Final matrix: 56 PASS,
one FAIL, two MISSING and two NOT_RUN. A is restored with fresh evidence; B is
unchanged. See [closure](cleaner-phase05-closure.md) for provenance and limits.
The blocks below are historical reference; do not run another fault/onboarding
packet or restart the service to fill missing observations.

Historical pre-restart status: session `s10121857` supplies 57 matrix rows: 46 PASS,
zero FAIL, nine NOT_RUN and two MISSING. Main A retirement, active-lease
revocation, expiry and stale-action engine records now reconcile. Lease expiry
preceded the deadline by 57,334ms. Both forced requests got one fallback receipt;
the controlled action got one agent receipt and exact replays changed no exported
values. These are separate from the twenty ordinary trials. Different private
lease-token bytes cannot be compared because they are redacted. The owner turn
version bump is observable but has no own audit entry. Global scheduled-job
absence remains missing, since no listing API exists; no new jobs were queued.

The user then confirmed restarting the test service in less than two seconds.
An actual subsequent `/healthz` read at 23:19:05 UTC returned HTTP 200,
`phase05-indexed-v1`, two tenants, `ready=true`. Restart control was performed by
the user, not this workspace; exact control/completion timestamps and hosting
revision/configuration are not independently inspected. Health does not prove
persistence. Source bytes/hashes and verification are retained in
`docs/evidence/cleaner-phase05-fault-reconciled-2026-10-12.json` and
`cleaner-phase05-restart-observation-2026-10-12.json`.

## Resume after the confirmed restart

Historical resume block; this stage is complete. Keep the previous fault records unchanged; do not
repeat retirement, lease-expiry or action fixtures. Old A7/A8 validity ends
around 19:58 EDT: test their denial before then or record an expiry confound.

> The dedicated Cleaner Core test service has been restarted once by its owner,
> who reported completion in less than two seconds. Public health is ready again.
> Resume the saved s10121857 packet at POST-RESTART recovery only. Do not repeat
> scope/fault tests or restart again. Preserve its revision, volume, variables,
> receiver and unrelated resources. Perform the five saved recovery checks on
> original A/B trial-01 work, the three CREATED fault/action work IDs, s3m1832
> storage and revoked/current grants. Export actual responses and compare with
> saved pre-restart records. Test old A7/A8 denial before their original expiry
> around 7:58 PM ET; distinguish native bridge errors from direct HTTP 401.
> Then schedule only the ONE restoration onboarding fixture, report its exact
> closed window and wait for my genuine closed-window confirmation before
> verify-workflow. Leave B unchanged, restore fresh main A and preserve all
> failures/missing evidence. Simulated acceptance remains distinct from delivery.

## Original full recovery packet (reference)

Ordinary twenty-trial records now reconcile. Security evidence has 71 PASS rows,
three native denial outcomes with HTTP status inferred, a browser OAuth check
not run and missing trace IDs. The timestamp fix for never-saved profiles is
local and tested, not deployed; do not change the hosted revision for this packet.

This packet tests main-agent retirement, lease expiry, stale versions/actions
and persistent restart. At most three new controlled fault/action fixtures and
one restoration onboarding fixture are allowed, all for synthetic tenant A.
These are separate from the twenty ordinary trials. The existing dedicated
Cleaner Core test service and receiver are the only live resources in scope.
Retry/uncertain-send guarantees and time-based capability expiry remain covered
by local injected-provider/clock/process-crash tests; the hosted simulator has
no send-fault controls. No real-provider or browser consent proof is claimed.

Copy only this quoted block into Grok:

> Use https://tourcore-production-72ec.up.railway.app and the existing Cleaner Core
> test connector/receiver only. Recheck healthy synthetic mode, two tenants,
> realSmsEnabled=false and healthy server-clock-v1. No real SMS, doors, calendars,
> provider changes, new inference, deployment or unrelated routines/connectors.
> Keep the conversation open for controlled faults; close it only for restoration
> onboarding at the end. No background computer-scheduled jobs. Keep raw exports
> and all failures; no replacement event IDs or repeated ordinary/security stages.
>
> Export any SAVED original native scope/identity/errors and refresh/revoke HTTP
> responses from the last packet. If absent, label missing; do not reconstruct
> them as raw. The matrix had 76 rows, including NOT_RUN and missing, not 76 passes.
> Keep tokens, private grant IDs, lease/probe nonces and authorization headers
> private; preserve work IDs, timestamps, recipients, receipts and audits.
>
> Save current main A/B profiles and completed trial-01 evidence, plus property/
> access markers s3m1832. Require A/B capability evidence fresh and no pending work
> or scheduled jobs. Mint fresh main grants covering this bounded run if needed;
> issuance alone must preserve evidence. Switch by stopping the current test
> connection before reconnecting the same /mcp URL. Confirm native B/grok_test_agent
> with own completed read, then native A/grok_test_agent with own completed read.
> For each native identity, propose against the other tenant's completed work
> using a dummy lease, a new test actionKey, valid expectedTurnVersion/start
> fields and that foreign work ID: NOT_FOUND, with no effects. Added tenantId
> arguments on native read/claim/propose must be rejected, never select authority.
> Record positive controls and baseline profile fields. Do not interpret an
> expired capability or cached session as an isolation result.
>
> First retire the connected MAIN A agent through A owner DELETE
> /owner/grants/PRIVATE_A_GRANT_ID. Do not revoke B. Immediately call native
> read_agent_profile and read_delegated_work on the still-configured old A access:
> both must fail. Capture the actual bridge error without inventing its HTTP
> status. Separately make an authenticated HTTP POST /mcp initialize with this
> revoked access and standard MCP headers; expect actual 401. This is a negative
> HTTP check, not substituted native execution. A owner profile must lose verified
> evidence and autonomy; B's public profile/grant must remain valid and unchanged.
> Owner verify-workflow of an OLD completed A ordinary work with its previously
> confirmed conversationClosed=true must fail WORKFLOW_NOT_VERIFIED: old-epoch
> notification/work evidence cannot reverify the newly retired agent.
>
> Mint/reconnect fresh MAIN A. Its native profile must still have unknown cleared
> capabilities and unavailable autonomy. No capability declaration, onboarding
> wakeup, probe or manual notification yet. This suppresses normal wakeups and
> lets controlled native claims run without racing the receiver. The undeployed
> empty-profile timestamp issue may still appear; compare evidence/readiness,
> not a changing empty-profile createdAt. Use one saved new session identifier
> and at most event IDs p05_SESSION_revoke, p05_SESSION_expiry and
> p05_SESSION_action; never replace a failed fixture with another ID.
>
> For the revoke fixture, owner POST /test/events with only its eventId, then
> native read and claim it. Save the exact private lease/proposal arguments and
> original deadline. Before lease/deadline expiry, revoke THAT connected A grant
> under A owner. Its native proposal must fail authentication; record the actual
> connector error and a separate immediate HTTP MCP 401. Owner evidence must show
> grant_revoked_lease_released and pending work with unchanged turn version 1,
> no confirmedStart, no validated action/reply and the same receivedAt/deadline.
> Mint/reconnect another fresh A grant and confirm capabilities still cleared.
> Submit the saved old lease proposal through this new native connection: expect
> LEASE_INVALID and no turn/action change. Do not reclaim or rescue that work.
>
> For the expiry fixture, create/read/claim once natively while A is unverified.
> Save leaseExpiresAt and exact proposal arguments. Keep this conversation open
> and synchronously poll owner evidence no faster than every five seconds until
> the server records lease_expired_or_grant_revoked, or the deadline is reached.
> Do not schedule computer jobs or extend the lease with repeated claims. Require
> pending status, no reply, a live current grant and server time BEFORE the
> original deadline: this establishes lease expiry independently of deadline
> fallback. If client/tool delay crosses the deadline, retain it as a setup
> failure and skip the remaining pre-deadline checks; no replacement fixture.
>
> While time remains, reclaim through native MCP and require a different lease.
> The original proposal with old lease must return LEASE_INVALID. Under A owner,
> POST /owner/turns with that owned turn's id, version increased from 1 to 2,
> recipient=synthetic_cleaner_A and its unchanged timeZone/windowStart/windowEnd/
> nextArrival/minimumMinutes; omit tenantId and confirmedStart. This is a deliberate
> synthetic OWNER version bump, not an agent confirmation. Propose through native
> MCP using the fresh lease but expectedTurnVersion=1: VERSION_CONFLICT. Preserve
> no validated action, no confirmedStart and no booking change by the agent.
> Leave this fixture for the original deadline fallback; do not submit a rescue.
>
> Once each fallback deadline passes, collect raw evidence: one deterministic
> fallback receipt to synthetic_cleaner_A, no confirmedStart, original deadline
> and no agent-validated action. Revoke fixture remains v1; expiry fixture remains
> the deliberate owner v2 if that step ran. These forced failures stay outside
> ordinary latency statistics. Normal notification must not have been accepted
> while A's capability evidence was cleared. B's profile/evidence must be intact.
>
> For the action fixture, create/read/claim once through native A and submit its
> valid requestedStart with current turn version and one saved stable actionKey.
> Preserve the EXACT proposal arguments privately. Read authoritative completion
> and replay that same proposal twice: accepted existing result, no extra version
> increment, validated-action audit, provider attempt or receipt. Change only
> start under the SAME committed actionKey: ACTION_CONFLICT. Export before/after
> evidence. This manual native action is a controlled replay test, not another
> autonomous ordinary pass. Do not claim phone delivery from simulated acceptance.
>
> Finish all work before restart. Confirm no pending/leased/reply_pending work
> and no scheduled fixture. Save both tenant profiles, selected ordinary/fault/
> action evidence and s3m1832 property/access reads. If scoped restart control is
> available, restart ONLY this dedicated Cleaner Core TEST service exactly once
> with the same deployed revision, volume and variables. No redeploy, reset or
> separate Tour Core restart. Record the real restart control/outcome and times.
> If unavailable, report NOT_RUN and stop at that boundary until I perform that
> single test-service restart; do not fabricate it from a health request.
>
> After the confirmed restart, recheck runtime and repeat the saved eventId for
> selected A and B completed ordinary work and only recovery fixtures whose
> creation/work IDs were actually saved. Never replay an uncreated event ID.
> Require original work IDs/deadlines, equal exported evidence and one receipt
> each, with no new audit/send. Read the saved property/access records under both
> owners: values remain tenant-scoped, clearanceCurrent=false, operatesDoors=false.
> Old revoked A access that is still within its original one-hour validity must
> fail natively plus an actual HTTP MCP 401; if naturally expired, record that
> confound rather than treating it as proof of persisted revocation.
> current A access succeeds without resurrecting its cleared evidence, and fresh
> B native identity/own read succeeds with its profile unchanged. Do not assert
> persistence from health alone or count failed identity discovery as a denial.
>
> Restore A readiness only with ONE new server-clock onboarding fixture after
> recovery. Mint fresh main A access, stop the prior connection, reconnect and
> confirm A/grok_test_agent. Owner POST /test/schedules with a saved new restoration
> eventId, kind=onboarding, delaySeconds=300. Require acceptance and at least one
> minute before runAt; no manual claim/proposal/notification/probe or client timing
> job. Tell me the Eastern-time window ending three minutes after runAt and ask
> me to close the conversation. On return obtain explicit confirmation it stayed
> closed for that entire window. Collect raw schedule/engine evidence first;
> only on a correlated on-time agent completion run verify-workflow with the
> genuine confirmation. Compare fresh evidence IDs/observation times against the
> retired epoch; never use an old workflow to restore readiness. Preserve any
> failure and fallback; no automatic replacement. Leave receiver enabled and
> connector on a fresh main A grant, B profile unchanged.
>
> Return raw sanitized responses and a matrix with exact status/body or native
> tool error, positive controls and PASS/FAIL/NOT_RUN/MISSING. Separate bridge
> failures from directly observed HTTP codes, epoch freshness from time-based
> capability expiry, and synthetic acceptance from phone delivery. No claim of
> testing hosted send uncertainty, browser OAuth UI or unexposed trace IDs.
