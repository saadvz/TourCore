import { z } from "zod";
import type { OperatorTool, ToolContext, ToolKind } from "../operator/tools";
import { SetupInputError } from "../setup/setupActions";
import { checkPublicEndpoint, runtimeHealth, testAccess, testOperatorAlerts, testStorage, testVisitorMessaging } from "./checks";
import type { Installation } from "./installation";
import { DEFAULT_SETUP_SESSION_MINUTES } from "./setupSessions";
import { getInstallationStatus, INSTALLATION_COMPONENTS, type ComponentStatus } from "./status";

/**
 * Installation tools for the operator's agent host. They report and test the
 * installation; they never take a credential as input and never return one.
 * Credentials go in only through the secure setup page on the Tour Core
 * computer (get_secure_setup_url). There is deliberately no tool that sets an
 * API key, sender key or webhook secret, and none that runs a shell command.
 */

function tool<S extends z.ZodObject>(def: { name: string; title: string; description: string; kind: ToolKind; input: S; run: (ctx: ToolContext, input: z.infer<S>) => Promise<Record<string, unknown>> }): OperatorTool {
  return def as unknown as OperatorTool;
}

function installation(ctx: ToolContext): Installation {
  if (!ctx.installation) throw new SetupInputError("INSTALLATION_UNAVAILABLE", "Installation tools aren't available on this Tour Core.");
  return ctx.installation;
}

const componentOut = (c: ComponentStatus) => ({
  component: c.component,
  label: c.label,
  state: c.state,
  summary: c.summary,
  ...(c.provider ? { provider: c.provider } : {}),
  ...(c.details?.length ? { details: c.details } : {}),
  ...(c.next ? { next: c.next } : {}),
  ...(c.optionalActions.length ? { optionalActions: c.optionalActions } : {}),
});

const SecureStep = z.enum(["visitor-messaging", "operator-alerts"]);

