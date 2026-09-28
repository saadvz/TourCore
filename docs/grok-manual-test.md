# Manual test: Tour Core Bot in a real Grok Bot (P0 operator demo)

Two new tests come first: **A** (an existing install gets proactive operator
alerts) and **B** (a fresh Grok-managed install where the operator never
touches their own terminal). The original connection and operator-demo tests
follow.

## A. Existing install: operator alerts

Needs: Grok connected to your current Tour Core (the connection tests below
pass), a real phone that's a verified Sendblue contact, and the **Tour Core
Exception Alert** routine created in Grok with an authenticated webhook trigger
([routine instructions](../grok-template/routines/exception-alert.md)). Rotate
the routine's sender key first so the value you use has never been shown
anywhere.

| # | Do | Expect |
| --- | --- | --- |
| A1 | Update Tour Core (restart `npm run setup` or `npm run service:restart`). Ask Grok *"Check my Tour Core installation."* | Grok calls `get_installation_status` and answers with a checklist: runtime, public address, Grok connection, visitor messaging (if it says "hasn't been checked", Grok runs `test_visitor_messaging` itself), operator alerts not connected, tour records stored with this installation, access system Demo |
| A2 | Grok offers to connect alerts. It calls `get_secure_setup_url` | A link `http://localhost:4321/install#s=...` for the Tour Core computer's browser. On the Tour Core computer you can also run `npm run install:link` |
| A3 | Open the link on the Tour Core computer. Enter the routine's webhook address and the **new** key. Click **Save and send a test alert** | "Sent a test alert..." on the page. The routine wakes and posts "Operator alerts are connected." Nothing was typed into chat |
| A4 | Open the same link from another device, or `https://<tunnel>/install` | Not found |
| A5 | Ask Grok *"Test operator alerts."* | Grok calls `test_operator_alerts`; the routine posts again; Grok never shows the address or key. Search the chat: neither value appears |
| A6 | From the real phone, start a tour and get into Unit 101 (developer mode "Move tour to now" if needed) | Normal visitor flow |
| A7 | Text *"Is there a pool?"* | Immediately: "I don't have that information for this property. I've flagged it for the property team..." |
| A8 | Don't say anything to Grok | Within seconds the routine wakes, calls `inspect_exception`, and posts something like: "A visitor touring Unit 101 asked whether the property has a pool. Tour Core doesn't have an approved answer. The tour is still active. Would you like to add an approved answer or leave it for the property team?" |
| A9 | Reply *"There's no pool, but there's a gym on the roof."*, then *"yes"* | Work Exception flow: Grok asks before adding the fact; after yes the phone gets exactly that text |
| A10 | Text another message from the phone | No second alert for the pool question |
| A11 | Break alerts on purpose: on the secure setup page enter a wrong key; text a new unknown question | The visitor still gets the fallback at once. `get_installation_status` shows operator alerts as an error. Enter the right key again: the pending alert is delivered once, with no duplicate |

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
| B2 | Watch Grok's cloud computer | Grok clones the repository on **its own** cloud computer, reads `GROK_BOOTSTRAP.md`, loads `.grok/skills/install-tour-core/SKILL.md` (and the other skills from `.grok/skills/`), and runs `npm run bootstrap:grok` |
| B2a | (Once `repository.url` is set) Repeat with a different repository address in the prompt | Grok stops and asks which repository to trust; `npm run bootstrap:grok` refuses to start ("Not starting an unexpected repository") |
| B3 | Read Grok's first message | Approximately: "I'll handle the technical setup and only ask when I need a login, approval or decision." Grok installs Tour Core without narrating the technical steps |
| B4 | Wait | "Tour Core is installed and running. I need your approval to connect to it. I've opened the approval screen. Check that the codes match and click Allow." The approval screen is in Grok's cloud browser |
| B5 | Take over the browser, check the codes match, click **Allow** | Without being asked: "Connected. I'm checking the rest of the setup now." Grok calls `get_installation_status` and `get_next_installation_step` |
| B6 | Wait | "Visitor texting is the next step. I've opened Tour Core's secure setup page..." Grok does **not** offer property setup or ask what to do next |
| B7 | Take over the browser, enter the Sendblue key, secret and number, say "done" | Grok tests it itself, then: "Visitor texting is connected and working. Everything needed to run Tour Core is connected and tested. Would you like to add your first property?" |
| B8 | Say yes and configure a property conversationally | Plain questions ("What's the property address?", "How many units can people self-tour?", "When can people tour?", "How carefully do you want to verify visitors?"); no field names |
| B9 | Once the property is saved | "Your property is configured. Would you like me to keep an eye on tours and let you know when a visitor needs help...?" Say yes: "I'm setting up alerts...", Grok creates the alert itself, then "I've created the alert. I opened Tour Core's secure setup page so you can finish connecting it without putting any credentials in chat." Enter the details there; Grok sends a test alert. (Saying no instead skips alerts and moves on) |
| B10 | Wait | Grok explains how prospects use it and says it will run a readiness check and a practice tour, then runs both without asking whether to skip them |
| B11 | Grok: "Everything passed. Would you like me to publish this property for demo?" Say yes | Published. "Your property is live for demo. I'll keep an eye on tours and let you know when something needs your attention." |
| B11a | Throughout B3–B11 | None of these appear in the chat: a `trycloudflare.com` address, `/mcp`, a tool count, "connector", "OAuth", "tunnel", ports, commands, environment variables or process ids. Grok never asks which setup step to do next |
| B12 | Text the property from the real phone, ask something unknown | Proactive alert as in A7–A8 |
| B13 | On the cloud computer, stop Tour Core (Grok runs `npm run service:stop`), then ask Grok anything | Grok notices Tour Core isn't answering, runs `npm run bootstrap:grok`, and Tour Core is back with the same installation (same records) |
| B14 | Stop the tunnel too (`npm run service:stop -- --tunnel`) and bootstrap again | New `trycloudflare.com` address. Status shows the Grok connection and visitor messaging need action. Grok reconnects (you approve again) and runs `test_visitor_messaging`, which moves Sendblue's webhook to the new address |

