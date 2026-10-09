import { afterEach, describe, expect, it } from "vitest";
import { exceptionCreatedEvent } from "../src/alerts/operatorEvents";
import { describeUpdates, RECOMMENDED_UPDATES } from "../src/alerts/preferences";
import { getInstallationStatus } from "../src/install/status";
import { GROK_ALERTS_SAY } from "../src/playbooks/grok";
import { installHarness, ROUTINE_KEY, ROUTINE_URL, SB_KEY, SB_SECRET, type InstallHarness } from "./installHarness";

/**
 * One failed delivery, then a passing test. Landlord get_state, installation
 * status, and runtime health have to name the same alert health both times.
 */

const DEGRADED_SAY = "A tour update didn't reach you. Check your inbox for anything new. I'm sending a test so the next ones get through.";
const DEGRADED_SUMMARY = "Some tour updates haven't reached you yet.";
const READY_LINE = `I'll keep you posted on ${describeUpdates(RECOMMENDED_UPDATES)}.`;
const SETUP = /Want me to text you|Want me to tell you when someone books|create the Tour Core Operator Updates|webhook address|secure secret input|I'm setting up your tour updates|get_secure_setup_url/;
const TUNNEL = "https://brave-otter-lamp.trycloudflare.com";

const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).forEach((fn) => fn()));

function harness(): InstallHarness {
  const h = installHarness({ env: { TOURCORE_DEPLOYMENT_MODE: "GROK_MANAGED_P0" } });
  cleanups.push(h.cleanup);
  h.ctx.client = { name: "Grok" };
  return h;
}

function markChecked(h: InstallHarness, what: "endpoint" | "messaging" | "alerts") {
  const at = new Date(h.now()).toISOString();
  const url = h.inst.publicBaseUrl()!;
  if (what === "endpoint") h.inst.files.recordCheck("publicEndpointCheck", { ok: true, at, message: "ok", url });
  if (what === "messaging") h.inst.files.recordCheck("visitorMessaging", { ok: true, at, message: "ok", problems: [], publicBaseUrl: url, webhookUrl: `${url}/webhooks/sendblue` });
  if (what === "alerts") {
    const changed = [h.inst.secrets.updatedAt("TOURCORE_GROK_ROUTINE_URL"), h.inst.secrets.updatedAt("TOURCORE_GROK_ROUTINE_KEY")].filter(Boolean).sort().at(-1);
    h.inst.files.recordCheck("operatorAlerts", { ok: true, at, message: "ok", ...(changed ? { credentialsChangedAt: changed } : {}) });
  }
}

function completeInfrastructure(h: InstallHarness) {
  h.inst.files.ensure({ deploymentMode: "GROK_MANAGED_P0" });
  h.inst.files.setPublicBaseUrl(TUNNEL, "CLOUDFLARE_QUICK_TUNNEL");
  markChecked(h, "endpoint");
  h.connectGrok();
  h.inst.secrets.set({ SENDBLUE_API_API_KEY: SB_KEY, SENDBLUE_API_API_SECRET: SB_SECRET, SENDBLUE_FROM_NUMBER: "+15550109999" });
  markChecked(h, "messaging");
  h.inst.files.writeState({ ...h.inst.files.state(), storage: { mode: "LOCAL_DEMO", phase: "READY", chosenAt: new Date(h.now()).toISOString() } });
  h.inst.secrets.set({ TOURCORE_GROK_ROUTINE_URL: ROUTINE_URL, TOURCORE_GROK_ROUTINE_KEY: ROUTINE_KEY });
  markChecked(h, "alerts");
}

async function publishedWithAlerts(h: InstallHarness) {
  completeInfrastructure(h);
  await h.ok("set_notification_preferences", { preset: "recommended" });
  return h.publish();
}

interface AlertComponent {
  component: string;
  state: string;
  summary: string;
  next?: { action: string; operatorMessage: string; tool?: string };
}

function alertsOf(status: { components: AlertComponent[] }): AlertComponent {
  return status.components.find((item) => item.component === "OPERATOR_ALERTS")!;
}

