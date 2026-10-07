import { BASELINE_FLAGGED, BASELINE_KEYS, BASELINE_TOOLS } from "./baseline";
import { CHATGPT_FLAGGED, CHATGPT_KEYS, CHATGPT_TOOLS } from "./chatgpt";
import { CLAUDE_FLAGGED, CLAUDE_FULL, CLAUDE_KEYS, CLAUDE_TOOLS } from "./claude";
import { GROK_ALERTS, GROK_ALERTS_SAY, GROK_BACKUPS_FULL, GROK_BACKUPS_TOOLS, GROK_FLAGGED, GROK_FULL, GROK_KEYS_FULL, GROK_KEYS_TOOLS, GROK_TOOLS, GROK_WAKE } from "./grok";
import { selectPlaybook, type PlaybookSelection, type ReportedClient } from "./select";
import { SHARED_AFTER_PUBLISH, SHARED_FLAGGED_RULES, SHARED_IRREVERSIBLE, SHARED_STEPS, SHARED_VOICE, STEP_TITLES, type StepId } from "./shared";

export interface PlaybookText {
  id: PlaybookSelection["id"];
  version: string;
  mode: PlaybookSelection["mode"];
  step: StepId;
  text: string;
}

function profileIntro(selection: PlaybookSelection): string {
  if (selection.id === "grok") return selection.mode === "full" ? GROK_FULL : GROK_TOOLS;
  if (selection.id === "claude") return selection.mode === "full" ? CLAUDE_FULL : CLAUDE_TOOLS;
  if (selection.id === "chatgpt") return CHATGPT_TOOLS;
  return BASELINE_TOOLS;
}

function profileStep(selection: PlaybookSelection, step: StepId): string | undefined {
  if (step === "texting-keys") {
    if (selection.id === "grok") return selection.mode === "full" ? GROK_KEYS_FULL : GROK_KEYS_TOOLS;
    if (selection.id === "claude") return CLAUDE_KEYS;
    if (selection.id === "chatgpt") return CHATGPT_KEYS;
    return BASELINE_KEYS;
  }
  if (step === "backups" && selection.id === "grok") return selection.mode === "full" ? GROK_BACKUPS_FULL : GROK_BACKUPS_TOOLS;
  if (step === "alerts" && selection.id === "grok") return GROK_ALERTS;
  return undefined;
}

function profileWake(selection: PlaybookSelection): string | undefined {
  return selection.id === "grok" ? GROK_WAKE : undefined;
}

function profileFlagged(selection: PlaybookSelection): string {
  if (selection.id === "grok") return GROK_FLAGGED;
  if (selection.id === "claude") return CLAUDE_FLAGGED;
  if (selection.id === "chatgpt") return CHATGPT_FLAGGED;
  return BASELINE_FLAGGED;
}

export function renderPlaybook(client: ReportedClient | undefined, step: StepId): PlaybookText {
  const selection = selectPlaybook(client);
  const copy = SHARED_STEPS[step];
  const extra = profileStep(selection, step);
  const ask = selection.id === "grok" && step === "alerts" ? GROK_ALERTS_SAY : copy.ask;
  const text = [
    SHARED_VOICE,
    SHARED_IRREVERSIBLE,
    profileIntro(selection),
    `${STEP_TITLES[step]}. Ask one thing.`,
    step === "another" ? SHARED_AFTER_PUBLISH : undefined,
    `Ask only this: ${ask}`,
    `Done looks like: ${copy.done}`,
    `If it fails: ${copy.ifItFails}`,
    extra,
    SHARED_FLAGGED_RULES,
    profileFlagged(selection),
    profileWake(selection),
  ]
    .filter((part): part is string => !!part)
    .join("\n\n");
  return { id: selection.id, version: selection.version, mode: selection.mode, step, text };
}
