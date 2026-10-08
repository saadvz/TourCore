---
name: setup-property
description: Set up a self-guided touring property in Tour Core through a friendly, one-question-at-a-time conversation, then check it and run a practice tour before offering to publish. Use when the operator wants to add, set up, import or change a building.
when-to-use: "set up a property", "set up my building", "add a property", "I have a new building", "change the tour hours", "add a unit"
allowed-tools: list_properties get_property_setup create_property_setup update_property_details save_property list_units add_unit update_unit save_units set_unit_details get_unit_details list_doors add_door preview_route set_route get_tour_hours set_tour_hours save_hours get_verification_policy set_verification_policy save_settings get_services set_services review_property_setup run_readiness_check run_dry_tour publish_demo_property publish pause_tours resume_tours remove_property
argument-hint: "[address]"
user-invocable: true
metadata:
  author: Tour Core
  short-description: Guided property setup, checked and practiced before publish
  version: "0.3.14"
---

# Setup Property

Tour Core is the system of record. Everything you learn goes into Tour Core
through its tools the moment the operator says it; nothing about the property
is kept only in this conversation. Read `context/operator-language.md` and
`context/safety-boundaries.md` in the Tour Core template before starting.

## When to use

The operator wants to set up a property, change its type, add or change units,
doors, tour hours, verification or messaging. For route questions on their own, use
**Map Route**.

## Required inputs and access

- The Tour Core connector must be connected (see the template setup guide).
- From the operator, in this order: address; property type (single-family
  home, multifamily, or apartment or condo — one unit); the units or spaces
  people can tour; for an apartment or condo, whether they control the
  building entrance or only the unit door, then optional entry instructions;
  each unit's basic information (bedrooms, bathrooms, monthly rent,
  availability are required; square footage, floor, description, parking,
  laundry, pets, utilities, furnished and features are offered); the
  entrance(s) they control; any hallway doors on the way; tour days and hours;
  how careful to be about checking IDs. A property or building name only if
  the operator offers one.
- Never ask for API keys, secrets, passwords or phone-provider credentials.
  Those are collected with a secure secret input during install, never in chat.

## Sequence

Ask one question at a time, in everyday words. Show what you inferred and let
the operator correct it.

1. `list_properties`. If the address already exists, say so and continue with
   that property.
2. Ask **"What's the property address?"** Then `create_property_setup` with the
   address. A US address needs a street, city, state and ZIP. If `nextQuestion`
   is "What ZIP code should I use?", ask that and save the answer with
   `update_property_details` `postalCode`. Do not invent a ZIP. Then read the
   address back exactly as Tour Core shows it and wait for yes. Only after
   `confirmAddress: true` ask property type. Pass `name` only if the operator
   said a public property or building name themselves; never suggest one, and
   never treat an internal space name such as "Main Home" as the property name.
3. Ask Tour Core's `nextQuestion`, **"What type of property is this?"**, with
   its `choices` in plain words: single-family home; multifamily (duplex /
   small building you own); apartment or condo (one unit). Never guess the
   type from the address. There is no whole-building apartment option. Save
   the answer with `update_property_details` (`propertyType`). It returns the
   next question about the spaces people tour.
4. Ask about the tourable spaces the way that type needs:
   - **Single-family home:** people tour the whole home. Ask whether to call it
     "Main Home" or something else, then `add_unit` (leave `name` out for
     "Main Home"). Its door is the home's entrance ("Front Door" unless the
     operator names it) and its route is set on its own. Never make up a unit
     number.
   - **Multifamily:** ask **"Which units can people tour?"** For each,
     `add_unit` with the operator's own name and description. Each unit gets
     its own door automatically ("Unit 1A Door").
   - **Apartment or condo (one unit):** ask **"What's the unit number?"** then
     `add_unit` with that number (`"4B"` is stored as `"Unit 4B"`; `"loft"` as
     `"Unit Loft"`). `update_unit` uses the same casing when they rename and
     confirms with that stored name ("Updated Unit Loft.", not "Updated loft."). Then
     ask Tour Core's next question: **"Do you control the building entrance, or
     only the unit door?"** Save `buildingAccess` `BUILDING_AND_UNIT` or
     `UNIT_ONLY` with `update_property_details`. If they control the building
     entrance, ask **"What's the building entrance called?"** and `add_door`
     `kind: entrance` — Tour Core sets the route as building entrance + unit
     door. If they only control the unit door, the route is that door alone
     (no building door on the route or in arrival text). Then ask the optional
     **"How should visitors get in and find your unit?"** Save their words as
     `entryInstructions`, or `skipEntryInstructions: true` if they skip.
     Skip stores nothing. Visitors hear those words only after identity
     verification, on the you're-all-set text. The nickname is the street
     plus unit (`145 Main St, Unit 4B`), never "Main Home". Mid-tour texts
     say `at Unit 4B`; a single-family home says `the front door`, never
     "Main Home".

   Never write a description or fact yourself.
