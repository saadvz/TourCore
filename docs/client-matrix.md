# Per-agent client matrix

The matrix runs the safety gates and the ten-duplex config diff once for each client, over the MCP connectors. A client's playbook follows that client's name and capabilities. It is not cut down to the weakest client. The client name does not add a tool or skip a gate.

## Clients

| Client | `clientInfo.name` | Capabilities | Profile | What that profile adds |
| --- | --- | --- | --- | --- |
| Grok | `Grok` | elicitation, sampling, and roots | Grok, full | Notes in the agent's own memory, the masked card for the texting login, the agent's own folder for the portable copy, more than one setup step in a chat, and the tour-update wake. |
| ChatGPT | `ChatGPT` | elicitation | ChatGPT, tools | One step at a time and the secure setup link. Elicitation does not turn this profile into the full one. There is no wake. |
| Claude | `claude-ai` | elicitation, sampling, and roots | Claude, full | Keeping the playbook in a project, the secure setup link, and a draft only when the landlord asks for one. There is no wake. |
| Unknown | `example-client` | tools only | Baseline, tools | One step at a time, the secure setup link, and nothing filled in. Elicitation on an unknown name would still be this profile. |
| Spoofed | `grok` | tools only | Baseline, tools | Nothing beyond the unknown client. The name does not unlock the masked card, the wake, or any tool. |

A grok or Cursor name that sends no capabilities still gets the full Grok playbook. That is how those clients connect, and it is how a stored sign-in name is applied after a restart. `prompts` and `resources` are ignored. They do not count as a declared set.

Tool lists stay 21 on the landlord connector, 22 for the hosted owner (`reset_hosted_demo`), 15 on QA, and 13 on ops.

## Safety gates

Each client has to pass all of these:

- Landlord, hosted-owner, QA, and ops tool lists, including annotations
- A landlord call to a QA tool is refused
- Publish and remove ask for a yes before anything changes
- The practice tour's safety checks hold: early arrival denied, an off-route door turned away, a repeat request does not grant access twice
- `initialize` instructions match, and they say a client name never changes a rule
- The playbook matches the profile in the table
- The ten duplexes at 18 Maple Street store the same config (zero fields differ)

The spoofed client is also compared with the unknown client. Playbook text, tool lists, gate results, and the stored duplex config have to match.

## Run it

```bash
npx vitest run --config vitest.eval.config.ts test/eval/clientMatrix.test.ts
```

`npm run test:eval` runs this file with the rest of the eval harness. `npm test` does not.
