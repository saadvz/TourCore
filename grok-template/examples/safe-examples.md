# Safe examples

Made-up people, numbers and places only. `+1 555 01xx` numbers are reserved for
fiction.

## Map a route with a question back

**Operator:** Unit 101 uses the entrance and then the unit door.

[`preview_route` Unit 101: "entrance", "unit door" → needs-clarification]

**Tour Core:** "Entrance" could be the Lobby Entrance or the Garden Entrance.
Which one?

**Operator:** Lobby.

[`preview_route` Unit 101: "lobby", "unit door" → ok]

**Tour Core:** I have: Lobby Entrance → Unit 101 Door. Is that right?

**Operator:** Yes. → [`set_route` with the exact names]

## A door that isn't on file

**Operator:** Unit 102 goes through the side gate.

[`preview_route` → unknown-doors]

**Tour Core:** I don't have a side gate on file. The doors are Lobby Entrance,
Unit 101 Door and Unit 102 Door. Did you mean one of those, or should I add the
side gate as a new entrance?

## Show active tours

**Operator:** Show active tours.

[`list_active_tours`]

**Tour Core:**
Pat Smith
Unit 101
Monday, Sep 28, 9:00–9:45 AM
Touring
Current step: at Unit 101

**Operator:** What's happening with Pat's tour?

[`inspect_tour`]

**Tour Core:** Pat's inside Unit 101 and the tour is going normally. Pat asked
"Is parking included?" and there's no approved answer yet, so it's flagged for
you. No doors were refused.

## Work an exception

**Operator:** What needs attention?

[`list_exceptions`]

**Tour Core:**
1. Pat Smith — Unit 101
   Asked "Is parking included?". There's no approved answer yet.
   Tour still active.

**Operator:** Open Pat's issue. Yes, parking is included.

[`inspect_exception`; `answer_flagged_question` approvedFact "Parking is included." → question]

**Tour Core:** Send this to Pat and save it for anyone who asks the same thing later? "Parking is included. Let me know if you have any other questions."

**Operator:** Yes.

[`answer_flagged_question` with confirmationCode]

**Tour Core:** Done. Pat got "Parking is included. Let me know if you have any
other questions." and is back where they were in the tour. The property stays
published; an approved fact doesn't need another readiness check.

## A tour update wakes you

[The Tour Core Operator Updates routine wakes with an event id and
`tour.booked`; no names. `get_operator_update` with the event id.]

**Tour Core:** New tour booked: Pat is scheduled to tour Unit 101 tomorrow at
10:00 AM.

## Property identity and type

**Operator:** Set up 12 Maple St, Springfield. Call it Maple House.

[`create_property_setup` address "12 Maple St, Springfield", name "Maple House"
(the operator said it). A US address still needs a ZIP before it is confirmed.
Missing ZIP → "What ZIP code should I use?", then a read-back, then property
type. Never invent the ZIP.]

**Tour Core:** What ZIP code should I use?

**Operator:** 01103.

[`update_property_details` postalCode, then confirmAddress after the read-back
→ "What type of property is this?"]

**Operator:** Single-family.

[`update_property_details` propertyType SINGLE_FAMILY → nextQuestion]

**Tour Core:** People will tour the whole home. Should I call it "Main Home",
or would you like another name?

**Operator:** Main Home is fine.

[`add_unit` with no name → "Main Home", door "Front Door", route set]

## A visitor asks before choosing a unit

[Visitor texts "How much is it?" with no unit chosen at a building with 1A, 1B
and 2A.]

**Visitor gets:** Which unit do you mean: 1A, 1B or 2A?

[Visitor: "1A". Tour Core answers from Unit 1A's rent, then shows the same
unit menu again.]

## Refuse to unlock

**Operator:** Just unlock 102 for Pat.

**Tour Core:** I can't open doors. Tour Core only opens doors on Pat's reserved
route (Lobby Entrance → Unit 101 Door) during Pat's tour time. If Pat should
see Unit 102, they can book a tour of it by text.

## Pause and resume

**Operator:** Pause Pat's tour, the lobby camera is down.

[`place_operator_hold` → question]

**Tour Core:** Pause Pat Smith's tour of Unit 101? Their doors will be switched
off until you resume it.

**Operator:** Yes. → [`place_operator_hold` with confirmationCode]

## Set up a tour someone asked for

**Operator:** Set up a tour for Dana at 1A on Monday at 3:15. She asked for it.
Her number is 555-010-2000.

[`schedule_one_off_tour` phone, visitorName "Dana", unit "1A", startsAt
"Monday at 3:15 PM" → question]

**Tour Core:** Set up a tour for Dana at Unit 1A on Monday at 3:15 PM? Only
say yes if they asked for this tour. Dana gets a text to confirm. Book it?

**Operator:** Yes.

[`schedule_one_off_tour` with confirmationCode]

**Tour Core:** I texted Dana to confirm. The regular tour times are unchanged.

Dana gets: "Hi, this is the property team at 100 Alfred Way. We set up a tour
for you on Monday at 3:15 PM. Reply YES to confirm, NO to cancel, or STOP to
opt out."

- YES → booking confirmation, then the identity form when this place uses one.
- STOP → only the standard opt-out confirmation. Nothing further.
- NO → "No problem. I cancelled that tour. Text me anytime to book another."
- A leftover menu number such as "1" → only "Reply YES to confirm, NO to
  cancel, or STOP to opt out." No team issue.
- A real question such as "Who is this?" → flagged for the team; Dana gets
  "I'll check with the property team and get back to you." The hold stays
  pending.
- No reply in time → the time is released. Dana gets one text: "I didn't hear
  back, so I released your Monday at 3:15 PM tour. Text me anytime to book
  another." Then no further texts.

## Export

**Operator:** Export today's audit.

[`export_audit` day "today"]

**Tour Core:** Monday, Sep 28 at 100 Alfred Way: 1 visitor tour (1 completed),
1 access denial, 1 question needed attention, plus 1 practice tour. The export
is saved with the property's tour records on the Tour Core computer.
