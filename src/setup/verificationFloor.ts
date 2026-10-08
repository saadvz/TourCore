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

export const LIVE_TEXTING_IDENTITY = "Live texting is on, so visitors will now fill out a basic identity form.";

export const DOCUMENT_CHECK_UNAVAILABLE =
  "A full ID check isn't available yet, so visitors will fill out a basic identity form instead.";

export const PRACTICE_ON_LIVE =
  "This place is still on the practice ID check, which only works while texting is in test mode. Want me to switch it to the basic identity form?";

/**
 * Practice (`mock`) is allowed only for QA or demo: local/test texting, demo
 * messaging, or a demo-published property that is not on a live texting line.
 * A live line's floor is the basic identity form. The client name is not an input.
 */
export function verificationFloor(input: {
  draft: Pick<TourCoreConfig, "messagingMode" | "messagingProvider">;
  services?: OperatorServices;
  installation?: Installation;
  /** Already-read provider. Save uses this so the check does not persist a messaging choice. */
  installed?: { provider?: string };
  publishedForDemo?: boolean;
}): VerificationLevel {
  const installed =
    input.installed ?? (input.installation ? installedMessaging(input.installation, { readOnly: true }) : input.services?.installedMessaging?.());
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

export interface VerificationWrite<T> {
  config: T;
  notice?: string;
  refused?: { code: typeof VERIFICATION_BELOW_FLOOR; message: string };
}

/**
 * The one write-time floor. Reading and deploy do not call this.
 * An explicit step down (basic form to practice on a line that is already live)
 * is refused and nothing is written. Switching texting to live, or restoring a
 * live property that is still on practice, raises it to the basic form.
 * A property already stored as live plus practice is left alone until a later
 * write raises the floor or someone asks for a legal check.
 * A full ID check cannot run, so a request for one is never stored. On test
 * or local texting the saved check stays put when it is already the basic
 * form, and otherwise becomes the basic form.
 */
export function enforceVerificationWrite<T extends Pick<TourCoreConfig, "verificationMode" | "messagingMode" | "messagingProvider">>(
  before: T | undefined,
  after: T,
  installed?: { provider?: string },
): VerificationWrite<T> {
  const floorBefore = before ? verificationFloor({ draft: before, installed }) : "mock";
  const floorAfter = verificationFloor({ draft: after, installed });
  const requested = after.verificationMode ?? "basic-form";
  const beforeMode = before?.verificationMode ?? "basic-form";
  let mode = requested;
  let notice: string | undefined;

  if (requested === "document-check") {
    const messagingChanged =
      !!before &&
      (before.messagingMode !== after.messagingMode || (before.messagingProvider ?? "") !== (after.messagingProvider ?? ""));
    const askedNow = !before || beforeMode !== "document-check" || messagingChanged;
    if (askedNow) {
      const keepCurrent = !!before && beforeMode !== "document-check" && verificationRank(beforeMode) >= verificationRank("basic-form");
      mode = keepCurrent ? beforeMode : "basic-form";
      notice = DOCUMENT_CHECK_UNAVAILABLE;
    }
  }

  if (verificationRank(mode) < verificationRank(floorAfter)) {
    const explicitLower = before !== undefined && verificationRank(beforeMode) > verificationRank(requested);
    const floorRose = before !== undefined && verificationRank(floorAfter) > verificationRank(floorBefore);
    if (explicitLower && !floorRose) {
      return { config: before, refused: { code: VERIFICATION_BELOW_FLOOR, message: PRACTICE_REFUSED } };
    }
    if (!before || floorRose) {
      mode = floorAfter;
      notice = LIVE_TEXTING_IDENTITY;
    }
  }

  if (mode === requested) return { config: after, ...(notice ? { notice } : {}) };
  return { config: { ...after, verificationMode: mode }, ...(notice ? { notice } : {}) };
}

/** Publish lists this ahead of a texting failure so the identity check is the first thing to fix. */
export function leadBlockers<T extends { code: string }>(blockers: T[]): T[] {
  const index = blockers.findIndex((item) => item.code === VERIFICATION_BELOW_FLOOR);
  if (index <= 0) return blockers;
  return [blockers[index]!, ...blockers.slice(0, index), ...blockers.slice(index + 1)];
}
