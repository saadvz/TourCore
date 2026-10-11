# Cleaner Core: bounded ordinary-run sample

Current account-reported checks: one full unattended synthetic success,
completed-request replay/duplicate webhook, and independent fallback with the
test receiver paused. This next sample measures repeatability with the existing
receiver enabled. It sends no real SMS or production booking changes.

Ask Grok:

> Verify the synthetic health endpoint at
> `https://tourcore-production-72ec.up.railway.app/healthz` and that the existing
> Cleaner Core Delegation Test receiver is enabled. Call `list_delegated_work`
> once to verify its connector still works; do not resolve any pending work.
> Preserve its URL/key/instructions. Use the securely saved admin token for the
> sender and evidence collector. Do not pause or recreate any routines.
>
> Prepare one bounded batch, starting five minutes from now: at most 20 fresh
> `/test/events` requests, spaced one minute apart, with a unique eventId per
> request and no other JSON fields. Railway must send each webhook. Tell me the
> first-send, last-send and final evidence-collection times in ET so I can close
> this conversation throughout execution.
>
> Save actual fixture request/response times, HTTP status and work ID for every
> attempt. Retry an ambiguous fixture POST only with its original eventId, at
> most once; never silently create a replacement ID. Preserve unresolved POST
> outcomes as such. Retrieve each work's admin evidence after its deadline and
> make a final collection three minutes after the last actual POST. Collectors
> must not claim, propose, or manually complete work. Keep credentials private.
>
> Stop generating additional requests if health is not ready, a quota/rate-limit
> block is observed, or three consecutive trials fail to produce completed
> agent decisions. Collect evidence for all already-created work regardless.
> Report the actual attempted count; never fill missing trials with invented
> results. Do not alter quotas or retry a failed batch automatically.
>
> Preserve raw evidence privately and provide a sanitized per-trial table with:
> event/work ID; receivedAt/deadlineAt; claimed, validated and completed audit
> times; notification status/attempts; receiver start/end if recorded; final
> decisionSource/status/deliveryStatus; reply count; and any approval/block.
> Use engine audit to calculate receipt-to-validation and receipt-to-completion
> seconds. Do not treat final report time as execution time. Missing fields
> remain unavailable. Distinguish fallback completions and incomplete work from
> agent successes.
>
> Report agent successes / created work, unresolved fixture attempts separately,
> deadline misses, fallbacks, approvals, duplicate replies, and min/median/P95/max
> successful completion latency. State the percentile method and sample size.
> Preserve failed cases; do not hide them by calculating only successful latency.
> Remove only the temporary batch sender after evidence collection. Leave the
> receiver enabled, keep evidence, and leave Tour Core unchanged.

The user must confirm the conversation stayed closed for the execution window.
Twenty sends at one-minute intervals span 19 minutes; with the five-minute setup
delay and three-minute evidence allowance, the planned window is about 27
minutes. Scheduling/report delays are separate observations.

Use a consistent percentile method. With 20 successful values, nearest-rank P95
is the 19th sorted value; median averages the 10th and 11th. A smaller successful
sample changes the P95 rank. A sample of 20 has limited precision and does not
establish a production SLA. Keep forced fault trials separate from ordinary-run
latency, while retaining their failure evidence in the overall proof record.