Pass = no attached files, no terminal on the operator's computer, no
credential in chat, no infrastructure jargon in the happy path, the operator
only approved, signed in, entered credentials on the secure setup page,
answered property questions and made decisions, and every row matches.

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
| C7 | Ask Grok *"List the Tour Core tools you can use."* then *"List my properties."* | 42 tools (32 operator + 10 installation), nothing that unlocks a door or sets a credential; `list_properties` runs and returns this Tour Core's real properties |
| C8 | Search the Grok chat for any Tour Core token | None: no credential was ever typed or shown |
| C9 | (Later) Click **Disconnect Grok** (or `npm run grok:disconnect`), then ask Grok to list properties | Grok gets an authorization error and asks to reconnect; properties, tours and Sendblue unchanged. Reconnect (C3–C6) before continuing |
| C10 | Connect again, but click **Deny** | Grok reports the connection was refused; nothing connected |

If C3 fails with a registration error, the Tour Core window names the refused
redirect host. See "If Grok says the connection failed during registration" in
the [setup guide](grok-template-setup.md).

### Operator demo

| # | Do | Expect |
| --- | --- | --- |
| 1 | Add/install the Tour Core Bot ([setup guide](grok-template-setup.md) steps 3–5, or install from the team template and reconnect with OAuth as above). Ask *"List the Tour Core tools you can use."* | 42 Tour Core tools; nothing that unlocks or opens a door, and nothing that takes a credential |
| 2 | *"Set up a property"* | Bot asks "What's the property address?"; one question at a time; no field names or codes |
| 3 | Answer: 100 Alfred Way, Brooklyn NY; two units (101, 102); one entrance ("Lobby Entrance"); no hallway doors. Confirm routes when shown | Bot shows "Lobby Entrance → Unit 101 Door" and asks "Is that right?" before saving; in the browser app the same property shows both routes |
| 3a | Say *"Unit 102 goes through the side gate"* | Bot says it doesn't have a side gate on file and lists the doors; nothing saved |
| 4 | Tour hours: *"Weekdays, 9 to 5"* | Bot reads back weekdays 9 AM–5 PM with the defaults |
| 5 | Verification: basic form. Texting: *"Real texts"* (Sendblue). Records: on this computer | Bot says Google Drive isn't available yet; `get_services` shows messaging connected |
| 6 | Confirm the read-back. Bot runs readiness | Checklist matches the browser app's readiness screen for the property, including "Visitor messaging connected" |
| 7 | Bot runs the practice tour | Proof points including early arrival denied and Unit 102 Door denied before Durin was contacted; no text reaches your phone |
| 8 | Bot asks to publish. First say *"not yet"*, then *"yes"* | "not yet": still Draft in the browser app. "yes": Published for demo |
| 9 | From the real phone, text the Sendblue number "Hi" and book Unit 101 at the next time; consent; fill the identity form | Normal visitor flow (unchanged) |
| 10 | *"Show active tours"* | Your name, Unit 101, tour time, status; no ids |
| 11 | Arrive and enter Unit 101 (developer mode "Move tour to now" if needed). Text *"is parking included?"* | "I don't have that information..." on the phone |
| 12 | *"What needs attention?"* | "Asked "is parking included?". There's no approved answer yet. Tour still active." |
| 13 | *"Open that issue. Yes, parking is included."* Then *"yes"* | Bot asks before adding the fact; after yes the phone gets the exact fact; issue shows handled; Bot says the setup needs rechecking before republishing |
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
