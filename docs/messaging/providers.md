# Messaging providers

Tour Core decides what a visitor is doing. A messaging provider only carries the text.

```
                    Tour Core
                       |
                MessagingService
               /    /    |    \
         Sendblue Twilio Photon local
```

Booking, scheduling, visitor questions, exceptions, and access policy do not import a provider. Adding Linq, Telnyx, WhatsApp, or a private adapter does not require changes in those layers.

## Contract

`MessagingProvider` in `src/messaging/provider.ts`.

| Piece | Who owns it |
| --- | --- |
| `id`, `displayName`, `description` | The adapter |
| `capabilities()` | The adapter, only for differences that change setup or delivery |
| `configFields()` | The secure setup page renders these and no others |
| `validateConfiguration()` | Missing or malformed settings, before any network call |
| `check()` | Read-only health. Do not send a message |
| `connect()` | Register this installation's webhook when the provider supports that |
| `verifyWebhook()` / `parseInbound()` | Authenticity, then a normalized inbound message |
| `send()` | One outbound text |
| `disconnect()` | Remove this installation's webhook when that is safe |

Unsupported features are omitted. Do not add empty methods for RCS, reactions, or polls.

## Inbound message

Webhook code produces this and nothing provider-shaped goes further:

```ts
{
  provider: "sendblue", // or "twilio", "photon", or your id
  providerMessageId: "abc123",
  from: "+15555550100",
  to: "+15555550123",
  text: "Hi",
  media: [{ url: "https://example.invalid/photo.jpg", contentType: "image/jpeg" }], // optional
  receivedAt: "2026-10-02T12:00:00.000Z",
  channel: "SMS"
}
```

Photos and other attachments are detected so the visitor can be told they can't send photos yet. Tour Core does not download or forward them. A photo alone gets the longer honesty reply. A photo plus a question Tour Core can't answer gets one combined text (`I can't take photos yet, but I'll let the property team know about your question.`) and is flagged. A photo with handleable text gets only `I can't take photos yet.` and the text is handled as a normal message.

`src/messaging/pipeline.ts` de-duplicates with `provider:providerMessageId` (`twilio:SMxxx`, `photon:spc-msg-...`). Sendblue keeps the existing ledger key `sendblue:in:...` so retries from before this split stay duplicates. A retry must not book twice, reply twice, or record consent twice.

## Outbound message

Tour Core sends `{ to, body, audience }`. The selected provider turns that into its own API. Visitor and session code must not import Sendblue, Twilio, or `spectrum-ts`.

## Webhooks

Each adapter has its own path:

- `/webhooks/sendblue`
- `/webhooks/twilio`
- `/webhooks/photon`
- `/webhooks/local` (QA loopback; JSON `{ id, from, to, text }`; no carrier signature)

Build the public URL from `PUBLIC_BASE_URL`. Verify the provider's signature on the raw body before parsing. Reject unsigned requests when the provider has a verification mechanism. Twilio uses `X-Twilio-Signature`. Photon uses Spectrum's Standard Webhooks secret and the legacy `X-Spectrum-Signature` header, both from the current Spectrum docs.

## Configuration

Register secret and non-secret names in `src/install/secretStore.ts`. The secure setup page asks only for `configFields()`. Secrets are write-only. Add the provider id to `MESSAGING_PROVIDER_IDS` and `MessagingProviderRegistry` (`src/messaging/registry.ts`). Selection is `TOURCORE_MESSAGING_PROVIDER` or the installation manifest. An unknown name fails clearly.

`choose_messaging_provider` is the deliberate switch. An installation-wide change takes the previous provider out of active use, clears the connection test, and invalidates property readiness until the new provider passes — except buildings already on local test texts, which stay as they are. Saved Sendblue, Twilio, and Photon credentials and attached lines stay. Switching to `local` must not blank carrier secrets. Switching back uses the stored account and a new connection test unless those details were never set.

A property may opt into local test texts (`choose_messaging_provider` with `local` and a property, or `set_services` with `messaging: local`) while the installation's primary provider stays in place for other buildings. That does not draft or disconnect a published live property. When more than one building exists, `local` without a property is refused. Full per-property live credentials (one building on Sendblue, another on Twilio) are a later slice.

## Health

`check()` and `connect()` return plain-language checks. Do not send a real message in a read-only test. Photon must use a line the Photon project actually reports. Do not treat an arbitrary phone number as an iMessage line.

## Capabilities

Report only what the account or API shows. Shared versus dedicated Photon lines come from `GET /projects/{id}/imessage/`. Do not invent carrier approval. A connected Twilio account is not an A2P approval.

