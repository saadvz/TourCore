import { formatAudit } from "../audit/audit";
import { formatClockTime, formatDay, friendlyTimeZone } from "../core/timezone";
import {
  addDoor,
  addUnit,
  CHOICE_LABELS,
  createPropertySetup,
  describeDays,
  describeHistory,
  describeInterval,
  describeMinutes,
  inferTimeZone,
  parseChoiceList,
  parseDays,
  parseMinutes,
  parseTimeOfDay,
  PropertyWorkspace,
  removeUnit,
  renameDoor,
  renameUnit,
  resolveTimeZone,
  reviewSetup,
  runDryTour,
  runReadinessCheck,
  setAlertContact,
  setPropertyDetails,
  setRoute,
  setServices,
  OperatorTeamCopy,
  SETUP_DEFAULTS,
  SetupInputError,
  setTourHours,
  setVerificationPolicy,
  statusLabel,
  validateConfig,
  type DryTourEvent,
  type SetupDraft,
} from "../setup";
import { unitDetailsView } from "../setup/presenters";
import { addTourableSpace, setUnitProfile, SINGLE_FAMILY_SPACE_NAME } from "../setup/setupActions";
import { PROPERTY_TYPE_LABELS, PROPERTY_TYPES, type PropertyType } from "../config/tourCoreConfig";
import { isCurrent } from "../setup/workspace";
import { InputClosedError, Prompter, style } from "./prompter";

/**
 * Terminal presentation for the setup engine. All decisions and validation
 * live in src/setup; this file only asks questions and prints answers.
 */

// PowerShell drops the "--" in `npm run setup:cli -- --dev`, so npm keeps the flag and exposes it as npm_config_dev.
const DEV = process.argv.includes("--dev") || process.env.npm_config_dev === "true";
const io = new Prompter();
const workspace = new PropertyWorkspace();
const { bold, dim, green, red, cyan, yellow } = style;
const OK = green("\u2713");
const BAD = red("\u2717");
const devCode = (code: string) => (DEV ? dim(` [${code}]`) : "");

async function retry(step: () => Promise<SetupDraft>): Promise<SetupDraft> {
  for (;;) {
    try {
      return await step();
    } catch (err) {
      if (!(err instanceof SetupInputError)) throw err;
      io.say(yellow(err.message));
    }
  }
}

function numberBetween(min: number, max: number) {
  return (answer: string) => {
    const n = Number(answer);
    return Number.isInteger(n) && n >= min && n <= max ? n : undefined;
  };
}

// ---------------------------------------------------------------- main menu

async function main(): Promise<void> {
  io.say(bold("\nTour Core"));
  io.say(dim("Set up self-guided tours for your property. Nothing here opens real doors or sends real texts yet."));
  if (DEV) io.say(dim(`(dev mode) records folder: ${workspace.root}`));

  for (;;) {
    const saved = workspace.list();
    io.say("");
    if (saved.length) io.say(dim(`Your properties: ${saved.map((s) => `${s.config.property.name} (${statusLabel(s)})`).join(", ")}`));
    const action = await io.choose("What would you like to do?", [
      { label: "Set up a new property", value: "new" as const },
      { label: "Edit an existing property", value: "edit" as const },
      { label: "Run a readiness check", value: "ready" as const },
      { label: "Run a practice tour", value: "practice" as const },
      { label: "Publish for demo", value: "publish" as const },
      { label: "View audit/export", value: "audit" as const },
      { label: "Quit", value: "quit" as const },
    ]);
    if (action === "quit") return;
    if (action === "new") {
      await newProperty();
      continue;
    }
    const id = await pickProperty();
    if (!id) continue;
    if (action === "edit") await reviewAndSave(workspace.load(id).config, true);
    if (action === "ready") await readinessFlow(id);
    if (action === "practice") await practiceFlow(id);
    if (action === "publish") await publishFlow(id);
    if (action === "audit") auditFlow(id);
  }
}

async function pickProperty(): Promise<string | undefined> {
  const saved = workspace.list();
  if (saved.length === 0) {
    io.say(yellow('You haven\'t set up a property yet. Choose "Set up a new property" first.'));
    return undefined;
  }
  if (saved.length === 1) return saved[0]!.config.property.id;
  return io.choose(
    "Which property?",
    saved.map((s) => ({ label: s.config.property.name, hint: statusLabel(s), value: s.config.property.id })),
  );
}

