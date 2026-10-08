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

[`get_next_installation_step` → CHOOSE_MESSAGING_PROVIDER]

**Tour Core:** How would you like prospects to text Tour Core?

Sendblue. Managed messaging with iMessage/SMS support. Sandbox and
dedicated-line behavior may differ.

Twilio. Dedicated SMS messaging with low usage cost. Carrier registration may
be required depending on country and use case.

Photon. Agent-focused messaging through Photon/Spectrum with iMessage
support. Available capabilities depend on the provisioned Photon line/account.

**Operator:** Sendblue.

[`choose_messaging_provider` sendblue → CONNECT_VISITOR_MESSAGING]

**Tour Core:** Sendblue needs your API key, API secret, and messaging number.
I'll ask for them securely; they won't be shown to me in chat.

[Grok secure secret input. Grok fills and submits Tour Core's form. The
operator does not open a page.]

[`get_next_installation_step` → TEST_VISITOR_MESSAGING → `test_visitor_messaging`
→ continue]

**Tour Core:** Visitor texting is connected and working. Everything needed to
start is connected and tested. Would you like to add your first property?

---

## Part 2: Set up a property

**Operator:** Yes.

**Tour Core:** What's the property address?
[`list_properties`]

**Operator:** 144 Hillside Ave, Teaneck NJ.

