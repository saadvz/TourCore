# Cleaner Core: first live delegation trial

This trial proves an unattended Grok routine can claim a synthetic rescheduling
request, propose the requested time, and obtain an engine-confirmed completion.
The reply stays in a local simulated ledger. It does not prove SMS delivery,
Guesty integration, or production reliability.

## 1. Prepare the separate receiver

Ask Grok to call `list_delegated_work` through the new Cleaner Core connector
once. An empty list is a valid bridge execution result. Create a new webhook-only
routine named **Cleaner Core Delegation Test**, with these instructions:

> For `eventType=cleaner.reschedule_requested`, use `workId` as the tool's `id`.
> Use only the Cleaner Core connector. Record the event ID and actual run
> start/end times without exposing keys or URLs. Read current work first.
> If it is completed, report the existing result and stop. If it has passed its
> deadline or is in review, stop and report that state. If it is pending/leased,
> claim it; use that claim's `leaseToken`, `turn.version`, and `requestedStart`
> to call `propose_cleaning_time` with `actionKey=grok_` followed by the actual
> work ID. Do not choose another time. If it is already `reply_pending`, read
> status without proposing another action. After proposing, read status to
> confirm completion; `accepted=true` alone is not completion. You may read up
> to three times, with a short pause between reads. Report pending if still
> pending. For any tool error, read current status and report the error; do not
> invent another action key. Report any approval prompt or block. Use no Tour
> Core tools, real SMS, external bookings, publishing, or door operations.

Do not create the test event yet. Leave Operator Updates unchanged. Keep the
receiver's private address and authorization value in its routine panel.

## 2. Bind Railway privately

Wait for the latest `cleaner-core/railway-agent-proof` deployment to be ready.
In this isolated service's Railway Variables add:

| Variable | Value copied from the new routine |
| --- | --- |
| `CLEANER_TEST_WEBHOOK_URL` | Complete Webhook URL |
| `CLEANER_TEST_WEBHOOK_AUTH` | Complete Authorization header value, including `Bearer ` if present |

Save and redeploy. Keep both existing test tokens and the `/data` volume.
Readiness must return the exact synthetic health response. Startup reports
`Grok test webhook notifications: configured` without printing secrets.
An incomplete pair prevents startup; never point these at Operator Updates.

## 3. Schedule one fixture while the conversation is closed

Ask Grok:

> Check the synthetic health endpoint at
> `https://tourcore-production-72ec.up.railway.app/healthz`. Confirm the dedicated
> Cleaner Core receiver is enabled. Request `CLEANER_TEST_ADMIN_TOKEN` using a
> supported masked field; I will copy it from Railway. Keep that value separate
> from the connector's agent token. Schedule a one-time sender on your computer
> for five minutes from now, then tell me its scheduled time so I can close this
> conversation. The sender must make one POST to
> `https://tourcore-production-72ec.up.railway.app/test/events`, with the admin
> bearer header and JSON containing only a fresh ASCII `eventId`, for example
> `grok_trial_` followed by the current UTC timestamp. The service sends the
> receiver's webhook; do not send the webhook yourself. Save actual request and
> response times, HTTP status, and returned work ID privately, without headers
> or tokens. If transport fails ambiguously, retry only the same eventId.
> After three minutes, collect `/test/evidence/WORK_ID` using admin auth and save
> its JSON privately. Report the matching work/event ID; notification attempted
> and accepted times and HTTP status; engine received, claimed, validated, and
> completed audit times; decisionSource/status/deliveryStatus; simulated reply
> count; receiver start/end and approval behavior. Missing times are unavailable,
> not estimates. Do not manually call the four tools from this conversation to
> complete the trial. Preserve all evidence and report failures. Clean up only
> the one-time sender afterward; leave the receiver and saved evidence available
> for the next controlled trial. Make no other changes.

Close the conversation before the scheduled POST and keep it closed until the
evidence collection time. Then share only the non-secret evidence report and
whether the conversation stayed closed. A delayed collector report is not the
agent execution time. Masked-value storage and deletion depend on supported Grok
controls; do not hand-edit its secret store.

## Interpret the result

- Notification HTTP 2xx proves transport acceptance only.
- Success requires matching work ID, a background receiver run with no required
  user intervention, `decisionSource=agent`, `status=completed`,
  `deliveryStatus=sent`, one simulated reply, and engine audit showing the agent
  claim and validated proposal before the two-minute deadline.
- `decisionSource=fallback` means the agent did not complete a valid proposal
  before the deadline. Preserve this result rather than repeating a manual tool
  action and calling it an unattended success.
- Bridge/tool errors, blocked approvals, and `review_required` are failures or
  incomplete outcomes to investigate. A claimed run alone is insufficient.

After the first success, separately test duplicate event delivery and a disabled
**test** routine to establish deduplication and independent fallback. Then collect
repeated ordinary trials for latency. Do not disable the production routine,
revoke production access, or attach a real SMS provider to this experiment.
