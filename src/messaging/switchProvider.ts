import { isLiveMessaging } from "../config/tourCoreConfig";
import type { Installation } from "../install/installation";
import type { PropertyWorkspace } from "../setup/workspace";
import { createMessagingProvider, manifestProviderName, selectionFromInstallation } from "./registry";
import type { MessagingProviderId } from "./provider";

/**
 * Deliberate provider change. Property and tour records stay. The previous
 * provider is taken out of active use, its webhook is removed when that is
 * safe, and messaging has to pass a connection test again.
 */
export async function chooseMessagingProvider(
  inst: Installation,
  provider: MessagingProviderId,
  options: { workspace?: PropertyWorkspace } = {},
): Promise<{ changed: boolean; summary: string }> {
  const current = selectionFromInstallation(inst).provider;
  const state = inst.files.state();
  if (current === provider && state.messagingProviderChoice === provider) {
    return { changed: false, summary: "Visitor texting is already set up to use that option." };
  }

  if (current && current !== provider) {
    const previous = createMessagingProvider(current, { env: () => inst.env(), sendblue: () => inst.sendblueEnv() });
    const urls = ownedWebhookUrls(inst, previous.webhookPath());
    try {
      await previous.disconnect?.(urls);
    } catch {
      // The old address can be removed later. It is no longer the active provider.
    }
    inst.secrets.delete(previous.settingNames() as never, new Date(inst.now()));
    if (options.workspace) {
      for (const id of options.workspace.propertyIds()) {
        const { config, state: property } = options.workspace.load(id);
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
  if (provider === "local") {
    return { changed: true, summary: "Visitor texting will use the local loopback. No real texts are sent." };
  }
  const name = provider === "sendblue" ? "Sendblue" : provider === "twilio" ? "Twilio" : "Photon";
  return { changed: true, summary: `Visitor texting will use ${name}. I'll ask for the account details securely; they won't be shown in chat.` };
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
