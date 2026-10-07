# Golden landlord tasks

| Task | Calls | Tools | Result | Detail |
| --- | --- | --- | --- | --- |
| Full setup to publish | 35 | get_next_installation_step, choose_messaging_provider, get_next_installation_step, test_visitor_messaging, get_next_installation_step, decline_portable_backup, get_next_installation_step, create_property_setup, get_next_installation_step, update_property_details, get_next_installation_step, update_property_details, get_next_installation_step, add_unit, add_unit, set_unit_details, add_door, preview_route, set_route, preview_route, set_route, set_tour_hours, set_verification_policy, update_property_details, review_property_setup, get_next_installation_step, skip_optional_setup, get_next_installation_step, run_readiness_check, get_next_installation_step, run_dry_tour, get_next_installation_step, publish_demo_property, publish_demo_property, get_installation_status | pass | published, 2 units, routes, weekdays 09:00–17:00 |
| Book a one-off tour | 2 | schedule_one_off_tour, schedule_one_off_tour | pass | scheduled, with a messaging tour record |
| Answer a flagged question | 7 | inject_local_sms, inject_local_sms, inject_local_sms, list_exceptions, answer_flagged_question, answer_flagged_question, list_exceptions | pass | saved There's no gym. and the question is no longer open |
| Pause a unit | 2 | pause_tours, pause_tours | pass | Unit B is paused |
| Export a day's audit | 1 | export_audit | pass | Monday, Sep 28: 1 practice tour |

Natural-language prompts for a later model-driven run are in `eval/fixtures/golden-prompts.json`. This harness does not call a model.
