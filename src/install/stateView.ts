import { PROPERTY_TYPE_LABELS, validateConfig } from "../config/tourCoreConfig";
import { nextProfileQuestion } from "../config/unitProfile";
import { renderPlaybook, spokenAsk } from "../playbooks/compose";
import type { ReportedClient } from "../playbooks/select";
import { SETUP_HELP_ENDING } from "../playbooks/setupHelp";
import { SHARED_STEPS, type StepId } from "../playbooks/shared";
import { visitorTexting } from "../operator/setupFlow";
import type { OperatorServices } from "../operator/services";
import { draftView } from "../setup/presenters";
import { SetupInputError, condoNextQuestion, operatorFacingPropertyName, visitorHelpQuestion, type SetupDraft } from "../setup/setupActions";
import { isCurrent, statusLabel } from "../setup/workspace";
import { operatorUnitName } from "../visitor/identity";
import { isHostedRailway } from "./deployment";
import type { Installation } from "./installation";
import { storageVolumeHealth } from "./persistentVolume";
import { getInstallationStatus, installedMessaging, primaryProperty, type InstallationStatus, type InstallationStep } from "./status";

const MILESTONES = [
  { id: "texting", order: 1, title: "Texting" },
  { id: "backups", order: 2, title: "Backups" },
  { id: "property", order: 3, title: "Property" },
  { id: "units", order: 4, title: "Units, doors, and routes" },
  { id: "hours", order: 5, title: "Hours" },
  { id: "practice", order: 6, title: "Practice tour" },
  { id: "publish", order: 7, title: "Publish" },
] as const;

type MilestoneId = (typeof MILESTONES)[number]["id"];

const SELF_HOST_DRIVE_ACTIONS = new Set(["CONNECT_GOOGLE_DRIVE", "FINISH_GOOGLE_DRIVE"]);
const SELF_HOST_DRIVE_TOOLS = new Set(["begin_google_drive_connect", "finish_google_drive_setup", "use_local_demo_storage", "migrate_storage_to_google_drive", "activate_google_drive_storage"]);

export interface StateReadInput {
  installation?: Installation;
  services: OperatorServices;
  client?: ReportedClient;
}

interface Picture {
  id?: string;
  draft?: SetupDraft;
  addressReady: boolean;
  needsAddressConfirm: boolean;
  typeReady: boolean;
  unitsReady: boolean;
  helpOpen: boolean;
  hoursReady: boolean;
  readinessPassed: boolean;
  practicePassed: boolean;
  published: boolean;
}

function component(status: InstallationStatus, name: string) {
  return status.components.find((item) => item.component === name);
}

function pictureOf(services: OperatorServices, id: string | undefined): Picture {
  const empty: Picture = {
    addressReady: false,
    needsAddressConfirm: false,
    typeReady: false,
    unitsReady: false,
    helpOpen: false,
    hoursReady: false,
    readinessPassed: false,
    practicePassed: false,
    published: false,
  };
  if (!id) return empty;
  let draft: SetupDraft;
  try {
    draft = services.workspace.openDraft(id).draft;
  } catch {
    return empty;
  }
  const saved = services.workspace.has(id) ? services.workspace.load(id) : undefined;
  const missingZip = !!draft.property.canonicalAddress && !draft.property.canonicalAddress.postalCode;
  const addressReady = !!draft.property.address.trim() && !missingZip && draft.property.addressConfirmed !== false;
  const needsAddressConfirm = !!draft.property.canonicalAddress?.postalCode && draft.property.addressConfirmed === false;
  const typeReady = !!draft.property.propertyType;
  const issues = validateConfig(draft);
  const unitIssues = issues.some((issue) => issue.section === "units" || issue.section === "routes");
  const unitsReady = addressReady && typeReady && draft.units.length > 0 && !condoNextQuestion(draft) && !nextProfileQuestion(draft.units) && !unitIssues;
  const helpOpen = !!visitorHelpQuestion(draft);
  const otherIssues = issues.some((issue) => issue.section !== "units" && issue.section !== "routes");
  return {
    id,
    draft,
    addressReady,
    needsAddressConfirm,
    typeReady,
    unitsReady,
    helpOpen,
    hoursReady: unitsReady && !helpOpen && !otherIssues,
    readinessPassed: !!saved && !!saved.state.readiness?.passed && isCurrent(saved.state.readiness, saved.state),
    practicePassed: !!saved && !!saved.state.dryTour?.passed && isCurrent(saved.state.dryTour, saved.state),
    published: saved?.state.status === "PUBLISHED_FOR_DEMO",
  };
}

