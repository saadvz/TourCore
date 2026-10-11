# Copy into the already-connected Grok Bot

We completed a scheduled background TourCore MCP read. Now test external-event
execution separately.

Create a separate temporary authenticated-webhook probe, using the existing
TourCore MCP connection. Leave the Operator Updates routine and TourCore's
normal alert settings unchanged.

On receipt of one synthetic `installation.test` event, call TourCore
`get_state` exactly once. Record the non-secret event ID, trigger type, actual
run start/end times, MCP success/failure, a non-sensitive returned status, and
any approval prompt or block. Do not follow the returned setup next step.
Do not send SMS, change properties, publish, operate doors, or modify bookings.

Using a supported authenticated sender outside the receiving routine, arrange
one real HTTP POST to that webhook about five minutes after setup. Record
actual send/acceptance times and HTTP status; correlate the same event ID with
the receiving routine's run. A scheduled sender is acceptable, but the receiver
must start from the webhook, not its own schedule. Report the actual tool trace
if available; distinguish observed results from inferred claims.

Keep webhook addresses, bearer keys, OAuth tokens, and setup links out of chat
and model-visible output. Use supported secure configuration. If the trigger
or secure sender cannot be prepared with the available capabilities, report
the exact blocker instead of inventing a route or changing production alerts.

Once prepared, tell me when to close this Grok conversation. Let the receiver
run while I am away. Preserve non-secret evidence before deleting only the
temporary probe and temporary sender. Report separately: HTTP acceptance,
receiver start, MCP completion, approval behavior, and cleanup.
