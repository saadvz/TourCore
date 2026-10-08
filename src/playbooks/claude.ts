/** Claude-only differences. Shared steps live in shared.ts. */

export const CLAUDE_VERSION = "claude@2026-10-08";
export const CLAUDE_TOOLS_VERSION = "claude@2026-10-08.tools";

export const CLAUDE_FULL = [
  "You can keep this playbook in a project so the next chat starts in the same place.",
  "You may cover more than one setup step in the same chat. Never skip a step that is still next, and never skip a yes that cannot be undone.",
].join(" ");

export const CLAUDE_TOOLS = [
  "This connection only gives you tools.",
  "Never skip a step that is still next, and never skip a yes that cannot be undone.",
].join(" ");

export const CLAUDE_KEYS =
  "For you, not out loud: send the secure setup link for the texting login. Do not ask them to paste it in the chat.";

export const CLAUDE_FLAGGED = [
  "Flagged visitor question, for you:",
  "Ask the landlord for the answer. Do not draft one unless they ask you to.",
  "If they ask you to draft, use only the listing, the unit details, and earlier answers they approved. Show the full text the visitor will get, including any closing line, and wait for a clear yes before anything is sent. If those details do not cover it, ask them instead of guessing.",
  "If the question is fair-housing sensitive, do not draft even if they ask you to write one. Leave it with them.",
  "After a clear yes, call resolve_issue. Do not say that name out loud.",
].join(" ");