function presentNext(status: InstallationStatus): InstallationStep {
  const step = status.nextStep;
  const hosted = isHostedRailway(status.deploymentMode);
  const selfHostDrive = SELF_HOST_DRIVE_ACTIONS.has(step.action) || (!!step.tool && SELF_HOST_DRIVE_TOOLS.has(step.tool));
  if (!hosted || !selfHostDrive) return step;
  return {
    ...step,
    component: "STORAGE",
    action: "CONFIRM_BACKUP_DESTINATION",
    performedBy: "OPERATOR_DECISION",
    operatorMessage: SHARED_STEPS.backups.ask,
    tool: "confirm_backup_destination",
    optional: true,
  };
}

function stepFor(action: string, picture: Picture): StepId {
  if (action === "START_RUNTIME" || action === "ESTABLISH_PUBLIC_ENDPOINT" || action === "CHECK_PUBLIC_ENDPOINT") return "starting";
  if (action === "CONNECT_GROK" || action === "RECONNECT_GROK" || action === "FIX_GROK_CONNECTOR") return "connect";
  if (action === "CHOOSE_MESSAGING_PROVIDER") return "texting-choose";
  if (action === "CONNECT_VISITOR_MESSAGING" || action === "FIX_VISITOR_MESSAGING") return "texting-keys";
  if (action === "CHOOSE_MESSAGING_LINE") return "texting-line";
  if (action === "TEST_VISITOR_MESSAGING" || action === "RECONNECT_VISITOR_MESSAGING") return "texting-test";
  if (action === "CONFIRM_BACKUP_DESTINATION" || action === "CONNECT_GOOGLE_DRIVE" || action === "FINISH_GOOGLE_DRIVE" || action === "CHECK_STORAGE") return "backups";
  if (action === "SET_UP_PROPERTY") return "property-address";
  if (action === "FINISH_PROPERTY_SETUP") {
    if (!picture.addressReady) return picture.needsAddressConfirm ? "property-confirm" : "property-address";
    if (!picture.typeReady) return "property-type";
    if (!picture.unitsReady) {
      if (picture.draft?.property.propertyType === "SINGLE_FAMILY" && picture.draft.units.length === 0) return "units-home";
      if (picture.draft && picture.draft.units.length > 0 && (condoNextQuestion(picture.draft) || nextProfileQuestion(picture.draft.units))) return "units-details";
      if (picture.draft && picture.draft.units.length > 0) return "units-route";
      return "units-which";
    }
    if (picture.helpOpen) return "hours-help";
    return "hours";
  }
  if (action === "OFFER_OPERATOR_ALERTS" || action === "CONNECT_OPERATOR_ALERTS" || action === "TEST_OPERATOR_ALERTS" || action === "FIX_OPERATOR_ALERTS") return "alerts";
  if (action === "RUN_READINESS") return "readiness";
  if (action === "RUN_PRACTICE_TOUR") return "practice";
  if (action === "PUBLISH" || action === "FIX_PROPERTY_TEXTING") return "publish";
  if (action === "ADD_ANOTHER_PROPERTY" || action === "DONE") return picture.published ? "another" : "operate";
  return "operate";
}

function milestonesFor(status: InstallationStatus, picture: Picture) {
  const textingDone = component(status, "VISITOR_MESSAGING")?.state === "READY";
  const backupsDone = component(status, "STORAGE")?.state === "READY";
  const propertyDone = picture.addressReady && picture.typeReady;
  const done = [textingDone, backupsDone, propertyDone, picture.unitsReady, picture.hoursReady, picture.readinessPassed && picture.practicePassed, picture.published];
  const prior = ["RUNTIME", "PUBLIC_ENDPOINT", "GROK_OPERATOR"].map((name) => component(status, name)).find((item) => item && item.state !== "READY");
  const alerts = component(status, "OPERATOR_ALERTS");
  const alertsBlocking = !!alerts && alerts.state !== "READY" && alerts.state !== "NOT_CONFIGURED" && !!alerts.next && picture.hoursReady && !(picture.readinessPassed && picture.practicePassed);
  const waiting = [
    "Texting isn't finished yet.",
    "Backups aren't decided yet. Saving a copy or skipping both still count.",
    "The property isn't set up yet.",
    "Units, doors, and routes aren't finished.",
    "Touring hours aren't confirmed yet.",
    "The practice tour hasn't passed.",
    "This place isn't published yet.",
  ];
  let marked = false;
  return MILESTONES.map((milestone, index) => {
    if (done[index]) return { ...milestone, status: "done" as const };
    if (marked) return { ...milestone, status: "blocked" as const, reason: waiting[index]! };
    if (milestone.id === "texting" && prior) {
      marked = true;
      const reason = prior.component === "RUNTIME" ? "Tour Core isn't running yet." : prior.component === "PUBLIC_ENDPOINT" ? "The connection isn't ready yet." : "You're not connected yet.";
      return { ...milestone, status: "blocked" as const, reason };
    }
    if (milestone.id === "practice" && alertsBlocking) {
      marked = true;
      return { ...milestone, status: "blocked" as const, reason: "Tour updates aren't set yet. You can turn them on or skip them." };
    }
    marked = true;
    return { ...milestone, status: "next" as const };
  });
}

