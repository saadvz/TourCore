import { nextProfileQuestion } from "../config/unitProfile";
import { mcpAuthModeFromEnv } from "../mcp/authMode";
import { MCP_PATH } from "../mcp/paths";
import type { OperatorServices } from "../operator/services";
import { isCurrent, type PropertyWorkspace } from "../setup/workspace";
import { probeRuntimeStore } from "../storage/runtimeStore";
import { DEPLOYMENT_MODE_LABELS, type DeploymentMode } from "./deployment";
import type { Installation } from "./installation";

/**
 * Where this installation stands, component by component, in one
 * provider-neutral model. Tour Core decides the whole onboarding sequence
 * here (not in Grok's instructions): `nextStep` is the one thing to do now,
 * who does it, what to say to the operator, and (separately) what Grok needs
 * to know to do it. Whether a component is required or optional is decided
 * here too, never by the agent.
 *
 * Canonical P0 order:
 *   runtime → public connection → Grok connection → visitor texting
 *   → first property → operator alerts (recommended) → readiness
 *   → practice tour → publish (explicit yes) → operate
 *
 * Copy rules: `operatorMessage`, `summary` and `lines` are safe to say to a
 * landlord as-is (no URLs, ports, commands, tool counts or protocol names).
 * Anything technical is in `grokInstructions` / `technical`, for Grok's own
 * actions and troubleshooting only.
 */

export const INSTALLATION_COMPONENTS = [
  "RUNTIME",
  "PUBLIC_ENDPOINT",
  "GROK_OPERATOR",
  "VISITOR_MESSAGING",
  "STORAGE",
  "ACCESS",
  "PROPERTY",
  "OPERATOR_ALERTS",
  "READINESS",
  "PRACTICE_TOUR",
  "PUBLISH",
] as const;
export type InstallationComponent = (typeof INSTALLATION_COMPONENTS)[number];

export const COMPONENT_STATES = ["NOT_CONFIGURED", "ACTION_REQUIRED", "CONFIGURING", "READY", "DEGRADED", "ERROR"] as const;
export type ComponentState = (typeof COMPONENT_STATES)[number];

/**
 *  REQUIRED_BEFORE_PROPERTY  must be READY before property setup is offered.
 *  REQUIRED_TO_PUBLISH       part of the property path; publish needs it.
 *  RECOMMENDED               offered at its point in the sequence; the operator may decline (skip_optional_setup).
 */
export type Requirement = "REQUIRED_BEFORE_PROPERTY" | "REQUIRED_TO_PUBLISH" | "RECOMMENDED";

export const REQUIREMENTS: Record<InstallationComponent, Requirement> = {
  RUNTIME: "REQUIRED_BEFORE_PROPERTY",
  PUBLIC_ENDPOINT: "REQUIRED_BEFORE_PROPERTY",
  GROK_OPERATOR: "REQUIRED_BEFORE_PROPERTY",
  VISITOR_MESSAGING: "REQUIRED_BEFORE_PROPERTY",
  STORAGE: "REQUIRED_BEFORE_PROPERTY",
  ACCESS: "REQUIRED_BEFORE_PROPERTY",
  PROPERTY: "REQUIRED_TO_PUBLISH",
  OPERATOR_ALERTS: "RECOMMENDED",
  READINESS: "REQUIRED_TO_PUBLISH",
  PRACTICE_TOUR: "REQUIRED_TO_PUBLISH",
  PUBLISH: "REQUIRED_TO_PUBLISH",
};

/** Infrastructure that must be READY before property setup is offered. */
export const INFRASTRUCTURE = INSTALLATION_COMPONENTS.filter((c) => REQUIREMENTS[c] === "REQUIRED_BEFORE_PROPERTY");
/** Components the operator may decline. */
export const OPTIONAL_COMPONENTS = INSTALLATION_COMPONENTS.filter((c) => REQUIREMENTS[c] === "RECOMMENDED");

