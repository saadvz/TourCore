# Phase 0.6 joint Twilio test

The first joint live test passed on 12 October 2026 (America/New_York): one
inbound test, one accepted reply and a signed `delivered` callback. The owner
confirmed the reply arrived. Signed STOP was saved, and an owner-authorized
Railway restart preserved opt-out and the single reply without a resend.
Post-STOP follow-ups were classified as unrecognized text, so exact-phrase
suppression remains inconclusive. Signed START then restored the previous test
consent: one new reply was accepted and delivered, and the owner confirmed phone
receipt. Final exact-phrase STOP suppression and cleanup remain pending. See the
[live evidence record](evidence/cleaner-phase06-live-twilio.json).
The purpose is one controlled reply and provider/phone evidence. Guesty,
bookings, entry, production cleaner consent and unattended Grok execution are
not inferred from this test.

## Prepare the dedicated lab

The owner's latest instruction is to reuse the existing Railway Cleaner Core
test service and change its source branch as needed. Use the
[exact Railway setup](cleaner-phase06-railway.md) for the existing service/volume,
isolated data path, Dockerfile selection, port and graceful shutdown settings.

Use the review branch `cleaner-core/phase06-integrations` with Node 24.
Keep the touring installation separate; retain the earlier Phase 0.5 records
and original test-service settings for rollback.
Use a dedicated Twilio test sending number and a dedicated lab process/storage
directory. Save that number/service's original inbound configuration privately
before routing it to the lab. Do not redirect a live visitor/cleaner line.

Set the following in the host's secure environment settings or an ignored
`.env.phase06` file with permission 0600. Do not paste secrets into chat.
The CLI uses environment variables; it does not automatically load `.env`.

| Variable | Value to supply securely |
| --- | --- |
| `CLEANER_PHASE06_TWILIO_ACCOUNT_SID` | Account SID owning the dedicated sending number |
| `CLEANER_PHASE06_TWILIO_AUTH_TOKEN` | That account's Auth Token for signatures and REST requests |
| `CLEANER_PHASE06_TWILIO_FROM_NUMBER` | Dedicated Twilio sending number, E.164 |
| `CLEANER_PHASE06_TWILIO_PHONE_SID` | Number's PN SID (read probe only) |
| `CLEANER_PHASE06_TWILIO_SERVICE_SID` | Attached Messaging Service's MG SID (read probe only) |
| `CLEANER_PHASE06_TWILIO_CAMPAIGN_SID` | Verified Usa2p resource's QE SID (read probe only) |
| `CLEANER_PHASE06_TEST_NUMBER` | Owner's allowlisted receiving/test phone, E.164 |
| `CLEANER_PHASE06_PUBLIC_URL` | Trusted HTTPS origin reaching the lab, no trailing slash/path |
| `CLEANER_PHASE06_OWNER_TOKEN` | Owner-only bearer of at least 32 characters; the existing test admin secret may be referenced on this controlled test service |
| `CLEANER_PHASE06_USE_CASE_REVIEWED` | `true` after checking cleaner coordination against the approved campaign and opt-in flow |
| `CLEANER_PHASE06_CONSENT_AT` | UTC ISO timestamp when the operator recorded the owner's explicit authorization for these test messages |
| `CLEANER_PHASE06_CONSENT_REFERENCE` | Private reference to that explicit test agreement, not an API key |
| `CLEANER_PHASE06_HOME` | Separate persistent lab directory; default `tourcore-data/cleaner-phase06-lab` |
| `CLEANER_PHASE06_HOST` / `CLEANER_PHASE06_PORT` | Default `127.0.0.1` / `4336`; use `0.0.0.0` only on the dedicated hosted lab |

The read probe checks the number and VERIFIED campaign association. The three
Account SID/Auth Token/sender settings suffice for bounded metadata discovery;
PN/MG/QE settings are optional as a complete explicit group. Review
approved description, examples and message flow in Twilio Console: an existing
Tour Core campaign is not automatically proof of cleaner-use-case coverage.
Record the result; don't edit or submit a campaign as part of this lab. If the
dedicated sender is not a US 10DLC number, establish the applicable sender
authorization separately; this probe specifically covers the roadmap's 10DLC gate.

```sh
npm ci
npm run build
# With settings already in the environment:
npm run cleaner:phase06:probe
npm run cleaner:phase06:lab -- --live
# Alternatively, load the ignored private file explicitly:
node --env-file=.env.phase06 dist/cleaner-phase06.js probe
node --env-file=.env.phase06 dist/cleaner-phase06.js lab --live
```

