---
name: backup-tour-core
description: Save a portable Tour Core backup or a readable export to the operator's Google Drive, or restore a backup onto a clean Tour Core, using Tour Core's tools and Grok's Google Drive connector.
when-to-use: "back up Tour Core", "save a backup", "restore Tour Core", "open my Tour Core backup", "export my tours", "is a backup due"
allowed-tools: backup_records restore_records export_records
argument-hint: "[backup | export | restore]"
user-invocable: true
metadata:
  author: Tour Core
  short-description: Portable backups and readable exports through Google Drive
  version: "0.1.0"
---

# Backup Tour Core

Call only `backup_records`, `restore_records`, and `export_records`.

Tour Core keeps live records itself. Google Drive, through your built-in
connector, is where portable backups and readable exports are saved. You do
not decide access, and a failed backup never stops a tour.

Prefer `backup_records` for create, confirm_destination, confirm_stored,
status, and decline, and `restore_records` for upload, preview, and import.
Import asks first, and replacing records that are already here needs an
explicit yes to replacement. On a demo, `backup_records` with `action: decline`
keeps records on this computer.

## When to use

The operator asks for a backup, a restore, or an export. Also after the first
property is published, after a structural republish, after an approved content
change, or after a completed tour, when `backup_records` with `action: status` says a backup is
due. Do not back up on every text message.

## Required inputs and access

- Tour Core is connected.
- Your built-in Google Drive connector, already approved by the operator.
  Reuse it if it is connected. Never ask for a Google password, client id,
  client secret, API key, or refresh token.
- A private folder named Tour Core, with Backups, Exports, and Properties.
  Do not create a public sharing link.

## Sequence

### Save a backup

Say:

> I'll save a portable Tour Core backup to your Google Drive.

1. `backup_records` with `action: create`.
2. Download the handoff once. Do not show that link to the operator, and do
   not paste the file into chat.
3. Upload it with the Google Drive connector to Tour Core/Backups.
4. Confirm the file is there.
5. `backup_records` with `action: confirm_stored`, and the file name and checksum from step 1.
   The checksum is the SHA-256 of the backup's `contents`, as compact JSON with sorted keys, and it is stored in the file's `checksum` field, so a hash of the whole downloaded file won't match.
6. Say:

> Your Tour Core backup is saved in Google Drive.

If the upload fails, say so. Do not call `backup_records` with `action: confirm_stored`. The property
and any tour in progress stay as they are.

### Save an export

Exports are for people to read. They are not backups.

1. For a readable export, `export_records` with kind `readable`.
2. Upload that file to Tour Core/Exports with the Google Drive connector.
3. Say you saved the export. Do not describe it as the live booking record.

On an installation whose records live in Google Drive (GOOGLE_DRIVE_READY), the day's audit-export.json is written with the records and copied into Drive by the save step. The CSV stays on the Tour Core computer. On a hosted installation (HOSTED_VOLUME, Drive used only for backups), day exports stay on the server as 30-minute download links that can be used until they expire. Only readable exports and backups come back as one-time links for the assistant to save into the Tour Core folder in Drive. Door access in a day export is only what was issued or used that day. Each embedded tour in that JSON is trimmed to that day's events and grants.

### Restore

1. Find the latest file in Tour Core/Backups with the Google Drive connector.
2. `restore_records` with `action: upload`, then upload that file to the handoff. Do not paste
   the JSON into chat. The upload note tells you to upload the file to that
   address. A backup up to 50 MB is accepted. If the upload is refused, say
   the limit from the message (413). Do not describe that refusal as a lost
   connection. Every expired upload, including a second look and a file that arrived before the link expired, says to send the file again. Start a new
   upload with `restore_records`, `action: upload`. "Upload the backup file first, then I can show you what's in it." is only for a live link with no file. An older ID check is named in the import summary: it now uses the basic identity form, and the landlord can ask for no form.
3. `restore_records` with `action: preview` and read the preview aloud:

> Backup contains:
> 1 property
> 4 tourable units
> 18 tour records

4. Ask before importing. If Tour Core says it already has records, stop unless
   the operator explicitly chooses to replace them. There is no merge.
5. `restore_records` with `action: import` and the confirmation it returns. Pass
   `recovery: replace` only after that explicit choice.
6. Read the reconnect lines. Provider logins are not in the backup. Guide the
   operator through visitor texting and tour updates again when those lines
   say reconnect is required.

## Validate

- Do not say the backup is in Google Drive until `backup_records` with `action: confirm_stored`
  succeeds. Tour Core cannot see Drive on its own.
- Reject a file Tour Core says is malformed, was changed or damaged, or uses an
  unsupported format. Do not import it. Say Tour Core's own words. The checksum is the SHA-256 of the backup's `contents`, as compact JSON with sorted keys, and it is stored in the file's `checksum` field, so a hash of the whole downloaded file won't match.
- A readable export must not be imported as a backup.

## Return

One or two plain sentences, such as "Your Tour Core backup is saved in Google
Drive." or the restore preview followed by what has to be reconnected.

## Requires approval

Connecting Google Drive the first time, and an explicit yes before a restore.
Replacing records that are already on this Tour Core needs a separate explicit
choice.

## Stop when

- The backup is confirmed stored, or the operator has the preview they asked
  to see.
- Drive is not connected: offer to connect it, and do not pretend a file was
  saved.
- Tour Core refuses the file or the restore.
- The operator does not agree to replace existing records.

## Routine

A daily Tour Core Backups routine is not part of this P0 setup. Grok Routines
can call Tour Core, but saving a file still needs the Google Drive connector
inside a conversation. Do not claim a routine wrote to Drive. Use the steps
above when a backup is due, or when the operator asks. The routine must not
be used for door or access decisions.