function focusStep(milestones: ReturnType<typeof milestonesFor>, action: string, picture: Picture): StepId {
  const current = milestones.find((milestone) => milestone.status === "next");
  const practiceBlocked = milestones.some((milestone) => milestone.id === "practice" && milestone.status === "blocked" && milestone.reason?.startsWith("Tour updates"));
  if (!current && practiceBlocked) return "alerts";
  if (!current) return stepFor(action, picture);
  if (current.id === "texting" || current.id === "backups") return stepFor(action, picture);
  if (current.id === "property") {
    if (picture.needsAddressConfirm) return "property-confirm";
    if (!picture.addressReady) return "property-address";
    return "property-type";
  }
  if (current.id === "units" || current.id === "hours") return stepFor("FINISH_PROPERTY_SETUP", picture);
  if (current.id === "practice") return picture.readinessPassed ? "practice" : "readiness";
  return "publish";
}

function healthLine(inst: Installation, status: InstallationStatus): string {
  if (component(status, "RUNTIME")?.state !== "READY") return `Tour Core isn't running right now. I'll try again. ${SETUP_HELP_ENDING}`;
  if (isHostedRailway(status.deploymentMode) && storageVolumeHealth(inst.options.root).persistentVolume === false) {
    return `Tour Core is running, but records need a lasting disk or they can disappear on the next update. ${SETUP_HELP_ENDING}`;
  }
  return "Tour Core is running.";
}

function storageLine(inst: Installation): string {
  const backup = inst.files.state().portableBackup;
  switch (inst.records.provider()) {
    case "HOSTED_VOLUME":
      if (backup?.destination) return "Records are kept here, and a portable copy has a folder.";
      if (backup?.declinedAt) return "Records are kept here. You skipped a portable copy.";
      return "Records are kept here. A portable copy isn't set up yet.";
    case "GOOGLE_DRIVE_READY":
      return "Records are kept in a folder you own.";
    case "GOOGLE_DRIVE_CONNECTING":
      return "A folder for records is still being connected.";
    case "LOCAL_DEMO":
      return "Records stay on this computer.";
    case "ERROR":
      return `Records couldn't be checked just now. I'll look again. ${SETUP_HELP_ENDING}`;
    default:
      return "A place for records isn't set up yet.";
  }
}

function alertsLine(status: InstallationStatus): string {
  const summary = component(status, "OPERATOR_ALERTS")?.summary ?? "Tour updates aren't turned on yet.";
  return /webhook|routine|grok|http/i.test(summary) ? "Tour updates aren't turned on yet." : summary;
}

export const TEXTING_NOT_CHOSEN = "Texting isn't chosen yet.";
export const TEXTING_KEYS_NEEDED = "Texting needs a login before it can connect.";
export const TEXTING_NEEDS_LINE = "Texting is connected. Choose the number people should text.";
export const TEXTING_TESTING = "A number is saved. Texting still needs a check.";
export const TEXTING_WORKING = "Texting is working.";
export const TEXTING_ERROR = "Texting isn't working yet.";

/** Plain texting line for the landlord. Ignores provider names in the raw summary. */
export function textingSummary(part: { state?: string; next?: { action?: string } } | undefined): string {
  if (!part) return TEXTING_NOT_CHOSEN;
  if (part.state === "READY") return TEXTING_WORKING;
  if (part.state === "ERROR") return TEXTING_ERROR;
  const action = part.next?.action;
  if (action === "CHOOSE_MESSAGING_LINE") return TEXTING_NEEDS_LINE;
  if (action === "CONNECT_VISITOR_MESSAGING" || action === "FIX_VISITOR_MESSAGING") return TEXTING_KEYS_NEEDED;
  if (action === "TEST_VISITOR_MESSAGING" || action === "RECONNECT_VISITOR_MESSAGING") return TEXTING_TESTING;
  return TEXTING_NOT_CHOSEN;
}

