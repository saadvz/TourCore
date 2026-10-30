import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { tenantFolder, type Tenant } from "../src/cleaner-core/hosted/registry";
import { PER_TENANT_NAMES } from "../src/cleaner-core/hosted/tenantEnv";
import { buildTouringEnv } from "../src/hosted/touringEnv";
import { readScratchInbox } from "../src/hosted/touringScratch";
import { closeHostedApps } from "./cleanerOauthHarness";
import { multiTenantApp, type MultiTenantApp } from "./multiTenantHarness";

/**
 * docs/tour-core-safety-gates.md, hosted tenants: two touring tenants (Lane, Mill) and one cleaning
 * tenant (Court) on one shared service. No text, grant, link, call, setting, or stand-down reaches
 * another tenant. Only 555 numbers.
 */

const LANE = "+15555550150";
const MILL = "+15555550170";
const COURT = "+15555550160";
const VISITOR = "+15555550177";
const SLOW = { timeout: 180_000 };

let open: MultiTenantApp | undefined;
afterEach(() => {
  open?.close();
  open = undefined;
  closeHostedApps();
});

async function three() {
  const m = (open = await multiTenantApp({ env: { TOUR_CORE_TENANTS: "1", CLEANER_CORE_SCRATCH_TOOLS: "1" } }));
  const join_ = async (label: string, number: string, service: "touring" | "cleaning") => {
    const { tenant } = m.registry.create({ label, twilioNumber: number });
    const token = await m.joinAt(tenant.id, "grok", "/mcp");
    await m.toolAt("/mcp", token, "choose_service", { service });
    return { tenant: m.registry.get(tenant.id)!, token };
  };
  const lane = await join_("Lane", LANE, "touring");
  const mill = await join_("Mill", MILL, "touring");
  const court = await join_("Court", COURT, "cleaning");
  return { m, lane, mill, court };
}

const manifestId = (m: MultiTenantApp, t: Tenant) => (JSON.parse(readFileSync(join(tenantFolder(m.app.root, t.id), "tour-core", "install", "manifest.json"), "utf8")) as { installationId: string }).installationId;

describe("hosted tenants gate", () => {
  it("gives a text to the number's own tenant only", SLOW, async () => {
    const { m, lane, mill } = await three();
    expect((await m.text(LANE, VISITOR, "Tour", "SMiso1")).status).toBe(200);
    expect(readScratchInbox(m.hosted(), lane.tenant.id)).toEqual([{ from: VISITOR, text: "Tour" }]);
    expect(readScratchInbox(m.hosted(), mill.tenant.id)).toEqual([]);
  });

  it("never lets a text to the cleaning number reach a touring process", SLOW, async () => {
    const { m, lane, mill } = await three();
    expect((await m.text(COURT, VISITOR, "Tour", "SMiso2")).status).toBe(200);
    expect(readScratchInbox(m.hosted(), lane.tenant.id)).toEqual([]);
    expect(readScratchInbox(m.hosted(), mill.tenant.id)).toEqual([]);
  });

  it("answers a grant with its own tenant's records, at /mcp and at /mcp/cleaner-core", SLOW, async () => {
    const { m, lane, mill } = await three();
    await m.text(LANE, VISITOR, "Tour", "SMiso3");
    const laneInbox = await m.toolAt("/mcp", lane.token, "read_inbox");
    const millInbox = await m.toolAt("/mcp", mill.token, "read_inbox");
    expect(laneInbox.structured?.texts).toEqual([{ from: VISITOR, text: "Tour" }]);
    expect(millInbox.structured?.texts).toEqual([]);
    const laneAtAlias = await m.toolAt("/mcp/cleaner-core", lane.token, "read_inbox");
    expect(laneAtAlias.status).not.toBe(200);
  });

  it("sends a /t/<id>/ link to the touring process the prefix names", SLOW, async () => {
    const { m, lane, mill } = await three();
    const laneHealth = (await (await m.app.http(`/t/${lane.tenant.id}/healthz`)).json()) as { installation?: string };
    const millHealth = (await (await m.app.http(`/t/${mill.tenant.id}/healthz`)).json()) as { installation?: string };
    expect(laneHealth.installation).toBeDefined();
    expect(laneHealth.installation).not.toBe(millHealth.installation);
    expect(manifestId(m, lane.tenant)).not.toBe(manifestId(m, mill.tenant));
  });

  it("builds a touring process's settings from its own tenant only", () => {
    const base: NodeJS.ProcessEnv = { PATH: "/usr/bin" };
    for (const name of PER_TENANT_NAMES) base[name] = `court-or-mill-${name}`;
    const lane: Tenant = { id: "tnt_lane000001", label: "Lane", twilioNumber: LANE, connections: [], invites: [], service: "touring", createdAt: "2026-10-30T00:00:00.000Z" };
    const env = buildTouringEnv({ base, tenant: lane, dataRoot: "/data", origin: "https://s.up.railway.app", key: "k", scratch: false });
    for (const value of Object.values(env)) expect(String(value)).not.toContain("court-or-mill");
    expect(env.TOURCORE_TWILIO_PHONE_NUMBER).toBe(LANE);
  });

  it("keeps a switch and a stand-down to one tenant", SLOW, async () => {
    const { m, lane, mill, court } = await three();
    const asked = await m.toolAt("/mcp", lane.token, "switch_service", { to: "cleaning" });
    const code = (asked.structured?.confirmation as { code: string }).code;
    await m.toolAt("/mcp", lane.token, "switch_service", { to: "cleaning", confirmation: code });
    expect(m.registry.get(lane.tenant.id)?.service).toBe("cleaning");
    expect(m.registry.get(mill.tenant.id)?.service).toBe("touring");
    expect(m.touring()!.supervisor.target(mill.tenant.id)).toBeDefined();
    expect((await m.toolAt("/mcp", court.token, "stand_down_service")).isError).toBe(false);
    expect(m.registry.get(court.tenant.id)?.service).toBe("cleaning");
    expect(m.touring()!.supervisor.target(mill.tenant.id)).toBeDefined();
  });
});
