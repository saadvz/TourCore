# Demo click path

Hosted demo order for the duplex at 18 Maple Street, from texting through publish. Confirmation codes are replaced with `<confirmation>`.

1. `get_next_installation_step` {} → CHOOSE_MESSAGING_PROVIDER — How would you like prospects to text Tour Core?
2. `choose_messaging_provider` {"provider":"local"} → TEST_VISITOR_MESSAGING — Visitor texting will use the local loopback. No real texts are sent.
3. `get_next_installation_step` {} → TEST_VISITOR_MESSAGING — I'm testing visitor texting.
4. `test_visitor_messaging` {} — Texting is in test mode, so texts don't reach real phones. Real visitors won't get anything until live texting is turned on.
5. `get_next_installation_step` {} → CONFIRM_BACKUP_DESTINATION — Visitor texting is connected. Next I recommend Google Drive so I can keep portable backups and exports of your Tour Core records there.
6. `decline_portable_backup` {} — Operational records stay with hosted Tour Core. Portable backups are off until you connect Google Drive.
7. `get_next_installation_step` {} → SET_UP_PROPERTY — Everything needed to start is connected and tested. Would you like to add your first property?
8. `create_property_setup` {"address":"18 Maple Street, Teaneck, NJ 07666"} — Started 18 Maple Street, Teaneck, NJ 07666. I'm using Eastern time for tours. You can change that anytime. Did I get that right: 18 Maple Street, Teaneck, NJ 07666?
9. `get_next_installation_step` {} → FINISH_PROPERTY_SETUP — Let's finish setting up 18 Maple Street, Teaneck, NJ 07666.
10. `update_property_details` {"property":"prop_18_maple_street_teaneck_nj_07666","confirmAddress":true} — Updated 18 Maple Street. Changes kept as a draft until 3 problems are fixed.
11. `get_next_installation_step` {} → FINISH_PROPERTY_SETUP — Let's finish setting up 18 Maple Street, Teaneck, NJ 07666.
12. `update_property_details` {"property":"prop_18_maple_street_teaneck_nj_07666","propertyType":"MULTIFAMILY_HOME"} — Updated 18 Maple Street. Changes kept as a draft until 2 problems are fixed.
13. `get_next_installation_step` {} → FINISH_PROPERTY_SETUP — Let's finish setting up 18 Maple Street, Teaneck, NJ 07666.
14. `add_unit` {"property":"prop_18_maple_street_teaneck_nj_07666","name":"Unit A"} — Added Unit A with Unit A Door.
15. `add_unit` {"property":"prop_18_maple_street_teaneck_nj_07666","name":"Unit B"} — Added Unit B with Unit B Door.
16. `set_unit_details` {"property":"prop_18_maple_street_teaneck_nj_07666","details":"Unit A is 2 bed 1 bath for $2,200, available now. Unit B is 1 bed 1 bath for $1,950, available October 15."} — Unit A — 2 bed · 1 bath · $2,200/month · available now
Unit B — 1 bed · 1 bath · $1,950/month · available October 15

Does that look right?
17. `add_door` {"property":"prop_18_maple_street_teaneck_nj_07666","name":"Front Door","kind":"entrance"} — Added Front Door.
18. `preview_route` {"property":"prop_18_maple_street_teaneck_nj_07666","unit":"Unit A","doors":["Front Door","Unit A Door"]} — I have: Front Door → Unit A Door. Is that right?
19. `set_route` {"property":"prop_18_maple_street_teaneck_nj_07666","unit":"Unit A","doors":["Front Door","Unit A Door"]} — Saved Unit A: Front Door → Unit A Door.
20. `preview_route` {"property":"prop_18_maple_street_teaneck_nj_07666","unit":"Unit B","doors":["Front Door","Unit B Door"]} — I have: Front Door → Unit B Door. Is that right?
21. `set_route` {"property":"prop_18_maple_street_teaneck_nj_07666","unit":"Unit B","doors":["Front Door","Unit B Door"]} — Saved Unit B: Front Door → Unit B Door.
22. `set_tour_hours` {"property":"prop_18_maple_street_teaneck_nj_07666","days":"weekdays","start":"9am","end":"5pm"} — Monday-Friday, 9:00 AM-5:00 PM. That's up to 8 tours a day.
23. `set_verification_policy` {"property":"prop_18_maple_street_teaneck_nj_07666","level":"basic-form"} — Basic identity form (recommended). Visitors who filled out the form won't be asked again for 30 days.
24. `update_property_details` {"property":"prop_18_maple_street_teaneck_nj_07666","skipVisitorHelp":true} — Updated 18 Maple Street. All changes saved.
25. `review_property_setup` {"property":"prop_18_maple_street_teaneck_nj_07666"} — Setup looks complete.
26. `get_next_installation_step` {} → OFFER_OPERATOR_ALERTS — Your property is configured. Would you like me to keep you updated when someone books, starts or finishes a tour, and alert you if something needs your input?
27. `skip_optional_setup` {"component":"OPERATOR_ALERTS"} → RUN_READINESS — No problem, that's off for now. You can turn it on any time.
28. `get_next_installation_step` {} → RUN_READINESS — Prospects can text your touring number to ask questions, choose a day and time, verify their details, and complete the self-guided tour in the same conversation. I'll run a readiness check and a practice tour before we turn it on.
29. `run_readiness_check` {"property":"prop_18_maple_street_teaneck_nj_07666"} — Everything's ready.
30. `get_next_installation_step` {} → RUN_PRACTICE_TOUR — I'm running a practice tour of 18 Maple Street, Teaneck, NJ 07666. Nobody is texted and no real door opens.
31. `run_dry_tour` {"property":"prop_18_maple_street_teaneck_nj_07666"} — Practice tour passed.
32. `get_next_installation_step` {} → PUBLISH — Everything passed. Would you like me to publish 18 Maple Street, Teaneck, NJ 07666 for demo?
33. `publish_demo_property` {"property":"prop_18_maple_street_teaneck_nj_07666"} — Everything passed. Do you want me to publish 18 Maple Street, Teaneck, NJ 07666 for demo?
34. `publish_demo_property` {"property":"prop_18_maple_street_teaneck_nj_07666","confirmationCode":"<confirmation>"} — 18 Maple Street, Teaneck, NJ 07666 is published for demo. Texting is in test mode, so texts don't reach real phones. Real visitors won't get anything until live texting is turned on. Door access is still in demo mode, so no physical locks will open.
35. `get_installation_status` {} → ADD_ANOTHER_PROPERTY — Your property is published.
