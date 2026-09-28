# Manual test: Tour Core Bot in a real Grok Bot (P0 operator demo)

This is the manual real end-to-end regression script. **B** is the main run:
a fresh Grok-managed install, from one prompt to a published property with
tour updates, where the operator never touches their own terminal. **C** is
the visitor test on that published property, **D** the negative checks, and
**A** turns tour updates on for an install that already exists. The original
connection and operator-demo tests follow.

Record pass/fail, a screenshot and who acted (Grok or the operator) for each
row.

## A. Existing install: turn on tour updates

Needs: Grok connected to your current Tour Core (the connection tests below
pass), a published property, and a real phone that's a verified Sendblue
contact. Instructions for the routine Grok creates:
[`grok-template/routines/operator-updates.md`](../grok-template/routines/operator-updates.md).

| # | Do | Expect |
| --- | --- | --- |
| A1 | Update Tour Core (restart `npm run setup` or `npm run service:restart`). Ask Grok *"Check my Tour Core installation."* | Grok calls `get_installation_status` and answers with a checklist: runtime, secure connection, Grok connection, visitor texting, tour records stored with this installation, access system Demo, "Tour updates aren't turned on yet" (or "Tour updates are off" if you declined before) |
| A2 | *"Turn on tour updates."* | Grok asks "Would you like me to keep you updated when someone books, starts or finishes a tour, and alert you if something needs your input?" and, if useful, recommends the defaults. Say yes: Grok calls `set_notification_preferences`, says "I'm setting up your tour updates.", creates the **Tour Core Operator Updates** routine itself and opens the secure setup page next to it (see B15 for the handoff) |
| A3 | Finish the handoff on the secure setup page | The **Tour updates (Grok Routine)** card has two masked fields and a masked "Or paste the routine's whole webhook example" box. After saving, Grok runs `test_operator_alerts` and the routine posts "Tour updates are connected. I'll let you know about your tours here." Nothing was typed into chat |
| A4 | Open the same setup link from another device, or `https://<tunnel>/install` | Not found |
| A5 | Ask Grok *"Test tour updates."* | Grok calls `test_operator_alerts`; the routine posts again; Grok never shows the address or key. Search the chat: neither value appears |
| A6 | *"What updates am I getting?"*, then *"Only tell me about problems."* | Grok reads `get_notification_preferences` (bookings, tour starts, completions and anything that needs attention), then saves `problems-only`. A new booking from the phone produces no update; an unknown question still does |

## B. Fresh Grok Bot, one prompt, no attachments

This is the development / open-source bootstrap. Start with a **completely
fresh** Grok Bot and a fresh Sendblue test setup. Do **not** attach
`bot-profile.md`, any `SKILL.md`, `template.json` or the `grok-template`
folder. The operator must not open a terminal on their own computer at any
point. Record where a person had to act.

Send only this (with the real repository address):

> Set up Tour Core, my AI landlord, using the open-source repository at
> https://github.com/&lt;owner&gt;/&lt;repo&gt;.
>
> Use your cloud computer to clone the repository. Read and follow the
> repository's GROK_BOOTSTRAP.md instructions as the authoritative installation
> guide.
>
> Do as much of the setup yourself as possible. Never ask me to paste secrets
> into chat. Use Tour Core's secure setup flow for credentials or
> authentication. After Tour Core is running, use its installation-status tools
> to determine what remains, test every component, then offer to configure my
> first property.
>
> Start now.