// -------------------------------------------------------------- new setup

async function newProperty(): Promise<void> {
  io.say(bold("\nLet's set up your property."));
  io.say(dim("I'll ask one thing at a time. Press Enter to accept a suggestion shown in [brackets]."));
  io.say("");
  const address = await io.askRequired("What's the property address?", undefined, "Please type the street address, like 100 Alfred Way, Brooklyn, NY.");
  const propertyType = await askPropertyType();
  const name = await io.ask("Does it have a property or building name? Leave blank to use the address.");
  const timezone = await askTimeZone(address);
  let draft = createPropertySetup({ address, name, propertyType, timezone, existingPropertyIds: workspace.list().map((s) => s.config.property.id) });
  draft = await editUnits(draft);
  draft = await editRoutes(draft, "all");
  draft = await editHours(draft, false);
  draft = await editVerification(draft);
  draft = await editServices(draft);
  draft = await editAlerts(draft);
  await reviewAndSave(draft, false);
}

function askPropertyType(current?: PropertyType): Promise<PropertyType> {
  io.say("");
  const choices = PROPERTY_TYPES.map((t) => ({ label: PROPERTY_TYPE_LABELS[t], value: t }));
  return io.choose("What type of property is this?", choices, current ? PROPERTY_TYPES.indexOf(current) + 1 : 3);
}

async function askTimeZone(address: string, current?: string): Promise<string> {
  const guess = current ?? inferTimeZone(address);
  const tz = typeof guess === "string" ? guess : guess.timezone;
  const basis = typeof guess === "string" ? "" : guess.basis === "address" ? " based on the address" : " based on this computer's clock";
  io.say("");
  io.say(`It looks like the property is on ${friendlyTimeZone(tz)} (${tz})${basis}.`);
  return io.askParsed(
    "What time zone is the property in?",
    tz,
    resolveTimeZone,
    'I don\'t recognize that time zone. Try "Eastern", "Central", "Mountain", "Pacific", or something like America/New_York.',
  );
}

async function editUnits(start: SetupDraft): Promise<SetupDraft> {
  let draft = start;
  const existingIds = draft.units.map((u) => u.id);
  io.say("");
  const singleFamily = draft.property.propertyType === "SINGLE_FAMILY";
  const count = singleFamily ? 1 : await io.askParsed("How many units can people self-tour?", String(existingIds.length || 1), numberBetween(1, 50), "Please enter a number from 1 to 50.");

  if (singleFamily) {
    const current = draft.units[0];
    draft = await retry(async () => {
      const name = await io.askRequired("People will tour the whole home. What should we call it?", current?.name ?? SINGLE_FAMILY_SPACE_NAME);
      return current ? renameUnit(draft, current.id, name) : addTourableSpace(draft, { name });
    });
  }
  for (let i = 0; i < count && !singleFamily; i++) {
    const current = existingIds[i] ? draft.units.find((u) => u.id === existingIds[i]) : undefined;
    draft = await retry(async () => {
      const name = await io.askRequired(`What's unit ${i + 1} called?`, current?.name ?? `Unit ${i + 1}`);
      return current ? renameUnit(draft, current.id, name) : addUnit(draft, { name }).draft;
    });
  }
  for (const id of existingIds.slice(count)) draft = removeUnit(draft, id);

  io.say(dim("\nA few basics visitors always ask about. Type \"not provided\" for anything you don't know or don't want listed."));
  for (const unit of draft.units) {
    for (const [field, question, hint] of [
      ["bedrooms", "How many bedrooms", '(0 or "studio" for a studio)'],
      ["bathrooms", "How many bathrooms", ""],
      ["monthlyRent", "What's the monthly rent for", "(e.g. $2,200)"],
      ["availability", "When is it available,", '(e.g. "now" or "October 15")'],
    ] as const) {
      const current = unitDetailsView(draft.units.find((u) => u.id === unit.id)!).inputs[field];
      draft = await retry(async () => {
        const answer = await io.askRequired(`${question} ${unit.name}? ${hint}`.replace(/\s+$/, ""), current || undefined);
        return setUnitProfile(draft, unit.id, { [field]: answer });
      });
    }
  }

  io.say("");
  const entrance = draft.doors.find((d) => d.kind === "ENTRANCE");
  draft = await retry(async () => {
    const name = await io.askRequired("What's the main entrance called?", entrance?.name ?? SETUP_DEFAULTS.entranceName);
    return entrance ? renameDoor(draft, entrance.id, name) : addDoor(draft, { name, kind: "ENTRANCE" }).draft;
  });

  for (const unit of draft.units) {
    const door = draft.doors.find((d) => d.id === unit.doorId);
    draft = await retry(async () => {
      const name = await io.askRequired(`What's the door to ${unit.name} called?`, door?.name ?? `${unit.name} Door`);
      return door ? renameDoor(draft, door.id, name) : addDoor(draft, { name, kind: "UNIT", unitId: unit.id }).draft;
    });
  }
  return draft;
}

