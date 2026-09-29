# Google Drive (first-party connector)

Google Drive is the recommended place for a landlord's Tour Core records.
Each installer connects **their own** Google account.

Nothing in this template carries:

- a Google account
- a Drive token
- a Tour Core folder id from anyone else's install

## Two different approvals

1. **Grok's built-in Google Drive connector.** Use it so the operator can connect Google in the normal way, and later so you can open the Tour Core folder and read human-facing exports. Connect it from Grok's connectors or Marketplace. Do not ask for a Google password, API key, or client secret.

2. **Tour Core's own Google approval.** Tour Core saves and reads its records directly, including when you are not handling a chat. xAI does not document a way for an outside program to use the connector's token, so this second approval is required. `begin_google_drive_connect` opens it. You never see the token.

If Tour Core says its Google app is not configured, say so and offer to keep records on this computer. Do not ask the landlord to create a Google Cloud project.

## What you say

> Visitor texting is working. Next I recommend connecting Google Drive so your property and tour records stay with you even if this Tour Core computer changes.

If they decline, `use_local_demo_storage`, and tell them the records stay on this computer and are not portable.

## What you use it for

- "Where are my Tour Core records?" — `get_storage_location`, then open that folder with the Drive connector.
- "Show me today's export." — the connector can open `Exports` in the Tour Core folder. Bookings and access still come from Tour Core tools, not from you reading the files.
- A new computer — `discover_storage`, then `takeover_storage_writer` after they confirm. Sendblue and other secrets are entered again. They are not in Drive.

Canonical records are JSON. Spreadsheets and CSV files under Exports are views. Do not edit those and expect Tour Core to follow them.