The probe exits 2 because the manual use-case/consent and live Guesty gates
remain open even if Twilio reads pass. This is an incomplete-gate result, not
a reason to retry sends. Do not start the lab with invalid Twilio read results.
The lab requires dedicated settings and explicit `--live`. Without
`CLEANER_PHASE06_USE_CASE_REVIEWED=true`, it starts in preflight-only mode and
queues/sends no replies, even if older consent is stored. Enabling replies also
requires the consent fields. It performs no send
on startup and never automatically reconfigures a number or service.

An optional `Dockerfile.cleaner-phase06` builds this same lab with Node 24.
It is a separate deployment definition, not a change to the main Dockerfile.
Mount persistent storage at `/data`, expose port 4336 (or set
`CLEANER_PHASE06_PORT` to the host's assigned port), and use `/healthz`.
Only one lab process may use a database. The initial validation record covers
the bundled Node CLI. Container/volume validation and the selected Railway
configuration are recorded separately in the [Railway setup](cleaner-phase06-railway.md).

## Route and run together

1. Confirm the lab `/healthz` is ready and the receiving phone's test consent
   is recorded. In the dedicated Twilio number or its Messaging Service,
   configure the effective incoming webhook as POST to
   `PUBLIC_URL/phase06/twilio/test/inbound`. If service-level routing is used,
   verify it actually selects that endpoint. Keep Advanced Opt-Out behavior
   enabled as appropriate. Individual sends set their own status callback;
   no global production callback needs to change.
2. From the configured test phone, send exactly **CLEANER CORE TEST** once.
   Expect exactly one reply:

   > Cleaner Core TEST: Received your test reply. This test does not change bookings or permit entry. Reply STOP to opt out.

3. Read authenticated lab evidence using the same secure environment:

   ```sh
   npm run cleaner:phase06:evidence
   # Or: node --env-file=.env.phase06 dist/cleaner-phase06.js evidence
   ```

   Confirm one inbound `test`, one reply and a provider receipt. `accepted` with
   delivery `unconfirmed` proves only provider acceptance. Wait for the signed
   carrier callback; `delivered` is distinct from the phone owner's observation
   that the message appeared. Capture both. If callbacks do not arrive, inspect
   Twilio's request/debugger log and verify the exact HTTPS origin/signature URL.
   Do not resend automatically to repair missing evidence.
4. Send **STOP**, then **CLEANER CORE TEST** again. The provider may issue its
   own STOP confirmation; the lab adds none. Expect no lab reply to the second
   test phrase and `optedOut=true`. Stop/restart the lab with the same persistent
   volume: opt-out stays true and there is no resend. A signed replay of an old
   inbound SID is already covered locally; never fabricate a new SID and label
   it a real carrier replay.
5. Send **START**, then **CLEANER CORE TEST** once more. For the already consenting
   contact this enables one new test reply. START alone is not business consent.
   Send **DONE** if desired: it records `reported_done`, changes no readiness or
   booking, and sends no additional lab reply.
6. Retain redacted lab evidence, UTC timestamps, test phone receipt observations
   and relevant Twilio message/debugger records. Record any failed/undelivered
   result as a failure. Do not intentionally send to an unrelated phone to force
   a failure. An uncertain send stays `review_required`; matching carrier
   callbacks do not automatically resolve its review or permit a resend.
7. Restore the saved configuration of the dedicated test number/service, stop
   the lab and retain its private evidence. Do not change touring or Phase 0.5
   routines/providers. After an actual crash, first ensure the old lab process
   is stopped, then remove only its stale `lab.lock` before reopening. Never
   discard SQLite/WAL files to clear a send review or an opt-out.

## Evidence and completion

Record account/campaign read outcomes, cleaner-use-case review, test-consent
reference (privately), inbound/response SIDs, callback result, observed phone
receipt, STOP/START/restart outcomes and cleanup. Keep raw credentials, phone
numbers and contact data out of the shared Git evidence. The authenticated
endpoint omits phones and consent references; SIDs still belong in private
account evidence unless deliberately redacted for publication.

This joint test can close the **controlled Twilio transport** gate. It does
not supply the actual cleaning-service owner's consent or Guesty account
feasibility. Phase 0.6 and the overall Phase 0 exit gate remain open until
those separate requirements are demonstrated.
