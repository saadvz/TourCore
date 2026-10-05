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
| `create_property_setup` | change | Starts a property from its street address. A US address needs street, city, state and ZIP; a missing ZIP is the next question, then a read-back to confirm, then property type. An optional public name only if the operator said one. Uses the installed visitor texting automatically |
| `update_property_details` | change | Property type, address, operator-given name, time zone, approved property facts, who gets alerts, optional visitor help number and support email (never the team's private alert line); `skipVisitorHelp` records an explicit skip; returns `nextQuestion` (how to name the tourable spaces for that type, then the optional help step) |
| `list_units` | read | Units with description, facts, door, route |
| `add_unit` | change | Adds a unit and its own door. For a single-family home the name is optional ("Main Home"), its door is the home's entrance ("Front Door" unless named) and its route is set automatically. Never a made-up unit number |
| `update_unit` | change | Renames a unit or changes its description/facts |
| `set_unit_details` | change | Saves units' bedrooms, bathrooms, rent, availability and optional details from the operator's words (bulk answers welcome); "not sure" is saved as not provided |
| `get_unit_details` | read | Unit details as short lines, what's still missing, and the one question to ask next |
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
| `set_services` | change | Live texts or practice texts; records location |
| `review_property_setup` | read | The setup as short lines to read back: address, "Called: ..." if named, property type, each unit with its details and route, "Tours: ...", "Verification: ...", "Visitor texting: Connected", "Door access: Demo", visitor help number and support email (or "not set") |
| `run_readiness_check` | change | The real readiness checks, recorded for publish |
| `run_dry_tour` | change | A full practice tour with safety proof points, recorded for publish |
| `publish_demo_property` | consequential | Publishes for demo, only when readiness and a practice tour passed for this exact setup. In a Grok-managed install it refuses while the property still uses practice texts although texting is installed, returning a `summary` and a `remediation` (switch to real texts, re-run readiness and the practice tour, ask again) |
| `list_active_tours` | read | Tours happening now |
| `inspect_tour` | read | One tour: status, activity, questions, denials, what needs attention |
| `list_exceptions` | read | The queue of issues that need the team |
| `inspect_exception` | read | One issue with context and next steps |
| `resolve_exception` | change | Marks an issue handled with a note; changes nothing else |
| `answer_flagged_question` | consequential | Saves the operator's answer as an approved fact (a unit detail like bedrooms becomes that unit's value), texts the visitor exactly that, asks one confirmation, keeps the property published |
| `place_operator_hold` | consequential | Pauses a running tour; its doors are switched off |
| `clear_operator_hold` | consequential | Resumes a paused tour; policy still decides every door |
| `revoke_tour_access` | consequential | Calls a tour off for good and tells the visitor |
| `list_tour_time_requests` | read | Who is waiting on a time that isn't a regular slot, or on moving a tour |
| `inspect_tour_time_request` | read | One custom-time request: who, the time they want, their current booking, and whether it's outside normal touring hours |
| `approve_tour_time_request` | consequential | Approves that time as a one-off. Asks once first. Outside normal touring hours asks a stronger question. Regular hours stay the same |
| `decline_tour_time_request` | change | Declines the request and tells the visitor. A current booking stays confirmed |
| `propose_tour_time` | change | Offers the visitor another time. The current booking stays until they agree |
| `reschedule_tour` | consequential | Moves a tour to a time the landlord is directing, including a one-off. Asks once first. Regular hours stay the same |
| `export_audit` | change | Writes a validated day's audit export (JSON + CSV) and summarizes it |
| `get_installation_status` | read | Every installation component's state (runtime, public address, Grok connection, messaging, tour updates, records, access, property, readiness, practice tour, publish) and the next step |
| `get_next_installation_step` | read | The one next step Tour Core decided, who does it, and the tool or skill to use |
| `get_installation_component` | read | One component's status and next step |
| `skip_optional_setup` | change | Records that the operator declined an optional step Tour Core offered (e.g. tour updates) |
| `check_runtime_health` | read | Whether Tour Core is running and healthy |
| `check_public_endpoint` | change | Checks from outside that the public address reaches this installation; records the result |
| `choose_messaging_line` | change | Saves which discovered Photon line prospects will text. Takes no secrets |
| `choose_messaging_provider` | change | Records whether prospects text through Sendblue, Twilio, or Photon. Takes no credentials. Switching requires a new connection test |
| `test_visitor_messaging` | change | Checks texting end to end and repairs Tour Core's own incoming-message address; takes no credentials |
| `get_notification_preferences` | read | Which tour updates and problem alerts the operator gets, and Tour Core's recommended default |
| `set_notification_preferences` | change | Saves the operator's choice: preset `recommended` (bookings, starts, completions, anything needing attention) or `problems-only`, or an exact `updates` list |
| `get_operator_update` | read | What one update is about, from its `eventId`: a plain `summary` sentence to post plus the tour or issue behind it |
| `test_operator_alerts` | change | Test tour updates: sends one test update to the Tour Core Operator Updates routine; takes no credentials |
| `test_storage` | change | Saves and reads back a test record where tour records are kept |
| `test_access` | read | Checks the access system answers ("Access system: Demo") |
| `get_secure_setup_url` | change | A short-lived link to Tour Core's secure setup page. Fill it with a secure secret input; hand over the browser only if that fill isn't available |
| `get_storage_status` | read | Whether tour records are on this computer or in Google Drive |
| `get_storage_location` | read | The Tour Core folder name and Google Drive id, for opening it. No tokens |
| `begin_google_drive_connect` | change | Starts Tour Core's own Google approval after Grok's Drive connector, or explains that the shared Google app is not configured yet |
| `finish_google_drive_setup` | change | Creates the Tour Core folder and makes Google Drive canonical after approval |
| `use_local_demo_storage` | change | Keeps records on this computer after the operator declines Drive. Says they are not portable |
| `prepare_storage_migration` | change | Counts local records to copy. Does not switch the canonical store |
| `migrate_storage_to_google_drive` | change | Copies records to Drive. Safe to repeat. Does not delete local records |
| `verify_storage_migration` | read | Checks the Drive copy against local records |
| `activate_google_drive_storage` | consequential | Makes Google Drive canonical only after the copy checked out. Asks once |
| `discover_storage` | read | Lists existing Tour Core folders in the connected Google account |
| `takeover_storage_writer` | consequential | Restores a Drive folder onto this computer. Asks before taking over another writer |
| `disconnect_google_drive_storage` | consequential | Optional direct-Drive mode only. Disconnects Drive after confirmation. Does not delete the folder. Not used for hosted backups |
| `confirm_backup_destination` | change | Hosted setup. Records that Grok's Google Drive connector will hold portable backups in the Tour Core folder. No tokens |
| `decline_portable_backup` | change | Hosted setup. Records that portable backups were declined. Operational records stay on hosted Tour Core |
| `get_backup_status` | read | Whether a portable backup is due, and non-secret metadata about the last one. Does not look inside Drive |
| `create_portable_backup` | change | Builds a validated secret-free snapshot and a short-lived download. Does not upload to Drive |
| `confirm_backup_stored` | change | After you have saved that file in Google Drive, record the file name and checksum. Tour Core does not see Drive itself |
| `create_readable_export` | change | A human-readable export, separate from a backup, as a short-lived download for Tour Core/Exports |
| `begin_restore_upload` | change | Opens a short-lived upload for one backup file. Nothing is imported yet |
| `preview_portable_restore` | read | Checks an uploaded backup and returns a plain preview. Does not change records |
| `import_portable_backup` | consequential | Restores a previewed backup after an explicit yes. Replacement of existing records needs a separate explicit choice. Provider logins are not restored |
| `reset_hosted_demo` | consequential | Hosted demo only, current owner only. First call warns and changes nothing. Second call erases the demo and starts a fresh unclaimed installation. Keeps the Railway service and Google Drive files. Hidden unless that owner is connected |

`reset_hosted_demo` is not offered on a self-hosted or local Tour Core, and it
is hidden from anyone who is not the current hosted owner. It does not take a
file path and it does not run a shell command.

There is intentionally no tool to open, unlock or grant a door, mint access,
change the door-access mode, or read or write raw files. There is also no
tool that sets an API key, sender key, webhook secret or any other
credential, and none that runs a shell command: credentials are collected
with a secure secret input and written by filling Tour Core's setup form, and runtime management (install, start,
restart) is done by Grok in its own terminal with `npm run bootstrap:grok`
and `npm run service:*`.
