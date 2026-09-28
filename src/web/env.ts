import { existsSync } from "node:fs";

/**
 * Loads a local `.env` file (git-ignored) into the environment for developer
 * convenience. Variables already set in the environment win. Values are
 * never printed.
 */
export function loadLocalEnv(path = ".env"): void {
  if (!existsSync(path)) return;
  try {
    process.loadEnvFile(path);
  } catch {
    console.warn("  Couldn't read .env; continuing with the current environment.");
  }
}
