# Cleaner Core Phase 0.6: integration validation

Status: validation kit implemented and **joint controlled Twilio transport test
passed**. Guesty live feasibility and production cleaner consent remain open.
Based on `cleaner-core/phase05-ordinary-evidence` at
`72e9d3b736f2100e509e7def951b9d0100b70ab9`. The user's request authorizes
Phase 0.6 and a joint controlled Twilio test. The attached implementation plan
defines discovery topics; it is not an instruction to deploy the later MVP.
The user has no active Guesty account and reports Twilio/test phone readiness.

This phase checks integration feasibility. It does not deliver the Phase 1
shared platform or the Phase 2 cleaning workflow. Grok remains optional under
the Phase 0.3/0.4 engine contract. No inference provider, production cleaner
agent instructions or touring tools changed. The existing Cleaner Core test
service was reused for the isolated lab under the owner's explicit instruction.

## Acceptance matrix

| Gate | Current evidence | Remaining live evidence |
| --- | --- | --- |
| Guesty API privileges | Official Open API endpoints identified; bounded GET probes implemented | Active account entitlement, authorized token and real listing/reservation/task reads |
| Guesty listing/reservation events | Svix verification including independent published vector; synthetic account/listing scoping, duplicates, stale updates, cancellation and restart checks | Subscription creation, real signed payloads, account binding, creation/date/listing/status changes and recovery from a missed event |
| Guesty calendar semantics | Hour-level fixture windows, offset/DST cases, multi-unit allotment and explicit absence of entry clearance | Real local time zone/check-in/check-out/late-checkout, blocks, next arrival, owner stays and sub-unit assignment |
| Guesty cleaning-task updates | Read endpoint and documented task status update identified; no write adapter enabled | Test-task change, readback and webhook; exact meaning of task completion versus property readiness |
| Twilio approved cleaner use case | Live reads verified account, SMS sender, service membership and VERIFIED campaign; owner explicitly confirmed cleaner coordination coverage | Actual production opt-in flow before a pilot |
| Twilio cleaner consent | Explicit joint-test authorization recorded; signed STOP, exact-phrase suppression, START and persistent opt-out across hosted restart verified | Actual cleaning-service owner's consent before a pilot |
| Twilio reply processing | Joint live signed inbound/response; one reply per accepted test; STOP/START and restart passed; replay/conflict cases covered locally | Controlled transport test complete; production workflow remains later scope |
| Twilio delivery receipts | Two accepted replies, matching signed delivered callbacks and owner-confirmed phone receipts; error/conflict/uncertain-send cases covered locally | Live failed-delivery path not forced; no claim of production guarantees |

Guesty account-dependent rows are **BLOCKED**, not passed by fixtures. Twilio
readiness and the controlled transport test were verified on the existing Railway
test service using secret references. Local transport tests inject the provider;
the separate joint phone test contacted the carrier. Cleanup disabled replies,
preserved opt-out/evidence, and the owner confirmed restoring the saved webhook. See
[validation evidence](evidence/cleaner-phase06-validation.json) and
[the joint Twilio runbook](cleaner-phase06-live-twilio.md) and
[live test evidence](evidence/cleaner-phase06-live-twilio.json).

## Local validation

All 28 Phase 0.6 checks pass. Focused revalidation passes 80 tests across
Phase 0.6, Phase 0.5 and the legacy SMS proof. Typecheck, build, whitespace and
all 26 baseline-evaluation tests pass. The bundled CLI starts/shuts down with
synthetic settings and no sends; invocation without `--live` is refused.

An earlier broad run passed 1,812/1,815 tests. The three failures were reproduced
on the unchanged Phase 0.5 baseline: the short-lived hosted setup-session test
and configured-credential redaction test time out at five seconds; the public
compliance scan finds eight existing phone-number occurrences. No legacy test
was weakened or unrelated phone/configuration changed. Final affected suites
were revalidated after the last callback-parser adjustment; the full repository
suite is **not claimed green**. No PR is opened while the repository's required
full checks fail; the implementation is supplied on its review branch.

## Delivered kit and reproduction

Requires Node 24, as the Phase 0.5 SQLite runtime does.

```sh
npm run typecheck
npm run build
npm run cleaner:phase06:check
npm run cleaner:phase06:probe
```

The last command sends no SMS, mints no OAuth tokens, subscribes no webhooks and
changes no provider configuration. With no dedicated settings it records
BLOCKED rows without any HTTP requests. It exits 2 while any integration gate
is incomplete. PASS on a read means the expected response/binding was observed,
not permission to write or proof of business semantics. Provider response bodies,
credentials, phone numbers and contact consent references are excluded from
the probe report. Task/calendar response shapes remain provisional until real
account captures are checked; unknown shapes fail visibly.

`src/integrations/phase06/guesty.ts` is an isolated fixture projection and
verification primitive. It is **not** a production webhook receiver, pagination
sync, reservation reconciler or Guesty task-write adapter. The projection persists
scoped minimal snapshots and source markers in SQLite and rejects version conflicts.
Fixtures supply normalized REST fields; they do not assert that every legacy/v2
webhook carries those fields. The signature check authenticates bytes, not account
entitlement or permission to change a booking. A production receiver must bind the
subscription to an authenticated account, durably accept an event before
acknowledgment, retrieve the current resource and reconcile it independently of
the arrival order. Periodic reconciliation is still required. Deletions/listing
removal and pagination are separate future integration work.

