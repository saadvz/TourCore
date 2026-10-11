import { resolve } from "node:path";

/** Messages contain setting names and requirements only, never supplied values. */
export class DelegationStartupError extends Error {}

export function validateTestCredentials(agentToken: unknown, adminToken: unknown) {
  for (const [name, value] of [["CLEANER_TEST_AGENT_TOKEN", agentToken], ["CLEANER_TEST_ADMIN_TOKEN", adminToken]] as const) {
    if (typeof value !== "string" || value.length === 0) throw new DelegationStartupError(`${name} is missing. Add it to the service variables.`);
    if (value.length < 32) throw new DelegationStartupError(`${name} must contain at least 32 characters.`);
  }
  if (agentToken === adminToken) throw new DelegationStartupError("CLEANER_TEST_AGENT_TOKEN and CLEANER_TEST_ADMIN_TOKEN must have different values.");
  return { agentToken: agentToken as string, adminToken: adminToken as string };
}

export function resolveTestStartupConfig(env: NodeJS.ProcessEnv) {
  const root = resolve(env.CLEANER_TEST_HOME ?? "tourcore-data/cleaner-core-test");
  const port = Number(env.CLEANER_TEST_PORT ?? env.PORT ?? 4332);
  const host = env.CLEANER_TEST_HOST ?? "127.0.0.1";
  const publicBaseUrl = env.CLEANER_TEST_PUBLIC_URL ?? (env.RAILWAY_PUBLIC_DOMAIN ? `https://${env.RAILWAY_PUBLIC_DOMAIN}` : undefined);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new DelegationStartupError("PORT (or CLEANER_TEST_PORT) must be an integer between 1 and 65535.");
  if (host !== "127.0.0.1" && host !== "0.0.0.0") throw new DelegationStartupError("CLEANER_TEST_HOST must be 127.0.0.1 or 0.0.0.0.");
  if (host === "0.0.0.0" && !publicBaseUrl) throw new DelegationStartupError("Set CLEANER_TEST_PUBLIC_URL to the HTTPS origin, or generate a Railway domain supplying RAILWAY_PUBLIC_DOMAIN.");
  if (publicBaseUrl !== undefined) {
    let url: URL;
    try { url = new URL(publicBaseUrl); }
    catch { throw new DelegationStartupError("CLEANER_TEST_PUBLIC_URL (or RAILWAY_PUBLIC_DOMAIN) does not form a valid HTTPS origin."); }
    if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
      throw new DelegationStartupError("CLEANER_TEST_PUBLIC_URL must be an HTTPS origin with no credentials, /mcp path, query, or fragment.");
    }
  }
  const supplied = env.CLEANER_TEST_AGENT_TOKEN !== undefined || env.CLEANER_TEST_ADMIN_TOKEN !== undefined;
  const credentials = supplied || host === "0.0.0.0" ? validateTestCredentials(env.CLEANER_TEST_AGENT_TOKEN, env.CLEANER_TEST_ADMIN_TOKEN) : undefined;
  return { root, port, host, publicBaseUrl, credentials };
}
