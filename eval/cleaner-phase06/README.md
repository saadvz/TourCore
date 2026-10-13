# Phase 0.6 validation kit

Run `npm run cleaner:phase06:check` for the isolated Guesty fixture and actual
Twilio-shaped loopback HTTP suite. Provider sends are injected. The independent
Svix docs vector supplements generated signature/tamper tests. These checks do
not require accounts, send SMS, operate doors or modify reservations/tasks.

Run `npm run cleaner:phase06:probe` for optional read-only account checks.
Missing settings produce BLOCKED evidence without network requests. Exit 2
means gates are incomplete; raw API responses/secrets are never printed.

Implementation/source scope and live prerequisites are in
[`docs/cleaner-phase06-integrations.md`](../../docs/cleaner-phase06-integrations.md).
The controlled live test is in
[`docs/cleaner-phase06-live-twilio.md`](../../docs/cleaner-phase06-live-twilio.md).
Recorded local results are in
[`docs/evidence/cleaner-phase06-validation.json`](../../docs/evidence/cleaner-phase06-validation.json).

This kit is separate from the production touring runtime and the Phase 0.5
synthetic service. No real Guesty/phone proof or completion should be inferred
from the focused test count.