| # | Do | Expect |
| --- | --- | --- |
| B1 | Send the prompt above, nothing else | No files attached; Grok asks for nothing before starting |
| B2 | Watch Grok's cloud computer (**step 1: bootstrap Tour Core**) | Grok clones the repository on **its own** cloud computer, reads `GROK_BOOTSTRAP.md`, loads `.grok/skills/install-tour-core/SKILL.md` (and the other skills from `.grok/skills/`), and runs `npm run bootstrap:grok` |
| B2a | (Once `repository.url` is set) Repeat with a different repository address in the prompt | Grok stops and asks which repository to trust; `npm run bootstrap:grok` refuses to start ("Not starting an unexpected repository") |
| B3 | Read Grok's first message | Approximately: "I'll handle the technical setup and only ask when I need a login, approval or decision." Grok installs Tour Core without narrating the technical steps |
| B4 | Wait | "Tour Core is installed and running. I need your approval to connect to it. I've opened the approval screen. Check that the codes match and click Allow." The approval screen is in Grok's cloud browser |
| B5 | Take over the browser, check the codes match, click **Allow** | Without being asked: "Connected. I'm checking the rest of the setup now." Grok calls `get_installation_status` and `get_next_installation_step` |
| B6 | Wait (**step 2: connect Sendblue**) | "Visitor texting is the next step. I've opened Tour Core's secure setup page..." Grok does **not** offer property setup or ask what to do next |
| B7 | Take over the browser, enter the Sendblue key, secret and number, say "done" | Grok tests it itself, then: "Visitor texting is connected and working. Everything needed to start is connected and tested. Would you like to add your first property?" |
| B7a | Right after texting is connected | Grok does **not** mention tour updates, and never calls them required. The secure setup page shows only the texting section |
| B8 | Say yes (**step 3: create property**). Grok asks "What's the property address?"; answer *"144 Hillside Ave, Teaneck"* | Grok calls `create_property_setup` with the address only. It never suggests or invents a building name |
| B9 | **Step 4: confirm canonical address** | Grok reads back the address as Tour Core saved it ("144 Hillside Ave, Teaneck NJ") and the guessed time zone, and asks if that's right |
| B10 | **Step 5: property type** | "What type of property is this?" with single-family home, multifamily home, apartment building, other. Answer *"Apartment building"*: Grok saves it (`update_property_details`) and asks "Which units can people tour?" (A single-family answer would get "Should I call it "Main Home"...?" instead, never a made-up unit number) |
| B11 | **Step 6: units and unit profiles.** Answer *"1A, 1B, 2A and 2B."*, then in one go: *"1A and 1B are 2 bed 1 bath for $2,200. 2A is 3 bed 2 bath for $2,800 and 2B is 2 bed 2 bath for $2,500."* | Grok reads back one line per unit (e.g. "Unit 1A — 2 bed · 1 bath · $2,200/month · availability not given yet") and asks only "When are these units available?". Answer *"1A and 1B now, 2A October 15, 2B not sure yet"*, and when optional details are offered: *"All units have in-unit laundry."* Grok asks "Does that look right?" before doors; nothing was invented, and "not sure yet" shows as not listed |
| B12 | **Step 7: map routes.** *"Visitors come in the main entrance. No inside doors."* | `add_door` Main Entrance; Grok shows "Main Entrance → Unit 1A Door" (etc.) and asks "Is that right?" before saving each route |
| B13 | **Step 8: tour hours.** *"Every day, 9 to 6."* | Grok reads back the days and hours with the defaults (45-minute tours, a new tour every hour, 10 minutes early) |
| B14 | **Step 9: verification.** *"Basic form."* | Saved; Grok says full ID checks aren't available yet only if asked |
| B15 | **Step 10: texting is automatic.** Watch the next message | Grok does **not** ask "How do you want to text people?" or where to keep records. The review lists: 144 Hillside Ave, Teaneck NJ / Apartment building / each unit with its details line and route / "Tours: ..." / "Verification: ..." / "Visitor texting: Connected" / "Door access: Demo", then "Does that look right?" |
| B16 | Say yes (**step 11: offer tour updates**) | "Your property is configured. Would you like me to keep you updated when someone books, starts or finishes a tour, and alert you if something needs your input?" Say *"Sure"*: Grok may add "I recommend alerts for bookings, tour starts, completions and anything that needs your attention. Want to use those defaults?" Say yes. Grok calls `set_notification_preferences` (recommended) and says "I'm setting up your tour updates." (Saying no instead skips updates and moves on) |
| B16a | Watch Grok's cloud computer | Grok creates the **Tour Core Operator Updates** routine itself (authenticated webhook trigger), then opens Tour Core's secure setup page next to the routine's trigger panel. Record how the panel shows the webhook address and key |
| B16b | Handoff | If both values stay hidden behind copy buttons, Grok copies each into the masked Tour Core fields itself without reading them. If either is visible on screen, Grok does **not** move it: it hands you the browser and asks you to copy both values across, or to paste the whole webhook example into Tour Core's paste box. Neither value appears in chat, tool arguments, files or commands |
| B16c | After saving | Grok runs `test_operator_alerts`; the routine posts "Tour updates are connected. I'll let you know about your tours here." |
| B17 | Wait (**step 12: readiness**) | "Prospects can text your touring number to ask questions, choose a unit and time, verify their details, and complete the self-guided tour in the same conversation. I'll run a readiness check and a practice tour before we turn it on." Grok runs the readiness check without asking whether to skip it |
| B18 | Wait (**step 13: practice tour**) | Practice tour passes with its proof points; no text reaches your phone, and no tour update is posted for it |
| B19 | **Step 14: publish.** Grok: "Everything passed. Would you like me to publish 144 Hillside Ave for demo?" Say *"not yet"*, then *"yes"* | "not yet": still Draft. "yes": published, and Grok says "Your property is published. Visitor texting is live. Door access is still in demo mode, so no physical locks will open. I'll keep you updated on your tours and let you know when something needs your attention." Never "everything runs in demo mode" |
| B19a | Throughout B3–B19 | None of these appear in the chat: a `trycloudflare.com` address, `/mcp`, a tool count, "connector", "OAuth", "tunnel", "webhook", "routine", ports, commands, environment variables or process ids. Grok never asks which setup step to do next |
| B20 | On the cloud computer, stop Tour Core (Grok runs `npm run service:stop`), then ask Grok anything | Grok notices Tour Core isn't answering, runs `npm run bootstrap:grok`, and Tour Core is back with the same installation (same records) |
| B21 | Stop the tunnel too (`npm run service:stop -- --tunnel`) and bootstrap again | New `trycloudflare.com` address. Status shows the Grok connection and visitor texting need action. Grok reconnects (you approve again) and runs `test_visitor_messaging`, which moves Sendblue's webhook to the new address |

