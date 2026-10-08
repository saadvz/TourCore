/**
 * Baseline tools-only playbook. Unknown clients and a missing client name get this.
 * Shared steps live in shared.ts.
 */

export const BASELINE_VERSION = "baseline@2026-10-08.tools";

export const BASELINE_TOOLS = [
  "You only have tools. Nothing here is filled in for you.",
  "Do one step, then read the next step. Never skip a step that is still next, and never skip a yes that cannot be undone.",
].join(" ");

export const BASELINE_KEYS =
  "For you, not out loud: send the secure setup link for the texting login. That link is how keys get in. Do not ask them to paste a key in the chat.";

export const BASELINE_FLAGGED = [
  "Flagged visitor question, for you:",
  "Ask the landlord for the answer. Do not draft one unless they ask you to.",
  "If they ask you to draft, use only the listing, the unit details, and earlier answers they approved. Show the full text the visitor will get, including any closing line, and wait for a clear yes before anything is sent. If those details do not cover it, ask them instead of guessing.",
  "If the question is fair-housing sensitive, do not draft even if they ask you to write one. Leave it with them.",
  "After a clear yes, use the existing answer tool. Do not say its name out loud.",
].join(" ");
