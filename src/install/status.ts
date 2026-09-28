import { mcpAuthModeFromEnv } from "../mcp/authMode";
import { MCP_PATH } from "../mcp/paths";
import type { OperatorServices } from "../operator/services";
import type { PropertyWorkspace } from "../setup/workspace";
import { probeRuntimeStore } from "../storage/runtimeStore";
import { DEPLOYMENT_MODE_LABELS, type DeploymentMode } from "./deployment";
import type { Installation } from "./installation";

/**
 * Where this installation stands, component by component, in one
 * provider-neutral model. Tour Core decides the installation sequence here
 * (not in Grok's instructions): `nextStep` is the first component that isn't
 * ready, with who does it and how. A new component (e.g. Google Drive as the
 * STORAGE provider) plugs into this list without changing the Grok skill.
 */

export const INSTALLATION_COMPONENTS = [
  "RUNTIME",
  "PUBLIC_ENDPOINT",
  "GROK_OPERATOR",
  "VISITOR_MESSAGING",
  "OPERATOR_ALERTS",
  "STORAGE",
  "ACCESS",
  "PROPERTY",
  "READINESS",
  "PRACTICE_TOUR",
  "PUBLISH",
] as const;
export type InstallationComponent = (typeof INSTALLATION_COMPONENTS)[number];

export const COMPONENT_STATES = ["NOT_CONFIGURED", "ACTION_REQUIRED", "CONFIGURING", "READY", "DEGRADED", "ERROR"] as const;
export type ComponentState = (typeof COMPONENT_STATES)[number];

/** Infrastructure that must be ready before property setup starts. */
export const INFRASTRUCTURE: InstallationComponent[] = ["RUNTIME", "PUBLIC_ENDPOINT", "GROK_OPERATOR", "VISITOR_MESSAGING", "OPERATOR_ALERTS", "STORAGE", "ACCESS"];

export const COMPONENT_LABELS: Record<InstallationComponent, string> = {
  RUNTIME: "Tour Core runtime",
  PUBLIC_ENDPOINT: "Public address",
  GROK_OPERATOR: "Grok connection",
  VISITOR_MESSAGING: "Visitor messaging",
  OPERATOR_ALERTS: "Operator alerts",
  STORAGE: "Tour records",
  ACCESS: "Access system",
  PROPERTY: "Property",
  READINESS: "Readiness check",
  PRACTICE_TOUR: "Practice tour",
  PUBLISH: "Publish",
};

export type InstallationAction =
  | "START_RUNTIME"
  | "ESTABLISH_PUBLIC_ENDPOINT"
  | "CHECK_PUBLIC_ENDPOINT"
  | "CONNECT_GROK"
  | "RECONNECT_GROK"
  | "FIX_GROK_CONNECTOR"
  | "CONNECT_VISITOR_MESSAGING"
  | "TEST_VISITOR_MESSAGING"
  | "RECONNECT_VISITOR_MESSAGING"
  | "FIX_VISITOR_MESSAGING"
  | "CONNECT_OPERATOR_ALERTS"
  | "TEST_OPERATOR_ALERTS"
  | "FIX_OPERATOR_ALERTS"
  | "CHECK_STORAGE"
  | "CHECK_ACCESS"
  | "SET_UP_PROPERTY"
  | "FINISH_PROPERTY_SETUP"
  | "RUN_READINESS"
  | "RUN_PRACTICE_TOUR"
  | "PUBLISH"
  | "DONE";

/**
 *  GROK                      Grok does it itself (a tool call, or a command on its computer).
 *  OPERATOR                  a human step Grok can't do (e.g. approving the OAuth connection).
 *  OPERATOR_IN_SECURE_SETUP  the operator enters credentials on Tour Core's secure setup page.
 *  OPERATOR_DECISION         Grok asks; the operator decides (e.g. publish, property details).
 */
export type PerformedBy = "GROK" | "OPERATOR" | "OPERATOR_IN_SECURE_SETUP" | "OPERATOR_DECISION";

