import type { DeploymentMode } from "./deployment";
import type { InstallationManifest } from "./manifest";
import { OTHER_SECRET_ENV, SECRET_SETTING_NAMES, SETTING_NAMES, type SecretStore } from "./secretStore";

/**
 * The settings Tour Core's adapters read, layered in one place:
 *
 *   1. the process environment (a developer's `.env` is loaded into it);
 *   2. values saved through the secure setup page (SecretStore), which win,
 *      so re-entering a credential there always takes effect;
 *   3. the public address from the installation manifest, used when no
 *      PUBLIC_BASE_URL is set, and always in GROK_MANAGED_P0 (where the tunnel,
 *      not a person, owns the address).
 *
 * Adapters keep reading familiar names (SENDBLUE_API_API_KEY, PUBLIC_BASE_URL,
 * ...), so LOCAL_DEVELOPER setups with only a `.env` behave exactly as before.
 */

export interface SettingsSource {
  secrets?: SecretStore;
  manifest?: () => InstallationManifest | undefined;
  deploymentMode?: () => DeploymentMode;
}

let source: SettingsSource = {};

/**
 * The running server registers its installation here. Returns a function that
 * puts the previous one back, but only if nothing registered since (servers
 * can close after a newer one started).
 */
export function useSettingsSource(next: SettingsSource): () => void {
  const previous = source;
  const mine: SettingsSource = { ...next };
  source = mine;
  return () => {
    if (source === mine) source = previous;
  };
}

export function effectiveEnv(env: NodeJS.ProcessEnv = process.env, from: SettingsSource = source): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  if (from.secrets) {
    for (const name of SETTING_NAMES) {
      const value = safe(() => from.secrets!.get(name));
      if (value) out[name] = value;
    }
  }
  const manifest = from.manifest ? safe(from.manifest) : undefined;
  const mode = from.deploymentMode?.() ?? manifest?.deploymentMode;
  if (manifest?.publicBaseUrl && (mode === "GROK_MANAGED_P0" || !out.PUBLIC_BASE_URL?.trim())) out.PUBLIC_BASE_URL = manifest.publicBaseUrl;
  return out;
}

/** Every configured credential value, wherever it came from. For redaction only. */
export function secretValues(env: NodeJS.ProcessEnv = process.env, from: SettingsSource = source): string[] {
  const merged = effectiveEnv(env, from);
  return [...SECRET_SETTING_NAMES, ...OTHER_SECRET_ENV].map((k) => merged[k]?.trim()).filter((v): v is string => !!v && v.length >= 6);
}

/** Where a setting's current value comes from, for status pages. Never the value. */
export function settingSource(name: (typeof SETTING_NAMES)[number], env: NodeJS.ProcessEnv = process.env, from: SettingsSource = source): "secure-setup" | "environment" | "not-set" {
  if (from.secrets && safe(() => from.secrets!.get(name))) return "secure-setup";
  return env[name]?.trim() ? "environment" : "not-set";
}

function safe<T>(read: () => T): T | undefined {
  try {
    return read();
  } catch {
    return undefined;
  }
}
