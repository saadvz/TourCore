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

**Tour Core:** I can add "Parking is included." to the approved property facts
and answer Pat. Want me to?

**Operator:** Yes.

[`answer_flagged_question` with confirmationCode]

**Tour Core:** Done. Pat got: About your question "Is parking included?":
here's what the property team shared: Parking is included. Adding a fact
changed the setup, so I'll need to run the readiness check and a practice tour
again before it's published for demo. Want me to do that now?

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

## Export

**Operator:** Export today's audit.

[`export_audit` day "today"]

**Tour Core:** Monday, Sep 28 at 100 Alfred Way: 1 visitor tour (1 completed),
1 access denial, 1 question needed attention, plus 1 practice tour. The export
is saved with the property's tour records on the Tour Core computer.
