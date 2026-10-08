import { isLiveMessaging, type TourCoreConfig } from "../config/tourCoreConfig";
import { installedMessaging } from "../install/status";
import type { Installation } from "../install/installation";
import { usesLocalMessaging } from "../messaging/propertyScope";
import type { OperatorServices } from "../operator/services";

/** Stored verification, weakest to strictest. Practice is `mock`. */
export const VERIFICATION_ORDER = ["mock", "basic-form", "document-check"] as const;
export type VerificationLevel = (typeof VERIFICATION_ORDER)[number];

export const VERIFICATION_BELOW_FLOOR = "VERIFICATION_BELOW_FLOOR";

export const PRACTICE_REFUSED =
  "Practice verification isn't available while people can text this place for real. The identity check stays as it is.";

/**
 * Practice (`mock`) is allowed only for QA or demo: local/test texting, demo
 * messaging, or a demo-published property that is not on a live texting line.
 * A live line's floor is the basic identity form. The client name is not an input.
 */
export function verificationFloor(input: {
  draft: Pick<TourCoreConfig, "messagingMode" | "messagingProvider">;
  services?: OperatorServices;
  installation?: Installation;
  publishedForDemo?: boolean;
}): VerificationLevel {
  const installed = input.installation ? installedMessaging(input.installation, { readOnly: true }) : input.services?.installedMessaging?.();
  const local = usesLocalMessaging(input.draft, installed);
  const demoMessaging = !isLiveMessaging(input.draft.messagingMode);
  if (local || demoMessaging) return "mock";
  return "basic-form";
}

export function verificationRank(level: VerificationLevel): number {
  return VERIFICATION_ORDER.indexOf(level);
}

/** True when the requested level is allowed. Stricter than the floor is allowed. Below the floor is not. */
export function verificationAllowed(floor: VerificationLevel, requested: VerificationLevel): boolean {
  return verificationRank(requested) >= verificationRank(floor);
}
