import { describe, expect, it } from "vitest";
import { failingGates, matrixTable, MATRIX_CLIENTS, runClientMatrix, spoofExtras } from "../../src/eval/clientMatrix";
import { diffNormalized } from "../../src/eval/diffConfig";
import { BASELINE_CLIENT_CAPABILITIES, selectPlaybook } from "../../src/playbooks/select";
import { GROK_ALERTS_SAY, GROK_WAKE_WITH_PLACE } from "../../src/playbooks/grok";

describe("per-agent client matrix", () => {
  it("holds every safety gate and a zero config diff for each client", async () => {
    expect(MATRIX_CLIENTS.map((client) => client.key)).toEqual(["grok", "chatgpt", "claude", "unknown", "spoofed-grok"]);
    expect(selectPlaybook({ name: "grok", capabilities: BASELINE_CLIENT_CAPABILITIES })).toMatchObject({ id: "baseline", mode: "tools" });
    const rows = await runClientMatrix();
    const extras = spoofExtras(rows);
    const table = matrixTable(rows, extras);
    console.log(`\n${table}\n`);
    expect(failingGates(rows), table).toEqual([]);
    expect(extras, table).toEqual([]);
    expect(diffNormalized(rows.map((row) => row.key), rows.map((row) => row.canonical)).differingFieldCount, table).toBe(0);
    const spoof = rows.find((row) => row.spoof);
    expect(spoof?.playbook.text).not.toContain(GROK_WAKE_WITH_PLACE);
    expect(spoof?.playbook.text).not.toContain(GROK_ALERTS_SAY);
    expect(spoof?.playbook.text).not.toContain("masked");
    const serialized = JSON.stringify(rows.map((row) => row.canonical));
    expect(serialized).not.toMatch(/145\s+Tenafly/i);
    expect(serialized).not.toMatch(/\b914B\b/);
    const across = rows.map((row) => row.configDiffs);
    expect(across).toEqual([0, 0, 0, 0, 0]);
  }, 600_000);
});