Pass = no attached files, no terminal on the operator's computer, no
credential in chat, no infrastructure jargon in the happy path, the operator
only approved, signed in, entered credentials on the secure setup page,
answered property questions and made decisions, and the order was exactly:
texting → property (address, type, units with details, routes, hours,
verification; texting automatic) → offer tour updates → readiness → practice
tour → publish.

## C. Visitor test on the published property

Continue from B with the property published and tour updates on. Use the real
phone. "Testy" below is whatever first name you give on the identity form.

| # | Do | Expect |
| --- | --- | --- |
| C1 | Text the touring number *"Hi"* | "Welcome to the self-guided tour for 144 Hillside Ave! I can answer questions about the property and help you tour on your own. Which unit would you like to see?" and the unit menu |
| C2 | Before choosing, text *"How much is 1A?"* | The answer from Unit 1A's details ($2,200/month), then the same unit menu again. No booking was needed to ask |
| C3 | Choose Unit 1A | Offered times, e.g. "I have 2:00 PM and 3:30 PM available on ... Which works for you?" |
| C4 | While choosing a time, text *"Does it have laundry?"* | The laundry answer from the unit details, then the **same** times re-presented |
| C5 | Pick a time, agree to texts, fill the identity form | Booking confirmed on the phone. Without anyone asking, Grok posts "New tour booked: Testy is scheduled to tour Unit 1A today at ..." |
| C6 | Arrive (developer mode "Move tour to now" if needed) and start the tour | Grok posts "Testy's Unit 1A tour has started." |
| C7 | Inside, text *"Is there a pool?"* | Immediately: "I don't have that information for this property. I've flagged it for the property team so they can get back to you." Grok, unprompted, tells you Testy asked about a pool and asks what to tell them (not a yes/no) |
| C8 | Reply *"No pool, but there's a gym on the roof."*, then *"yes"* to Grok's one confirmation | The phone gets exactly that answer, then the tour step it was on. The property stays **Published for demo**; no readiness check or practice tour is asked for |
| C9 | *"What needs attention?"* | Nothing: the question is resolved |
| C10 | Finish the tour from the phone ("I'm done", "yes") | Recap and follow-up on the phone. Grok posts "Testy's Unit 1A tour is complete." |
| C11 | Ask Grok to change the tour hours | Grok says this is a structural change; afterwards the property is back to draft and needs readiness, a practice tour and your yes to republish |

