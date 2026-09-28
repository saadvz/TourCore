# First-run conversation (safe example)

A made-up property and visitor. Tool calls and computer actions are shown in
brackets; the operator never sees them.

---

## Part 1: Set up Tour Core

**Operator:** Set up Tour Core.

**Tour Core:** I'll handle the technical setup and only ask when I need a
login, approval or decision.

[Cloud computer: clone the canonical repository → read `GROK_BOOTSTRAP.md` →
`npm run bootstrap:grok`. Add the Tour Core connection; open the approval
screen in the cloud browser.]

**Tour Core:** Tour Core is installed and running. I need your approval to
connect to it. I've opened the approval screen. Check that the codes match and
click Allow.

[Operator takes over the browser and clicks Allow.]

**Tour Core:** Connected. I'm checking the rest of the setup now.

[`get_installation_status`, `get_next_installation_step` →
CONNECT_VISITOR_MESSAGING. `get_secure_setup_url` step visitor-messaging,
opened in the cloud browser.]

**Tour Core:** Visitor texting is the next step. I've opened Tour Core's secure
setup page so you can connect your Sendblue messaging account there, not in
chat.

**Operator:** Done.

[`get_next_installation_step` → TEST_VISITOR_MESSAGING → `test_visitor_messaging`
→ `get_next_installation_step` → SET_UP_PROPERTY]

**Tour Core:** Visitor texting is connected and working. Everything needed to
run Tour Core is connected and tested. Would you like to add your first
property?

---

## Part 2: Set up a property

**Operator:** Yes.

**Tour Core:** What's the property address?
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

[`set_services` messaging sendblue (texting is already connected); `review_property_setup`]

**Tour Core:** Here's what I have:
100 Alfred Way
2 tourable units
Lobby Entrance
Weekdays, 9 AM–5 PM
Basic visitor verification
Sendblue visitor messaging

Does that look right?

**Operator:** Yes.

[`get_next_installation_step` → OFFER_OPERATOR_ALERTS]

**Tour Core:** Your property is configured. Would you like me to keep an eye
on tours and let you know when a visitor needs help or Tour Core needs your
input? I recommend it.

**Operator:** Sure.

**Tour Core:** I'm setting up alerts so I can notify you when a visitor needs
your input.

[Creates the Tour Core Exception Alert routine; `get_secure_setup_url` step
operator-alerts, opened in the cloud browser.]

**Tour Core:** I've created the alert. I opened Tour Core's secure setup page
so you can finish connecting it without putting any credentials in chat.

**Operator:** Done.

[`get_next_installation_step` → TEST_OPERATOR_ALERTS → `test_operator_alerts`
→ RUN_READINESS]

**Tour Core:** Alerts are working. Prospects can text your touring number to
choose a unit and time, verify their details, and complete the self-guided
tour in the same conversation. I'll run a readiness check and a practice tour
before we turn it on.
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

**Tour Core:** Everything passed. Would you like me to publish 100 Alfred Way
for demo?

**Operator:** Yes.

[`publish_demo_property` with confirmationCode]

**Tour Core:** Your property is live for demo. I'll keep an eye on tours and
let you know when something needs your attention.

---

## Part 3: A visitor needs you (nobody asked)

[A visitor texts "Is there a pool?". Tour Core answers them right away that it
doesn't have that information, records the question, and wakes the Tour Core
Exception Alert routine with only the issue reference. The routine calls
`inspect_exception`.]

**Tour Core:** A visitor touring Unit 101 asked whether the property has a
pool. Tour Core doesn't have an approved answer. The tour is still active.
Would you like to add an approved answer or leave it for the property team?

**Operator:** No pool. Say "There's no pool, but there's a gym on the roof."

[`answer_flagged_question` → returns a question]

**Tour Core:** I can add "There's no pool, but there's a gym on the roof." to
the approved facts for 100 Alfred Way and answer Pat. Want me to?

**Operator:** Yes.

---

## If readiness fails

**Tour Core:** Almost there. One thing: Unit 102 doesn't have a complete route
yet. Want me to set it up the same as Unit 101 (Lobby Entrance → Unit 102
Door)?

**Operator:** Yes.

[`preview_route` → show → `set_route` → `run_readiness_check` again]
