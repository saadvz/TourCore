import { afterEach, describe, expect, it } from "vitest";
import { closeHostedApps } from "./cleanerOauthHarness";
import { multiTenantApp, type MultiTenantApp } from "./multiTenantHarness";
import { ROUTINE_KEY, ROUTINE_URL } from "./installHarness";

/**
 * A touring tenant's landlord alerts: the host connects a routine through a one-time link, and the
 * touring process's events reach that routine and no other. Only 555 numbers; wakes are faked.
 */

const LANE = "+15555550150";
const MILL = "+15555550170";
const SLOW = { timeout: 90_000 };
const MILL_URL = "https://routines.example/hooks/mill-routine-SECRETPATH";

let open: MultiTenantApp | undefined;
afterEach(() => {
  open?.close();
  open = undefined;
  closeHostedApps();
});

async function touringTenant(m: MultiTenantApp, label: string, number: string) {
  const { tenant } = m.registry.create({ label, twilioNumber: number });
  const token = await m.joinAt(tenant.id, "grok", "/mcp");
  await m.toolAt("/mcp", token, "choose_service", { service: "touring" });
  return { tenant, token };
}

/** Asks for the link and posts the routine to it, as Grok's computer does. */
async function connectRoutine(m: MultiTenantApp, token: string, url = ROUTINE_URL, key = ROUTINE_KEY) {
  const reply = await m.toolAt("/mcp", token, "save_alert_routine");
  const link = /(https:\/\/\S+)$/.exec(reply.text)?.[1];
  expect(link).toBeDefined();
  const path = new URL(link!).pathname;
  return { reply, path, res: await m.app.http(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url, key }) }) };
}

const waitFor = async (check: () => boolean, ms = 30_000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("Timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
};

describe("touring alerts", () => {
  it("gives a private link and never repeats the routine's address or key", SLOW, async () => {
    const m = (open = await multiTenantApp({ env: { TOUR_CORE_TENANTS: "1" } }));
    const { tenant, token } = await touringTenant(m, "Lane", LANE);
    const { reply, path, res } = await connectRoutine(m, token);
    expect(reply.text).toMatch(/^Send the host this private link to paste the routine's webhook address and key\. Never in chat: https:\/\//);
    expect(path).toMatch(new RegExp(`^/t/${tenant.id}/touring/alert-routine/[A-Za-z0-9_-]{43}$`));
    expect(res.status).toBe(200);
    expect(await res.text()).not.toContain(ROUTINE_KEY);
    expect(m.app.logs.join("\n")).not.toContain(ROUTINE_KEY);
  });

  it("wakes the Grok routine with a test event, carrying no phone numbers", SLOW, async () => {
    const m = (open = await multiTenantApp({ env: { TOUR_CORE_TENANTS: "1" } }));
    const { token } = await touringTenant(m, "Lane", LANE);
    await connectRoutine(m, token);
    await waitFor(() => m.wakes.length > 0);
    const wake = m.wakes[0]!;
    expect(wake.url).toBe(ROUTINE_URL);
    expect(JSON.parse(wake.body).eventType).toBe("installation.test");
    expect(wake.body).not.toMatch(/\+1555/);
  });

  it("lets publish past the alerts check only after the routine is connected", SLOW, async () => {
    const m = (open = await multiTenantApp({ env: { TOUR_CORE_TENANTS: "1" } }));
    const { token } = await touringTenant(m, "Lane", LANE);
    expect((await m.toolAt("/mcp", token, "publish", { property: "Hillside" })).text).toContain("Connect the touring alert routine first.");
    await connectRoutine(m, token);
    await waitFor(() => m.wakes.length > 0);
    expect((await m.toolAt("/mcp", token, "publish", { property: "Hillside" })).text).not.toContain("Connect the touring alert routine first.");
  });

  it("refuses an http routine address, and a used link", SLOW, async () => {
    const m = (open = await multiTenantApp({ env: { TOUR_CORE_TENANTS: "1" } }));
    const { token } = await touringTenant(m, "Lane", LANE);
    const plain = await connectRoutine(m, token, "http://routines.example/hooks/x");
    expect(plain.res.status).toBe(400);
    const good = await connectRoutine(m, token);
    expect(good.res.status).toBe(200);
    const again = await m.app.http(good.path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url: ROUTINE_URL, key: ROUTINE_KEY }) });
    expect(again.status).toBe(404);
  });

  it("keeps one tenant's routine away from another's events", SLOW, async () => {
    const m = (open = await multiTenantApp({ env: { TOUR_CORE_TENANTS: "1" } }));
    const lane = await touringTenant(m, "Lane", LANE);
    const mill = await touringTenant(m, "Mill", MILL);
    await connectRoutine(m, mill.token, MILL_URL);
    await waitFor(() => m.wakes.length > 0);
    await connectRoutine(m, lane.token);
    await waitFor(() => m.wakes.length > 1);
    expect(m.wakes.filter((w) => w.url === MILL_URL)).toHaveLength(1);
    expect(m.wakes.filter((w) => w.url === ROUTINE_URL)).toHaveLength(1);
    expect(lane.tenant.id).not.toBe(mill.tenant.id);
  });

  it("retries a wake the routine refused, from the touring process's outbox", { timeout: 120_000 }, async () => {
    const m = (open = await multiTenantApp({ env: { TOUR_CORE_TENANTS: "1" } }));
    const { token } = await touringTenant(m, "Lane", LANE);
    m.setWakeStatus(500);
    await connectRoutine(m, token);
    await waitFor(() => m.wakes.length > 0);
    m.setWakeStatus(200);
    await waitFor(() => m.wakes.length > 1, 90_000);
    expect(JSON.parse(m.wakes[1]!.body).eventId).toBe(JSON.parse(m.wakes[0]!.body).eventId);
  });
});