export interface InstallationStep {
  component: InstallationComponent | null;
  action: InstallationAction;
  operatorMessage: string;
  performedBy: PerformedBy;
  /** The Tour Core tool that does or starts this step. */
  tool?: string;
  /** The Grok skill that walks through it. */
  skill?: string;
  /** Which part of the secure setup page to open (pass to get_secure_setup_url). */
  secureSetupStep?: "visitor-messaging" | "operator-alerts";
  /** A command Grok runs on the Tour Core computer (never on the operator's own computer). */
  command?: string;
}

export interface ComponentStatus {
  component: InstallationComponent;
  label: string;
  state: ComponentState;
  /** One plain sentence for the operator. */
  summary: string;
  /** Provider role, e.g. LOCAL_DEMO or DURIN_DEMO. Never a credential. */
  provider?: string;
  details?: string[];
  next?: InstallationStep;
  /** Recommended but not required improvements (e.g. a portable records store, once available). */
  optionalActions: InstallationStep[];
}

export interface InstallationStatus {
  schemaVersion: 1;
  installationId?: string;
  deploymentMode: DeploymentMode;
  deploymentLabel: string;
  publicAddress?: string;
  connectorUrl?: string;
  components: ComponentStatus[];
  infrastructureReady: boolean;
  nextStep: InstallationStep;
  summary: string;
  lines: string[];
  checkedAt: string;
}

export interface StatusOptions {
  /** From outside the process (bootstrap): whether the runtime answered. Inside the server it's running by definition. */
  runtime?: { running: boolean; message?: string };
}

const BOOTSTRAP = "npm run bootstrap:grok";

function component(c: InstallationComponent, state: ComponentState, summary: string, extra: Partial<ComponentStatus> = {}): ComponentStatus {
  return { component: c, label: COMPONENT_LABELS[c], state, summary, optionalActions: [], ...extra };
}

function step(c: InstallationComponent, action: InstallationAction, performedBy: PerformedBy, operatorMessage: string, extra: Partial<InstallationStep> = {}): InstallationStep {
  return { component: c, action, performedBy, operatorMessage, ...extra };
}

// ------------------------------------------------------------ components

function runtimeStatus(options: StatusOptions): ComponentStatus {
  if (options.runtime && !options.runtime.running) {
    return component("RUNTIME", "ERROR", options.runtime.message ?? "Tour Core isn't running.", {
      next: step("RUNTIME", "START_RUNTIME", "GROK", "Tour Core isn't running. I'll start it on my cloud computer.", { command: BOOTSTRAP }),
    });
  }
  return component("RUNTIME", "READY", "Tour Core is running.");
}

function endpointStatus(inst: Installation, mode: DeploymentMode): ComponentStatus {
  const url = inst.publicBaseUrl();
  const raw = inst.sendblueEnv().publicBaseUrlRaw;
  const manifest = safe(() => inst.files.manifest());
  const quick = manifest?.publicEndpointProvider === "CLOUDFLARE_QUICK_TUNNEL" && manifest.publicBaseUrl === url;
  const details = quick ? ["This is a temporary demo address. It changes if the tunnel restarts, and Tour Core will say what needs reconnecting."] : [];
  const establish = (): InstallationStep =>
    mode === "GROK_MANAGED_P0"
      ? step("PUBLIC_ENDPOINT", "ESTABLISH_PUBLIC_ENDPOINT", "GROK", "Tour Core needs a public address. I'll set one up on my cloud computer.", { command: BOOTSTRAP })
      : mode === "SELF_HOSTED"
        ? step("PUBLIC_ENDPOINT", "ESTABLISH_PUBLIC_ENDPOINT", "OPERATOR", "Tour Core needs its stable https address. Set PUBLIC_BASE_URL on the server where Tour Core runs.")
        : step("PUBLIC_ENDPOINT", "ESTABLISH_PUBLIC_ENDPOINT", "OPERATOR", "Tour Core needs a public https address. Start a secure tunnel and set PUBLIC_BASE_URL (see the README's developer path).");
  if (!url) {
    if (raw) return component("PUBLIC_ENDPOINT", "ERROR", "The public address isn't an https address.", { next: establish() });
    return component("PUBLIC_ENDPOINT", mode === "LOCAL_DEVELOPER" ? "NOT_CONFIGURED" : "ACTION_REQUIRED", "Tour Core doesn't have a public address yet.", { next: establish() });
  }
  const check = inst.files.state().publicEndpointCheck;
  const recheck = step("PUBLIC_ENDPOINT", "CHECK_PUBLIC_ENDPOINT", "GROK", "I'll check that Tour Core's public address reaches it.", { tool: "check_public_endpoint" });
  if (!check || check.url !== url) return component("PUBLIC_ENDPOINT", "ACTION_REQUIRED", "The public address hasn't been checked yet.", { details, next: recheck });
  if (!check.ok) {
    return component("PUBLIC_ENDPOINT", "ERROR", check.message, { details, next: mode === "GROK_MANAGED_P0" ? { ...establish(), operatorMessage: `${check.message} I'll repair it on my cloud computer.` } : recheck });
  }
  return component("PUBLIC_ENDPOINT", "READY", "Tour Core is reachable at its public address.", { details });
}