## D. Negative checks

| # | Do | Expect |
| --- | --- | --- |
| D1 | Look at a delivered update's payload (the routine's run history in Grok, or Tour Core's outbox on the cloud computer) | Only `schemaVersion`, `eventId`, `eventType`, `propertyId`, `tourId` or `exceptionId`, `occurredAt`. No visitor names, phone numbers or message text |
| D2 | From a new phone thread, before choosing a unit, text *"How much is it?"* | "Which unit do you mean: 1A, 1B, 2A or 2B?" Answer *"2A"*: the rent, then the unit menu again |
| D3 | In the browser app, switch the property to practice texts, then ask Grok to publish | Publishing is refused: "Visitor texting is connected, but this property isn't using it yet. I'll connect the property to your touring number before publishing." Grok switches it back itself, reruns the readiness check and practice tour, and asks the publish question again. It never asks how to text people |
| D4 | Run a practice tour, and a tour in the browser demo | No tour updates are posted for either |
| D5 | Turn on cancellations (*"Also tell me about cancellations."*) after a tour was already cancelled | Only cancellations from now on are posted; the earlier one is never sent late |
| D6 | Break updates on purpose: on the secure setup page enter a wrong key; text a new unknown question | The visitor still gets the fallback at once. `get_installation_status` shows tour updates as an error. Enter the right key again: the pending update is delivered once, with no duplicate |
| D7 | Search the whole chat | Never "everything runs in demo mode", never the routine's address or key, never ids or codes |

The final template experience is simpler still: install the Tour Core Bot
template and say *"Set up Tour Core."* The template already knows the
canonical repository and the bootstrap behavior, so rows B2 onward apply
unchanged.

---

## Connection and operator demo

Not part of `npm test`. Needs a Grok Bot account, the Tour Core computer with
Sendblue and a tunnel (README), and one real phone that's a verified Sendblue
contact. Use a fresh `TOURCORE_HOME` so earlier properties don't interfere:

```powershell
$env:TOURCORE_HOME = "$PWD\tourcore-grok-test"; npm run setup
```

`.env` must not set `TOURCORE_MCP_AUTH_MODE` (OAuth is the default). If an
earlier static setup left a Tour Core connector with a `Bearer` header in
Grok, remove it first.

Record pass/fail and a screenshot for each step.

### P0 only: Grok legacy OAuth compatibility

Grok Bot currently connects through Cursor's MCP client. When it registers
with Tour Core (Dynamic Client Registration), it sends this callback set:

```
cursor://anysphere.cursor-mcp/oauth/callback
https://www.cursor.com/agents/mcp/oauth/callback
http://localhost:8787/callback
```

Normal Tour Core OAuth stays strict. It allows https on Grok's hosts, or a
loopback address. So it refuses the whole registration because of the first
two, and Grok never reaches the approval page. The Tour Core window shows
`Refused an MCP client registration from "Cursor" ...` with one
`refused redirect: scheme=... host=... path=... reason: ...` line per URI.

This flag exists only because of that currently observed Grok Bot/Cursor
behavior. To enable it for P0 Grok testing:

