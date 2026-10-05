import { isLiveMessaging } from "../config/tourCoreConfig";
import type { PropertyWorkspace } from "../setup/workspace";
import { DEFAULT_LOCAL_FROM_NUMBER, readLocalEnv } from "./local/provider";
import type { MessagingProviderId } from "./provider";

/**
 * First slice of property-scoped messaging: a property may opt into the local
 * loopback while the installation's primary provider (Sendblue, Twilio, or
 * Photon) stays in place for every other building. Full per-property carrier
 * credentials are a later slice.
 */
export type PropertyMessagingProvider = "local";

export function propertyMessagingOverride(config: { messagingProvider?: string } | undefined): PropertyMessagingProvider | undefined {
  return config?.messagingProvider === "local" ? "local" : undefined;
}

/** Which provider this live property actually uses. Absent when texts are practice-only. */
export function propertyMessagingProvider(
  config: { messagingMode?: string; messagingProvider?: string } | undefined,
  installed?: { provider?: string } | undefined,
): MessagingProviderId | undefined {
  if (!isLiveMessaging(config?.messagingMode)) return undefined;
  if (propertyMessagingOverride(config) === "local") return "local";
  return installed?.provider as MessagingProviderId | undefined;
}

export function usesLocalMessaging(
  config: { messagingMode?: string; messagingProvider?: string } | undefined,
  installed?: { provider?: string } | undefined,
): boolean {
  return propertyMessagingProvider(config, installed) === "local";
}

export function anyPropertyUsesLocal(workspace: PropertyWorkspace): boolean {
  return workspace.propertyIds().some((id) => {
    const draft = workspace.openDraft(id).draft;
    return usesLocalMessaging(draft);
  });
}

export function localLoopbackNumber(env?: NodeJS.ProcessEnv): string {
  return readLocalEnv(env).fromNumber ?? DEFAULT_LOCAL_FROM_NUMBER;
}