[`create_property_setup` address "144 Hillside Ave, Teaneck NJ" (no name: the
operator didn't give one) → nextQuestion "What ZIP code should I use?"]

**Tour Core:** What ZIP code should I use?

**Operator:** 07666.

[`update_property_details` postalCode "07666" → read the address back]

**Tour Core:** I have:
144 Hillside Ave
Teaneck, NJ 07666
Is that the address?

**Operator:** Yes.

[`update_property_details` confirmAddress true → "What type of property is this?"]

**Tour Core:** What type of property is this: a single-family home, a
multifamily home (duplex or small building you own), or an apartment or
condo (one unit)?

**Operator:** A multifamily — I own the small building.

[`update_property_details` propertyType MULTIFAMILY_HOME → nextQuestion
"Which units can people tour?"]

**Tour Core:** Which units can people tour?

**Operator:** 1A and 1B.

[`add_unit` "Unit 1A"; `add_unit` "Unit 1B"]

**Tour Core:** Added Unit 1A and Unit 1B, each with its own door. How many
bedrooms and bathrooms does each have, and what's the rent?

**Operator:** 1A is 2 bed 1 bath for $2,300. 1B is 1 bed 1 bath for $1,950.

[`set_unit_details` details "1A is 2 bed 1 bath for $2,300. 1B is 1 bed 1 bath
for $1,950." → nextQuestion "When are these units available?"]

**Tour Core:** When are these units available?

**Operator:** 1A now, 1B October 15.

[`set_unit_details` units 1A availability "now", 1B availability "October 15"]

**Tour Core:** Here's what I have:
Unit 1A — 2 bed · 1 bath · $2,300/month · available now
Unit 1B — 1 bed · 1 bath · $1,950/month · available October 15
Does that look right?

**Operator:** Yes.

**Tour Core:** Which door do visitors come in through?

**Operator:** The main entrance.

[`add_door` "Main Entrance", entrance]

**Tour Core:** Any hallway or inside doors between the main entrance and the
units?

**Operator:** No, the units are right off the lobby.

[`preview_route` Unit 1A: "main entrance", "unit door"; same for Unit 1B]

**Tour Core:** I have:
Unit 1A: Main Entrance → Unit 1A Door
Unit 1B: Main Entrance → Unit 1B Door
Is that right?

**Operator:** Yep.

[`set_route` for each unit with the exact door names]

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

[`set_verification_policy` basic-form. Texting isn't asked about: the property
already uses the installed touring number, which covers every property.
`review_property_setup`]

**Tour Core:** Here's what I have:
144 Hillside Ave, Teaneck NJ
Multifamily (duplex / small building you own)

Unit 1A
2 bed · 1 bath · $2,300/month · available now
Route: Main Entrance → Unit 1A Door

Unit 1B
1 bed · 1 bath · $1,950/month · available October 15
Route: Main Entrance → Unit 1B Door

Tours: Monday-Friday, 9:00 AM-5:00 PM
Verification: Basic identity form
Visitor texting: Connected
Door access: Demo

Does that look right?

**Operator:** Yes.

[`get_next_installation_step` → OFFER_OPERATOR_ALERTS]

**Tour Core:** Want me to text you when someone books, starts, or finishes a tour, and ping you the moment something needs you?

**Operator:** Sure.

[`set_notification_preferences` preset recommended]

**Tour Core:** I'm setting up your tour updates.

[Creates the Tour Core Operator Updates routine; `get_secure_setup_url` step
operator-alerts, opened next to the routine's trigger panel. The panel shows
the address on screen, so Grok doesn't move it and hands the browser over.]

**Tour Core:** I'll ask for the tour-update connection details securely; they
won't be shown in chat.

[Secure secret input. Grok submits them. Only if those values are visibly
shown on screen, and secure input cannot take them, does Grok say the normal
collection could not be used.]

**Operator:** Done.

[`get_next_installation_step` → TEST_OPERATOR_ALERTS → `test_operator_alerts`.
The routine wakes with `installation.test` and posts:]

**Tour Core:** Tour updates are connected. I'll let you know about your tours
here.

[`get_next_installation_step` → RUN_READINESS]

**Tour Core:** Prospects can text your touring number to ask questions, choose
a unit and time, verify their details, and complete the self-guided tour in
the same conversation. I'll run a readiness check and a practice tour before
we turn it on.
[`run_readiness_check`]

✓ Property details
✓ Tour hours
✓ Unit routes
✓ Verification
✓ Visitor messaging connected
✓ Records
✓ Tour progress can be safely saved
✓ Door access
✓ Audit/export

[`run_dry_tour`]

Practice tour passed:
✓ Booking worked
✓ Verification worked
✓ Early arrival was denied
✓ Entrance access was allowed at the right time
✓ Unit 1A access was allowed
✓ Unit 1B Door (not on the route) was turned away before any door was unlocked
✓ A repeated request didn't create a second access grant
✓ Tour completed
✓ Follow-up worked

[`publish_demo_property` → returns a question]

**Tour Core:** Everything passed. Would you like me to publish 144 Hillside Ave
for demo?

**Operator:** Yes.

[`publish_demo_property` with confirmationCode]

**Tour Core:** Your property is published. Visitor texting is live. Door
access is still in demo mode, so no physical locks will open. I'll keep you
updated on your tours and let you know when something needs your attention.

---

## Part 3: Tour updates (nobody asked)

[A visitor, Testy, books Unit 1A by text. Tour Core wakes the Tour Core
Operator Updates routine with only an event id and `tour.booked`. The routine
calls `get_operator_update`.]

**Tour Core:** New tour booked: Testy is scheduled to tour Unit 1A today at
3:00 PM.

[Later: `tour.started`.]

**Tour Core:** Testy's Unit 1A tour has started.

[Inside, Testy texts "Is there a pool?". Tour Core replies "I'll pass your
question to the property team, and they'll reply here as soon as they can." and sends `exception.created`. The
routine calls `get_operator_update`.]

**Tour Core:** Testy, touring Unit 1A, asked whether the property has a pool.
Tour Core doesn't have that yet. The tour is still active. What should I tell
them?

**Operator:** No pool, but there's a gym on the roof.

[`answer_flagged_question` approvedFact "There's no pool, but there's a gym on
the roof." → returns a question]

**Tour Core:** Send this to Testy and save it for anyone who asks the same thing later? "There's no pool, but there's a gym on the roof. Let me know if you have any other questions."

**Operator:** Yes.

[`answer_flagged_question` with confirmationCode. Testy gets the answer, then
Tour Core puts their tour step back in front of them.]

[Later: `tour.completed`.]

**Tour Core:** Testy's Unit 1A tour is complete.

---

## Set up a tour someone asked for

**Operator:** Dana asked for a tour of 1A on Monday at 3:15. Her number is
555-010-2000. Set that up.

[`schedule_one_off_tour` → question]

**Tour Core:** Set up a tour for Dana at Unit 1A on Monday at 3:15 PM? Only
say yes if they asked for this tour. Dana gets a text to confirm. Book it?

**Operator:** Yes.

[`schedule_one_off_tour` with confirmationCode]

**Tour Core:** I texted Dana to confirm a tour of Unit 1A on Monday at
3:15 PM. The regular tour times are unchanged.

---

## If readiness fails

**Tour Core:** Almost there. One thing: Unit 1B doesn't have a complete route
yet. Want me to set it up the same as Unit 1A (Main Entrance → Unit 1B Door)?

**Operator:** Yes.

[`preview_route` → show → `set_route` → `run_readiness_check` again]
