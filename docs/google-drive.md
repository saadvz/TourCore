# Google Drive as Tour Core's canonical store

Tour Core keeps its own records. Grok installs Tour Core and explains it.
Google Drive is the portable copy of those records for a real installation.
A local folder remains available for tests, development, and an operator who
declines Drive. That local folder is not portable storage.

## What Grok's connector does

Official docs (checked for this milestone):

- [Google Drive connector](https://docs.x.ai/grok/connectors/google-drive) — search, read, create, and upload files during a conversation. OAuth scopes requested by Grok include `drive.metadata.readonly`, `drive.readonly`, optional `drive`, and `userinfo.email`.
- [Connectors](https://docs.x.ai/grok/connectors) — built-in connectors authenticate the Grok user. There is no API to hand that token to another program.
- [Grok Bot computer and apps](https://docs.x.ai/grok-bot/computer-and-apps) — connectors are plugins the operator approves in the browser. They are for the Bot's own tasks.

Tour Core therefore does **not** send each save through Grok. Webhooks, door decisions, and restarts keep working when Grok is not in a chat. Grok's connector is for connecting the account, finding the Tour Core folder, and opening exports.

## Tour Core's own Google authorization

[Drive API scopes](https://developers.google.com/workspace/drive/api/guides/api-specific-auth) (updated 2026-09-03): `https://www.googleapis.com/auth/drive.file` is the non-sensitive scope for files the app creates. Tour Core also requests `https://www.googleapis.com/auth/userinfo.email` so the operator can see which Google account was approved. Full Drive access is not requested.

The flow is the [web server authorization-code flow](https://developers.google.com/identity/protocols/oauth2/web-server) with PKCE (S256), a random `state`, and an exact redirect URI (`{PUBLIC_BASE_URL}/google/oauth/callback`). Refresh tokens live in SecretStore on the Tour Core computer. They are not written to Drive, URLs after the exchange, or logs.

A landlord does not create a Google Cloud project. A distributor configures `TOURCORE_GOOGLE_OAUTH_CLIENT_ID` and `TOURCORE_GOOGLE_OAUTH_CLIENT_SECRET` (the OAuth client for the Tour Core app). A developer can set the same variables locally. Until that client exists, Tour Core says so and can keep records locally.

`LOCAL_DEVELOPER` and `GROK_MANAGED_P0` may use a loopback redirect when that is the public address. `SELF_HOSTED` and `HOSTED_RAILWAY_P0` use the stable web callback `{PUBLIC_BASE_URL}/google/oauth/callback`. On Railway that base is `https://${RAILWAY_PUBLIC_DOMAIN}` unless `PUBLIC_BASE_URL` is set. Register that exact URI on the Google web client. Do not register a trycloudflare host for the hosted service.

## Folder

One private folder named `Tour Core` per store. Files are never shared by Tour Core (no permissions calls).

Canonical JSON (schema version on each document) holds installation metadata, properties, tours, runtime sessions, the messaging ledger, operator events, and an append-only storage audit. `indexes/lookup.json` is rebuilt from those files so an inbound text does not scan Drive. `exports/` holds CSV and summary views. Views are not a second source of truth.

Secrets stay in SecretStore: Sendblue keys, webhook secrets, the Grok routine address and key, Tour Core MCP tokens, Google tokens, setup-session secrets.

## Consistency

Drive is not a transactional database. A change is written as a new file, then a catalog file is updated only if its etag still matches (`If-Match`). Readers trust a file only when the catalog names its checksum. If the catalog update fails, the previous catalog still names the previous files. Two writers cannot silently overwrite each other: a writer lease (`lease.json`) names the host and an expiry. A second live host is refused until the operator takes over, or until the lease has expired.

The local data folder, when Drive is canonical, is a cache. A newer Drive revision wins. The cache is rebuilt by restoring the folder onto a clean computer.

If Drive is down, a recently checked cache may answer an already-approved property fact. A booking, a schedule change, or a door grant is not confirmed unless it is saved. A door is not opened if the canonical records cannot be confirmed.

## Migration and a new computer

`prepare` → `migrate` (resumable) → `verify` → `activate` (only after verification, and only with confirmation). The local copy is kept. A failed check leaves the local files canonical.

A new computer connects the same Google account, discovers the folder, takes the writer lease, and restores JSON. Sendblue and other provider secrets are entered again.

## Manual test

See the Google Drive section of `docs/grok-manual-test.md`. Automated tests use `FakeGoogleDrive` and do not call Google.
