---
name: setup-property
description: Set up a self-guided touring property in Tour Core through a friendly, one-question-at-a-time conversation, then check it and run a practice tour before offering to publish. Use when the operator wants to add, set up, import or change a building.
when-to-use: "set up a property", "set up my building", "add a property", "I have a new building", "change the tour hours", "add a unit"
allowed-tools: list_properties get_property_setup create_property_setup update_property_details list_units add_unit update_unit set_unit_details get_unit_details list_doors add_door preview_route set_route get_tour_hours set_tour_hours get_verification_policy set_verification_policy get_services set_services review_property_setup run_readiness_check run_dry_tour publish_demo_property
argument-hint: "[address]"
user-invocable: true
metadata:
  author: Tour Core
  short-description: Guided property setup, checked and practiced before publish
  version: "0.2.0"
---

# Setup Property

Tour Core is the system of record. Everything you learn goes into Tour Core
through its tools the moment the operator says it; nothing about the property
is kept only in this conversation. Read `context/operator-language.md` and
`context/safety-boundaries.md` in the Tour Core template before starting.

## When to use

The operator wants to set up a building, add or change units, doors, tour
hours, verification or messaging. For route questions on their own, use
**Map Route**.

## Required inputs and access

- The Tour Core connector must be connected (see the template setup guide).
- From the operator, in this order: address; the units people can tour; each
  unit's basic information (bedrooms, bathrooms, monthly rent, availability are
  required; square footage, floor, description, parking, laundry, pets,
  utilities, furnished and features are offered); the entrance(s); any hallway
  doors on the way; tour days and hours; how careful to be about checking IDs.
- Never ask for API keys, secrets, passwords or phone-provider credentials.
  Those are connected on the Tour Core computer, never in chat.

## Sequence

Ask one question at a time, in everyday words. Show what you inferred and let
the operator correct it.

1. `list_properties`. If the address already exists, say so and continue with
   that property.
2. Ask **"What's the property address?"** Then `create_property_setup` with the
   address (and a name if they gave one). Tell them the time zone Tour Core
   guessed ("I've got Eastern Time for that address. Right?") and fix it with
   `update_property_details` if they say no.
3. Ask **"Can you tell me about the units people can tour?"** (e.g. "Two units,
   101 and 102"). For each unit, `add_unit` with the operator's own name and
   description. Each unit gets its own door automatically ("Unit 101 Door").
   Never write a description or fact yourself.
4. **Unit information, before doors and routes.** Ask for bedrooms, bathrooms,
   rent and availability, and accept a natural answer for several units at
   once ("1A and 1B are 2 bed 1 bath for $2,200. 2A is 3 bed 2 bath for
   $2,800"): pass it as `details` to `set_unit_details`. Offer the optional
   details (square footage, floor, parking, laundry, pets, utilities,
   furnished, features) once. "I don't know", "not sure", "not available yet"
   and "don't list the price" are answers: pass them as the operator said
   them. Never fill in or guess a value. `set_unit_details` returns short lines
   and, if anything required is still missing, the one `nextQuestion` to ask
   (e.g. "When are these units available?"). Ask only that; don't re-ask what's
   known. When nothing is missing, read the lines back and ask **"Does that look
   right?"**:

   > Unit 1A — 2 bed · 1 bath · $2,300/month · available now
   > Unit 1B — 1 bed · 1 bath · $1,950/month · available October 15

   Corrections go through `set_unit_details` too. These details are approved
   facts: visitors' questions ("How many bedrooms?", "How much is it?", "When
   is it available?") are answered from them.
5. Ask **"Which door do visitors come in through?"** `add_door` with
   `kind: entrance`. Ask **"Any hallway or inside doors on the way to the
   units?"** Add each as `kind: hallway`. Add only doors the operator named.
6. Routes: follow the **Map Route** skill for each unit (`preview_route`, show
   the operator, then `set_route` with the exact names).
7. Ask **"When can people tour?"** Pass their words to `set_tour_hours`
   ("weekdays", "9 to 5"). Mention the visible defaults once (45-minute tours,
   a new tour every hour, 10 minutes early) and change any they want.
8. Ask **"How carefully do you want to verify visitors?"** Offer "Basic
   identity form (free, recommended)" or "Practice verification (everyone
   passes; for trying things out)". `set_verification_policy`. Full ID checks
   aren't available yet; say so if asked.
9. Texting: when Tour Core's texting is already connected (it is in a guided
   install), `set_services` with `messaging: sendblue` without asking. Tour
   records are stored with this Tour Core installation; don't ask about it.
10. `review_property_setup` and read it back as a short list:

    > Here's what I have:
    > 100 Alfred Way
    > 2 tourable units
    > Lobby Entrance
    > Weekdays, 9 AM–5 PM
    > Basic visitor verification
    > Real texts through Sendblue
    >
    > Does that look right?

11. On yes, the setup is saved. In a guided install, go back to Tour Core's
    next step (`get_next_installation_step`, Install Tour Core skill): it
    offers alerts next, then runs the checks. Otherwise: "I'll run a readiness
    check and a practice tour before we turn it on." Then run **Run Readiness
    Check**. If it fails, explain each problem in plain words and offer the fix;
    change nothing without the operator's OK. If it passes, run **Simulate
    Tour**.
12. If both passed, `publish_demo_property`. It returns a question; ask it word
    for word. Only after a clear yes, call it again with the `confirmationCode`.

Later edits: facts and unit details (bedrooms, rent, availability,
description, amenities, directions) are approved content: saving them keeps
the property published and active tours use them right away. Doors, routes,
tour hours, verification and messaging are structural: they send the property
back to draft until readiness and a practice tour pass again. Tell the operator
which it is before saving a structural change to a published property.

## Validate

- Every change came back without an error, and `review_property_setup` shows it.
- `problems` is empty before you offer the readiness check.
- If a tool returns an error, tell the operator what it said in plain words and
  ask how to proceed. Don't retry with guesses.

## Return

A short, friendly summary of the property as Tour Core has it, the readiness
and practice-tour results, and whether it's published for demo.

## Requires approval

- Publishing (always, via the tool's own confirmation).
- Changing anything the operator didn't ask for, including fixes suggested by
  the readiness check.
- Removing units or doors: not available through Grok; point the operator to
  the Tour Core app on the computer.

## Stop when

The property is published for demo, or the operator stops, or a tool reports a
problem only the operator can fix (for example messaging that isn't connected on
the Tour Core computer).