function grokStatus(inst: Installation): ComponentStatus {
  const mode = mcpAuthModeFromEnv(inst.env());
  const url = inst.publicBaseUrl();
  const connector = url ? `${new URL(url).origin}${MCP_PATH}` : undefined;
  if (typeof mode !== "string") {
    return component("GROK_OPERATOR", "ERROR", "The Grok connector is switched off by a setting Tour Core doesn't recognize.", {
      next: step("GROK_OPERATOR", "FIX_GROK_CONNECTOR", "OPERATOR", "Tour Core's connector setting (TOURCORE_MCP_AUTH_MODE) must be oauth. Remove it and restart Tour Core."),
    });
  }
  if (mode === "static") {
    return inst.env().TOURCORE_OPERATOR_TOKEN?.trim()
      ? component("GROK_OPERATOR", "READY", "Grok connects with a development token.", { details: ["Development only. Use OAuth for a real Grok Bot."] })
      : component("GROK_OPERATOR", "ACTION_REQUIRED", "The development connector has no token.", {
          next: step("GROK_OPERATOR", "FIX_GROK_CONNECTOR", "OPERATOR", "Switch the connector back to OAuth (remove TOURCORE_MCP_AUTH_MODE) and restart Tour Core."),
        });
  }
  if (!connector) return component("GROK_OPERATOR", "NOT_CONFIGURED", "Grok can connect once Tour Core has a public address.");
  let connections: ReturnType<Installation["grants"]["connections"]> = [];
  try {
    connections = inst.grants.connections();
  } catch {
    return component("GROK_OPERATOR", "ERROR", "Tour Core couldn't read its Grok connection records.", {
      next: step("GROK_OPERATOR", "RECONNECT_GROK", "OPERATOR", `Reconnect Tour Core in Grok at ${connector}.`),
    });
  }
  const current = connections.filter((c) => c.address === connector);
  if (current.length) return component("GROK_OPERATOR", "READY", "Grok is connected.", { details: [`Connector address: ${connector}`] });
  const approve = "Grok signs in with just this address; approve the request on Tour Core's connection page (http://localhost:4321/grok on the Tour Core computer).";
  if (connections.length) {
    return component("GROK_OPERATOR", "ACTION_REQUIRED", "Tour Core's public address changed, so Grok needs to reconnect.", {
      details: [`New connector address: ${connector}`],
      next: step("GROK_OPERATOR", "RECONNECT_GROK", "OPERATOR", `Tour Core's public address changed. Reconnect Tour Core in Grok at ${connector}. ${approve}`),
    });
  }
  return component("GROK_OPERATOR", "ACTION_REQUIRED", "Grok isn't connected to Tour Core yet.", {
    details: [`Connector address: ${connector}`],
    next: step("GROK_OPERATOR", "CONNECT_GROK", "OPERATOR", `Add Tour Core in Grok as a custom connector at ${connector}. ${approve}`),
  });
}

