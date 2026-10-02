import type { MessagingProviderId } from "./provider";

/**
 * SMS consent is separate from the transport. STOP, START and HELP stay
 * available wherever Tour Core sends a text. Keyword confirmation is a
 * deployment choice. It is not implied by implementing MessagingProvider.
 */

export type SmsConsentModeSetting = "keyword_confirm" | "provider_default" | "disabled";
export type ResolvedConsentMode = "keyword_confirm" | "disabled";

export interface ConsentRecommendation {
  mode: ResolvedConsentMode;
  /**
   * explicit: TOURCORE_SMS_CONSENT_MODE was set.
   * provider_recommendation: the provider documents a usual setup, not a legal finding.
   * no_provider_requirement: Tour Core has no authoritative rule from that provider.
   */
  source: "explicit" | "provider_recommendation" | "no_provider_requirement";
  /** Plain sentence. Not legal advice. */
  note: string;
}

export function smsConsentModeSetting(env: NodeJS.ProcessEnv = process.env): SmsConsentModeSetting {
  const raw = env.TOURCORE_SMS_CONSENT_MODE?.trim().toLowerCase();
  if (raw === "keyword_confirm" || raw === "disabled" || raw === "provider_default") return raw;
  return "provider_default";
}

/**
 * What Tour Core can actually know about each provider. Twilio's note is a
 * recommendation for current U.S. application-to-person SMS, not a check that
 * the account is registered. Sendblue and Photon do not publish one rule that
 * applies to every line, so they do not inherit Twilio's keyword flow.
 */
export function providerConsentRecommendation(provider: MessagingProviderId | undefined): ConsentRecommendation {
  if (provider === "twilio") {
    return {
      mode: "keyword_confirm",
      source: "provider_recommendation",
      note: "Recommended for current U.S. application-to-person SMS. Tour Core does not decide whether this Twilio account is registered.",
    };
  }
  if (provider === "photon") {
    return {
      mode: "disabled",
      source: "no_provider_requirement",
      note: "Photon does not give Tour Core an SMS keyword rule. The conversation starts immediately. Set TOURCORE_SMS_CONSENT_MODE=keyword_confirm to require TOUR and YES. SMS or RCS fallback is not assumed.",
    };
  }
  return {
    mode: "keyword_confirm",
    source: "no_provider_requirement",
    note: "Sendblue does not give Tour Core one compliance rule for every line. This deployment keeps keyword confirmation until TOURCORE_SMS_CONSENT_MODE=disabled. That is not Twilio A2P and it is not a carrier approval. Sandbox and dedicated lines may differ.",
  };
}

export function resolveConsentPolicy(env: NodeJS.ProcessEnv, provider: MessagingProviderId | undefined): ConsentRecommendation {
  const setting = smsConsentModeSetting(env);
  if (setting === "disabled") {
    return { mode: "disabled", source: "explicit", note: "This deployment turned keyword confirmation off. STOP, START, and HELP still apply." };
  }
  if (setting === "keyword_confirm") {
    return { mode: "keyword_confirm", source: "explicit", note: "This deployment requires keyword confirmation before property or booking content." };
  }
  return providerConsentRecommendation(provider);
}

/** Applies an explicit setting, otherwise the caller's provider default. */
export function resolveConsentMode(env: NodeJS.ProcessEnv, providerDefault: ResolvedConsentMode = "keyword_confirm"): ResolvedConsentMode {
  const setting = smsConsentModeSetting(env);
  if (setting === "disabled") return "disabled";
  if (setting === "keyword_confirm") return "keyword_confirm";
  return providerDefault;
}

export function consentModeForProvider(env: NodeJS.ProcessEnv, provider: MessagingProviderId | undefined): ResolvedConsentMode {
  return resolveConsentPolicy(env, provider).mode;
}