export const INSTALLATION_TOOLS: OperatorTool[] = [
  tool({
    name: "get_installation_status",
    title: "Installation status",
    kind: "read",
    description:
      "Where this Tour Core installation stands: runtime, public address, Grok connection, visitor messaging, operator alerts, tour records, access system, property, readiness, practice tour and publish, each READY / ACTION_REQUIRED / etc., plus the next step. The source of truth for \"What's left to set up?\". Never contains credentials.",
    input: z.strictObject({}),
    run: async (ctx) => {
      const s = getInstallationStatus(installation(ctx), ctx.services);
      return {
        summary: s.summary,
        deployment: s.deploymentLabel,
        deploymentMode: s.deploymentMode,
        ...(s.publicAddress ? { publicAddress: s.publicAddress, connectorUrl: s.connectorUrl } : {}),
        infrastructureReady: s.infrastructureReady,
        lines: s.lines,
        components: s.components.map(componentOut),
        nextStep: s.nextStep,
      };
    },
  }),
  tool({
    name: "get_next_installation_step",
    title: "Next installation step",
    kind: "read",
    description:
      "The one next installation step Tour Core decided: which component, the action, who does it (GROK, OPERATOR, OPERATOR_IN_SECURE_SETUP or OPERATOR_DECISION), the tool or skill to use, and a plain message for the operator. Call it again after each step.",
    input: z.strictObject({}),
    run: async (ctx) => {
      const s = getInstallationStatus(installation(ctx), ctx.services);
      return { summary: s.nextStep.operatorMessage, ...s.nextStep };
    },
  }),
  tool({
    name: "get_installation_component",
    title: "One installation component",
    kind: "read",
    description: "The status of one installation component, with details and its next step.",
    input: z.strictObject({ component: z.enum(INSTALLATION_COMPONENTS) }),
    run: async (ctx, i) => {
      const c = getInstallationStatus(installation(ctx), ctx.services).components.find((x) => x.component === i.component)!;
      return { ...componentOut(c), summary: `${c.label}: ${c.summary}` };
    },
  }),
  tool({
    name: "check_runtime_health",
    title: "Check Tour Core's health",
    kind: "read",
    description: "Whether Tour Core is running and healthy: version, uptime, deployment mode, whether running tours can be saved, and alerts waiting to be delivered.",
    input: z.strictObject({}),
    run: async (ctx) => {
      const h = runtimeHealth(installation(ctx));
      return { summary: h.runtimeRecords === "ok" ? "Tour Core is running and healthy." : "Tour Core is running, but it can't save running tours right now.", health: h };
    },
  }),
  tool({
    name: "check_public_endpoint",
    title: "Check the public address",
    kind: "change",
    description: "Checks from the outside that Tour Core's public https address reaches this installation, and records the result.",
    input: z.strictObject({}),
    run: async (ctx) => {
      const r = await checkPublicEndpoint(installation(ctx), { attempts: 2, delayMs: 2000 });
      return { ok: r.ok, summary: r.message, ...(r.url ? { publicAddress: r.url } : {}) };
    },
  }),
  tool({
    name: "test_visitor_messaging",
    title: "Test visitor messaging",
    kind: "change",
    description:
      "Checks visitor texting end to end (account, texting number, incoming messages, identity-form links) using details already saved on the secure setup page, and repairs what Tour Core owns: its own incoming-message address with Sendblue for the current public address. Takes no credentials. Nothing is texted.",
    input: z.strictObject({}),
    run: async (ctx) => {
      const r = await testVisitorMessaging(installation(ctx), { onConnected: ctx.resetMessaging });
      return { summary: r.message, ...r };
    },
  }),
  tool({
    name: "test_operator_alerts",
    title: "Test operator alerts",
    kind: "change",
    description: "Sends one test alert to the connected Grok Routine (Tour Core Exception Alert) and reports whether it was accepted. Takes no credentials.",
    input: z.strictObject({}),
    run: async (ctx) => {
      const r = await testOperatorAlerts(installation(ctx));
      return { summary: r.message, ...r };
    },
  }),
  tool({
    name: "test_storage",
    title: "Test tour records storage",
    kind: "change",
    description: "Saves, reads back and removes a test record where tour records are kept, and says where that is.",
    input: z.strictObject({}),
    run: async (ctx) => {
      const r = await testStorage(installation(ctx), ctx.services);
      return { summary: r.message, ...r };
    },
  }),
  tool({
    name: "test_access",
    title: "Test the access system",
    kind: "read",
    description: 'Checks that the access system answers. Say "Access system: Demo" or "Access system: Connected"; never name the lock provider. No door opens.',
    input: z.strictObject({}),
    run: async (ctx) => {
      const r = await testAccess(installation(ctx));
      return { summary: r.message, ...r };
    },
  }),
  tool({
    name: "get_secure_setup_url",
    title: "Open secure setup",
    kind: "change",
    description:
      "A short-lived link to Tour Core's secure setup page, which only opens in the browser on the Tour Core computer (Grok's cloud computer in a Grok-managed install). Open it there and ask the operator to take over the browser to enter credentials. The values go straight to Tour Core: never ask for them in chat and never type them yourself.",
    input: z.strictObject({ step: SecureStep.optional().describe("Which part to open: visitor-messaging (Sendblue) or operator-alerts (Grok Routine).") }),
    run: async (ctx, i) => {
      const inst = installation(ctx);
      const { token, expiresAt } = inst.sessions.mint();
      const base = ctx.localUrl?.() ?? "http://localhost:4321";
      const minutes = Math.round((expiresAt - inst.now()) / 60_000) || DEFAULT_SETUP_SESSION_MINUTES;
      return {
        summary: `Here's the secure setup page. It opens only in the browser on the Tour Core computer and expires in ${minutes} minutes.`,
        url: `${base}/install#s=${token}${i.step ? `&step=${i.step}` : ""}`,
        expiresInMinutes: minutes,
        instructions:
          "Open this link in the browser on the Tour Core computer. If a person needs to type something, ask the operator to take over the browser. Don't ask for the values in chat and don't type them yourself. When they're done, call get_installation_status.",
      };
    },
  }),
];