function messagingStatus(inst: Installation): ComponentStatus {
  const env = inst.sendblueEnv();
  const connect = step("VISITOR_MESSAGING", "CONNECT_VISITOR_MESSAGING", "OPERATOR_IN_SECURE_SETUP", "Visitor texting still needs to be connected. I'll open Tour Core's secure setup page so you can enter the Sendblue details there, not in chat.", {
    tool: "get_secure_setup_url",
    secureSetupStep: "visitor-messaging",
  });
  if (!env.apiKey || !env.apiSecret || !env.fromNumberRaw) return component("VISITOR_MESSAGING", "ACTION_REQUIRED", "Visitor texting isn't connected yet.", { provider: "SENDBLUE", next: connect });
  const check = inst.files.state().visitorMessaging;
  const test = step("VISITOR_MESSAGING", "TEST_VISITOR_MESSAGING", "GROK", "I'll check that Tour Core can text visitors and hear their replies.", { tool: "test_visitor_messaging" });
  const changedAt = latest(inst.secrets.updatedAt("SENDBLUE_API_API_KEY"), inst.secrets.updatedAt("SENDBLUE_API_API_SECRET"), inst.secrets.updatedAt("SENDBLUE_FROM_NUMBER"));
  if (!check || (changedAt && check.at < changedAt)) return component("VISITOR_MESSAGING", "ACTION_REQUIRED", "Visitor texting is set up but hasn't been checked yet.", { provider: "SENDBLUE", next: test });
  if (check.publicBaseUrl !== env.publicBaseUrl) {
    return component("VISITOR_MESSAGING", "ACTION_REQUIRED", "Tour Core's public address changed, so visitor replies need the new address.", {
      provider: "SENDBLUE",
      next: step("VISITOR_MESSAGING", "RECONNECT_VISITOR_MESSAGING", "GROK", "Tour Core's public address changed, so Sendblue needs the new address for visitor replies. I'll update it.", { tool: "test_visitor_messaging" }),
    });
  }
  if (!check.ok) {
    const accountProblem = check.problems.some((p) => /account|sign in|details|number/i.test(p));
    return component("VISITOR_MESSAGING", "ERROR", check.problems[0] ?? check.message, {
      provider: "SENDBLUE",
      details: check.problems,
      next: accountProblem ? { ...connect, action: "FIX_VISITOR_MESSAGING", operatorMessage: `${check.problems[0] ?? check.message} I'll open the secure setup page so you can fix the Sendblue details.` } : test,
    });
  }
  return component("VISITOR_MESSAGING", "READY", `Visitors can text ${env.fromNumber ?? "the property number"}.`, { provider: "SENDBLUE" });
}

function alertsStatus(inst: Installation): ComponentStatus {
  const env = inst.env();
  const connect = step("OPERATOR_ALERTS", "CONNECT_OPERATOR_ALERTS", "OPERATOR_IN_SECURE_SETUP", "Connect operator alerts so Tour Core can notify you when a visitor needs attention. I'll open the secure setup page so you can enter the Grok Routine's connection details there, not in chat.", {
    tool: "get_secure_setup_url",
    secureSetupStep: "operator-alerts",
  });
  if (!env.TOURCORE_GROK_ROUTINE_URL?.trim() || !env.TOURCORE_GROK_ROUTINE_KEY?.trim()) {
    return component("OPERATOR_ALERTS", "ACTION_REQUIRED", "Operator alerts aren't connected yet.", { provider: "GROK_ROUTINE", next: connect });
  }
  const changedAt = latest(inst.secrets.updatedAt("TOURCORE_GROK_ROUTINE_URL"), inst.secrets.updatedAt("TOURCORE_GROK_ROUTINE_KEY"));
  const check = inst.files.state().operatorAlerts;
  const test = step("OPERATOR_ALERTS", "TEST_OPERATOR_ALERTS", "GROK", "I'll send a test alert to make sure Tour Core can reach you.", { tool: "test_operator_alerts" });
  if (!check || check.credentialsChangedAt !== changedAt) return component("OPERATOR_ALERTS", "ACTION_REQUIRED", "Operator alerts are set up but haven't been tested yet.", { provider: "GROK_ROUTINE", next: test });
  if (!check.ok) return component("OPERATOR_ALERTS", "ERROR", check.message, { provider: "GROK_ROUTINE", next: { ...connect, action: "FIX_OPERATOR_ALERTS", operatorMessage: `${check.message} I'll open the secure setup page so you can re-enter the routine's details.` } });
  let health;
  try {
    health = inst.outbox.health();
  } catch {
    health = undefined;
  }
  if (health && (health.retrying > 0 || health.failed > 0)) {
    return component("OPERATOR_ALERTS", "DEGRADED", `Some alerts haven't gone through yet${health.lastError ? `: ${health.lastError}` : "."}`, {
      provider: "GROK_ROUTINE",
      details: [`${health.retrying} waiting to retry, ${health.failed} gave up.`],
      next: test,
    });
  }
  return component("OPERATOR_ALERTS", "READY", "Tour Core can alert you when a visitor needs attention.", { provider: "GROK_ROUTINE" });
}

