# Tour Core tools (custom MCP connector)

The Tour Core Bot's only integration is Tour Core itself, reached as a custom
remote MCP server on the Tour Core computer:

- **URL:** `PUBLIC_BASE_URL/mcp` (your https tunnel address + `/mcp`)
- **Transport:** Streamable HTTP (stateless, JSON responses)
- **Auth:** OAuth. Grok discovers it from the URL, opens a Tour Core approval
  page, and the owner clicks Allow on the Tour Core computer. Nothing is pasted
  into Grok.

Custom MCP servers don't travel with Grok Bot templates, so every installer
connects it after adding the Bot (see `docs/grok-template-setup.md`).

The tool list is generated from `src/operator/tools.ts`; run `npm run
grok:tools` to print it. Every tool validates its input and calls the same
Tour Core actions as the browser app. Kinds: **read** changes nothing;
**change** edits setup or records through Tour Core's normal rules;
**consequential** returns a yes/no question first and acts only when called
again with the code after the operator's yes.

| Tool | Kind | What it does |
| --- | --- | --- |
| `list_properties` | read | Every property and its status |
| `get_property_setup` | read | Full setup: units, doors, routes, hours, verification, messaging, problems |
| `create_property_setup` | change | Starts a property from its address (no duplicate for the same address) |
| `update_property_details` | change | Name, address, time zone, approved property facts, who gets alerts |
| `list_units` | read | Units with description, facts, door, route |
| `add_unit` | change | Adds a unit and its own door |
| `update_unit` | change | Renames a unit or changes its description/facts |
| `list_doors` | read | Every door on file |
| `add_door` | change | Adds an entrance or hallway door the operator named |
| `get_route` | read | A unit's saved route (or a suggestion) |
| `preview_route` | read | Resolves the operator's door words to doors on file, without saving |
| `set_route` | change | Saves a route from exact door names; refuses unknown doors and invalid routes |
| `get_tour_hours` | read | Days, hours, length, spacing, early arrival |
| `set_tour_hours` | change | Sets tour hours from everyday words |
| `get_verification_policy` | read | Visitor verification choice and reuse window |
| `set_verification_policy` | change | Basic identity form or practice verification |
| `get_services` | read | Messaging choice and connection, records location, door access mode |
| `set_services` | change | Real texts (Sendblue) or practice texts; records location |
| `review_property_setup` | read | The setup as short lines to read back |
| `run_readiness_check` | change | The real readiness checks, recorded for publish |
| `run_dry_tour` | change | A full practice tour with safety proof points, recorded for publish |
| `publish_demo_property` | consequential | Publishes for demo, only when readiness and a practice tour passed for this exact setup |
| `list_active_tours` | read | Tours happening now |
| `inspect_tour` | read | One tour: status, activity, questions, denials, what needs attention |
| `list_exceptions` | read | The queue of issues that need the team |
| `inspect_exception` | read | One issue with context and next steps |
| `resolve_exception` | change | Marks an issue handled with a note; changes nothing else |
| `answer_flagged_question` | consequential | Adds the operator's own words as an approved fact and texts the visitor exactly that |
| `place_operator_hold` | consequential | Pauses a running tour; its doors are switched off |
| `clear_operator_hold` | consequential | Resumes a paused tour; policy still decides every door |
| `revoke_tour_access` | consequential | Calls a tour off for good and tells the visitor |
| `export_audit` | change | Writes a validated day's audit export (JSON + CSV) and summarizes it |
| `get_installation_status` | read | Every installation component's state (runtime, public address, Grok connection, messaging, alerts, records, access, property, readiness, practice tour, publish) and the next step |
| `get_next_installation_step` | read | The one next step Tour Core decided, who does it, and the tool or skill to use |
| `get_installation_component` | read | One component's status and next step |
| `check_runtime_health` | read | Whether Tour Core is running and healthy |
| `check_public_endpoint` | change | Checks from outside that the public address reaches this installation; records the result |
| `test_visitor_messaging` | change | Checks texting end to end and repairs Tour Core's own incoming-message address; takes no credentials |
| `test_operator_alerts` | change | Sends a test alert to the Tour Core Exception Alert routine |
| `test_storage` | change | Saves and reads back a test record where tour records are kept |
| `test_access` | read | Checks the access system answers ("Access system: Demo") |
| `get_secure_setup_url` | change | A short-lived link to Tour Core's secure setup page, for the Tour Core computer's browser only |

There is intentionally no tool to open, unlock or grant a door, mint access,
change the door-access mode, or read or write raw files. There is also no
tool that sets an API key, sender key, webhook secret or any other
credential, and none that runs a shell command: credentials go in only
through the secure setup page, and runtime management (install, start,
restart) is done by Grok in its own terminal with `npm run bootstrap:grok`
and `npm run service:*`.
