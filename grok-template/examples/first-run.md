# First-run conversation (safe example)

A made-up property and visitor. Tool calls are shown in brackets; the operator
never sees them.

---

**Operator:** I want to set up my building.

**Tour Core:** Sure. What's the address?
[`list_properties`]

**Operator:** 100 Alfred Way, Brooklyn.

[`create_property_setup` address "100 Alfred Way, Brooklyn", name "100 Alfred Way"]

**Tour Core:** Got it. I've set 100 Alfred Way to Eastern Time. Right?

**Operator:** Yes.

**Tour Core:** How many units can people self-tour, and what are they called?

**Operator:** Two. 101 is a one-bedroom and 102 is a two-bedroom.

[`add_unit` "Unit 101", description "One-bedroom"; `add_unit` "Unit 102", description "Two-bedroom"]

**Tour Core:** Added Unit 101 and Unit 102, each with its own door. Which door
do visitors come in through?

**Operator:** The lobby entrance.

[`add_door` "Lobby Entrance", entrance]

**Tour Core:** Any hallway or inside doors between the lobby and the units?

**Operator:** No, the units are right off the lobby.

[`preview_route` Unit 101: "lobby entrance", "unit door"; same for Unit 102]

**Tour Core:** I have:
Unit 101: Lobby Entrance → Unit 101 Door
Unit 102: Lobby Entrance → Unit 102 Door
Is that right?

**Operator:** Yep.

[`set_route` Unit 101 ["Lobby Entrance", "Unit 101 Door"]; `set_route` Unit 102 ["Lobby Entrance", "Unit 102 Door"]]

**Tour Core:** When can people tour?

**Operator:** Weekdays, 9 to 5.

[`set_tour_hours` days "weekdays", start "9", end "5"]

**Tour Core:** Done: weekdays, 9 AM–5 PM. Tours last 45 minutes, a new one can
start every hour, and visitors can get in up to 10 minutes early. Want to
change any of that?

**Operator:** No, that's fine.

**Tour Core:** How would you like visitors to verify who they are? I'd suggest
the basic identity form (free): they give their legal name, email and phone
before the tour. Or practice verification, where everyone passes, just for
trying things out.

**Operator:** Basic form.

[`set_verification_policy` basic-form]

**Tour Core:** How do you want to text people? For the demo I'd use real texts
through Sendblue.

**Operator:** Sendblue.

[`set_services` messaging sendblue; `get_services`]

**Tour Core:** Where should I keep the tour records? Right now they're kept on
the Tour Core computer; Google Drive is coming next.

**Operator:** That's fine.

[`review_property_setup`]

**Tour Core:** Here's what I have:
100 Alfred Way
2 tourable units
Lobby Entrance
Weekdays, 9 AM–5 PM
Basic visitor verification
Sendblue visitor messaging

Does that look right?

**Operator:** Yes.

**Tour Core:** Great. I'll check the setup and run a practice tour before
publishing.
[`run_readiness_check`]

✓ Property details
✓ Tour hours
✓ Unit routes
✓ Verification
✓ Visitor messaging connected
✓ Records
✓ Tour progress can be safely saved
✓ Durin access
✓ Audit/export

[`run_dry_tour`]

Practice tour passed:
✓ Booking worked
✓ Verification worked
✓ Early arrival was denied
✓ Entrance access was allowed at the right time
✓ Unit 101 access was allowed
✓ Unit 102 Door (not on the route) was denied before Durin was contacted
✓ A repeated request didn't create a second access grant
✓ Tour completed
✓ Follow-up worked

[`publish_demo_property` → returns a question]

**Tour Core:** Everything passed. Do you want me to publish 100 Alfred Way for
demo?

**Operator:** Yes.

[`publish_demo_property` with confirmationCode]

**Tour Core:** 100 Alfred Way is published for demo. Visitors can text the
property number to start a tour.

---

## If readiness fails

**Tour Core:** Almost there. One thing: Unit 102 doesn't have a complete route
yet. Want me to set it up the same as Unit 101 (Lobby Entrance → Unit 102
Door)?

**Operator:** Yes.

[`preview_route` → show → `set_route` → `run_readiness_check` again]