async function views(h: InstallHarness) {
  const readOnly = getInstallationStatus(h.inst, h.services, { readOnly: true, client: h.ctx.client });
  const live = getInstallationStatus(h.inst, h.services, { client: h.ctx.client });
  const state = await h.ok("get_state");
  const status = await h.ok("get_installation_status");
  const component = await h.ok("get_installation_component", { component: "OPERATOR_ALERTS" });
  const next = await h.ok("get_next_installation_step");
  const health = await h.ok("check_runtime_health");
  return { readOnly, live, state, status, component, next, health };
}

function expectSameHealth(
  seen: Awaited<ReturnType<typeof views>>,
  expected: { state: string; summary: string; action: string; failed: number; retrying: number },
) {
  const readOnly = alertsOf(seen.readOnly);
  const live = alertsOf(seen.live);
  const fromStatus = alertsOf(seen.status);
  expect(readOnly).toMatchObject({ state: expected.state, summary: expected.summary });
  expect(live.state).toBe(readOnly.state);
  expect(live.summary).toBe(readOnly.summary);
  expect(live.next?.action).toBe(readOnly.next?.action);
  expect(live.next?.operatorMessage).toBe(readOnly.next?.operatorMessage);
  expect(live.next?.tool).toBe(readOnly.next?.tool);
  expect(fromStatus).toMatchObject({ state: expected.state, summary: expected.summary });
  expect(fromStatus.next?.action).toBe(readOnly.next?.action);
  expect(fromStatus.next?.operatorMessage).toBe(readOnly.next?.operatorMessage);
  expect(fromStatus.next?.tool).toBe(readOnly.next?.tool);
  expect(seen.component).toMatchObject({ state: expected.state, summary: `Tour updates: ${expected.summary}` });
  expect(seen.state.alerts.summary).toBe(expected.summary);
  expect(seen.state.nextStep.action).toBe(expected.action);
  expect(seen.next.action).toBe(expected.action);
  expect(seen.status.nextStep.action).toBe(expected.action);
  const delivery = seen.health.technical.alertDelivery;
  expect(delivery).toMatchObject({ failed: expected.failed, retrying: expected.retrying });
  expect(seen.readOnly.components.find((item) => item.component === "OPERATOR_ALERTS")?.technical).toEqual(
    seen.live.components.find((item) => item.component === "OPERATOR_ALERTS")?.technical,
  );
  expect(expected.state === "DEGRADED").toBe(delivery.failed > 0 || delivery.retrying > 0);
  expect(JSON.stringify(seen.state)).not.toMatch(SETUP);
}