export const COMPONENT_LABELS: Record<InstallationComponent, string> = {
  RUNTIME: "Tour Core",
  PUBLIC_ENDPOINT: "Secure connection",
  GROK_OPERATOR: "Grok connection",
  VISITOR_MESSAGING: "Visitor texting",
  STORAGE: "Tour records",
  ACCESS: "Access system",
  PROPERTY: "Property",
  OPERATOR_ALERTS: "Alerts",
  READINESS: "Readiness check",
  PRACTICE_TOUR: "Practice tour",
  PUBLISH: "Publish",
};

/** Conversation phase: where the operator is in onboarding. Phases only move forward unless the state changes. */
export type OnboardingPhase = "BOOTSTRAP" | "CONNECT" | "INFRASTRUCTURE" | "PROPERTY" | "VALIDATE" | "PUBLISH" | "OPERATE";

const PHASE_OF: Record<InstallationComponent, OnboardingPhase> = {
  RUNTIME: "BOOTSTRAP",
  PUBLIC_ENDPOINT: "BOOTSTRAP",
  GROK_OPERATOR: "CONNECT",
  VISITOR_MESSAGING: "INFRASTRUCTURE",
  STORAGE: "INFRASTRUCTURE",
  ACCESS: "INFRASTRUCTURE",
  PROPERTY: "PROPERTY",
  OPERATOR_ALERTS: "PROPERTY",
  READINESS: "VALIDATE",
  PRACTICE_TOUR: "VALIDATE",
  PUBLISH: "PUBLISH",
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
  | "CHECK_STORAGE"
  | "SET_UP_PROPERTY"
  | "FINISH_PROPERTY_SETUP"
  | "OFFER_OPERATOR_ALERTS"
  | "CONNECT_OPERATOR_ALERTS"
  | "TEST_OPERATOR_ALERTS"
  | "FIX_OPERATOR_ALERTS"
  | "RUN_READINESS"
  | "RUN_PRACTICE_TOUR"
  | "PUBLISH"
  | "DONE";

/**
 *  GROK                      Grok does it itself (a tool call, or a command on its computer), without asking.
 *  OPERATOR                  a human step Grok can't do (e.g. approving the connection).
 *  OPERATOR_IN_SECURE_SETUP  the operator enters credentials on Tour Core's secure setup page.
 *  OPERATOR_DECISION         Grok asks the question in operatorMessage; the operator decides.
 */
export type PerformedBy = "GROK" | "OPERATOR" | "OPERATOR_IN_SECURE_SETUP" | "OPERATOR_DECISION";

export interface InstallationStep {
  component: InstallationComponent | null;
  action: InstallationAction;
  phase: OnboardingPhase;
  performedBy: PerformedBy;
  /** Safe to say to the operator as-is: plain words, no technical details. */
  operatorMessage: string;
  /** For Grok only (may contain addresses or commands). Never repeat it to the operator. */
  grokInstructions?: string;
  /** The Tour Core tool that does or starts this step. */
  tool?: string;
  /** The Grok skill that walks through it. */
  skill?: string;
  /** Which part of the secure setup page to open (pass to get_secure_setup_url). */
  secureSetupStep?: "visitor-messaging" | "operator-alerts";
  /** A command Grok runs on the Tour Core computer (never the operator's). Never shown to the operator. */
  command?: string;
  /** RECOMMENDED steps can be declined with skip_optional_setup. */
  optional?: boolean;
}

export interface ComponentStatus {
  component: InstallationComponent;
  label: string;
  state: ComponentState;
  requirement: Requirement;
  /** One plain sentence for the operator. */
  summary: string;
  /** Provider role, e.g. LOCAL_DEMO or DURIN_DEMO. Never a credential. For Grok, not the operator. */
  provider?: string;
  /** Technical details for Grok's own actions or troubleshooting. Never repeat them to the operator. */
  technical?: string[];
  next?: InstallationStep;
  /** Recommended but not required improvements (e.g. turning on alerts later). */
  optionalActions: InstallationStep[];
}

export interface InstallationStatus {
  schemaVersion: 1;
  installationId?: string;
  deploymentMode: DeploymentMode;
  deploymentLabel: string;
  phase: OnboardingPhase;
  components: ComponentStatus[];
  /** Every REQUIRED_BEFORE_PROPERTY component is READY. */
  infrastructureReady: boolean;
  nextStep: InstallationStep;
  /** Operator-safe. */
  summary: string;
  /** Operator-safe checklist. */
  lines: string[];
  /** For Grok's own actions and troubleshooting only. */
  technical: { publicAddress?: string; connectorUrl?: string; deploymentMode: DeploymentMode };
  checkedAt: string;
}

export interface StatusOptions {
  /** From outside the process (bootstrap): whether the runtime answered. Inside the server it's running by definition. */
  runtime?: { running: boolean; message?: string };
}

const BOOTSTRAP = "npm run bootstrap:grok";

export const OPERATOR_MESSAGES = {
  firstProperty: "Everything needed to start is connected and tested. Would you like to add your first property?",
  offerAlerts: "Your property is configured. Would you like me to keep an eye on tours and alert you when something needs your attention? I recommend it.",
  validate:
    "Prospects can text your touring number to choose a unit and time, verify their details, and complete the self-guided tour in the same conversation. I'll run a readiness check and a practice tour before we turn it on.",
  operate: "Your property is live for demo. I'll keep an eye on tours and let you know when something needs your attention.",
  operateWithoutAlerts: "Your property is live for demo. Ask me any time to show active tours or what needs your attention.",
} as const;

function component(c: InstallationComponent, state: ComponentState, summary: string, extra: Partial<ComponentStatus> = {}): ComponentStatus {
  return { component: c, label: COMPONENT_LABELS[c], state, requirement: REQUIREMENTS[c], summary, optionalActions: [], ...extra };
}

function step(c: InstallationComponent, action: InstallationAction, performedBy: PerformedBy, operatorMessage: string, extra: Partial<InstallationStep> = {}): InstallationStep {
  return { component: c, action, phase: PHASE_OF[c], performedBy, operatorMessage, ...(REQUIREMENTS[c] === "RECOMMENDED" ? { optional: true } : {}), ...extra };
}

// ------------------------------------------------------------ components

function runtimeStatus(options: StatusOptions): ComponentStatus {
  if (options.runtime && !options.runtime.running) {
    return component("RUNTIME", "ERROR", "Tour Core isn't running.", {
      technical: options.runtime.message ? [options.runtime.message] : undefined,
      next: step("RUNTIME", "START_RUNTIME", "GROK", "I'm starting Tour Core.", { command: BOOTSTRAP, grokInstructions: `Run ${BOOTSTRAP} in the Tour Core folder on your cloud computer.` }),
    });
  }
  return component("RUNTIME", "READY", "Tour Core is installed and running.");
}

function endpointStatus(inst: Installation, mode: DeploymentMode): ComponentStatus {
  const url = inst.publicBaseUrl();
  const raw = inst.sendblueEnv().publicBaseUrlRaw;
  const manifest = safe(() => inst.files.manifest());
  const quick = manifest?.publicEndpointProvider === "CLOUDFLARE_QUICK_TUNNEL" && manifest.publicBaseUrl === url;
  const technical = [...(url ? [`Public address: ${url}`] : []), ...(quick ? ["Temporary quick-tunnel address: it changes if the tunnel restarts."] : [])];
  const establish = (): InstallationStep =>
    mode === "GROK_MANAGED_P0"
      ? step("PUBLIC_ENDPOINT", "ESTABLISH_PUBLIC_ENDPOINT", "GROK", "I'm setting up Tour Core's secure public connection.", { command: BOOTSTRAP, grokInstructions: `Run ${BOOTSTRAP} in the Tour Core folder on your cloud computer.` })
      : step("PUBLIC_ENDPOINT", "ESTABLISH_PUBLIC_ENDPOINT", "OPERATOR", "Tour Core needs a secure public connection before it can be reached.", {
          grokInstructions:
            mode === "SELF_HOSTED" ? "Set PUBLIC_BASE_URL to the server's stable https address and restart Tour Core." : "Start a secure tunnel and set PUBLIC_BASE_URL (README, developer path).",
        });
  if (!url) {
    if (raw) return component("PUBLIC_ENDPOINT", "ERROR", "Tour Core's public connection isn't set up correctly.", { technical: ["PUBLIC_BASE_URL isn't https."], next: establish() });
    return component("PUBLIC_ENDPOINT", mode === "LOCAL_DEVELOPER" ? "NOT_CONFIGURED" : "ACTION_REQUIRED", "Tour Core doesn't have a secure public connection yet.", { next: establish() });
  }
  const check = inst.files.state().publicEndpointCheck;
  const recheck = step("PUBLIC_ENDPOINT", "CHECK_PUBLIC_ENDPOINT", "GROK", "I'm checking Tour Core's secure public connection.", { tool: "check_public_endpoint" });
  if (!check || check.url !== url) return component("PUBLIC_ENDPOINT", "ACTION_REQUIRED", "Tour Core's secure public connection hasn't been checked yet.", { technical, next: recheck });
  if (!check.ok) {
    return component("PUBLIC_ENDPOINT", "ERROR", "Tour Core's secure public connection isn't working.", {
      technical: [...technical, check.message],
      next: mode === "GROK_MANAGED_P0" ? { ...establish(), operatorMessage: "Tour Core's secure public connection stopped working. I'm repairing it." } : recheck,
    });
  }
  return component("PUBLIC_ENDPOINT", "READY", "Tour Core has a secure public connection.", { technical });
}

function grokStatus(inst: Installation): ComponentStatus {
  const mode = mcpAuthModeFromEnv(inst.env());
  const url = inst.publicBaseUrl();
  const connector = url ? `${new URL(url).origin}${MCP_PATH}` : undefined;
  const approval = "Open the approval screen (/grok on the Tour Core computer) in your cloud browser and hand control to the operator.";
  if (typeof mode !== "string") {
    return component("GROK_OPERATOR", "ERROR", "Grok can't connect to Tour Core because of a setting.", {
      technical: [`TOURCORE_MCP_AUTH_MODE "${mode.invalid}" turns the connector off.`],
      next: step("GROK_OPERATOR", "FIX_GROK_CONNECTOR", "GROK", "I'm fixing a Tour Core setting so I can connect to it.", { grokInstructions: "Remove TOURCORE_MCP_AUTH_MODE (or set it to oauth) and restart Tour Core." }),
    });
  }
  if (mode === "static") {
    return inst.env().TOURCORE_OPERATOR_TOKEN?.trim()
      ? component("GROK_OPERATOR", "READY", "Grok is connected.", { technical: ["Development static-token mode. Use OAuth for a real Grok Bot."] })
      : component("GROK_OPERATOR", "ACTION_REQUIRED", "Grok isn't connected to Tour Core yet.", {
          next: step("GROK_OPERATOR", "FIX_GROK_CONNECTOR", "GROK", "I'm fixing a Tour Core setting so I can connect to it.", { grokInstructions: "Static mode has no token: remove TOURCORE_MCP_AUTH_MODE and restart Tour Core." }),
        });
  }
  if (!connector) return component("GROK_OPERATOR", "NOT_CONFIGURED", "Grok can connect once Tour Core has a secure public connection.");
  let connections: ReturnType<Installation["grants"]["connections"]> = [];
  try {
    connections = inst.grants.connections();
  } catch {
    connections = [];
  }
  const technical = [`Connector address: ${connector}`];
  if (connections.some((c) => c.address === connector)) return component("GROK_OPERATOR", "READY", "Grok is connected.", { technical });
  if (connections.length) {
    return component("GROK_OPERATOR", "ACTION_REQUIRED", "Tour Core's connection changed, so Grok needs to reconnect.", {
      technical,
      next: step("GROK_OPERATOR", "RECONNECT_GROK", "OPERATOR", "Tour Core's secure connection changed, so I need your approval to reconnect. I've opened the approval screen. Check that the codes match and click Allow.", {
        grokInstructions: `Remove the old Tour Core connector and add it again at ${connector} with OAuth (no token). ${approval} After approval, call get_installation_status without waiting to be asked.`,
      }),
    });
  }
  return component("GROK_OPERATOR", "ACTION_REQUIRED", "Grok isn't connected to Tour Core yet.", {
    technical,
    next: step("GROK_OPERATOR", "CONNECT_GROK", "OPERATOR", "Tour Core is installed and running. I need your approval to connect to it. I've opened the approval screen. Check that the codes match and click Allow.", {
      grokInstructions: `Add Tour Core as a custom connector at ${connector} with OAuth (leave token fields empty). ${approval} After approval, say "Connected. I'm checking the rest of the setup now." and call get_installation_status without waiting to be asked.`,
    }),
  });
}

function messagingStatus(inst: Installation): ComponentStatus {
  const env = inst.sendblueEnv();
  const connect = step("VISITOR_MESSAGING", "CONNECT_VISITOR_MESSAGING", "OPERATOR_IN_SECURE_SETUP", "Visitor texting is the next step. I've opened Tour Core's secure setup page so you can connect your Sendblue messaging account there, not in chat.", {
    tool: "get_secure_setup_url",
    secureSetupStep: "visitor-messaging",
    grokInstructions: "Call get_secure_setup_url with step visitor-messaging, open the link in your cloud browser, and hand control to the operator. Don't show the link in chat. When they're done, call get_next_installation_step.",
  });
  if (!env.apiKey || !env.apiSecret || !env.fromNumberRaw) return component("VISITOR_MESSAGING", "ACTION_REQUIRED", "Visitor texting isn't connected yet.", { provider: "SENDBLUE", next: connect });
  const check = inst.files.state().visitorMessaging;
  const test = step("VISITOR_MESSAGING", "TEST_VISITOR_MESSAGING", "GROK", "I'm testing visitor texting.", { tool: "test_visitor_messaging" });
  const changedAt = latest(inst.secrets.updatedAt("SENDBLUE_API_API_KEY"), inst.secrets.updatedAt("SENDBLUE_API_API_SECRET"), inst.secrets.updatedAt("SENDBLUE_FROM_NUMBER"));
  if (!check || (changedAt && check.at < changedAt)) return component("VISITOR_MESSAGING", "ACTION_REQUIRED", "Visitor texting is set up but hasn't been tested yet.", { provider: "SENDBLUE", next: test });
  if (check.publicBaseUrl !== env.publicBaseUrl) {
    return component("VISITOR_MESSAGING", "ACTION_REQUIRED", "Visitor texting needs updating after Tour Core's connection changed.", {
      provider: "SENDBLUE",
      next: step("VISITOR_MESSAGING", "RECONNECT_VISITOR_MESSAGING", "GROK", "I'm updating visitor texting to use Tour Core's new connection.", { tool: "test_visitor_messaging" }),
    });
  }
  if (!check.ok) {
    const accountProblem = check.problems.some((p) => /account|sign in|details|number/i.test(p));
    return component("VISITOR_MESSAGING", "ERROR", check.problems[0] ?? check.message, {
      provider: "SENDBLUE",
      technical: check.problems,
      next: accountProblem ? { ...connect, action: "FIX_VISITOR_MESSAGING", operatorMessage: `${check.problems[0] ?? check.message} I've opened Tour Core's secure setup page so you can fix the Sendblue details there.` } : test,
    });
  }
  return component("VISITOR_MESSAGING", "READY", `Visitor texting is connected and working (${env.fromNumber ?? "your touring number"}).`, { provider: "SENDBLUE" });
}

function storageStatus(inst: Installation): ComponentStatus {
  try {
    probeRuntimeStore(inst.runtime, new Date(inst.now()));
  } catch {
    return component("STORAGE", "ERROR", "Tour Core couldn't save a test record.", { provider: "LOCAL_DEMO", next: step("STORAGE", "CHECK_STORAGE", "GROK", "I'm checking where tour records are kept.", { tool: "test_storage" }) });
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

function propertyStatus(services: OperatorServices): { status: ComponentStatus; ready: boolean; name?: string } {
  const ws = services.workspace;
  const primary = primaryProperty(ws);
  if (!primary) {
    return {
      ready: false,
      status: component("PROPERTY", "NOT_CONFIGURED", "No property is set up yet.", {
        next: step("PROPERTY", "SET_UP_PROPERTY", "OPERATOR_DECISION", OPERATOR_MESSAGES.firstProperty, { skill: "setup-property" }),
      }),
    };
  }
  const { draft, unsavedChanges } = ws.openDraft(primary.id);
  const name = draft.property.name;
  if (!primary.saved || unsavedChanges) {
    return {
      ready: false,
      name,
      status: component("PROPERTY", "CONFIGURING", `${name} is still being set up.`, {
        next: step("PROPERTY", "FINISH_PROPERTY_SETUP", "OPERATOR_DECISION", `Let's finish setting up ${name}.`, { skill: "setup-property", tool: "review_property_setup" }),
      }),
    };
  }
  const question = nextProfileQuestion(draft.units);
  if (question) {
    return {
      ready: false,
      name,
      status: component("PROPERTY", "CONFIGURING", `${name} still needs some unit details.`, {
        next: step("PROPERTY", "FINISH_PROPERTY_SETUP", "OPERATOR_DECISION", question.question, {
          skill: "setup-property",
          tool: "set_unit_details",
          grokInstructions: "Ask this in plain words and save the answer with set_unit_details (the operator's words; \"not sure\" or \"don't list it\" count as answers). get_unit_details shows what's still missing.",
        }),
      }),
    };
  }
  return { ready: true, name, status: component("PROPERTY", "READY", `${name} is set up.`) };
}

function alertsStatus(inst: Installation, propertyReady: boolean): ComponentStatus {
  const env = inst.env();
  const configured = !!env.TOURCORE_GROK_ROUTINE_URL?.trim() && !!env.TOURCORE_GROK_ROUTINE_KEY?.trim();
  const skipped = inst.files.state().skipped?.OPERATOR_ALERTS;
  const connect = (operatorMessage: string, action: InstallationAction = "CONNECT_OPERATOR_ALERTS", performedBy: PerformedBy = "OPERATOR_IN_SECURE_SETUP") =>
    step("OPERATOR_ALERTS", action, performedBy, operatorMessage, {
      tool: "get_secure_setup_url",
      secureSetupStep: "operator-alerts",
      grokInstructions:
        "Create the Tour Core Exception Alert routine yourself (authenticated webhook trigger; instructions in grok-template/routines/exception-alert.md). Then call get_secure_setup_url with step operator-alerts, open it in your cloud browser and hand control to the operator to enter the routine's connection details. Never show the webhook address or key in chat.",
    });
  const offer = step("OPERATOR_ALERTS", "OFFER_OPERATOR_ALERTS", "OPERATOR_DECISION", OPERATOR_MESSAGES.offerAlerts, {
    tool: "get_secure_setup_url",
    secureSetupStep: "operator-alerts",
    grokInstructions:
      "If they say yes: say \"I'm setting up alerts so I can notify you when a visitor needs your input.\", create the Tour Core Exception Alert routine yourself (authenticated webhook trigger; grok-template/routines/exception-alert.md), call get_secure_setup_url with step operator-alerts, open it and hand control to the operator. If they say no: call skip_optional_setup with component OPERATOR_ALERTS.",
  });
  if (!configured) {
    if (!propertyReady) return component("OPERATOR_ALERTS", "NOT_CONFIGURED", "Offered once your first property is set up.", { provider: "GROK_ROUTINE" });
    if (skipped) return component("OPERATOR_ALERTS", "NOT_CONFIGURED", "Alerts are off. You can turn them on any time.", { provider: "GROK_ROUTINE", optionalActions: [offer] });
    return component("OPERATOR_ALERTS", "ACTION_REQUIRED", "Alerts aren't turned on yet.", { provider: "GROK_ROUTINE", next: offer });
  }
  const changedAt = latest(inst.secrets.updatedAt("TOURCORE_GROK_ROUTINE_URL"), inst.secrets.updatedAt("TOURCORE_GROK_ROUTINE_KEY"));
  const check = inst.files.state().operatorAlerts;
  const test = step("OPERATOR_ALERTS", "TEST_OPERATOR_ALERTS", "GROK", "I'm sending a test alert.", { tool: "test_operator_alerts" });
  if (!check || check.credentialsChangedAt !== changedAt) return component("OPERATOR_ALERTS", "ACTION_REQUIRED", "Alerts are set up but haven't been tested yet.", { provider: "GROK_ROUTINE", next: test });
  if (!check.ok) {
    return component("OPERATOR_ALERTS", "ERROR", "Alerts aren't reaching you.", {
      provider: "GROK_ROUTINE",
      technical: [check.message],
      next: connect("Alerts aren't reaching you yet. I've opened Tour Core's secure setup page so you can re-enter the alert's connection details there, not in chat.", "FIX_OPERATOR_ALERTS"),
    });
  }
  let health;
  try {
    health = inst.outbox.health();
  } catch {
    health = undefined;
  }
  if (health && (health.retrying > 0 || health.failed > 0)) {
    return component("OPERATOR_ALERTS", "DEGRADED", "Some alerts haven't reached you yet.", {
      provider: "GROK_ROUTINE",
      technical: [`${health.retrying} waiting to retry, ${health.failed} gave up.`, ...(health.lastError ? [health.lastError] : [])],
      next: test,
    });
  }
  return component("OPERATOR_ALERTS", "READY", "I'll let you know when a visitor needs your attention.", { provider: "GROK_ROUTINE" });
}

function validationStatuses(services: OperatorServices, propertyReady: boolean): ComponentStatus[] {
  const blocked = (c: InstallationComponent, summary: string) => component(c, "NOT_CONFIGURED", summary);
  const primary = propertyReady ? primaryProperty(services.workspace) : undefined;
  if (!primary) {
    return [blocked("READINESS", "Runs once a property is set up."), blocked("PRACTICE_TOUR", "Runs once the readiness check passes."), blocked("PUBLISH", "Available once the practice tour passes.")];
  }
  const { config, state } = services.workspace.load(primary.id);
  const name = config.property.name;
  const readinessOk = !!state.readiness?.passed && isCurrent(state.readiness, state);
  const dryOk = !!state.dryTour?.passed && isCurrent(state.dryTour, state);
  const published = state.status === "PUBLISHED_FOR_DEMO";
  const failedReadiness = !!state.readiness && !state.readiness.passed && isCurrent(state.readiness, state);
  return [
    readinessOk
      ? component("READINESS", "READY", `${name} passed its readiness check.`)
      : component("READINESS", failedReadiness ? "ERROR" : "ACTION_REQUIRED", failedReadiness ? `${name}'s readiness check found something to fix.` : `${name} needs a readiness check.`, {
          next: step("READINESS", "RUN_READINESS", "GROK", failedReadiness ? `I'm checking ${name} again.` : OPERATOR_MESSAGES.validate, { tool: "run_readiness_check", skill: "run-readiness-check" }),
        }),
    !readinessOk
      ? blocked("PRACTICE_TOUR", "Runs once the readiness check passes.")
      : dryOk
        ? component("PRACTICE_TOUR", "READY", `${name}'s practice tour passed.`)
        : component("PRACTICE_TOUR", "ACTION_REQUIRED", `${name} needs a practice tour.`, {
            next: step("PRACTICE_TOUR", "RUN_PRACTICE_TOUR", "GROK", `I'm running a practice tour of ${name}. Nobody is texted and no real door opens.`, { tool: "run_dry_tour", skill: "simulate-tour" }),
          }),
    published
      ? component("PUBLISH", "READY", `${name} is live for demo.`)
      : !(readinessOk && dryOk)
        ? blocked("PUBLISH", "Available once the readiness check and practice tour pass.")
        : component("PUBLISH", "ACTION_REQUIRED", `${name} is ready to publish.`, {
            next: step("PUBLISH", "PUBLISH", "OPERATOR_DECISION", `Everything passed. Would you like me to publish ${name} for demo?`, {
              tool: "publish_demo_property",
              skill: "setup-property",
              grokInstructions: "Publish only after the operator's explicit yes, through publish_demo_property's confirmation question.",
            }),
          }),
  ];
}

// -------------------------------------------------------------- overall

export function getInstallationStatus(inst: Installation, services: OperatorServices, options: StatusOptions = {}): InstallationStatus {
  const deployment = inst.deployment();
  const mode = deployment.mode;
  const infra = [runtimeStatus(options), endpointStatus(inst, mode), grokStatus(inst), messagingStatus(inst), storageStatus(inst), accessStatus()];
  if (deployment.invalid) infra[0]!.technical = [...(infra[0]!.technical ?? []), `TOURCORE_DEPLOYMENT_MODE "${deployment.invalid}" isn't recognized; using ${mode}.`];
  const infrastructureReady = infra.every((c) => c.state === "READY");
  const property = propertyStatus(services);
  const components: ComponentStatus[] = [
    ...infra,
    // Nothing on the property path is offered until the infrastructure is ready.
    infrastructureReady ? property.status : component("PROPERTY", property.ready ? "READY" : "NOT_CONFIGURED", property.ready ? property.status.summary : "Set up once Tour Core is connected and tested."),
    alertsStatus(inst, infrastructureReady && property.ready),
    ...validationStatuses(services, infrastructureReady && property.ready),
  ];
  const alertsOn = components.find((c) => c.component === "OPERATOR_ALERTS")!.state === "READY";
  const nextStep = components.find((c) => c.state !== "READY" && c.next)?.next ?? {
    component: null,
    action: "DONE" as const,
    phase: "OPERATE" as const,
    performedBy: "GROK" as const,
    operatorMessage: alertsOn ? OPERATOR_MESSAGES.operate : OPERATOR_MESSAGES.operateWithoutAlerts,
  };
  const phase: OnboardingPhase = nextStep.phase;
  const url = inst.publicBaseUrl();
  const manifest = safe(() => inst.files.manifest());
  return {
    schemaVersion: 1,
    ...(manifest ? { installationId: manifest.installationId } : {}),
    deploymentMode: mode,
    deploymentLabel: DEPLOYMENT_MODE_LABELS[mode],
    phase,
    components,
    infrastructureReady,
    nextStep,
    summary: summaryFor(phase, infrastructureReady, components),
    lines: components.filter((c) => c.state !== "NOT_CONFIGURED" || c.component === "PROPERTY").map(statusLine),
    technical: { deploymentMode: mode, ...(url ? { publicAddress: url, connectorUrl: `${new URL(url).origin}${MCP_PATH}` } : {}) },
    checkedAt: new Date(inst.now()).toISOString(),
  };
}

function summaryFor(phase: OnboardingPhase, infrastructureReady: boolean, components: ComponentStatus[]): string {
  if (phase === "OPERATE") return "Your property is live for demo.";
  if (!infrastructureReady) {
    const left = components.filter((c) => INFRASTRUCTURE.includes(c.component) && c.state !== "READY").length;
    return `${components[0]!.state === "READY" ? "Tour Core is running. " : ""}${left} more thing${left === 1 ? "" : "s"} to connect before your first property.`;
  }
  if (phase === "PROPERTY") return "Everything needed to run Tour Core is connected and tested.";
  if (phase === "VALIDATE") return "Your property is set up. Next come the readiness check and a practice tour.";
  return "Everything passed. Publishing needs your OK.";
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
