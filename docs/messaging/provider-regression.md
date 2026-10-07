# Manual provider regression

## Fresh Grok onboarding

Use a new Grok Bot and a Tour Core installation with no messaging provider selected.

Expected conversation:

**Grok:** Tour Core is connected. How would you like prospects to text Tour Core?

Choices:

- Sendblue. Managed messaging with iMessage/SMS support. Sandbox and dedicated-line behavior may differ.
- Twilio. Dedicated SMS messaging with low usage cost. Carrier registration may be required depending on country and use case.
- Photon. Agent-focused messaging through Photon/Spectrum with iMessage support. Available capabilities depend on the provisioned Photon line/account.

**Operator:** Photon

**Grok:** Photon needs your project credentials. I'll ask for them securely.

A secure credential control appears. The operator submits there. The values do not appear in the chat.

**Grok:** Photon is connected. I found these available lines...

The operator picks a listed line when there is more than one. Grok tests the provider and continues. The operator should not see "Open Tour Core's secure setup page and enter..." unless secure input could not be used.

Sendblue and Twilio use the same shape: the choice comes first, then that provider's secure fields, then a test, then the next onboarding step. The operator stays in the Grok conversation except for OAuth, login, or MFA.

## Provider regression

Run this once for each connected provider before trusting a real line. Use the same visitor script every time. Only the transport changes.

Do not run this in `npm test`. It uses a real provider account and a real phone.

## Before you start

1. Tour Core is running and `PUBLIC_BASE_URL` is the https address that provider can reach.
2. The installation's messaging provider is the one you are testing (`sendblue`, `twilio`, or `photon`).
3. That provider passed Tour Core's connection test. Visitor texting says it is connected.
4. One property is published and uses `messagingMode: "live"`.
5. You have a phone that can text the property's number.
6. Set `TOURCORE_SMS_CONSENT_MODE` deliberately:
   - `provider_default` uses that provider's own recommendation
   - `keyword_confirm` requires TOUR, then YES, on every provider
   - `disabled` starts the conversation immediately; STOP, START, and HELP still work

Provider recommendations when the mode is `provider_default`:

| Provider | Visitor flow | Why |
| --- | --- | --- |
| Twilio | TOUR, then YES | Recommended for current U.S. application-to-person SMS. Tour Core does not check registration. |
| Sendblue | TOUR, then YES | Not a Sendblue or carrier rule. This deployment keeps keyword confirmation until you set `disabled`. Sandbox and dedicated lines may differ. |
| Photon | Conversation starts on the first text | Photon does not give Tour Core an SMS keyword rule. Do not treat this as Twilio A2P. |

## Same visitor script

Text the property number from the phone. Record every reply.

1. `Hi` (or `TOUR` when keyword confirmation is on).
2. If asked, reply `YES`.
3. Choose the first unit (`1`).
4. Choose the first day (`1`).
5. Choose the first time (`1`).
6. Open the identity-form link from the booking text and submit it.
7. Ask one property question, such as parking.
8. Text `HELP`. Confirm the reply includes how to opt out and does not invent a support address.
9. Text `STOP`. Confirm the opt-out reply and that a later booking text gets no tour reply.
10. Text `START`. Confirm you can continue.
11. In Tour Core, confirm one booking exists for that phone, not two, and the inbound record's provider is the one you are testing.

Repeat the first inbound text once, immediately, if you can provoke a webhook retry. The second delivery must not send a second reply or create a second booking.

Send a photo alone. The visitor must get exactly one reply: `I can't take photos yet. Text your question and I'll pass it along.` The photo is not forwarded. Send a photo with a question Tour Core can't answer: exactly `I can't take photos yet, but I'll pass your question to the property team, and they'll reply here as soon as they can.` once, and the question is flagged. Do not also send `I can't take photos yet.` Send a photo with an approved-fact question or a booking reply (`1`, `YES`): exactly `I can't take photos yet.` once, then the text is handled as usual. Do not also send “Text your question…”. A retried photo webhook must not send a second copy of that reply.

## Sendblue

- Inbound arrives at `PUBLIC_BASE_URL/webhooks/sendblue`.
- A request with a bad signing secret is rejected.
- The reply is sent from the configured Sendblue number.

## Twilio

- Inbound arrives at `PUBLIC_BASE_URL/webhooks/twilio` as form fields.
- A request with a bad `X-Twilio-Signature` is rejected.
- The reply is an SMS from `TOURCORE_TWILIO_PHONE_NUMBER`.
- A connected account is not proof of carrier registration.

## Photon

Use a real Photon project id and secret, and a line that Photon's API lists for that project. Do not type a phone number Photon did not report. Do not use a Twilio number unless Photon lists that line.

1. Connection test shows the line model Photon returned (`shared` or `dedicated`). Do not mark the line dedicated unless Photon said so.
2. Do not record SMS or RCS fallback unless that same account response reports it. The current adapter does not claim those capabilities.
3. From an iMessage client, text the provisioned line.
4. Confirm the webhook hit `PUBLIC_BASE_URL/webhooks/photon` and a request with a bad signature is rejected.
5. Confirm Tour Core stored a normalized inbound message: provider `photon`, the visitor number, the line number, the text, and Photon's message id. It must not store the raw Spectrum space or user object as the conversation.
6. Confirm the visitor receives one real iMessage reply from that line.
7. Run the shared visitor script above.

## After each provider

Property records, the booking, and the consent record should look the same aside from the provider name and the phone numbers. Switching providers afterward must be an explicit choice and must require a new connection test. Saved credentials and attached lines for other providers stay.
