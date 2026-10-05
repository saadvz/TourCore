import { isLiveMessaging } from "../config/tourCoreConfig";
import type { Installation } from "../install/installation";
import { setServices, SetupInputError } from "../setup/setupActions";
import type { PropertyWorkspace } from "../setup/workspace";
import { propertyMessagingOverride } from "./propertyScope";
import { createMessagingProvider, manifestProviderName, selectionFromInstallation } from "./registry";
import type { MessagingProviderId } from "./provider";

/**
 * Deliberate provider change. Property and tour records stay. The previous
 * provider is taken out of active use, its webhook is removed when that is
 * safe, and messaging has to pass a connection test again.
 *
 * Saved Sendblue, Twilio, and Photon credentials and attached lines stay in
 * the secret store. Switching to local (or any other provider) must not
 * blank them. Switching back uses the stored account unless it was never set.
 *
 * First slice of property-scoped messaging: `local` plus a property opts that
 * building into the QA loopback without changing the installation's primary
 * provider and without drafting other published buildings.
 */
export async function chooseMessagingProvider(
  inst: Installation,
  provider: MessagingProviderId,
  options: { workspace?: PropertyWorkspace; propertyId?: string } = {},
): Promise<{ changed: boolean; summary: string; scope: "property" | "installation" }> {
  if (options.propertyId && options.workspace) {
    return applyPropertyMessaging(options.workspace, options.propertyId, provider, inst);
  }
  if (provider === "local" && options.workspace) {
    const ids = options.workspace.propertyIds();
    if (ids.length === 1) return applyPropertyMessaging(options.workspace, ids[0]!, provider, inst);
    if (ids.length > 1) {
      throw new SetupInputError(
        "PROPERTY_REQUIRED",
        "Say which building should use local test texts. Other buildings stay on live visitor texting.",
      );
    }
  }

  const current = selectionFromInstallation(inst).provider;
  const state = inst.files.state();
  if (current === provider && state.messagingProviderChoice === provider) {
    return { changed: false, summary: "Visitor texting is already set up to use that option.", scope: "installation" };
  }

  if (current && current !== provider) {
    const previous = createMessagingProvider(current, { env: () => inst.env(), sendblue: () => inst.sendblueEnv() });
    const urls = ownedWebhookUrls(inst, previous.webhookPath());
    try {
      await previous.disconnect?.(urls);
    } catch {
      // The old address can be removed later. It is no longer the active provider.
    }
    if (options.workspace) {
      for (const id of options.workspace.propertyIds()) {
        const { config, state: property } = options.workspace.load(id);
        if (propertyMessagingOverride(config) === "local") continue;
        if (isLiveMessaging(config.messagingMode) && (property.readiness || property.publishedAt)) {
          options.workspace.invalidateReadiness(id, "Visitor texting changed. Run the readiness check again.");
        }
      }
    }
  }

  const next = { ...inst.files.state(), messagingProviderChoice: provider };
  delete next.visitorMessaging;
  inst.files.writeState(next);
  inst.files.update({ messagingProvider: manifestProviderName(provider) }, new Date(inst.now()));
  return { changed: true, summary: switchSummary(inst, provider), scope: "installation" };
}

function applyPropertyMessaging(
  workspace: PropertyWorkspace,
  propertyId: string,
  provider: MessagingProviderId,
  inst: Installation,
): { changed: boolean; summary: string; scope: "property" } {
  if (!workspace.has(propertyId) && !workspace.openDraft(propertyId).draft) {
    throw new SetupInputError("PROPERTY_NOT_FOUND", "I couldn't find that property.");
  }
  const { draft } = workspace.openDraft(propertyId);
  if (provider === "local") {
    if (propertyMessagingOverride(draft) === "local" && isLiveMessaging(draft.messagingMode)) {
      return { changed: false, summary: "Visitor texting for this building already uses local test texts.", scope: "property" };
    }
    workspace.persistEdit(setServices(draft, { messagingProvider: "local" }), new Date(inst.now()));
    return {
      changed: true,
      summary: "Visitor texting for this building will use local test texts. No real texts are sent. Other buildings stay as they are.",
      scope: "property",
    };
  }

  const installProvider = selectionFromInstallation(inst).provider;
  if (installProvider && provider !== installProvider) {
    throw new SetupInputError(
      "PROPERTY_PROVIDER_UNAVAILABLE",
      "A building can use local test texts or the installation's live visitor texting. Choosing a different live provider for one building isn't available yet.",
    );
  }
  if (propertyMessagingOverride(draft) === undefined && isLiveMessaging(draft.messagingMode)) {
    return { changed: false, summary: "Visitor texting for this building already uses the installation's live texting.", scope: "property" };
  }
  workspace.persistEdit(setServices(draft, { messagingMode: "live" }), new Date(inst.now()));
  return {
    changed: true,
    summary: "Visitor texting for this building will use the installation's live texting.",
    scope: "property",
  };
}

function switchSummary(inst: Installation, provider: MessagingProviderId): string {
  if (provider === "local") {
    return "Visitor texting will use the local loopback. No real texts are sent.";
  }
  const name = provider === "sendblue" ? "Sendblue" : provider === "twilio" ? "Twilio" : "Photon";
  const incoming = createMessagingProvider(provider, { env: () => inst.env(), sendblue: () => inst.sendblueEnv() });
  if (incoming.validateConfiguration().ok) {
    return `Visitor texting will use ${name}. I'll test the saved account next.`;
  }
  return `Visitor texting will use ${name}. I'll ask for the account details securely; they won't be shown in chat.`;
}

function ownedWebhookUrls(inst: Installation, path: string): string[] {
  const bases = new Set<string>();
  const current = inst.publicBaseUrl()?.replace(/\/$/, "");
  if (current) bases.add(current);
  for (const entry of inst.files.state().publicBaseUrlHistory) {
    if (entry.url) bases.add(entry.url.replace(/\/$/, ""));
  }
  return [...bases].map((base) => `${base}${path}`);
}