async function editRoutes(start: SetupDraft, which: "all" | "missing"): Promise<SetupDraft> {
  let draft = start;
  for (const unit of draft.units) {
    const existing = draft.routes.find((r) => r.unitId === unit.id);
    if (which === "missing" && existing?.stops.length && !validateConfig(draft).some((i) => i.section === "routes" && i.unitId === unit.id)) continue;

    for (;;) {
      const doors = draft.doors;
      const entranceIdx = doors.findIndex((d) => d.kind === "ENTRANCE");
      const unitDoorIdx = doors.findIndex((d) => d.id === unit.doorId);
      const suggestion = existing?.stops.length
        ? existing.stops.map((s) => doors.findIndex((d) => d.id === s.doorId) + 1).filter((n) => n > 0)
        : [entranceIdx + 1, unitDoorIdx + 1].filter((n) => n > 0);

      io.say("");
      io.say(`Which doors should someone use to tour ${bold(unit.name)}?`);
      doors.forEach((d, i) => io.say(`  ${i + 1}. ${d.name}`));
      const picks = await io.askParsed(
        "List them in the order the visitor walks through, like 1, 2",
        suggestion.join(", "),
        (a) => parseChoiceList(a, doors.length),
        `Please list door numbers from 1 to ${doors.length}, separated by commas, without repeats.`,
      );
      const directions = await io.ask(
        `Any directions from the entrance to ${unit.name}? (optional, e.g. "straight ahead, first door on the left")`,
        existing?.directions,
      );
      const next = setRoute(draft, unit.id, picks.map((i) => doors[i]!.id), { directions });
      const problems = validateConfig(next).filter((i) => i.section === "routes" && i.unitId === unit.id);
      if (problems.length === 0) {
        draft = next;
        break;
      }
      problems.forEach((p) => io.say(`  ${BAD} ${p.message}${devCode(p.code)}`));
      if (!(await io.confirm("Want to pick the doors again?", true))) {
        draft = next;
        break;
      }
    }
  }
  return draft;
}

