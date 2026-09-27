# Tour Core

Tour Core is an open-source self-touring tool. A prospect books a tour by text, gives consent, fills out a
basic identity form, and then tours a unit on their own. Tour Core opens only the doors on their reserved
route, and only during their reserved window. Afterward it sends a follow-up and keeps a full audit trail.

**Tour Core does not control locks.** It requests authorized access through **Durin**, and only after its
own policy check allows the request. If policy says no, Durin is never asked.

This repo is an early vertical slice. Everything runs locally in demo mode: nothing sends real texts or opens
real doors.

## Quick start

Requires Node.js 20+ (built on 22). No environment variables or accounts needed.

```bash
npm install
npm run setup
```

`npm run setup` starts the setup app on this computer, prints a link (`http://localhost:4321/`) and opens it in
your browser. Keep the window open while you work and press Ctrl+C to stop. Your work is saved as you go.

In the browser you:

1. **Set up a property**: address, name, time zone (guessed from the address; you confirm it) and optional
   building facts.
2. **Units**: add each tourable unit with an optional short description and other facts. Only what you write is ever
   shared with visitors.
3. **Doors**: the main entrance, each unit's door, and any hallway doors or extra entrances.
4. **Routes**: for each unit, the doors in order (Lobby Entrance ↓ Unit 101 Door). A suggested route is filled in.
5. **Tour hours**: days, first start, last finish, tour length, spacing, and the early-arrival allowance.
6. **Verification**: basic identity form (recommended) or practice verification.
7. **Records and messages**: demo records, demo messaging and Durin demo mode, plus who gets alerts.
8. **Review**: everything on one page, with Edit beside each section.
9. **Readiness check**: eight real checks, each failure with a button that takes you straight to the fix.
10. **Practice tour**: a timeline of the visitor's journey, the safety test (too early, on time, no duplicate
    access, the unit, a door that isn't on the route) and wrap-up.
11. **Publish for demo**, then view the property, run another practice tour, edit, or read the tour history.

Come back any time with `npm run setup`. Your properties are listed on the first screen. You can edit one thing,
such as renaming a unit (and optionally its matching door), changing one route or changing tour hours, without
redoing a section.

**Saving.** Valid edits are saved immediately. Edits with problems are kept as a draft, and your saved setup is left
alone until they're fixed. The line at the top of each setup screen always says which: "All changes saved",
"Changes kept as a draft until 1 problem is fixed", or "Changes not saved yet" while you're still typing. Continue
also saves anything still on screen, such as a suggested route, but only if Tour Core says it's valid.

### Visitor demo: the tour from both sides

On a property that passes its readiness check, click **Start visitor demo**. A phone-style page opens for the
pretend visitor, and your tab switches to a live view of the same tour. If the phone tab doesn't open, use "Open
the visitor's phone" on the live view.

On the phone, the visitor:

1. picks a unit and gets its approved description;
2. picks a tour time;
3. agrees to texts and tour records, and fills in the basic identity form;
4. taps "I'm here".
   - Arriving early gets the real policy answer ("I can open the doors from 8:50 AM").
   - "Skip ahead to my tour time" is a demo control that moves the demo clock forward.
5. is guided along the route ("I'm at Unit 101");
6. can ask questions, which are answered only from facts you entered and flagged for you when there's no answer;
7. finishes the tour and answers the follow-up question.

The **Test wrong door** demo control tries a door that isn't on the route. Tour Core refuses it and never contacts
Durin.

The live view polls every 1.5 seconds and shows:

- who is touring, the unit and the tour time;
- the tour's status and where the visitor is;
- questions that need your attention;
- recent activity in plain sentences.

**Tour history** lists every practice tour and visitor demo ("Sep 27, 2:14 PM — Passed"). Open one to see:

- the visitor conversation;
- the safety checks;
- the access decisions;
- the full timeline, with downloads.

Visitor demos run the real engine: the same `TourCore`, policy, messaging contract, verification boundary and Durin
adapter. The phone page only draws what `src/visitor/` returns and sends taps back. A live demo lives in the setup
app's memory, and its records are saved after every step.

