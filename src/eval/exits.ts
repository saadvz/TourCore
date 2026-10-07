import type { ClickStep, EvalSession, ExitHint } from "./session";

export interface ExitRecord {
  task: string;
  what: string;
  label: "key" | "not key";
  taken: boolean;
  source: string;
}

interface StepLike {
  action?: string;
  performedBy?: string;
  tool?: string;
  secureSetupStep?: string;
  mentionsSecureSetup?: boolean;
  operatorMessage?: string;
}

/**
 * An out-of-chat exit. "key" means the landlord leaves chat to enter an API
 * key or similar secret. Signing in to Google Drive, or clicking Allow, is
 * not a key.
 */
export function classifyExit(step: StepLike): { what: string; label: "key" | "not key" } | undefined {
  const action = step.action ?? "";
  const tool = step.tool ?? "";
  const performedBy = step.performedBy ?? "";
  const secure = performedBy === "OPERATOR_IN_SECURE_SETUP" || tool === "get_secure_setup_url" || !!step.secureSetupStep || step.mentionsSecureSetup === true;
  if (action === "CONFIRM_BACKUP_DESTINATION" || action === "CONNECT_GOOGLE_DRIVE" || tool === "begin_google_drive_connect" || tool === "confirm_backup_destination") {
    return { what: "Google Drive backup sign-in", label: "not key" };
  }
  if (action === "CONNECT_GROK" || action === "RECONNECT_GROK" || (performedBy === "OPERATOR" && /approval|Allow/i.test(step.operatorMessage ?? ""))) {
    return { what: "Grok connection approval", label: "not key" };
  }
  if (secure && (step.secureSetupStep === "operator-alerts" || action === "OFFER_OPERATOR_ALERTS")) {
    return { what: "Tour-update secure setup (routine address and key)", label: "key" };
  }
  if (secure) return { what: "Texting secure setup (API key)", label: "key" };
  return undefined;
}

function seenKey(exits: ExitRecord[], what: string): boolean {
  return exits.some((exit) => exit.what === what);
}

/** Exits observed on the canonical click path. The baseline path does not take any of them. */
export function exitsFromClickPath(steps: ClickStep[], hints: ExitHint[]): ExitRecord[] {
  const exits: ExitRecord[] = [];
  const takenTools = new Set(steps.map((step) => step.tool));
  for (const hint of hints) {
    const classified = classifyExit(hint);
    if (!classified || seenKey(exits, classified.what)) continue;
    const taken =
      classified.label === "key"
        ? takenTools.has("get_secure_setup_url")
        : classified.what.startsWith("Google Drive")
          ? takenTools.has("confirm_backup_destination") || takenTools.has("begin_google_drive_connect")
          : false;
    exits.push({
      task: "full setup to publish",
      what: classified.what,
      label: classified.label,
      taken,
      source: hint.action ?? "next step",
    });
  }
  return exits;
}

/**
 * In-process probe of the Sendblue choice. No property is created and the
 * secure-setup token is not stored.
 */
export async function probeTextingExit(session: EvalSession): Promise<ExitRecord> {
  await session.call("choose_messaging_provider", { provider: "sendblue" }, false);
  const next = await session.call("get_next_installation_step", {}, false);
  const url = await session.call("get_secure_setup_url", { step: "visitor-messaging" }, false);
  const hasUrl = typeof url.url === "string" && url.url.length > 0;
  if (next.action !== "CONNECT_VISITOR_MESSAGING" || next.tool !== "get_secure_setup_url" || next.performedBy !== "OPERATOR_IN_SECURE_SETUP" || !hasUrl) {
    throw new Error(`sendblue probe did not offer secure setup: ${JSON.stringify({ action: next.action, tool: next.tool, performedBy: next.performedBy, hasUrl })}`);
  }
  return {
    task: "full setup to publish",
    what: "Texting secure setup (API key)",
    label: "key",
    taken: false,
    source: "sendblue probe (not the baseline path)",
  };
}

export function followOnExits(): ExitRecord[] {
  return [
    { task: "book a one-off tour", what: "none", label: "not key", taken: false, source: "no out-of-chat step" },
    { task: "answer a flagged question", what: "none", label: "not key", taken: false, source: "no out-of-chat step" },
    { task: "pause a unit", what: "none", label: "not key", taken: false, source: "no out-of-chat step" },
    { task: "export a day's audit", what: "none", label: "not key", taken: false, source: "summary stays in chat; a download link is not a sign-in" },
  ];
}
