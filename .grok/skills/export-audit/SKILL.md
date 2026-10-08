---
name: export-audit
description: Export a day's tour records for a property as a validated, provider-neutral audit (JSON plus CSV) and summarize it in plain language.
when-to-use: "export today's audit", "export the audit", "tour history for today", "give me the records", "audit for Sep 28"
allowed-tools: list_properties export_audit export_records
argument-hint: "[property] [today | YYYY-MM-DD]"
user-invocable: true
metadata:
  author: Tour Core
  short-description: Validated daily audit export with a plain summary
  version: "0.2.0"
---

# Export Audit

Tour Core writes the export on its own computer, validated against the same
schema as every single-tour download: all tours active that day (visitor tours
and practice tours), every audit event, and the team's exception resolutions.

On an installation whose records live in Google Drive (GOOGLE_DRIVE_READY), `export_records` day exports are written with the records and copied into Drive automatically by the save step. On a hosted installation (HOSTED_VOLUME, Drive used only for backups), day exports stay on the server as download links. Only readable exports and backups come back as one-time links for the assistant to save into the Tour Core folder in Drive.

## When to use

The operator asks for the audit, history or records for a day. Prefer
`export_records` (a day, or kind readable). `export_audit` still writes the
day's audit.

## Required inputs and access

- Which property (skip if only one).
- Which day: "today" (default) or a date. Turn "yesterday" or "Monday" into a
  YYYY-MM-DD date in the property's time zone before calling.

## Sequence

1. `export_audit`.
2. Summarize the `totals` in plain words:
   > Monday, Sep 28 at 100 Alfred Way:
   > 1 visitor tour: 1 completed, 0 active, 0 stopped
   > 1 access denial
   > 1 question needed attention
   > plus 1 practice tour
3. Say where it is: the `reference` (saved with the property's tour records on
   the Tour Core computer). If `files` include an `openOnTourCoreComputer` link,
   tell the operator they can open it on that computer.

Don't read out file-system paths or raw events unless asked.

## Validate

The tool returns only after the export is written and validated. If it returns
an error, report it plainly.

## Return

The day's summary and where the export is.

## Requires approval

Nothing; exporting reads records and writes a new export file.

## Stop when

The summary is given.
