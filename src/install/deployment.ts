/**
 * How this Tour Core is installed and who runs it.
 *
 *  LOCAL_DEVELOPER  a developer's own computer: `npm run setup`, a local
 *                   browser, a manual tunnel and `.env`. The default.
 *  GROK_MANAGED_P0  installed and run by Grok on its own cloud computer
 *                   (`npm run bootstrap:grok`). A demo deployment, not 24/7
 *                   production hosting.
 *  SELF_HOSTED      already running at a stable https address; Grok only
 *                   connects over OAuth MCP and drives configuration.
 *
 * The mode changes how the installation is set up and reached, never a tour,
 * policy or access rule.
 */

export const DEPLOYMENT_MODES = ["LOCAL_DEVELOPER", "GROK_MANAGED_P0", "SELF_HOSTED"] as const;
export type DeploymentMode = (typeof DEPLOYMENT_MODES)[number];

const ALIASES: Record<string, DeploymentMode> = {
  local_developer: "LOCAL_DEVELOPER",
  local: "LOCAL_DEVELOPER",
  developer: "LOCAL_DEVELOPER",
  grok_managed_p0: "GROK_MANAGED_P0",
  grok_managed: "GROK_MANAGED_P0",
  grok: "GROK_MANAGED_P0",
  self_hosted: "SELF_HOSTED",
  selfhosted: "SELF_HOSTED",
};

export type ParsedDeploymentMode = { mode: DeploymentMode } | { invalid: string };

/** Accepts the canonical names and a few friendly spellings ("grok", "self-hosted"). Blank means "not set". */
export function parseDeploymentMode(raw: string | undefined): ParsedDeploymentMode | undefined {
  const value = raw?.trim();
  if (!value) return undefined;
  const mode = ALIASES[value.toLowerCase().replace(/[\s-]+/g, "_")];
  return mode ? { mode } : { invalid: value };
}

/**
 * TOURCORE_DEPLOYMENT_MODE wins, then what the installation manifest recorded,
 * then LOCAL_DEVELOPER. An unreadable value falls back to the manifest/default
 * and is reported so the operator can fix it.
 */
export function resolveDeploymentMode(env: NodeJS.ProcessEnv = process.env, recorded?: DeploymentMode): { mode: DeploymentMode; source: "environment" | "manifest" | "default"; invalid?: string } {
  const parsed = parseDeploymentMode(env.TOURCORE_DEPLOYMENT_MODE);
  if (parsed && "mode" in parsed) return { mode: parsed.mode, source: "environment" };
  const invalid = parsed && "invalid" in parsed ? parsed.invalid : undefined;
  if (recorded) return { mode: recorded, source: "manifest", ...(invalid ? { invalid } : {}) };
  return { mode: "LOCAL_DEVELOPER", source: "default", ...(invalid ? { invalid } : {}) };
}

export const DEPLOYMENT_MODE_LABELS: Record<DeploymentMode, string> = {
  LOCAL_DEVELOPER: "Developer computer",
  GROK_MANAGED_P0: "Grok's cloud computer (demo)",
  SELF_HOSTED: "Self-hosted",
};
