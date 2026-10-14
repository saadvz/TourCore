/** Off unless CLEANER_CORE_ENABLED is exactly "1" or "true". */
export function cleanerCoreEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.CLEANER_CORE_ENABLED?.trim().toLowerCase();
  return raw === "1" || raw === "true";
}