## Consent

`TOURCORE_SMS_CONSENT_MODE` is `keyword_confirm`, `provider_default`, or `disabled`. STOP, START, and HELP stay in the visitor engine for every SMS provider. Do not put Twilio or Photon rules in `src/visitor/conversation.ts`.

## Secrets

Never commit account ids, tokens, phone numbers that belong to an operator, or webhook signing secrets. `.env.example` uses empty secrets. Phone examples use reserved numbers such as `+15555550123`.

## Example adapter

This adapter is not registered. It shows the shape.

```ts
import { MessagingError, toE164 } from "../Messenger";
import type { MessagingProvider } from "../provider";

export class ExampleMessagingProvider implements MessagingProvider {
  readonly id = "example" as never;
  readonly provider = "example";
  readonly displayName = "Example";
  readonly description = "A documentation-only adapter.";
  readonly presentation = "MESSAGING" as const;

  capabilities() {
    return {
      inboundMessaging: true,
      outboundMessaging: true,
      inboundSms: true,
      outboundSms: true,
      arbitraryInboundSenders: true,
      requiresPreverifiedContacts: false,
      supportsMms: false,
      supportsImessage: false,
      supportsRcs: false,
      supportsDeliveryStatus: false,
      supportsReadStatus: false,
    };
  }

  configFields() {
    return [{ name: "TOURCORE_EXAMPLE_TOKEN", label: "Token", hint: "From the provider.", secret: true, required: true }];
  }

  settingNames() { return ["TOURCORE_EXAMPLE_TOKEN"]; }
  credentialNames() { return ["TOURCORE_EXAMPLE_TOKEN"]; }
  defaultConsentMode() { return "keyword_confirm" as const; }
  webhookPath() { return "/webhooks/example"; }

  validateConfiguration() {
    return process.env.TOURCORE_EXAMPLE_TOKEN ? { ok: true, problems: [] } : { ok: false, problems: ["The example token isn't set."] };
  }

  async check() {
    return this.validateConfiguration().ok
      ? [{ id: "account", label: "Example", ok: true, message: "Example account connected" }]
      : [{ id: "account", label: "Example", ok: false, message: "The example token isn't set." }];
  }

  async connect() {
    const checks = await this.check();
    return { ok: checks.every((c) => c.ok), checks, webhook: "not-supported" as const, removedPreviousWebhook: false };
  }

  verifyWebhook() {
    return process.env.TOURCORE_EXAMPLE_TOKEN ? { ok: true as const, signed: true as const } : { ok: false as const, code: "WEBHOOK_UNSIGNED" as const };
  }

  parseInbound(raw: Buffer, now = new Date()) {
    const body = JSON.parse(raw.toString("utf8")) as { id?: string; from?: string; text?: string };
    const from = body.from ? toE164(body.from) : undefined;
    if (!body.id || !from) return { ignored: "not a message event" };
    return { message: { provider: "example", providerMessageId: body.id, from, text: body.text ?? "", channel: "SMS" as const, receivedAt: now.toISOString() } };
  }

  async send(message: { to: string; body: string; audience: string }) {
    if (!process.env.TOURCORE_EXAMPLE_TOKEN) throw new MessagingError("EXAMPLE_NOT_CONFIGURED", "The example token isn't set.");
    return { provider: "example", providerMessageId: "ex_1", channel: "SMS" as const, status: "SENT" as const, sentAt: new Date().toISOString() };
  }
}
```

Register it beside Sendblue, Twilio, and Photon. Do not edit the booking engine.

## Photon

The Photon adapter uses Spectrum cloud as documented for `spectrum-ts` 12.x:

- package: `spectrum-ts`
- import: `spectrum-ts/providers/imessage`
- management API: `https://spectrum.photon.codes`
- inbound: `POST /webhooks/photon` with `normalized-events.v1`
- outbound: `imessage(app).space.create(user)` then `space.send(text)`
- lines: `GET /projects/{projectId}/lines/?platform=imessage` plus `GET /projects/{projectId}/imessage/` for shared or dedicated

It does not use `@photon-ai/advanced-imessage`, `@photon-ai/imessage-kit`, or the local Messages package.

Manual checks for a real Sendblue, Twilio, or Photon line are in `docs/messaging/provider-regression.md`.

## Not in this milestone

Linq is not implemented. Neither is full per-property live credentials (one building on Sendblue, another on Twilio). One installation still has one primary live provider and one public inbound number for that provider. A property may additionally opt into the local QA loopback. The inbound message already carries `to`, so a later router can choose a property without rewriting the visitor engine.
