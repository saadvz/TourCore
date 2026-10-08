# Google Drive (first-party connector)

For the hosted product, Google Drive is where portable backups and readable
exports are saved. Live tour records stay on hosted Tour Core. Each installer
connects their own Google account to Grok, once.

Nothing in this template carries a Google account, a Drive token, or a Tour
Core folder id from anyone else's install.

## One approval

Use Grok's built-in Google Drive connector. If it is already connected, reuse
it. Do not ask for a Google password, OAuth client id, client secret, API key,
or refresh token. Do not start a second Google approval for Tour Core.

Create or find a private folder named `Tour Core`, with `Backups`, `Exports`,
and `Properties`. Do not create a public sharing link. Then call
`confirm_backup_destination`. Tour Core records the destination. It does not
receive your Google token.

## What you say

> Visitor texting is connected. Next I recommend Google Drive so I can keep portable backups and exports of your Tour Core records there.

After the folder exists:

> Google Drive is connected. I've prepared your Tour Core folder.

After the first publish, save a portable backup and say:

> I've also saved a portable backup of this setup to your Google Drive.

If they decline, call `decline_portable_backup`. Operational records stay with
hosted Tour Core.

## What you use it for

- Saving a portable backup into `Tour Core/Backups` (`create_portable_backup`, then `confirm_backup_stored` only after the file is there).
- Saving a readable export into `Tour Core/Exports`. An export is not a backup. On an installation whose records live in Google Drive (`GOOGLE_DRIVE_READY`), the day's `audit-export.json` is written with the records and copied into Drive by the save step. The CSV stays on the Tour Core computer. On a hosted installation (`HOSTED_VOLUME`, Drive used only for backups), day exports stay on the server as 30-minute download links that can be used until they expire. Only readable exports and backups come back as one-time links for the assistant to save into the Tour Core folder in Drive. Door access in a day export is only what was issued or used that day.
- "Open my Tour Core backup." Open the file with the Drive connector. Bookings and access still come from Tour Core tools.
- Restoring a lost installation: download the latest backup, upload it through Tour Core's restore handoff (50 MB by default (TOURCORE_RESTORE_UPLOAD_MAX_BYTES); a larger file is refused with 413 and the cap stated in the message), read the preview, and import only after an explicit yes. An older "mock" verification setting restores as basic-form.

Do not say "Tour Core needs its own Google Drive permission."

## Optional direct Drive

Self-hosted and experimental installs may set `TOURCORE_STORAGE_MODEL=DIRECT_GOOGLE_DRIVE`. That mode uses Tour Core's own Google approval and is not the hosted product path. Follow `begin_google_drive_connect` only when Tour Core's next step names it.
