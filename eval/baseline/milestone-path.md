# Milestone demo path

18 Maple Street duplex through the milestone tools. Local texting, backups declined, then property, a skipped alerts step, units, a blocked practice check, the route preview and save, hours, the checks, and publish. Confirmation codes are not included.

1. `set_up_texting` — status done — milestone Backups — next confirm_backup_destination — Texting is in test mode, so texts don't reach real phones. Real visitors won't get anything until live texting is turned on.
2. `decline_portable_backup` — Operational records stay with hosted Tour Core. Portable backups are off until you connect Google Drive.
3. `save_property` — status done — milestone Units, doors, and routes — next save_units — Saved 18 Maple Street, Teaneck, NJ 07666.
4. `save_settings` — status done — milestone Units, doors, and routes — next save_units — Settings: Basic identity form. Tour updates are off for now.
5. `save_units` — status done — milestone Units, doors, and routes — next save_doors_and_routes — Unit A, Unit B
6. `run_checks` — status blocked — milestone Units, doors, and routes — next save_doors_and_routes — code ROUTES_MISSING — This place doesn't have a way through yet, so the practice tour can't run.
7. `save_doors_and_routes` — status next — milestone Units, doors, and routes — next save_doors_and_routes — I have: Unit A: Front Door → Unit A Door. Unit B: Front Door → Unit B Door. Nothing was saved.
8. `save_doors_and_routes` — status done — milestone Practice tour — next run_checks — Unit A: Front Door → Unit A Door. Unit B: Front Door → Unit B Door
9. `save_hours` — status done — milestone Practice tour — next run_checks — Tours are MON, TUE, WED, THU, FRI from 09:00 to 17:00.
10. `run_checks` — status done — milestone Publish — next publish — The check passed, and the practice tour passed.
11. `publish` — status next — milestone Publish — next publish — Everything passed. Do you want me to publish 18 Maple Street, Teaneck, NJ 07666 for demo?
12. `publish` — status done — milestone Setup — next get_state — 18 Maple Street, Teaneck, NJ 07666 is published for demo. Texting is in test mode, so texts don't reach real phones. Real visitors won't get anything until live texting is turned on. Door access is still in demo mode, so no physical locks will open.
