# Manual test: Tour Core Bot in a real Grok Bot (P0 operator demo)

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
| C7 | Ask Grok *"List the Tour Core tools you can use."* then *"List my properties."* | 32 tools, nothing that unlocks a door; `list_properties` runs and returns this Tour Core's real properties |
| C8 | Search the Grok chat for any Tour Core token | None: no credential was ever typed or shown |
| C9 | (Later) Click **Disconnect Grok** (or `npm run grok:disconnect`), then ask Grok to list properties | Grok gets an authorization error and asks to reconnect; properties, tours and Sendblue unchanged. Reconnect (C3–C6) before continuing |
| C10 | Connect again, but click **Deny** | Grok reports the connection was refused; nothing connected |

If C3 fails with a registration error, the Tour Core window names the refused
redirect host. See "If Grok says the connection failed during registration" in
the [setup guide](grok-template-setup.md).

### Operator demo

| # | Do | Expect |
| --- | --- | --- |
| 1 | Add/install the Tour Core Bot ([setup guide](grok-template-setup.md) steps 3–5, or install from the team template and reconnect with OAuth as above). Ask *"List the Tour Core tools you can use."* | 32 Tour Core tools; nothing that unlocks or opens a door |
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