async function editHours(start: SetupDraft, editing: boolean): Promise<SetupDraft> {
  let draft = start;
  for (;;) {
    const th = draft.tourHours;
    const current = `${describeDays(th.days)}, ${formatClockTime(th.start)} to ${formatClockTime(th.end)}`;
    io.say("");
    const preset = await io.choose("When can people tour?", [
      ...(editing ? [{ label: `Keep ${current}`, value: "keep" as const }] : []),
      { label: "Weekdays, 9 AM to 5 PM", hint: "recommended", value: "weekdays" as const },
      { label: "Every day, 10 AM to 6 PM", value: "everyday" as const },
      { label: "Something else", value: "custom" as const },
    ]);
    if (preset === "weekdays") draft = setTourHours(draft, { days: ["MON", "TUE", "WED", "THU", "FRI"], start: "09:00", end: "17:00" });
    if (preset === "everyday") draft = setTourHours(draft, { days: ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"], start: "10:00", end: "18:00" });
    if (preset === "custom") {
      const days = await io.askParsed("Which days?", "Mon-Fri", parseDays, "I didn't catch that. Try something like Mon-Fri, weekends, or Mon, Wed, Sat.");
      const startAt = await io.askParsed("What time can the first tour start?", "9am", parseTimeOfDay, "Try a time like 9am or 10:30 AM.");
      const endAt = await io.askParsed("What time should the last tour be over?", "5pm", parseTimeOfDay, "Try a time like 5pm or 6:30 PM.");
      draft = setTourHours(draft, { days, start: startAt, end: endAt });
    }

    const t = draft.tourHours;
    io.say("");
    const keep = await io.confirm(
      `Each tour lasts ${describeMinutes(t.tourLengthMinutes)}, a new tour can start every ${describeInterval(t.slotEveryMinutes)}, and visitors can get in up to ${describeMinutes(t.earlyArrivalMinutes)} early. Keep these?`,
      true,
    );
    if (!keep) {
      const minutes = (q: string, def: number) => io.askParsed(q, String(def), parseMinutes, "Try something like 45, 30 minutes, or 1 hour.");
      draft = setTourHours(draft, {
        tourLengthMinutes: await minutes("How long is each tour, in minutes?", t.tourLengthMinutes),
        slotEveryMinutes: await minutes("How often can a new tour start, in minutes?", t.slotEveryMinutes),
        earlyArrivalMinutes: await minutes("How many minutes early can visitors get in?", t.earlyArrivalMinutes),
      });
    }

    const problems = validateConfig(draft).filter((i) => i.section === "hours");
    if (problems.length === 0) return draft;
    problems.forEach((p) => io.say(`  ${BAD} ${p.message}${devCode(p.code)}`));
    io.say(yellow("Let's try the tour hours again."));
    editing = true;
  }
}

async function editVerification(draft: SetupDraft): Promise<SetupDraft> {
  io.say("");
  const mode = await io.choose(
    "How carefully do you want to verify visitors?",
    [
      {
        label: "Basic identity form",
        hint: "recommended. Visitors share their legal name, email and phone. It keeps a record of who they say they are, but doesn't prove it",
        value: "basic-form" as const,
      },
      { label: "Practice verification", hint: "everyone passes automatically. Only for trying things out", value: "mock" as const },
    ],
    draft.verificationMode === "mock" ? 2 : 1,
  );
  let next = setVerificationPolicy(draft, { mode });
  io.say("");
  const keep = await io.confirm(
    `Once someone has been checked, they can book another tour without re-checking for ${next.verificationValidForDays} days. Keep that?`,
    true,
  );
  if (!keep) {
    const days = await io.askParsed("How many days should a check stay good for?", String(next.verificationValidForDays), numberBetween(1, 365), "Please enter a number of days from 1 to 365.");
    next = setVerificationPolicy(next, { reuseForDays: days });
  }
  return next;
}

async function editServices(draft: SetupDraft): Promise<SetupDraft> {
  io.say("");
  const storageMode = await io.choose("Where should tour records be kept?", [
    { label: CHOICE_LABELS.storage.memory, hint: "more choices, like Google Drive, are coming soon", value: "memory" as const },
  ]);
  io.say("");
  const messagingMode = await io.choose("How should messages be sent?", [
    { label: "Demo messaging", hint: "texts show up on this screen instead of on phones", value: "demo" as const },
    { label: "Live texting", hint: "real texts through the messaging provider connected for this installation", value: "live" as const },
  ]);
  io.say("");
  const accessMode = await io.choose("How should doors be opened?", [
    { label: "Durin demo mode", hint: "no real doors open. Tour Core only asks Durin for access after its safety checks pass", value: "durin-mock" as const },
  ]);
  return setServices(draft, { storageMode, messagingMode, accessMode });
}

async function editAlerts(draft: SetupDraft): Promise<SetupDraft> {
  io.say("");
  return retry(async () => {
    const name = await io.askRequired(OperatorTeamCopy.cliPrompt(), draft.operator.name);
    const visitorContact = await io.ask(
      "What number can stuck visitors call? Pick one someone answers during tour hours.",
      draft.operator.visitorContact,
    );
    const supportEmail = await io.ask(
      "What email should we give visitors who text HELP? Leave blank if they should reply here.",
      draft.operator.supportEmail,
    );
    return setAlertContact(draft, { name, visitorContact, supportEmail });
  });
}

async function editPropertyDetails(draft: SetupDraft): Promise<SetupDraft> {
  io.say("");
  return retry(async () => {
    const address = await io.askRequired("What's the property address?", draft.property.address);
    const propertyType = await askPropertyType(draft.property.propertyType);
    const name = await io.ask("Property or building name (leave blank to use the address)", draft.property.displayName);
    const timezone = await askTimeZone(address, draft.property.timezone);
    return setPropertyDetails(draft, { name, address, propertyType, timezone });
  });
}

// ------------------------------------------------------------ review, save

async function reviewAndSave(start: SetupDraft, editing: boolean): Promise<void> {
  let draft = start;
  for (;;) {
    const review = reviewSetup(draft);
    io.say(bold("\nHere's what I have:"));
    for (const section of review.sections) {
      io.say(`\n${cyan(section.title)}`);
      section.lines.forEach((l) => io.say(`  ${l}`));
    }
    if (review.issues.length) {
      io.say(yellow("\nA few things need attention:"));
      review.issues.forEach((i) => io.say(`  ${BAD} ${i.message}${devCode(i.code)}`));
    }
    io.say("");
    const choice = await io.choose("Does this look right?", [
      { label: review.canSave ? "Yes, save it" : "Yes, save it (after fixing the items above)", value: "save" as const },
      { label: "Change property name, address or time zone", value: "property" as const },
      { label: "Change units and doors", value: "units" as const },
      { label: "Change routes", value: "routes" as const },
      { label: "Change tour hours", value: "hours" as const },
      { label: "Change how visitors are verified", value: "verification" as const },
      { label: "Change records, messages or doors", value: "services" as const },
      { label: "Change who gets alerts", value: "alerts" as const },
      { label: editing ? "Go back without saving changes" : "Leave without saving", value: "leave" as const },
    ]);

    if (choice === "save") {
      if (!review.canSave) {
        io.say(yellow("Let's fix those first. Pick the part you'd like to change."));
        continue;
      }
      const saved = workspace.save(draft);
      io.say(green(`\nSaved ${saved.config.property.name}.`));
      io.say(dim("Your setup is stored for you. There's nothing you need to edit by hand."));
      await afterSave(saved.config.property.id);
      return;
    }
    if (choice === "leave") {
      if (await io.confirm(editing ? "Discard your changes?" : "Leave without saving? Your answers will be lost.", false)) return;
      continue;
    }
    if (choice === "property") draft = await editPropertyDetails(draft);
    if (choice === "units") draft = await editRoutes(await editUnits(draft), "missing");
    if (choice === "routes") draft = await editRoutes(draft, "all");
    if (choice === "hours") draft = await editHours(draft, true);
    if (choice === "verification") draft = await editVerification(draft);
    if (choice === "services") draft = await editServices(draft);
    if (choice === "alerts") draft = await editAlerts(draft);
  }
}

async function afterSave(id: string): Promise<void> {
  if (!(await readinessFlow(id))) {
    io.say(dim('Fix those with "Edit an existing property", then run the readiness check again.'));
    return;
  }
  io.say("");
  if (!(await io.confirm("Want to run a practice tour?", true))) return;
  if (!(await practiceFlow(id))) return;
  io.say("");
  if (await io.confirm("Publish this property for demo?", true)) await publishFlow(id);
}

// ----------------------------------------------- readiness, practice, publish

async function readinessFlow(id: string): Promise<boolean> {
  const { config } = workspace.load(id);
  io.say(bold(`\nChecking ${config.property.name}...`));
  const result = await runReadinessCheck(config);
  workspace.recordReadiness(id, result);
  for (const check of result.checks) {
    io.say(`  ${check.ok ? OK : BAD} ${check.label}`);
    check.problems.forEach((p, i) => io.say(`      ${p}${devCode(check.codes[i] ?? "")}`));
    await io.pause(120);
  }
  for (const note of result.advisories ?? []) io.say(`  ${note}`);
  io.say(result.passed ? green("\nEverything's ready.") : yellow("\nA few things need fixing first."));
  return result.passed;
}

async function practiceFlow(id: string): Promise<boolean> {
  let { config, state } = workspace.load(id);
  if (!state.readiness?.passed || !isCurrent(state.readiness, state)) {
    io.say(dim("\nLet's run the readiness check first."));
    if (!(await readinessFlow(id))) return false;
    ({ config, state } = workspace.load(id));
  }
  const unitId =
    config.units.length > 1
      ? await io.choose("\nWhich unit should the practice tour visit?", config.units.map((u) => ({ label: u.name, value: u.id })))
      : config.units[0]?.id;

  io.say(bold(`\nPractice tour: ${config.property.name}`));
  io.say(dim("A pretend visitor named Pat takes a tour. No real texts are sent and no real doors open."));
  const result = await runDryTour(config, { unitId, onEvent: (e) => renderPracticeEvent(e, config.operator.name) });
  const saved = workspace.recordDryTour(id, result);

  if (result.passed) {
    io.say(green(bold("\nPractice tour passed.")) + " Every step worked and every safety check held.");
    io.say(dim('Tour records saved. Choose "View audit/export" to see them.'));
    if (DEV && saved.dryTour?.recordsFolder) io.say(dim(`(dev) ${saved.dryTour.recordsFolder}`));
  } else {
    io.say(red(`\nThe practice tour stopped: ${result.failure}`));
  }
  return result.passed;
}

async function renderPracticeEvent(e: DryTourEvent, operatorName: string): Promise<void> {
  const indent = (body: string, pad: string) => body.split("\n").join(`\n${pad}`);
  switch (e.kind) {
    case "stage":
      await io.pause(350);
      io.say(`\n${cyan(`-- ${e.title} --`)}`);
      break;
    case "moment":
      io.say(`  ${yellow(e.time.padStart(8))}  ${e.text}`);
      break;
    case "text": {
      const who = e.audience === "OPERATOR" ? `Alert to ${operatorName}:` : "Text to Pat:";
      io.say(`            ${dim(who)} ${indent(e.body, "            ")}`);
      break;
    }
    case "check":
      io.say(`  ${e.ok ? OK : BAD} ${e.label}${e.outcome ? `: ${e.outcome}` : ""}${e.detail && !e.ok ? ` (${e.detail})` : ""}`);
      break;
    case "dev":
      if (DEV) io.say(`            ${dim(e.line)}`);
      break;
  }
}

async function publishFlow(id: string): Promise<void> {
  const { config } = workspace.load(id);
  const result = await workspace.publishDemoProperty(id);
  if (!result.published) {
    io.say(yellow(`\n${config.property.name} isn't ready to publish yet:`));
    result.blockers.forEach((b) => io.say(`  ${BAD} ${b.message}${devCode(b.code)}`));
    return;
  }
  io.say(green(bold(`\nPublished for demo.`)) + ` ${config.property.name} is set up for demo tours.`);
  io.say(
    dim(
      "This is a demo, not a live launch: texts show on screen, records stay on this computer, and doors run in Durin demo mode, so no real doors open.",
    ),
  );
}

function auditFlow(id: string): void {
  const { config } = workspace.load(id);
  const latest = workspace.latestPracticeTour(id);
  if (!latest) {
    io.say(yellow("\nNo practice tours yet. Run one first to see its history here."));
    return;
  }
  const tz = config.property.timezone;
  io.say(bold(`\nHistory of the latest practice tour (${formatDay(new Date(latest.bundle.exportedAt), tz)})`));
  if (DEV) {
    io.say(formatAudit(latest.bundle.auditEvents, tz));
    io.say(dim(`\n(dev) ${latest.folder}`));
    return;
  }
  for (const entry of describeHistory(latest.bundle.auditEvents, { ...latest.bundle, operatorName: config.operator.name }, tz)) {
    const mark = entry.tone === "blocked" ? red("\u2717") : entry.tone === "good" ? OK : " ";
    io.say(`  ${yellow(entry.time.padStart(8))}  ${mark} ${entry.text}`);
  }
  io.say(dim("\nTour records saved. Open the browser setup (npm run setup) to download them."));
}

main()
  .catch((err) => {
    if (err instanceof InputClosedError) return;
    console.error(red("\nSomething went wrong. Your saved setup is safe."));
    if (DEV) console.error(err);
    process.exitCode = 1;
  })
  .finally(() => {
    io.say(dim("\nGoodbye."));
    io.close();
  });