function storageStatus(inst: Installation): ComponentStatus {
  try {
    probeRuntimeStore(inst.runtime, new Date(inst.now()));
  } catch {
    return component("STORAGE", "ERROR", "Tour Core couldn't save a test record.", { provider: "LOCAL_DEMO", next: step("STORAGE", "CHECK_STORAGE", "GROK", "Tour Core couldn't save a test record. I'll check storage.", { tool: "test_storage" }) });
  }
  return component("STORAGE", "READY", "Tour records are stored with this Tour Core installation.", { provider: "LOCAL_DEMO" });
}

function accessStatus(): ComponentStatus {
  return component("ACCESS", "READY", "Demo. No real doors open.", { provider: "DURIN_DEMO" });
}

/** The property onboarding works on: the published one, else the most recently saved, else a draft. */
export function primaryProperty(ws: PropertyWorkspace): { id: string; saved: boolean } | undefined {
  const ids = ws.propertyIds();
  if (!ids.length) return undefined;
  const saved = ws.list();
  const published = saved.find((p) => p.state.status === "PUBLISHED_FOR_DEMO");
  if (published) return { id: published.config.property.id, saved: true };
  const recent = [...saved].sort((a, b) => (b.state.savedAt ?? "").localeCompare(a.state.savedAt ?? ""))[0];
  if (recent) return { id: recent.config.property.id, saved: true };
  return { id: ids[0]!, saved: false };
}

function propertyStatuses(services: OperatorServices): ComponentStatus[] {
  const ws = services.workspace;
  const primary = primaryProperty(ws);
  const blocked = (c: InstallationComponent, summary: string) => component(c, "NOT_CONFIGURED", summary);
  if (!primary) {
    return [
      component("PROPERTY", "NOT_CONFIGURED", "No property is set up yet.", {
        next: step("PROPERTY", "SET_UP_PROPERTY", "OPERATOR_DECISION", "No property is configured yet. Want to set one up?", { skill: "setup-property" }),
      }),
      blocked("READINESS", "Runs once a property is set up."),
      blocked("PRACTICE_TOUR", "Runs once a property passes its readiness check."),
      blocked("PUBLISH", "Available once the practice tour passes."),
    ];
  }
  const { draft, unsavedChanges } = ws.openDraft(primary.id);
  const name = draft.property.name;
  if (!primary.saved || unsavedChanges) {
    return [
      component("PROPERTY", "CONFIGURING", `${name} is still being set up.`, {
        next: step("PROPERTY", "FINISH_PROPERTY_SETUP", "OPERATOR_DECISION", `${name} still has setup questions to answer. Want to finish it?`, { skill: "setup-property", tool: "review_property_setup" }),
      }),
      blocked("READINESS", "Runs once the setup is complete."),
      blocked("PRACTICE_TOUR", "Runs once the readiness check passes."),
      blocked("PUBLISH", "Available once the practice tour passes."),
    ];
  }
  const { state } = ws.load(primary.id);
  const hash = state.configHash;
  const readinessOk = !!state.readiness?.passed && state.readiness.configHash === hash;
  const dryOk = !!state.dryTour?.passed && state.dryTour.configHash === hash;
  const published = state.status === "PUBLISHED_FOR_DEMO";
  return [
    component("PROPERTY", "READY", `${name} is set up.`),
    readinessOk
      ? component("READINESS", "READY", `${name} passed its readiness check.`)
      : component("READINESS", state.readiness && !state.readiness.passed && state.readiness.configHash === hash ? "ERROR" : "ACTION_REQUIRED", state.readiness && !state.readiness.passed ? `${name}'s last readiness check found problems.` : `${name} needs a readiness check.`, {
          next: step("READINESS", "RUN_READINESS", "GROK", `I'll run the readiness check for ${name}.`, { tool: "run_readiness_check", skill: "run-readiness-check" }),
        }),
    !readinessOk
      ? blocked("PRACTICE_TOUR", "Runs once the readiness check passes.")
      : dryOk
        ? component("PRACTICE_TOUR", "READY", `${name}'s practice tour passed.`)
        : component("PRACTICE_TOUR", "ACTION_REQUIRED", `${name} needs a practice tour.`, {
            next: step("PRACTICE_TOUR", "RUN_PRACTICE_TOUR", "GROK", `I'll run a practice tour of ${name}. Nobody is texted and no real door opens.`, { tool: "run_dry_tour", skill: "simulate-tour" }),
          }),
    published
      ? component("PUBLISH", "READY", `${name} is published for demo.`)
      : !(readinessOk && dryOk)
        ? blocked("PUBLISH", "Available once the readiness check and practice tour pass.")
        : component("PUBLISH", "ACTION_REQUIRED", `${name} is ready to publish.`, {
            next: step("PUBLISH", "PUBLISH", "OPERATOR_DECISION", `Everything passed for ${name}. Publishing needs your explicit OK.`, { tool: "publish_demo_property", skill: "setup-property" }),
          }),
  ];
}

