---
name: map-route
description: Map the doors a visitor walks through to reach one unit, from the operator's own description, using only doors Tour Core has on file. Shows the inferred route and saves it only after the operator confirms.
when-to-use: "map the route", "Unit 101 uses the lobby entrance", "how do people get to 102", "change the route", "fix the route"
allowed-tools: get_state save_doors_and_routes
argument-hint: "[unit]"
user-invocable: true
metadata:
  author: Tour Core
  short-description: Route mapping with no invented doors
  version: "0.2.0"
---

# Map Route

Call only `get_state` and `save_doors_and_routes`.

A route is the exact, ordered list of doors Tour Core will allow for a visitor
to one unit. Tour Core refuses any door that isn't on it, before any door is
unlocked. So a route must only contain doors that really exist and that the
operator confirmed. An apartment or condo that only controls the unit door
starts and ends at that unit door — do not add a building entrance to the
route. If they control the building entrance, the route is that entrance then
the unit door.

## When to use

The operator describes how visitors get to a unit, or asks to change a route,
or the readiness check says a unit "doesn't have a complete route".

## Required inputs and access

- The unit (e.g. "Unit 101").
- The doors in walking order, in the operator's words ("the lobby entrance and
  then the unit door").

## Sequence

1. `get_state` so you know which doors are already on file. Never assume a door exists.
2. `save_doors_and_routes` with `preview: true`, the unit, and the operator's words for each door, in
   order. A preview does not save anything.
3. Act on what it returns:
   - A matched route: show it as Tour Core resolved it and ask:
     > I have:
     > Lobby Entrance → Unit 101 Door
     >
     > Is that right?
   - A question (for example "'entrance'
     could be Lobby Entrance or Garden Entrance. Which one?"): ask that question.
   - A door that isn't on file: tell the operator Tour Core doesn't have that door and
     list the doors `get_state` shows. Ask whether they meant one of those or want to add a
     new door. Only if they ask to add it, `save_doors_and_routes` with that door, then preview again.
   - A problem (for example "needs to start at an entrance"
     — skip that for a unit-only apartment or condo): read it and ask how they'd like
     to fix it.
4. After a clear yes, `save_doors_and_routes` with the **exact door names** from the
   preview, in order, plus the operator's own directions if they gave any.
5. `get_state` to confirm what was saved and read the route back.

## Validate

- `save_doors_and_routes` succeeded and `get_state` shows the same doors.
- If it says a door isn't on file, nothing was saved.
  Go back to step 2; don't guess a different name.

## Return

The saved route in one line (Lobby Entrance → Unit 101 Door) and any directions.

## Requires approval

- Saving a route (the operator's "yes" to the preview).
- Adding a door that wasn't on file.

## Stop when

Every unit the operator mentioned has a saved route, or the operator stops.