5. **Unit information, before doors and routes.** Ask for bedrooms, bathrooms,
   rent and availability, and accept a natural answer for several units at
   once ("1A and 1B are 2 bed 1 bath for $2,200. 2A is 3 bed 2 bath for
   $2,800"): pass it as `details` to `set_unit_details`. On a single-family
   home with exactly one unit, omit the unit name and Tour Core uses that
   unit. A single-family home with no unit yet: "Add the house as a unit
   first, then I'll save these details." Multi-unit properties still need a
   unit. Offer the optional
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
   is it available?") are answered from them first, at any point in their
   conversation.
6. Doors: ask **"Which door do visitors come in through?"** when this type
   has a building entrance they control. `add_door` with `kind: entrance`.
   Ask **"Any hallway or inside doors on the way to the units?"** Add each as
   `kind: hallway`. Add only doors the operator named. A single-family home
   already has its entrance; ask only if they want to rename it or there are
   inside doors. An apartment or condo that only controls the unit door has
   no building door to add.
7. Routes: follow the **Map Route** skill for each unit (`preview_route`, show
   the operator, then `set_route` with the exact names). A single-family
   home's route is already set. An apartment or condo route is set when they
   answer the building-door question (and name the entrance, if they control
   it).
8. Ask **"When can people tour?"** Pass their words to `set_tour_hours`
   ("weekdays", "9 to 5", "every day"). A new property starts at
   Monday–Friday, 9:00 AM–5:00 PM. Mention the other visible defaults once
   (45-minute tours, a new tour every hour, 10 minutes early) and change any
   they want.
9. Ask **"Should visitors fill out a short identity form before their tour? I recommend it, so you know who's coming in."**
   Options: "Basic identity form (recommended)" and "No form". The basic form is the default.
   If they pick no form, ask **"Without a form, anyone who texts can book a tour and get in without telling you who they are. Want to go ahead with no form?"**
   Call `set_verification_policy` with `level: none` only after they say yes, and pass the confirmation code it returns.
   Do not ask how many days the form lasts, and do not mention reuse. Read it back as **"Verification: No identity form."**
   If they say no, leave the basic identity form.
   If they keep the basic form, the reuse question is **"How many days before a visitor fills out the form again?"**
   Help: **"A visitor who already filled out the form can book another tour within this many days without filling it out again."**
   The default is 30. Read the basic form back as **"Verification: Basic identity form (recommended)".**
10. Texting is automatic: when this Tour Core has visitor texting installed,
    a new property uses it on its own. One touring number covers every property.
    Don't ask "How do you want to text people?" and don't ask for a separate
    number per property. If `get_services` shows the property still on practice texts
    while texting is installed, `set_services` with `messaging: sendblue`
    yourself. `set_services` only sets live, local test, or practice texts for this property;
    it does not change the installation provider or saved credentials. `messaging: local`
    puts this building on local test texts without drafting other published buildings.
    For local, `get_services` reports `messaging.current` as `"test"` (never
    `"live"`) and the status line is "Visitor texting: test mode". `get_services`
    and `set_services` say "Texting is in test mode, so texts
    don't reach real phones. Real visitors won't get anything until live texting is
    turned on. Door access is still in demo mode, so no physical locks will open."
    Do not say texting is live and do not name the texting service.
    Where
    records live comes from `get_storage_status` (this computer, or Google Drive).
    Don't ask about it.
11. Ask Tour Core's next question about visitor help word for word:
    **"What number can stuck visitors call? Pick one someone answers during tour hours."**
    Save a number with `update_property_details` `visitorContact`. If they skip,
    call `update_property_details` with `skipVisitorHelp: true` so it is not
    asked again. Never use the team's private alert line as the visitor number.
    The number stays optional.
12. `review_property_setup` and read its `lines` back as a short list:

    > Here's what I have:
    > 144 Hillside Ave, Teaneck NJ
    > Multifamily (duplex / small building you own)
    >
    > Unit 1A
    > 2 bed · 1 bath · $2,300/month · available now
    > Route: Main Entrance → Unit 1A Door
    >
    > Unit 1B
    > 1 bed · 1 bath · $1,950/month · available October 15
    > Route: Main Entrance → Unit 1B Door
    >
    > Tours: Monday-Friday, 9:00 AM-5:00 PM
    > Verification: Basic identity form (recommended)
    > Visitor texting: Connected
    > Door access: Demo
    > Visitors can call: not set
    >
    > Does that look right?

    If the operator gave the property a name, a "Called: ..." line follows the
    address. If they set a help number, that line shows the value instead of
    "not set". A single-family home's unit heading is the street line
    (for example "910 QA Gate Rd"), never "Main Home". Multifamily, apartment
    and condo units keep their stored names. Local or test-mode texting reads
    "Visitor texting: test mode" instead of "Connected".
13. On yes, the setup is saved. In a guided install, go back to Tour Core's
    next step (`get_next_installation_step`, Install Tour Core skill): it
    offers tour updates next, then runs the checks. Otherwise: "I'll run a
    readiness check and a practice tour before we turn it on." Then run **Run
    Readiness Check**. If it fails, explain each problem in plain words and
    offer the fix; change nothing without the operator's OK. If it passes, run
    **Simulate Tour**.
14. If both passed, `publish_demo_property`. It returns one question; ask it
    word for word. Only after a clear yes, call it again with the
    `confirmationCode` and wait for the result. Then `get_property_setup` or
    `get_installation_status` and say it is published only if that says so.
    Do not ask again, and do not say it still needs a yes, after a successful
    publish. Calling it again when it is already published changes nothing.
    If it refuses because visitor texting is connected but the property isn't
    using it yet, follow its `remediation` yourself: `set_services` with
    `messaging: sendblue`, `run_readiness_check`, `run_dry_tour`, then ask the
    publish question again. After publishing, say each part as it is: "Visitor
    texting is live. Door access is still in demo mode, so no physical locks
    will open." For local test texts, use the test-mode sentence plus the door
    line, and do not say visitors can start a tour by texting the touring
    number. Never say "everything runs in demo mode".

**Pause, resume, or remove.** These are not setup edits and do not change the
published configuration. `pause_tours` stops new bookings at a property or one
unit (ask the exact question it returns; if tours are already booked, the
operator chooses keep or cancel). A tour in progress always finishes.
`resume_tours` turns bookings back on and texts people who were told tours
would be back (or who got a paused-unit line). A later visitor Tour, Hi, or
book restarts booking the same way as a first text. `remove_property` takes the
property off the list after the exact confirmation — including an unpublished
setup `list_properties` still shows (same lookup by id, name, or address),
whether or not that setup is complete. Booked visitors get a cancel text that
the property isn't offering tours anymore (not that they'll be texted when
tours are back) and pending door access is switched off. Waiting visitors are
not texted that tours are back. A later text to that line gets a goodbye and
cannot book. It is refused while someone is on a tour. Published records stay
(`export_audit`, `inspect_tour`) — including a property sent back to draft
when it still has a publish timestamp, visitor tour or reservation records, or a
publish event in its audit. A practice tour alone does not count. An unpublished setup is removed completely.
Ask the exact question it returns: unpublished (complete or not) uses
**Remove the setup for {name}? It isn't published yet, so no visitors are
affected, but everything entered for it will be deleted for good.** Published
with no bookings says **No one is booked, so no cancel texts go out.** One
booked visitor is singular (**1 booked visitor gets**). {name} is the
operator-given property name, or street plus unit when there is exactly one
unit, otherwise the street line — never "Main Home". After yes on a draft,
say **Removed the setup for {name}.** Otherwise keep
Tour Core's wording. Say
**remove**, never archive. This is not `place_operator_hold`, which pauses one
visitor's tour.

Later edits: facts and unit details (bedrooms, rent, availability,
description, amenities, directions) and the visitor help number are approved
content: saving them keeps the property published and active tours use them
right away. A practice tour's T+15 close includes that number when it is set.
Doors, routes, tour hours, verification and messaging are structural: they send
the property back to draft until readiness and a practice tour pass again. Tell
the operator which it is before saving a structural change to a published
property. After
the new hours are published, anyone already texting picks them up on their
next message: a stale numbered day gets "Tour times just changed. Here's
what's open now:" and the fresh days; "Tour" starts the day picker over from
the current hours; an offered next opening is checked against those hours
before it is booked.

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
