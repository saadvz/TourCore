# Tour Core Backups

This routine is not enabled for HOSTED_RAILWAY_P0.

Grok's native Google Drive connector runs inside a conversation. A Grok
Routine can wake and call Tour Core (`backup_records`), but there is no
documented way for that routine to upload a file through the Drive connector
and then stay quiet. Shipping a routine that claimed to do so would be fake.

Until a routine can reliably write with the Drive connector:

- Tour Core creates a portable backup when Grok is in a conversation: after
  publish, after a structural or approved-content change, after a completed
  tour, or when the operator asks.
- Grok uploads that file with the Drive connector and only then tells Tour
  Core it was stored.
- A failed backup does not affect a live tour.
- Do not use a backup routine as part of door or access policy.

The intended later behavior, once Drive writes from a routine are real:

- daily
- ask Tour Core whether a backup is due
- generate a snapshot only when it is
- save it to Tour Core/Backups
- stay quiet on success
- tell the operator only if backups keep failing