describe("operator alert recovery", () => {
  it("one failed update is degraded on every view, and a passing test makes every view ready", async () => {
    const h = harness();
    const propertyId = await publishedWithAlerts(h);
    expect((await h.ok("get_state")).nextStep.action).toBe("ADD_ANOTHER_PROPERTY");

    h.setClock(h.now() + 60_000);
    h.net.state.routineStatus = 400;
    const event = exceptionCreatedEvent({ propertyId, exceptionId: "exc_0123456789ab", occurredAt: new Date(h.now()).toISOString() });
    h.inst.outbox.enqueue(event);
    await h.inst.outbox.drain();
    expect(h.inst.outbox.get(event.eventId)?.status).toBe("failed");

    const degraded = await views(h);
    expectSameHealth(degraded, { state: "DEGRADED", summary: DEGRADED_SUMMARY, action: "TEST_OPERATOR_ALERTS", failed: 1, retrying: 0 });
    expect(degraded.state.nextStep).toMatchObject({ tool: "test_operator_alerts", say: DEGRADED_SAY });
    expect(degraded.next).toMatchObject({ tool: "test_operator_alerts", operatorMessage: DEGRADED_SAY });
    expect(degraded.readOnly.nextStep).toMatchObject({ tool: "test_operator_alerts", operatorMessage: DEGRADED_SAY });
    expect(alertsOf(degraded.status).next).toMatchObject({ tool: "test_operator_alerts", operatorMessage: DEGRADED_SAY });
    expect(degraded.state.playbook.text).toContain(`Say only this: ${DEGRADED_SAY}`);
    expect(degraded.state.playbook.text).toContain("Do not create a routine");
    expect(degraded.state.playbook.text).not.toContain("Ask one thing");
    expect(degraded.state.playbook.text).not.toContain("Ask only this");
    expect(degraded.state.playbook.step).toBe("alerts-degraded");

    h.setClock(h.now() + 60_000);
    h.net.state.routineStatus = 202;
    const passed = await h.ok("test_operator_alerts");
    expect(passed.ok).toBe(true);

    const ready = await views(h);
    expectSameHealth(ready, { state: "READY", summary: READY_LINE, action: "ADD_ANOTHER_PROPERTY", failed: 0, retrying: 0 });
    expect(JSON.stringify(ready.state)).not.toMatch(/A tour update didn't reach you/);
  });

  it("a failing test keeps the error path", async () => {
    const h = harness();
    const propertyId = await publishedWithAlerts(h);
    h.setClock(h.now() + 60_000);
    h.net.state.routineStatus = 400;
    h.inst.outbox.enqueue(exceptionCreatedEvent({ propertyId, exceptionId: "exc_abcdefabcdef", occurredAt: new Date(h.now()).toISOString() }));
    await h.inst.outbox.drain();
    h.setClock(h.now() + 60_000);
    const failed = await h.ok("test_operator_alerts");
    expect(failed.ok).toBe(false);
    const component = await h.ok("get_installation_component", { component: "OPERATOR_ALERTS" });
    expect(component).toMatchObject({
      state: "ERROR",
      summary: "Tour updates: Tour updates aren't reaching you.",
      next: {
        action: "FIX_OPERATOR_ALERTS",
        tool: "get_secure_setup_url",
        operatorMessage: "Tour updates aren't reaching you yet. I'll ask for the connection again, securely; it won't be shown in chat.",
      },
    });
  });

  it("a fresh install still offers tour updates the first time", async () => {
    const h = harness();
    h.inst.files.ensure({ deploymentMode: "GROK_MANAGED_P0" });
    h.inst.files.setPublicBaseUrl(TUNNEL, "CLOUDFLARE_QUICK_TUNNEL");
    markChecked(h, "endpoint");
    h.connectGrok();
    h.inst.secrets.set({ SENDBLUE_API_API_KEY: SB_KEY, SENDBLUE_API_API_SECRET: SB_SECRET, SENDBLUE_FROM_NUMBER: "+15550109999" });
    markChecked(h, "messaging");
    h.inst.files.writeState({ ...h.inst.files.state(), storage: { mode: "LOCAL_DEMO", phase: "READY", chosenAt: new Date(h.now()).toISOString() } });
    await h.setUpAlfredWay();
    let state = await h.ok("get_state");
    for (let i = 0; i < 6 && state.nextStep.say !== GROK_ALERTS_SAY; i++) {
      const say = String(state.nextStep.say);
      const propertyId = (state.setup as { propertyId?: string } | undefined)?.propertyId;
      const property = propertyId ? { property: propertyId } : {};
      if (/zip/i.test(say)) await h.ok("save_property", { ...property, postalCode: "11215" });
      else if (/did i get that right/i.test(say)) await h.ok("save_property", { ...property, confirmAddress: true });
      else if (/what state/i.test(say)) await h.ok("save_property", { ...property, state: "NY" });
      else if (/what city/i.test(say)) await h.ok("save_property", { ...property, city: "Brooklyn" });
      else break;
      state = await h.ok("get_state");
    }
    expect(state.nextStep).toMatchObject({ action: "OFFER_OPERATOR_ALERTS", say: GROK_ALERTS_SAY });
    expect(state.playbook.text).toContain("create the Tour Core Operator Updates routine");
    expect(state.playbook.step).toBe("alerts");
  });
});
