import { existsSync, readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { handleSecureSetupApi, parseRoutineSnippet } from "../src/install/secureSetup";
import { OPERATOR_TOOLS } from "../src/operator/tools";
import { installHarness, ROUTINE_KEY, ROUTINE_URL } from "./installHarness";

/**
 * Connecting the Operator Updates routine: as much as Grok can do without the
 * routine's address or key ever entering the conversation, the tool calls, or
 * the template.
 */

const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).forEach((c) => c()));

describe("pasting the routine's webhook example", () => {
  it("finds the address and bearer key in a curl example, labeled lines, or two bare values", () => {
    const curl = `curl -X POST ${ROUTINE_URL} \\\n  -H "Authorization: Bearer ${ROUTINE_KEY}" \\\n  -H "Content-Type: application/json" -d '{"hello":"world"}'`;
    expect(parseRoutineSnippet(curl)).toEqual({ webhookUrl: ROUTINE_URL, key: ROUTINE_KEY });
    expect(parseRoutineSnippet(`Webhook URL: ${ROUTINE_URL}\nKey: ${ROUTINE_KEY}`)).toEqual({ webhookUrl: ROUTINE_URL, key: ROUTINE_KEY });
    expect(parseRoutineSnippet(`${ROUTINE_URL}\n${ROUTINE_KEY}`)).toEqual({ webhookUrl: ROUTINE_URL, key: ROUTINE_KEY });
    expect(parseRoutineSnippet(ROUTINE_URL)).toBeUndefined();
    expect(parseRoutineSnippet(`Bearer ${ROUTINE_KEY}`)).toBeUndefined();
  });

  it("the secure setup page saves both from one paste and sends a test update; the page never echoes them", async () => {
    const h = installHarness({ env: { TOURCORE_DEPLOYMENT_MODE: "GROK_MANAGED_P0" } });
    cleanups.push(h.cleanup);
    const { token } = h.inst.sessions.mint();
    const post = (body: unknown) => handleSecureSetupApi({ installation: h.inst, services: h.services }, "POST", "/api/install/operator-alerts", { "x-tourcore-setup-session": token }, body);

    const bad = await post({ snippet: "no address here" });
    expect(bad).toMatchObject({ status: 400, json: { error: { message: "I couldn't find both the webhook address and the key in what you pasted. Paste them into the two fields instead." } } });

    const out = await post({ snippet: `curl -X POST ${ROUTINE_URL} -H "Authorization: Bearer ${ROUTINE_KEY}"` });
    expect(out).toMatchObject({ status: 200, json: { ok: true, saved: true } });
    expect(h.inst.secrets.get("TOURCORE_GROK_ROUTINE_URL")).toBe(ROUTINE_URL);
    expect(h.inst.secrets.get("TOURCORE_GROK_ROUTINE_KEY")).toBe(ROUTINE_KEY);
    expect(h.net.routineCalls()).toHaveLength(1);
    expect(JSON.parse(h.net.routineCalls()[0]!.body!)).toMatchObject({ eventType: "installation.test" });
    for (const secret of [ROUTINE_URL, ROUTINE_KEY]) expect(JSON.stringify(out)).not.toContain(secret);
    expect((await h.ok("get_installation_component", { component: "OPERATOR_ALERTS" })).state).toBe("READY");
  });
});

describe("routine secrets stay outside MCP and the template", () => {
  it("no Tour Core tool takes an address, key, token or secret as input", () => {
    const CREDENTIAL = new Set(["url", "address", "key", "token", "secret", "password", "webhook", "bearer", "credential", "credentials"]);
    const words = (field: string) => field.split(/(?=[A-Z])|_/).map((w) => w.toLowerCase());
    for (const t of OPERATOR_TOOLS) {
      for (const field of Object.keys(t.input.shape)) {
        // A property's street address is setup data, not a credential.
        if (field === "address") continue;
        expect(words(field).filter((w) => CREDENTIAL.has(w)), `${t.name}.${field}`).toEqual([]);
      }
    }
  });

  it("the template ships the Operator Updates routine definition and nothing installation-specific", () => {
    const root = new URL("../grok-template/", import.meta.url);
    const manifest = JSON.parse(readFileSync(new URL("template.json", root), "utf8"));
    expect(manifest.routines).toEqual([expect.objectContaining({ name: "Tour Core Operator Updates", doc: "routines/operator-updates.md", credentialsTravelWithTemplate: false })]);
    expect(manifest.routines[0].allowedTools).toContain("get_operator_update");
    expect(existsSync(new URL("routines/exception-alert.md", root))).toBe(false);
    const doc = readFileSync(new URL("routines/operator-updates.md", root), "utf8");
    for (const type of ["tour.booked", "tour.started", "tour.completed", "exception.created", "get_operator_update"]) expect(doc).toContain(type);
    expect(doc).not.toMatch(/routines\.example|Bearer [A-Za-z0-9_-]{12,}/);
  });

  it("the operator is asked in plain words, never told to configure a webhook", async () => {
    const h = installHarness({ env: { TOURCORE_DEPLOYMENT_MODE: "GROK_MANAGED_P0" } });
    cleanups.push(h.cleanup);
    const prefs = await h.ok("get_notification_preferences");
    expect(prefs.recommendation).toBe("I recommend alerts for bookings, tour starts and completions, and anything that needs your attention.");
    for (const text of [prefs.summary, prefs.recommendation]) expect(text).not.toMatch(/webhook|routine|configure/i);
  });
});