`twilioLab.ts` starts only through an explicit lab command. It retains minimal
inbound kinds/hashes, consent and an outbox in a **separate lab database**; it
does not import a cleaning schedule or create an agent task. Preflight-only startup disables all test replies, including those with older
stored consent. Enabling later never retroactively replies to an earlier test
phrase. Optional startup probes and private evidence logging support the
OAuth-controlled Railway test without exposing secrets. Only the exact
`CLEANER CORE TEST` phrase from the fixed test phone queues a controlled reply.
START/DONE are observations, not vacancy, access or property-readiness evidence.
A Twilio `OptOutType` takes priority. Its provider confirmation is not repeated.
STOP suppresses pending replies; a send already in flight cannot be recalled.
START re-enables only a previously consenting test contact. It cannot create
cleaner consent. Reopening does not reset opt-out state from environment settings.

The lab commits `sending` before a Twilio POST. An uncertain response or a crash
at that boundary enters review and **never automatically resends**. One signed
inbound source SID creates at most one test response. Separate new test messages
can each receive one response. A provider receipt is acceptance, not delivery.
Early callbacks are retained but count as delivery only after their message SID
matches the REST receipt. Terminal conflicts require review. Receipt callbacks
never authorize a second booking action or another send. Review resolution and
multi-process/shared-platform operation are not implemented by this lab.

## Guesty account testing, when an account becomes available

Use the Open API, not the Booking Engine API. The operator creates authorized
keys in Guesty's own page and obtains/caches a token through its normal secure
flow. The probe takes that token; it intentionally does not mint one per run.
Authentication alone does not prove access to any particular endpoint.

1. Select an owner-authorized **test** listing, reservation and cleaning task.
   Store the access token and the IDs/date range using the secure environment
   variables listed in `.env.example`. Run `cleaner:phase06:probe` and retain
   its redacted report. Check real response shapes privately before adapting
   the projections. Do not publish guest/contact data or credentials.
2. In Guesty's dashboard, create a dedicated HTTPS subscription for listing
   changes, `reservation.created.v2`, `reservation.updated.v2`,
   `calendar.updated.v2` and task events as supported by that account. Retain
   the endpoint signing secret securely. Capture signed raw events privately;
   verify signatures before trusting them. Capture the actual account and
   listing linkage. Confirm creation, dates, unit relocation and cancellation;
   replay a duplicate/out-of-order event and recover a deliberately missed event
   by an authorized read. The kit does not create this subscription.
3. Compare explicit reservation check-in/out instants, localized dates, listing
   time zone and a real next arrival. Exercise same-day turnover, late checkout,
   DST, cancelled reservations, manual/owner/preparation blocks and multi-unit
   allotment. Calendar availability describes booking availability, not vacancy.
   Missing/uncertain unit assignment or blocking semantics requires review.
4. Use a disposable task. Preserve its initial state privately; perform an
   explicitly approved task update through Guesty, read it back, and inspect
   the task webhook. Confirm statuses, listing/reservation linkage and time
   semantics. Restore/clean up the test task with the owner. A successful task
   GET does not prove PUT permission. A task marked completed does not, by
   itself, establish house readiness, host approval or permission to enter.

No account subscription, write, signing-secret retrieval or live Guesty request
has been performed in this phase. Guesty feasibility remains an open Phase 0
exit gate until those account observations are supplied.

## Other Phase 0.6 providers

| Provider | Decision for this phase |
| --- | --- |
| Ring | Deferred; no camera API, account/device eligibility or occupancy inference claimed |
| Yale | Simulate first; no hardware integration or code lifecycle enabled; exact model/rights still need discovery |
| Venmo/payouts | Ledger-only product posture; no transfers or payout integration; ledger implementation belongs to the MVP |
| Inventory suppliers | Reporting-only product posture; no purchases or supplier credentials; reporting belongs to the MVP |

## Primary references checked on 12 October 2026 (America/New_York)

- [Guesty authentication](https://open-api-docs.guesty.com/docs/authentication): Open API credentials/tokens; cache tokens rather than minting repeatedly.
- [Guesty webhook delivery and signing](https://open-api-docs.guesty.com/docs/webhooks): Svix verification, duplicate/out-of-order handling and fresh reads.
- [Guesty reservation events](https://open-api-docs.guesty.com/docs/webhooks-reservations): v2 event names and lean payloads.
- [Guesty calendar endpoint](https://open-api-docs.guesty.com/reference/get_availability-pricing-api-calendar-listings-id) and [calendar blocks](https://open-api-docs.guesty.com/docs/calendar-block-types): dates, wrapped `data.days` response and multi-unit allotment.
- [Guesty task read](https://open-api-docs.guesty.com/reference/get_tasks-open-api-taskid), [task update](https://open-api-docs.guesty.com/reference/put_tasks-open-api-taskid) and [task events](https://open-api-docs.guesty.com/docs/webhooks-tasks): feasibility references, not proof of this account's privileges.
- [Svix verification](https://docs.svix.com/receiving/verifying-payloads/how): independent published test vector and exact raw-body verification.
- [Twilio campaign resource](https://www.twilio.com/docs/messaging/api/usapptoperson-resource) and [service numbers](https://www.twilio.com/docs/messaging/api/phonenumber-resource): campaign/account/service/number bindings.
- [Twilio Advanced Opt-Out](https://www.twilio.com/docs/messaging/tutorials/advanced-opt-out), [webhook signatures](https://www.twilio.com/docs/usage/webhooks/webhooks-security) and [delivery callbacks](https://www.twilio.com/docs/messaging/guides/outbound-message-status-in-status-callbacks): consent/reply and delivery test requirements.
