import type { PropertyWorkspace, PublishResult } from "./workspace";

/**
 * The setup engine's public actions. Any setup surface (the terminal wizard
 * today, a Grok Bot skill later) should drive setup only through these.
 */
export {
  createPropertySetup,
  setPropertyDetails,
  setAlertContact,
  addUnit,
  renameUnit,
  removeUnit,
  setUnitSummary,
  setUnitDetails,
  setUnitProfile,
  suggestRoute,
  doorFollowsUnitName,
  defaultUnitDoorName,
  addDoor,
  renameDoor,
  removeDoor,
  setRoute,
  setTourHours,
  setVerificationPolicy,
  setServices,
  reviewSetup,
  visitorHelpDecided,
  visitorHelpLines,
  visitorHelpQuestion,
  VISITOR_HELP_QUESTION,
  VISITOR_HELP_NUMBER_QUESTION,
  VISITOR_HELP_EMAIL_QUESTION,
  describeDays,
  describeMinutes,
  describeInterval,
  SETUP_DEFAULTS,
  OperatorTeamCopy,
  CHOICE_LABELS,
  SetupInputError,
  type SetupDraft,
  type SetupReview,
  type ReviewSection,
} from "./setupActions";
export { runReadinessCheck, type ReadinessResult, type ReadinessCheck } from "./readiness";
export { runDryTour, type DryTourEvent, type DryTourResult } from "./dryTour";
export { PropertyWorkspace, statusLabel, configHash, isCurrent, type PropertyState, type PublishResult, type PublicationStatus } from "./workspace";

/** Demo publish only: never a production launch. See PublicationStatus. */
export function publishDemoProperty(workspace: PropertyWorkspace, propertyId: string, now?: Date): Promise<PublishResult> {
  return workspace.publishDemoProperty(propertyId, now);
}
export { parseDays, parseTimeOfDay, parseMinutes, parseChoiceList, resolveTimeZone, inferTimeZone } from "./parse";
export { SETUP_COMMANDS, applySetupCommand, type SetupCommandName } from "./commands";
export {
  draftView,
  readinessView,
  dryTourView,
  propertySummary,
  saveStateView,
  tourListView,
  tourDetailView,
  fixFor,
  SETUP_STEPS,
  COMMON_TIME_ZONES,
  type DraftView,
  type SetupStep,
} from "./presenters";
export type { TourRecord, ConversationItem } from "./workspace";
export { describeHistory, type HistoryEntry } from "../audit/describe";
export { validateConfig } from "../config/tourCoreConfig";
export type { ConfigIssue, ConfigSection } from "../config/validateConfig";
