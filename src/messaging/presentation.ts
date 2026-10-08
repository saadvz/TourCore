import type { MessageChannel } from "./Messenger";

/**
 * What kind of reply a message asks for. Tour Core states the intent once;
 * the channel decides the wording: buttons on the web, typed replies in a
 * messages app. Business logic never branches on the provider.
 */
export type ReplyPrompt =
  | { kind: "yes-no" }
  | { kind: "choose"; options: string[]; what: string; after?: string }
  | { kind: "say"; phrase: string; purpose: string }
  | { kind: "form"; link?: string };

export function withPrompt(body: string, prompt: ReplyPrompt | undefined, channel: MessageChannel, team = "property team"): string {
  if (!prompt) return body;
  if (channel === "WEB") {
    switch (prompt.kind) {
      case "choose":
        return prompt.after ? `${body}\n${prompt.after}\nPick ${prompt.what} below.` : `${body}\nPick ${prompt.what} below.`;
      case "form":
        return `${body}\nThe form is just below.`;
      default:
        return body;
    }
  }
  switch (prompt.kind) {
    case "yes-no":
      return `${body}\nReply YES or NO.`;
    case "choose":
      return `${body}\n${numbered(prompt.options, prompt.after)}`;
    case "say":
      return `${body}\nText "${prompt.phrase}" ${prompt.purpose}.`;
    case "form":
      return prompt.link ? `${body}\n${prompt.link}` : `${body}\nThe ${team} will send you the form link shortly.`;
  }
}

/** "Reply 1 for Unit 101 or 2 for Unit 102." / a numbered list for longer menus. */
function numbered(options: string[], after?: string): string {
  // Empty `after` means the body already has the one instruction (e.g. "Reply yes to take it, or pick a day:").
  if (after === "") return options.map((o, i) => `${i + 1}) ${o}`).join("\n");
  if (options.length <= 3) {
    const parts = options.map((o, i) => `${i + 1} for ${o}`);
    const reply = `Reply ${parts.length > 1 ? `${parts.slice(0, -1).join(", ")} or ${parts.at(-1)}` : parts[0]}.`;
    return after ? `${reply}\n${after}` : reply;
  }
  return `${options.map((o, i) => `${i + 1}) ${o}`).join("\n")}\n${after ?? "Reply with the number."}`;
}