Other commands:

```bash
npm run setup -- --dev      # browser app plus internal ids, codes, adapter names, Durin calls and file paths
npm run setup -- --no-open  # don't open the browser automatically
npm run setup:cli           # the same setup in the terminal (development, scripting, quick debugging)
npm run setup:cli -- --dev
npm run demo                # scripted walkthrough of one tour on the sample property
npm run demo:auto           # same, without prompts
npm test                    # vitest
npm run typecheck           # tsc
```

## What "Publish for demo" means

Publishing sets the property's status to `PUBLISHED_FOR_DEMO`. That is **not** a production launch. It only means:

1. the saved setup is valid,
2. the readiness check passed for this exact setup,
3. a practice tour passed for this exact setup.

Changing anything afterward puts the property back to draft, and both checks must pass again. Messaging, storage,
verification and Durin access all stay in demo mode. No physical door is controlled.

## Setup engine (UI-independent)

```
Terminal wizard (src/cli)      Browser app (src/web)      Future Grok Bot
            \                          |                        /
             '-------------->  Setup actions (src/setup)  <----'
                                       |
                                   Tour Core
```

Neither UI holds setup rules.

- **Browser.** It calls named commands (`SETUP_COMMANDS` in `src/setup/commands.ts`, each with a typed input schema)
  and draws view models from `src/setup/presenters.ts`: the review cards, readiness fixes, the practice-tour timeline
  and plain-language history. Anything technical sits under a `dev` key, which the browser server removes unless
  `--dev` is on.
- **Server.** It listens on localhost only, rejects other hosts and non-JSON posts, and keeps unfinished setups as
  drafts. A setup is saved only once it's valid.

The actions:

