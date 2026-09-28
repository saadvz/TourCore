# Terminology (reusable context)

Say the words on the left to operators. The right column is what Tour Core
calls it internally; use it only if the operator asks for technical detail.

| Say this | Tour Core means |
| --- | --- |
| property, building, the address | a property setup (identified by its canonical address; `displayName` only if the operator gave one) |
| single-family home, multifamily home, apartment building, other | the property type (`SINGLE_FAMILY`, `MULTIFAMILY_HOME`, `APARTMENT_BUILDING`, `OTHER`) |
| unit, "Main Home" | a tourable unit (a single-family home has one, the whole home) |
| entrance | an ENTRANCE door |
| hallway door, inside door | a COMMON door on a route |
| the unit's door | the unit's own UNIT door |
| route | the ordered doors a visitor to one unit may use |
| tour hours | days, first start, last finish, tour length, spacing, early arrival |
| basic identity form | basic-form verification (claimed identity, not document-checked) |
| practice verification | mock verification (everyone passes) |
| real texts | Sendblue messaging |
| practice texts / on screen | demo messaging |
| tour records | the canonical tour store and audit |
| readiness check | readiness checks |
| practice tour | dry tour |
| published for demo | PUBLISHED_FOR_DEMO (not production) |
| paused | operator hold, or a door-system (provider) failure |
| called off | revoked |
| needs attention, issue | an exception |
| approved fact | an operator-written property or unit fact |
| door system, door access | Durin (demo mode in P0) |
| tour updates | operator events delivered to the Tour Core Operator Updates Grok Routine |
| visitor texting is live | the property uses the installation's Sendblue messaging |

Handles you'll see in tool results and must never show: `propertyId`,
`unitId`, `doorId`, `tourRef`, `exceptionId`, `eventId`, `confirmation.code`.
