# Safe examples

Made-up people, numbers and places only. `+1 555 01xx` numbers are reserved for
fiction.

## Map a route with a question back

**Operator:** Unit 101 uses the entrance and then the unit door.

[`save_doors_and_routes` Unit 101: "entrance", "unit door" → needs-clarification]

**Tour Core:** "Entrance" could be the Lobby Entrance or the Garden Entrance.
Which one?

**Operator:** Lobby.

[`save_doors_and_routes` Unit 101: "lobby", "unit door" → ok]

**Tour Core:** I have: Lobby Entrance → Unit 101 Door. Is that right?

**Operator:** Yes. → [`save_doors_and_routes` with the exact names]

## A door that isn't on file

**Operator:** Unit 102 goes through the side gate.

[`save_doors_and_routes` → unknown-doors]

**Tour Core:** I don't have a side gate on file. The doors are Lobby Entrance,
Unit 101 Door and Unit 102 Door. Did you mean one of those, or should I add the
side gate as a new entrance?

## Show active tours

**Operator:** Show active tours.

[`get_tours`]

**Tour Core:**
Pat Smith
Unit 101
Monday, Sep 28, 9:00–9:45 AM
Touring
Current step: at Unit 101

**Operator:** What's happening with Pat's tour?

[`get_tours`]

**Tour Core:** Pat's inside Unit 101 and the tour is going normally. Pat asked
"Is parking included?" and there's no approved answer yet, so it's flagged for
you. No doors were refused.

## Work an exception

**Operator:** What needs attention?

[`get_inbox`]

**Tour Core:**
1. Pat Smith — Unit 101
   Asked "Is parking included?". There's no approved answer yet.
   Tour still active.

**Operator:** Open Pat's issue. Yes, parking is included.

[`get_inbox`; `resolve_issue` approvedFact "Parking is included." → question]

**Tour Core:** Send this to Pat and save it for anyone who asks the same thing later? "Parking is included. Let me know if you have any other questions."

**Operator:** Yes.

[`resolve_issue` with confirmationCode]

**Tour Core:** Done. Pat got "Parking is included. Let me know if you have any
other questions." and is back where they were in the tour. The property stays
published; an approved fact doesn't need another readiness check.

## A tour update wakes you

[The Tour Core Operator Updates routine wakes with an event id and
`tour.booked`; no names. `get_inbox` with the event id.]

**Tour Core:** New tour booked: Pat is scheduled to tour Unit 101 tomorrow at
10:00 AM.

## Property identity and type

**Operator:** Set up 12 Maple St, Springfield. Call it Maple House.

[`save_property` address "12 Maple St, Springfield", name "Maple House"
(the operator said it). Ask for one missing part at a time and keep every
part already given. A missing street is "What's the street address?". A
missing state is "What state is it in?" before any city question. A city
given while the state is still missing is kept: "Got it. What state is that
in?". "What city should I use?" only after the street and state are saved.
Missing ZIP → "What ZIP code should I use?", then a one-line read-back ("Did
I get that right: ...?"), then property type. A street on its own keeps its
suffix. No time zone line until a state is known. When a question follows a guess: "I'm using Eastern time for tours. You can change that anytime. What ZIP code should I use?" "Want a different one?" is only when nothing follows the guess. A guessed time zone updates only before the address is confirmed, and
never on a property that was published or already had a confirmed address or
an operator-set zone. Never invent a part.]

**Tour Core:** What state is it in?

**Operator:** Massachusetts.

[`save_property` state "Massachusetts". Springfield stays the city.]

**Tour Core:** What ZIP code should I use?

**Operator:** 01103.

[`save_property` postalCode, then confirmAddress after the read-back
→ "What type of property is this?"]

**Operator:** Single-family.

[`save_property` propertyType SINGLE_FAMILY → nextQuestion]

**Tour Core:** People will tour the whole home. Should I call it "Main Home",
or would you like another name?

**Operator:** Main Home is fine.

[`save_units` with no name → "Main Home", door "Front Door", route set]

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

[`hold_tour` → question]

**Tour Core:** Pause Pat Smith's tour of Unit 101? Their doors will be switched
off until you resume it.

**Operator:** Yes. → [`hold_tour` with confirmationCode]

## Set up a tour someone asked for

**Operator:** Set up a tour for Dana at 1A on Monday at 3:15. She asked for it.
Her number is 555-010-2000.

[`schedule_tour` phone, visitorName "Dana", unit "1A", startsAt
"Monday at 3:15 PM" → question]

**Tour Core:** Set up a tour for Dana at Unit 1A on Monday at 3:15 PM? Only
say yes if they asked for this tour. Dana gets a text to confirm. Book it?

**Operator:** Yes.

[`schedule_tour` with confirmationCode]

**Tour Core:** I texted Dana to confirm. The regular tour times are unchanged.

Dana gets: "Hi, this is the {team} at 100 Alfred Way. We set up a tour
for you on Monday at 3:15 PM. Reply YES to confirm, NO to cancel, or STOP to
opt out."

- YES → booking confirmation, then the identity form when this place uses one.
- STOP → only the standard opt-out confirmation. Nothing further.
- NO → "No problem. I cancelled that tour. Text me anytime to book another."
- A leftover menu number such as "1" → only "Reply YES to confirm, NO to
  cancel, or STOP to opt out." No team issue.
- A real question such as "Who is this?" → flagged for the team; Dana gets
  "I'll check with the {team} and get back to you." The hold stays
  pending.
- No reply in time → the time is released. Dana gets one text: "I didn't hear
  back, so I released your Monday at 3:15 PM tour. Text me anytime to book
  another." Then no further texts.

## Export

**Operator:** Export today's audit.

[`export_records` day "today"]

**Tour Core:** Monday, Sep 28 at 100 Alfred Way: 1 visitor tour (1 completed),
1 access denial, 1 question needed attention, plus 1 practice tour. The export
is saved with the property's tour records on the Tour Core computer.
