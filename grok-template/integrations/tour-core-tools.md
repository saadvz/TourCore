# Tour Core tools (custom MCP connector)

The Tour Core Bot's landlord connector is Tour Core itself, reached as a custom
remote MCP server:

- **Landlord URL:** `PUBLIC_BASE_URL/mcp` (hosted: the service URL + `/mcp`)
- **Ops URL:** the same origin + `/mcp/ops`, bearer `TOURCORE_OPS_TOKEN`. Off until that secret is set.
- **QA URL:** the same origin + `/mcp/qa`, bearer `TOURCORE_QA_TOKEN`. Off until that secret is set.
- **Transport:** Streamable HTTP (stateless, JSON responses)
- **Landlord auth:** OAuth, or the existing static `TOURCORE_OPERATOR_TOKEN` when that mode is on. A saved landlord token keeps working. Ops and QA do not use that token.

Custom MCP servers don't travel with Grok Bot templates, so every installer
connects the landlord connector after adding the Bot (see `docs/grok-template-setup.md`).
Add the ops and QA connectors only on the computers that should have them.

The landlord list is the tools below. Run `npm run grok:tools` to print it.
Every tool validates its input and calls the same Tour Core actions as the browser app.
Kinds: **read** changes nothing; **change** edits setup or records through Tour Core's normal rules;
**consequential** returns a yes/no question first and acts only when called again with the code after the operator's yes.

Set `TOURCORE_LEGACY_TOOLS=1` during the switch-over so the landlord connector also keeps the older tools, the QA test tools, and the ops tools. Unset it once the QA connector is confirmed. Planned removal: October 15, 2026. The older tools stay out of the tables below.

## Landlord connector

| Tool | Kind | What it does |
| --- | --- | --- |
| `get_state` | read | What is done, what is stuck, and the one next step. Call this first |
| `save_property` | change | Saves the property address, type, time zone, name, facts, help number, alert contact, building access, and entry instructions. A street with no state or ZIP leaves the time zone unset. Changing only the state still checks a ZIP already saved. A mismatch asks which to fix and saves nothing |
| `save_units` | change | Adds, renames, or updates units and their leasing details. Say the `place`, never Main Home |
| `save_doors_and_routes` | change | Saves doors and walking routes, or with preview true only shows the matched route |
| `save_hours` | change | Saves touring days and hours from everyday words. Tours have to end later the same day. Tours must last 15 minutes to 4 hours, and starts must be 15 minutes to 8 hours apart |
| `save_settings` | change | Saves the basic identity form (recommended) or no form, plus tour-update choices. No form asks first, because anyone who texts could book and get in without saying who they are |
| `set_up_texting` | change | Sets up texting for this install (the provider, the line, and the check). The landlord chooses the provider here |
| `run_checks` | change | Runs the readiness check and a practice tour, including the connection, door-access, and alert self-tests |
| `publish` | consequential | Publishes the property for demo after a yes to the confirmation it returns |
| `remove_property` | consequential | Removes a property after a yes |
| `get_tours` | read | Tours happening now and tours coming up |
| `schedule_tour` | consequential | Books a one-off tour after a yes |
| `cancel_tour` | consequential | Calls off a tour after a yes. Destructive hint |
| `hold_tour` | consequential | Holds a tour after a yes |
| `pause_tours` | consequential | Pauses or resumes tours for a property or unit after a yes (`paused` true or false) |
| `get_inbox` | read | What needs the landlord, including a tour-update event id |
| `reply_to_time_request` | consequential | Answers a requested tour time after a yes |
| `resolve_issue` | consequential | Handles an open issue. Show `visitorWillReceive` before a yes |
| `export_records` | read | A day's tour records as a validated export. Each embedded tour keeps only that day's events and grants. Practice-tour denials are counted apart from visitors who were turned away |
| `backup_records` | change | Portable backup: create, confirm the destination, confirm it was stored, status, or decline. On a hosted install, a decline says operational records stay with hosted Tour Core. When records are already on this computer, or Google Drive is still waiting for approval, it says your records stay on this computer and portable backups stay off until Google Drive is connected |
| `restore_records` | consequential | Upload, preview, or import a backup. Import asks first. Destructive hint. An upload whose declared size is over the cap is refused and the connection is cut after at most 1 MB |

`reset_hosted_demo` is added for the current hosted owner only. It is not offered on a self-hosted or local Tour Core. It does not take a file path and it does not run a shell command.

## Ops connector

Needs `TOURCORE_OPS_TOKEN`. A landlord token cannot list or call these.

| Tool | Kind | What it does |
| --- | --- | --- |
| `discover_storage` | read | Finds an existing records store this install can take over |
| `takeover_storage_writer` | consequential | Takes over as the writer for that store. Destructive hint |
| `prepare_storage_migration` | read | Checks a move onto Google Drive before it starts |
| `migrate_storage_to_google_drive` | change | Copies records onto Google Drive |
| `verify_storage_migration` | read | Checks the copy |
| `activate_google_drive_storage` | change | Starts using the copied records |
| `disconnect_google_drive_storage` | consequential | Disconnects Google Drive storage. Destructive hint |
| `get_storage_status` | read | Where records live right now |
| `get_storage_location` | read | The folder those records use |
| `begin_google_drive_connect` | change | Starts Google's approval so Tour Core can save records there |
| `finish_google_drive_setup` | change | Finishes that approval |
| `check_runtime_health` | read | When records aren't on permanent storage: Whether this Tour Core is healthy. Whoever set up your Tour Core hosting needs to attach permanent storage. Until then, hold off on updating Tour Core. |
| `check_public_endpoint` | read | Whether the public address reaches this installation |

## QA connector

Needs `TOURCORE_QA_TOKEN`. A landlord token cannot list or call these.

| Tool | Kind | What it does |
| --- | --- | --- |
| `inject_local_sms` | change | Sends a visitor text on the local loopback. Leave `property` out to use the shared line and not name a place |
| `read_local_outbox` | read | Outbound local replies as separate bubbles |
| `use_local_demo_storage` | change | Keeps records on this computer for a demo |

There is intentionally no tool to open, unlock or grant a door, mint access,
change the door-access mode, or read or write raw files. There is also no
tool that sets an API key, sender key, webhook secret or any other
credential, and none that runs a shell command: credentials are collected
with a secure secret input and written by filling Tour Core's setup form, and runtime management (install, start,
restart) is done by Grok in its own terminal with `npm run bootstrap:grok`
and `npm run service:*`.