1. Add to `.env`: `TOURCORE_GROK_LEGACY_OAUTH_COMPAT=true`
2. Restart Tour Core (`Ctrl+C`, `npm run setup`). The startup lines now include
   the warning *"Grok legacy OAuth compatibility is enabled for this P0 demo..."*,
   and so does the Connect Grok page. `npm run grok:status` shows
   `Grok legacy .... ON`.
3. In Grok, remove the Tour Core connector if it's half-added, then add it again
   and go through C3–C7 below.

What it changes: registration also accepts exactly
`cursor://anysphere.cursor-mcp/oauth/callback` and
`https://www.cursor.com/agents/mcp/oauth/callback`. They must match as exact
strings. Nothing else is accepted: no other `cursor://` address, no other
custom scheme, no other `cursor.com` or `cursor.sh` host or path, and no
wildcards. Everything else is unchanged:

- owner approval on this computer with the matching code
- PKCE S256, `state`, exact redirect match and single-use codes
- token lifetime, scope and revocation
- Tour Core's confirmation codes, policy and Durin

`api2.cursor.sh` is **not** allowed. If a refusal line names it, copy that
whole `refused redirect: ...` line into the test notes. Only if the real flow
proves that exact URI is Grok's callback should it be considered.

**Turn it off** once Grok no longer registers the legacy callback. You'll know
because a registration with the flag off stops producing `scheme=cursor` or
`host=www.cursor.com` refusals. To turn it off, delete the line from `.env` and
restart Tour Core. Grok connections that used a legacy callback then need
reconnecting. Tour Core refuses those callbacks immediately once the flag is off.

### Connect with OAuth

| # | Do | Expect |
| --- | --- | --- |
| C1 | Tour Core and the tunnel running. On any computer: `curl -i -X POST https://<tunnel>/mcp` | `401`; `WWW-Authenticate: Bearer resource_metadata="https://<tunnel>/.well-known/oauth-protected-resource/mcp", scope="tourcore.operator"` |
| C2 | `curl https://<tunnel>/.well-known/oauth-protected-resource/mcp` and `curl https://<tunnel>/.well-known/oauth-authorization-server` | JSON; `authorization_servers` is `["https://<tunnel>"]`; the second lists `/authorize`, `/token`, `/register`, `/revoke`, `S256` |
| C3 | In Grok: New Connector → Custom → `https://<tunnel>/mcp`, no token or header | Grok opens a **Tour Core** page: "Grok is requesting permission to manage this Tour Core installation", can/can't lists, a six-digit code. Tour Core's window logs "An MCP client registered... (redirects: ...)" and "Authorization request from ...: will return to ..." (no 404, no refusal). Record both lines |
| C4 | On the Tour Core computer | A **Connect Grok** window opened by itself (else open `http://localhost:4321/grok`); same code as the Grok page |
| C5 | On the Grok-opened page, try to approve: there's no Allow there. From another device, open `https://<tunnel>/grok` | Only Deny on the public page; `/grok` through the tunnel is "Not found" |
| C6 | Click **Allow** on the Connect Grok window | Grok's page returns to Grok; Grok shows Tour Core connected; Connect Grok lists "Grok since ..." |
| C7 | Ask Grok *"List the Tour Core tools you can use."* then *"List my properties."* | 48 tools (34 property and tour + 14 installation), nothing that unlocks a door or sets a credential; `list_properties` runs and returns this Tour Core's real properties |
| C8 | Search the Grok chat for any Tour Core token | None: no credential was ever typed or shown |
| C9 | (Later) Click **Disconnect Grok** (or `npm run grok:disconnect`), then ask Grok to list properties | Grok gets an authorization error and asks to reconnect; properties, tours and Sendblue unchanged. Reconnect (C3–C6) before continuing |
| C10 | Connect again, but click **Deny** | Grok reports the connection was refused; nothing connected |

If C3 fails with a registration error, the Tour Core window names the refused
redirect host. See "If Grok says the connection failed during registration" in
the [setup guide](grok-template-setup.md).

### Operator demo

