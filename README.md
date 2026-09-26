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

`npm run setup` opens a guided setup in the terminal:

```
1. Set up a new property
2. Edit an existing property
3. Run a readiness check
4. Run a practice tour
5. Publish for demo
6. View audit/export
7. Quit
```

A first run walks through the property address, name and time zone, the units, the entrance, each unit's door, each
unit's route, tour hours, visitor verification, records, messages and door access. It then shows a review
("Does this look right?"), saves, runs the readiness check, offers a practice tour, and offers to publish for demo.
You never edit a file by hand.

Other commands:

```bash
npm run setup -- --dev   # same wizard, plus technical codes and Durin mock output
npm run demo             # scripted walkthrough of one tour on the sample property
npm run demo:auto        # same, without prompts
npm test                 # vitest
npm run typecheck        # tsc
```

## What "Publish for demo" means

Publishing sets the property's status to `PUBLISHED_FOR_DEMO`. That is **not** a production launch. It only means:

1. the saved setup is valid,
2. the readiness check passed for this exact setup,
3. a practice tour passed for this exact setup.

Changing anything afterward puts the property back to draft, and both checks must pass again. Messaging, storage,
verification and Durin access all stay in demo mode. No physical door is controlled.

## Setup engine (UI-independent)

The wizard (`src/cli/`) only asks questions and prints answers. All setup logic lives in `src/setup/` and is exposed
as plain actions that a Grok Bot skill can call the same way:

| Action | What it does |
| --- | --- |
| `createPropertySetup` / `setPropertyDetails` | Property name, address and time zone (inferred from the address, always confirmed) |
| `addUnit` / `renameUnit` / `removeUnit` | Tourable units |
| `addDoor` / `renameDoor` / `removeDoor` | Entrance and unit doors (ids are generated and can't collide) |
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
src/setup/         setup engine: actions, readiness, practice tour, save/publish
src/cli/           terminal wizard (npm run setup)
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
