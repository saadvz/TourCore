# Isolated real SMS delegation proof

This opt-in adapter completes the transport needed for Phase 0.1:
real inbound SMS → signed Twilio webhook → durable work → existing Grok
receiver/MCP tools → engine validation → real outbound SMS. Cleaning turns
remain synthetic. It does not change a real booking or the Tour Core installation.

The user confirmed on 11 October 2026 that a separate SMS-capable Twilio number
is on a paid account and already sends to their controlled test phone. No live
SMS result is recorded yet. The 20 synthetic trials were confirmed to have run
with the Grok conversation closed.

## Configure the existing isolated Railway service

Deploy the latest `cleaner-core/railway-agent-proof` branch. Keep the existing
volume, one replica, port, agent/admin tokens, and Cleaner Core webhook settings.
Add these variables privately in Railway, then deploy them together:

| Variable | Value |
| --- | --- |
| `CLEANER_TEST_TWILIO_ACCOUNT_SID` | Account SID (`AC…`) for the separate test number's account/subaccount |
| `CLEANER_TEST_TWILIO_AUTH_TOKEN` | That account's raw Auth Token, without a `Bearer ` prefix |
| `CLEANER_TEST_TWILIO_FROM_NUMBER` | Separate Twilio test number, in E.164 format such as `+12025550100` |
| `CLEANER_TEST_SMS_TEST_NUMBER` | Your controlled test phone, in E.164 format; this is the only allowed recipient |
| `CLEANER_TEST_SMS_ENABLED` | `true` |

The example number above is fictional; enter your own values privately.
Use the account Auth Token, rather than an API key secret: incoming Twilio
signatures also use this token. Existing `CLEANER_TEST_WEBHOOK_AUTH` remains the
full `Bearer …` value for Grok; it is a different credential.

The app uses Railway's public domain, or the explicit `CLEANER_TEST_PUBLIC_URL`
HTTPS origin if configured. For this deployment the origin is
`https://tourcore-production-72ec.up.railway.app`. A trailing slash on an explicit
origin is normalized. Do not add a path or query to the origin.

Once deployed, `/healthz` must return HTTP 200:

```json
{"service":"cleaner-core-test","mode":"sms-proof","ready":true}
```

Startup logs report `SMS proof: enabled for one controlled phone` and
`Grok test webhook notifications: configured`, without printing private values.
Missing settings block startup with the variable's name.

## Configure the separate Twilio number

In Twilio Console, open **Phone Numbers → Manage → Active numbers → your
separate test number → Messaging configuration**. Set **A message comes in**
to **Webhook**, method **HTTP POST**, and this exact URL:

```text
https://tourcore-production-72ec.up.railway.app/sms-proof/twilio/inbound
```

Save the number configuration. If a Messaging Service controls its inbound
handling, configure that service to use this webhook or defer to the number's
webhook. Leave the original Tour Core number/settings untouched. No bearer
header belongs on this inbound webhook: the application checks Twilio's
`X-Twilio-Signature`, account, sender and recipient.

Outbound delivery callbacks are configured automatically on each Twilio send;
no separate status URL needs to be copied into the number panel. They use
`/sms-proof/twilio/status/reply_WORK_ID` and are also signature-verified.

Do not send the test SMS until health and the existing Grok receiver are ready.
The current receiver already checks `eventType` and uses the four existing
Cleaner Core tools; no new routine or connector is needed.

## One real unattended trial

1. Have Grok check the expected `sms-proof` health response and confirm that
   **Cleaner Core Delegation Test** is enabled with its existing instructions
   and connector. Do not create `/test/events` requests or call claim/propose
   from the conversation.
2. Close the Grok conversation before sending. From the configured test phone,
   send **`CLEANER CORE TEST`** once to the separate Twilio number, without an
   attachment. Keep the conversation closed until after the reply arrives;
   wait at least three minutes if it does not arrive.
3. The app creates a trusted synthetic reschedule request, uses the real
   Message SID for deduplication, and wakes the same Grok receiver. The agent
   claims/proposes through MCP; the engine composes the text and sends it only
   to the configured test phone. The reply begins **`Cleaner Core TEST:`**.
   If no agent decision arrives before the 120-second deadline, the independent
   engine sends the host-review fallback instead.
4. Reopen Grok for evidence collection using its separately saved admin token.
   Read `GET /test/sms/evidence`, locate the inbound Message SID/work ID, then
   read `GET /test/evidence/WORK_ID`. Use `Authorization: Bearer ADMIN_TOKEN`
   only for these read-only admin endpoints. Do not submit another event to
   produce a report.

Report only non-secret findings: matching inbound/work/outbound IDs; inbound
receipt/deadline; notification attempts/status/times; receiver start/end and
tool trace without lease tokens; engine audit; decision source and completion
status; Twilio acceptance and delivery status/error code; outbound count;
whether the phone actually received exactly one reply and when; whether the
conversation stayed closed; and any approval prompt. Do not include auth
values, phone numbers, or private webhook URLs.

`decisionSource=agent`, `status=completed`, and `deliveryStatus=sent` mean the
engine received a **Twilio acceptance receipt** in this mode. They do not alone
prove carrier delivery. Require `sms.outbound[].providerStatus=delivered` where
available, plus the actual phone receipt. `accepted`/`queued`/`sent` are separate
provider states. A failed/undelivered callback remains visible even if the
engine previously recorded provider acceptance.

## Recovery and scope

SMS is disabled unless explicitly enabled. `/test/events` always remains
synthetic and writes replies to the local ledger, including while SMS is on.
Only signed messages from the configured phone pair containing the test phrase
create SMS work. Neither webhook payloads nor MCP tools select a recipient.
This proof does not evaluate natural-language cleaning requests or Guesty.

`sms-proof.json` durably records input before acknowledgment and binds existing
work to the configured account/phone pair/public origin. Recovery preserves the
first receipt's deadline; duplicate provider deliveries return the same work.
Changing the phone pair/account/origin on existing storage blocks startup;
use the original routing or a separate test storage directory. Token rotation
does not change routing. Keep one writer and the dedicated Railway volume.

Twilio sends are not treated as idempotent. An uncertain send is marked for
review, with no automatic retry after restart. A later signed callback can
record its outcome but does not silently clear that review. Inspect Twilio's
message record before deciding any manual recovery. Saved evidence omits
phone numbers and credentials.

After testing, set `CLEANER_TEST_SMS_ENABLED=false` and redeploy to disable real
messaging; restore the separate number's prior webhook if appropriate. Keep
evidence, and leave the existing Tour Core service and routines untouched.
Disable after outstanding work finishes; a pending SMS reply while disabled
will require review and cannot be marked sent through the simulated ledger.

Local verification uses fictional numbers and a fake Twilio transport. It
covers signed HTTP input, actual SDK MCP delegation, wire parameters/auth,
provider acceptance and delivery callbacks, source replay, deadline fallback,
interrupted-input recovery, uncertain-send review, and corrupt/rerouted storage.
It does not establish live Twilio delivery or background bridge availability.

Verified locally: 47 focused tests and TypeScript checking passed. The new bundled entrypoint started with
fictional SMS settings in the existing production-dependency container image;
health, admin evidence authentication, unsigned-provider rejection and graceful
shutdown passed. Both deployment Dockerfiles passed build validation. A fresh
local image build was stopped while dependency installation made no progress
in this workspace; the new Railway image build remains to be observed.