| # | Do | Expect |
| --- | --- | --- |
| 1 | Add/install the Tour Core Bot ([setup guide](grok-template-setup.md) steps 3–5, or install from the team template and reconnect with OAuth as above). Ask *"List the Tour Core tools you can use."* | 48 Tour Core tools; nothing that unlocks or opens a door, and nothing that takes a credential |
| 2 | *"Set up a property"* | Bot asks "What's the property address?"; one question at a time; no field names or codes |
| 3 | Answer: 100 Alfred Way, Brooklyn NY; apartment building; two units (101, 102); one entrance ("Lobby Entrance"); no hallway doors. Confirm routes when shown | Bot confirms the address, asks "What type of property is this?", never invents a building name; shows "Lobby Entrance → Unit 101 Door" and asks "Is that right?" before saving; in the browser app the same property shows both routes |
| 3a | Say *"Unit 102 goes through the side gate"* | Bot says it doesn't have a side gate on file and lists the doors; nothing saved |
| 4 | Tour hours: *"Weekdays, 9 to 5"* | Bot reads back weekdays 9 AM–5 PM with the defaults |
| 5 | Verification: basic form | Bot doesn't ask how to text people (the property already uses the installed texting); `get_services` shows messaging connected |
| 6 | Confirm the read-back. Bot runs readiness | Checklist matches the browser app's readiness screen for the property, including "Visitor messaging connected" |
| 7 | Bot runs the practice tour | Proof points including early arrival denied and Unit 102 Door denied before Durin was contacted; no text reaches your phone |
| 8 | Bot asks to publish. First say *"not yet"*, then *"yes"* | "not yet": still Draft in the browser app. "yes": Published for demo; Bot says visitor texting is live and door access is still in demo mode |
| 9 | From the real phone, text the Sendblue number "Hi" and book Unit 101 at the next time; consent; fill the identity form | Normal visitor flow (unchanged) |
| 10 | *"Show active tours"* | Your name, Unit 101, tour time, status; no ids |
| 11 | Arrive and enter Unit 101 (developer mode "Move tour to now" if needed). Text *"is parking included?"* | "I don't have that information..." on the phone |
| 12 | *"What needs attention?"* | "Asked "is parking included?". There's no approved answer yet. Tour still active." |
| 13 | *"Open that issue. Yes, parking is included."* Then *"yes"* | Bot asks once before adding the fact; after yes the phone gets the exact fact and the tour step it was on; issue shows handled; the property stays published |
| 13a | *"Pause the tour"*, *"yes"*; text "I'm at unit 101"; then *"resume it"*, *"yes"* | While paused the phone gets "Your tour is paused..." and no door opens; after resume doors work again in the window |
| 13b | *"Just unlock 102 for me"* | Bot refuses: it can't open doors |
| 14 | Finish the tour from the phone ("I'm done", "yes") | Recap and follow-up; *"Show active tours"* is empty |
| 15 | *"Export today's audit"* | Summary: 1 visitor tour completed, access denials, 1 question needing attention, plus practice tours; file listed; `http://localhost:<port>/api/properties/<id>/audit-exports/<export>/audit-export.json` opens on the Tour Core computer |
| 16 | Start a **new** Grok conversation and ask *"What's the status of 100 Alfred Way?"* | Same state as before (from Tour Core, not memory) |
| 17 | Restart Tour Core (Ctrl+C, `npm run setup`), then ask *"Show exceptions"* | Still answers without reconnecting (approvals survive a restart); a confirmation code from before the restart is refused if reused |
| 17a | Wait over an hour (or leave Grok idle), then ask anything | Still answers: Grok renewed its token. If Grok didn't register for refresh tokens it asks to reconnect instead; note which |
| 18 | Stop the tunnel and ask anything | Bot says the Tour Core connector is unreachable and stops; nothing is invented |

Also note what Grok actually did during C3 (from the Tour Core window): the
client name it registered, the redirect host, and whether it asked for
refresh tokens. Those facts aren't in xAI's public docs.

Pass = every row matches. The browser app stays usable throughout and shows
the same property, tours and history.
