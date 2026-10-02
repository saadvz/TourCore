# Messaging providers and A2P registration

Tour Core sends visitor texts through a messaging provider. Sendblue is the adapter included in this repository. Twilio is another provider a deployer may choose. A custom adapter can use the same messaging contract.

Tour Core does not require Twilio. The visitor conversation, keyword opt-in, STOP and HELP handling, and consent record are provider-neutral. When a provider requires its own compliance registration, that registration stays with the deployer and the provider. It is not a Tour Core business profile.

## What the deployer supplies

Some providers, including Twilio in the United States, may require A2P 10DLC brand and campaign registration before SMS is delivered. Those requirements change. Follow the provider's current documentation.

Tour Core can support a keyword opt-in. It does not submit a brand, a campaign, or a Trust Hub profile for you. Put the deploying organization's public details in configuration:

| Setting | Example |
| --- | --- |
| `TOURCORE_PUBLIC_BRAND_NAME` | `Tour Core` |
| `TOURCORE_PUBLIC_LEGAL_NAME` | `Example Property Company LLC` |
| `TOURCORE_PUBLIC_CONTACT_EMAIL` | `support@example.com` |
| `TOURCORE_PUBLIC_SMS_NUMBER` | `+15555550123` |
| `PUBLIC_BASE_URL` | `https://example.com` |

`TOURCORE_PUBLIC_BRAND_NAME` defaults to Tour Core when it is empty. If `TOURCORE_PUBLIC_LEGAL_NAME` is empty, the compliance pages do not invent a legal entity. In production they show a configuration warning instead.

Do not commit account identifiers, auth tokens, messaging service identifiers, brand or campaign identifiers, Trust Hub identifiers, or business registration numbers. Those belong only in private deployment configuration.

## Keyword opt-in

A deployer who uses a provider that wants a visible opt-in can publish:

- `https://example.com/TourCore/privacy`
- `https://example.com/TourCore/terms`
- `https://example.com/TourCore/sms`

Generic example, with placeholders only:

Prospective renters opt in by texting the configured keyword to the displayed property-tour number. They see that number on a listing, website, sign, or QR code. Tour Core replies with a messaging disclosure and asks them to reply YES. Reply STOP to opt out. Reply HELP for help. Help uses the address in `TOURCORE_PUBLIC_CONTACT_EMAIL`.

Replace every placeholder with the deploying organization's own legal name, support address, phone number, and public website before sending anything to a provider. This page is not a completed campaign application.
