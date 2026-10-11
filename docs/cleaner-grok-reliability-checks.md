# Cleaner Core live reliability checks

The first complete synthetic delegation was reported successful on 11 October
2026 with the conversation closed: durable receipt to completed simulated reply
took 23.656 seconds. The earlier 401 trial completed independent fallback.
Neither result proves real SMS delivery or repeated-run reliability.

On 11 October 2026 the user also supplied a passing completed-request replay
report: two fixture replays and one direct duplicate webhook left the final
evidence byte-for-byte identical to baseline, including version 2 and one reply.
The next pending check is the explicit test-receiver outage below.

## Completed-request replay and duplicate webhook

Use the existing successful event
`grok-trial2-20261011035922-99e29bf23114` and work
`work_ad84198e386b10d6c73c414835b009c4`. This test is not a new scheduling trial.

Ask Grok to:

1. Save baseline `/test/evidence/WORK_ID` using its securely stored admin token.
2. POST `/test/events` twice using that exact eventId, including no other fields.
   Both responses must refer to the existing work. The engine's notification
   record must not show additional attempts as a result of these fixture replays.
3. Send one additional webhook to the existing dedicated receiver using its
   privately saved correct auth. Use exactly the sender's five fields:
   `schemaVersion=1`, `eventType=cleaner.reschedule_requested`, eventId and workId
   equal to the existing work ID, and deadlineAt from the baseline evidence.
4. Let the receiver read completed status and stop. Do not manually claim,
   propose, alter instructions, regenerate credentials, or create new work.
5. Save final evidence and compare: same work ID, confirmed start and turn version,
   `decisionSource=agent`, `status=completed`, `deliveryStatus=sent`, one simulated
   reply, and no additional claimed/validated/send/completed engine audit entries.
   Report actual HTTP statuses, receiver trace and any approval. Preserve errors.

The fixture replay tests source-event deduplication. The direct duplicate webhook
tests the receiver's completed-work guard. Neither proves concurrent duplicate
execution or proposal replay during an active lease; those remain separate cases.
Keep webhook values, admin token and lease tokens out of the shared report.

## Explicit test-receiver outage

After the replay check passes, use supported controls to disable only
**Cleaner Core Delegation Test**. Verify it is disabled. If the platform does
not support reversible disabling, report that limitation before substituting
another fault. Preserve the receiver URL/key and production Operator Updates.

Schedule one fresh `/test/events` request five minutes ahead, record scheduled
send/collection times, and close the conversation during execution. The sender
uses the admin token privately; the service sends its own webhook. Do not
manually perform tools to resolve the request. Retrieve evidence three minutes
after actual POST and preserve the result regardless of transport status:
some platforms accept delivery to disabled routines without executing them.

Required outcome: no agent claimed/validated audit, unchanged confirmed start
and turn version, fallback selected after the deadline, completed/sent status,
one simulated reply, and no required user intervention. Record receipt,
deadline, notification status/attempts, fallback/send/completion audit times,
and evidence of no receiver run. Re-enable only the test receiver afterward,
verify that it is enabled, and confirm it was not recreated or its key changed.
Delayed notifications must not produce another reply for the completed work.

## Repeated runs and remaining cases

After these checks, collect at least 20 ordinary trials using distinct event IDs
and closed conversations. Separate fixture HTTP, webhook acceptance, agent start,
validated proposal, reply completion, and report timings. Preserve failures and
missing timestamps. Report sample size, success fraction, deadline misses, and
preliminary latency percentiles with the limits of such a small sample.

Concurrent duplicates, active-lease retries, changed booking versions, revoked
test authentication and restart recovery need their own controlled live trials.
Existing local tests cover these engine contracts; do not label that local
coverage as live-provider proof. Do not deliberately exhaust paid quotas or
alter production credentials. Real SMS and Guesty integration remain later work.
