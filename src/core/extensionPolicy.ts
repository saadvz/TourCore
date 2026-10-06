/**
 * ONE isolated policy point: whether an ask for more time before the T-5
 * offering can be granted right away. Default is T-5-only. Flip this
 * constant (or pass the same flag into the scheduler) to grant early asks.
 */
export const EARLY_EXTENSION_ASK_GRANTS = false;

export type ExtensionAskDecision = "defer" | "consider" | "after-t";

/**
 * Whether this ask may try to take the one-time extension.
 * - after T: never
 * - after an offering T-5 warning: yes (recheck the slot)
 * - before that warning: only when EARLY_EXTENSION_ASK_GRANTS is on
 */
export function earlyExtensionAskDecision(input: {
  offeringT5Sent: boolean;
  nowMs: number;
  windowEndMs: number;
  /** Override the default constant. Tests use this so they don't flip global state. */
  earlyAskGrants?: boolean;
}): ExtensionAskDecision {
  if (input.nowMs >= input.windowEndMs) return "after-t";
  if (input.offeringT5Sent) return "consider";
  return (input.earlyAskGrants ?? EARLY_EXTENSION_ASK_GRANTS) ? "consider" : "defer";
}
