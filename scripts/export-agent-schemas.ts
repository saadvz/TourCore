import { mkdirSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { AgentProfile, AgentProfileView } from "../src/agents/profile";

mkdirSync("docs/schemas", { recursive: true });
for (const [name, schema] of [["agent-profile", AgentProfile], ["agent-profile-view", AgentProfileView]] as const) {
  const document = z.toJSONSchema(schema);
  document.title = name === "agent-profile" ? "Stored AgentProfile" : "AgentProfile readiness response";
  writeFileSync(`docs/schemas/${name}.schema.json`, JSON.stringify(document, null, 2) + "\n");
  console.log(`Exported ${name} schema.`);
}
