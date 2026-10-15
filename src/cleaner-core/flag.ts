/** Off unless CLEANER_CORE_ENABLED is exactly "1" or "true". */
export function cleanerCoreEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.CLEANER_CORE_ENABLED?.trim().toLowerCase();
  return raw === "1" || raw === "true";
}

/** On unless CLEANER_CORE_GROUP_CHAT is exactly "0" or "false". */
export function groupChatEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.CLEANER_CORE_GROUP_CHAT?.trim().toLowerCase();
  return raw !== "0" && raw !== "false";
}