| Action | What it does |
| --- | --- |
| `createPropertySetup` / `setPropertyDetails` | Property name, address and time zone (inferred from the address, always confirmed) |
| `addUnit` / `renameUnit` / `setUnitDetails` / `removeUnit` | Tourable units, their description and approved facts. A rename can also rename the unit's door, but only if it still has the suggested name |
| `addDoor` / `renameDoor` / `removeDoor` | Entrances, unit doors, and hallway or shared doors (ids are generated and can't collide) |
| `setRoute` | Ordered doors for one unit, plus optional directions |
| `setTourHours` | Days, hours, tour length, spacing, early-arrival allowance |
| `setVerificationPolicy` | Basic identity form or practice verification, plus the reuse window |
| `setServices` / `setAlertContact` | Records, messages, door access, and who gets alerts |
| `reviewSetup` | Readable summary plus every problem, in plain language |
| `runReadinessCheck` | Eight checks against the real adapters the setup selects |
| `runDryTour` | One full simulated tour through the real engine, with safety checks |
| `publishDemoProperty` | Publishes only if all of the gates above pass |
| `parseDays`, `parseTimeOfDay`, `parseMinutes`, `resolveTimeZone` | Turn everyday answers ("Mon-Fri", "9am", "Eastern") into config values |

Validation (`src/config/validateConfig.ts`) returns machine-readable codes with plain messages, for example
`ROUTE_DOOR_MISSING` with "Unit 101's route refers to a door that no longer exists."

The practice tour runs inquiry, reservation, consent, verification, an early arrival (denied), arrival, entrance
access, a duplicate request (no second grant), unit access with directions, and an **off-route door that is denied
before Durin is called**. Then it runs completion (all doors re-locked) and the follow-up, and saves the tour history.

## Configuration

Each property has one canonical `TourCoreConfig`, written by the setup flow to
`tourcore-data/properties/<propertyId>/tourcore.config.json`. Status and check results go in `status.json`, and each
practice tour's records go in `practice-tours/<time>/` (`tour-export.json` and `audit.csv`). Set `TOURCORE_HOME` to
store this elsewhere; it's optional.

The config holds the property (including its **IANA time zone**, e.g. `America/New_York`), operator alert contact,
doors, units, routes, and tour hours: days, start, end, `slotEveryMinutes`, `tourLengthMinutes` and
`earlyArrivalMinutes`. It also holds `verificationMode`, `verificationValidForDays`, `messagingMode`, `storageMode` and
`accessMode`. Policy values live only in config. Setup shows the defaults (45-minute tours, hourly, 10 minutes early,
checks reusable for 30 days) and lets the operator change them.

**Approved facts.** `property.facts`, `unit.summary` and `unit.facts` hold only what the operator wrote.
`approvedFacts(config, unitId)` (`src/core/facts.ts`) and `TourCore.approvedFacts(reservationId)` return them as
structured entries marked `source: "operator"`. Future tour guidance may repeat these and nothing else.
`TourCore.answerQuestion` matches questions to those facts with a small deterministic keyword lookup
(`findApprovedAnswer`). No match means "I don't have that information", plus a flagged question for the operator.
It never guesses. Edits that aren't valid yet are kept in `draft.json` next to the saved config.

**Write safety.** Local records are written atomically: a temp file is flushed, then renamed over the target. Whole
practice-tour folders are built in a temp folder and renamed into place. If the process stops between writing the
setup file and its status file, loading detects the mismatch and treats the property as an unchecked draft (fails
closed). Each tour folder holds `record.json`, `tour-export.json` and `audit.csv`.

All tour-hour and access-window math uses the property's time zone, never the host machine's.
`config/demo-property.json` is the sample property used by `npm run demo`.

## The boundary: Tour Core, then policy, then Durin

```
TourCore.requestAccess()
   ├─ audit ACCESS_REQUESTED
   ├─ durin.getHealth()
   ├─ evaluateAccess()  ── DENY ──► audit ACCESS_DENIED, explain, stop (Durin never called)
   │        │ ALLOW
   ├─ existing active grant? ──► reuse it (no second grant)
   └─ durin.requestAccess()  ── failure ──► PROVIDER_FAILURE, safe denial, operator alerted
```

- `src/policy/evaluateAccess.ts` is a pure, deny-by-default policy. It checks the reservation, prospect, consent,
  verification, time window, exact route, reservation status and Durin health.
- `src/durin/DurinAccessAdapter.ts` is the entire access contract: `requestAccess`, `revokeAccess` and `getHealth`.
- `src/durin/MockDurinAccessAdapter.ts` is "Durin demo mode".

## Layout

```
src/config/        TourCoreConfig schema, plain-language validation
src/core/          TourCore engine, schedule, time zones, clock
src/domain/        entities, reservation state machine
src/policy/        evaluateAccess
src/durin/         Durin contract + demo mode
src/messaging/     Messenger contract + demo messaging
src/verification/  basic identity form + practice verification
src/storage/       store contract + in-memory store
src/audit/, src/export/   audit formatting/CSV, validated export bundle
src/createTourCore.ts     the only place config modes map to adapters
src/setup/         setup engine: actions, commands, presenters, readiness, practice tour, save/publish
src/visitor/       visitor demo session over the real engine + phone and live-view presenters
src/web/           local server + API (server.ts, api.ts); pages in public/: app.js (setup), tours.js (history, live),
                   visitor.js (phone), ui.js (shared helpers). No build step.
src/cli/           terminal wizard (npm run setup:cli)
src/demo/          scripted demo (npm run demo)
```

## Mocked today, and what replaces it

| Component | Now | Next |
| --- | --- | --- |
| Messaging | Demo messaging (prints texts) | Bland SMS behind `Messenger` |
| Storage | On this computer (in-memory, plus JSON/CSV files) | Google Drive behind `TourCoreStore` |
| Verification | Simulated form response, or practice verification | Real Google Form mapped to `BasicFormResponseSchema` |
| Access | Durin demo mode | **Stays mocked** until the real Durin contract is ready |

Tour Core never stores government ID images. The basic form records claimed identity only (legal name, email,
phone). It does not prove identity.

## License

Apache-2.0