function textingLine(status: InstallationStatus): string {
  return textingSummary(component(status, "VISITOR_MESSAGING"));
}

function setupOf(services: OperatorServices, inst: Installation, picture: Picture, status: InstallationStatus) {
  if (!picture.id || !picture.draft) return undefined;
  const draft = picture.draft;
  const view = draftView(draft);
  const saved = services.workspace.has(picture.id) ? services.workspace.load(picture.id) : undefined;
  const texting = visitorTexting(services, picture.id, draft.messagingMode, installedMessaging(inst, { readOnly: true }));
  return {
    propertyId: picture.id,
    name: operatorFacingPropertyName(draft),
    address: view.property.address,
    propertyType: draft.property.propertyType ? PROPERTY_TYPE_LABELS[draft.property.propertyType] : "Not chosen yet",
    timezone: view.property.timezoneLabel,
    status: saved ? statusLabel(saved) : "Setup in progress",
    units: view.units.map((unit) => ({
      name: operatorUnitName(draft.property, unit.name),
      ...(unit.door ? { door: unit.door.name } : {}),
      ...(unit.route ? { route: unit.route.doorNames.join(" → ") } : {}),
    })),
    doors: view.doors.map((door) => ({ name: door.name, kind: door.kindLabel })),
    routes: view.units.filter((unit) => unit.route).map((unit) => ({ unit: operatorUnitName(draft.property, unit.name), doors: unit.route!.doorNames })),
    hours: view.tourHours.summary ?? `${view.tourHours.daysLabel}, ${view.tourHours.hoursLabel}`,
    verification: view.reviewCards.find((card) => card.step === "verification")?.rows ?? [],
    texting: texting.label,
    alerts: alertsLine(status),
  };
}

function propertyList(services: OperatorServices) {
  const ws = services.workspace;
  return ws
    .propertyIds()
    .filter((id) => !ws.has(id) || !ws.load(id).state.removedAt)
    .map((id) => {
      const { draft } = ws.openDraft(id);
      const saved = ws.has(id) ? ws.load(id) : undefined;
      return { propertyId: id, name: operatorFacingPropertyName(draft), address: draft.property.address, status: saved ? statusLabel(saved) : "Setup in progress" };
    });
}

/** One read-only picture. Does not persist texting choices or probe the disk. */
export function readState(input: StateReadInput, propertyId?: string): Record<string, unknown> {
  const inst = input.installation;
  if (!inst) throw new SetupInputError("INSTALLATION_UNAVAILABLE", "Installation tools aren't available on this Tour Core.");
  const status = getInstallationStatus(inst, input.services, { readOnly: true });
  const requested = propertyId?.trim() || undefined;
  const id = requested ?? primaryProperty(input.services.workspace)?.id;
  if (requested) {
    const known = input.services.workspace.propertyIds().includes(requested);
    if (!known) {
      try {
        input.services.workspace.openDraft(requested);
      } catch {
        throw new SetupInputError("PROPERTY_NOT_FOUND", "I couldn't find that property.");
      }
    }
  }
  const picture = pictureOf(input.services, id);
  const milestones = milestonesFor(status, picture);
  const current = milestones.find((milestone) => milestone.status === "next") ?? null;
  const next = presentNext(status);
  const step = focusStep(milestones, next.action, picture);
  const playbook = renderPlaybook(input.client, step);
  const copy = SHARED_STEPS[step];
  const setup = setupOf(input.services, inst, picture, status);
  return {
    summary: current ? `${current.title} is next.` : status.phase === "OPERATE" ? "Your property is published." : "Nothing is waiting on you.",
    scope: requested ? "property" : "install",
    ...(requested ? {} : { properties: propertyList(input.services) }),
    ...(setup ? { setup } : {}),
    units: setup?.units ?? [],
    doors: setup?.doors ?? [],
    routes: setup?.routes ?? [],
    hours: setup?.hours ?? null,
    verification: setup?.verification ?? [],
    texting: { summary: textingLine(status) },
    alerts: { summary: alertsLine(status) },
    health: { summary: healthLine(inst, status) },
    storage: { summary: storageLine(inst) },
    milestones,
    currentMilestone: current?.id ?? null,
    nextStep: { action: next.action, component: next.component, say: spokenAsk(input.client, step), doneLooksLike: copy.done },
    playbook: { id: playbook.id, version: playbook.version, mode: playbook.mode, step: playbook.step, text: playbook.text },
  };
}

export type { MilestoneId };