// -------------------------------------------------------------- overall

export function getInstallationStatus(inst: Installation, services: OperatorServices, options: StatusOptions = {}): InstallationStatus {
  const deployment = inst.deployment();
  const mode = deployment.mode;
  const components: ComponentStatus[] = [
    runtimeStatus(options),
    endpointStatus(inst, mode),
    grokStatus(inst),
    messagingStatus(inst),
    alertsStatus(inst),
    storageStatus(inst),
    accessStatus(),
    ...propertyStatuses(services),
  ];
  if (deployment.invalid) components[0]!.details = [`TOURCORE_DEPLOYMENT_MODE "${deployment.invalid}" isn't recognized; using ${mode}.`];
  const nextStep = components.find((c) => c.state !== "READY" && c.next)?.next ?? {
    component: null,
    action: "DONE" as const,
    performedBy: "GROK" as const,
    operatorMessage: "Tour Core is set up and published. Visitors can text the property, and I'll let you know when something needs your judgment.",
  };
  const url = inst.publicBaseUrl();
  const infrastructureReady = components.filter((c) => INFRASTRUCTURE.includes(c.component)).every((c) => c.state === "READY");
  const left = components.filter((c) => c.state !== "READY" && c.next).length;
  const manifest = safe(() => inst.files.manifest());
  return {
    schemaVersion: 1,
    ...(manifest ? { installationId: manifest.installationId } : {}),
    deploymentMode: mode,
    deploymentLabel: DEPLOYMENT_MODE_LABELS[mode],
    ...(url ? { publicAddress: url, connectorUrl: `${new URL(url).origin}${MCP_PATH}` } : {}),
    components,
    infrastructureReady,
    nextStep,
    summary: nextStep.action === "DONE" ? "Tour Core is fully set up." : `${components[0]!.state === "READY" ? "Tour Core is running. " : ""}${left} thing${left === 1 ? "" : "s"} left to set up.`,
    lines: components.map(statusLine),
    checkedAt: new Date(inst.now()).toISOString(),
  };
}

export function statusLine(c: ComponentStatus): string {
  const mark = c.state === "READY" ? "\u2713" : c.state === "ERROR" || c.state === "DEGRADED" ? "\u2717" : "\u2022";
  return `${mark} ${c.label}: ${c.summary}`;
}

function latest(...values: (string | undefined)[]): string | undefined {
  return values.filter((v): v is string => !!v).sort().at(-1);
}

function safe<T>(read: () => T): T | undefined {
  try {
    return read();
  } catch {
    return undefined;
  }
}
