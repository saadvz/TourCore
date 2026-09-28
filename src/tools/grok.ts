import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mcpAuthModeFromEnv } from "../mcp/authMode";
import { MCP_PATH } from "../mcp/mcpBridge";
import { OAuthGrantStore } from "../mcp/oauth";
import { grokLegacyCompatFromEnv } from "../mcp/oauth/clients";
import { mask, readSendblueEnv } from "../messaging/sendblue/runtime";
import { OPERATOR_TOOLS } from "../operator/tools";
import { defaultWorkspaceRoot } from "../setup/workspace";
import { FileRuntimeStore } from "../storage/runtimeStore";
import { loadLocalEnv } from "../web/env";

/**
 * Developer tooling for connecting Grok Bot (or any MCP agent host) to this
 * Tour Core. Never part of `npm test`.
 *   npm run grok:connect                what to enter in Grok (OAuth: just the URL)
 *   npm run grok:connect -- --static    development only: create a static bearer token
 *   npm run grok:connect -- --static --rotate
 *   npm run grok:status                 mode, URL, current OAuth connections (no token values)
 *   npm run grok:disconnect             revoke every OAuth approval; Grok must connect again
 *   npm run grok:tools                  the tools Grok Bot will see
 */

const say = (line = "") => console.log(line ? `  ${line}` : "");
const TOKEN_KEY = "TOURCORE_OPERATOR_TOKEN";
const flag = (rest: string[], name: string) => rest.includes(`--${name}`) || process.env[`npm_config_${name}`] === "true";

function setEnvValue(key: string, value: string): void {
  const text = existsSync(".env") ? readFileSync(".env", "utf8") : "";
  const line = `${key}=${value}`;
  const pattern = new RegExp(`^${key}=.*$`, "m");
  const next = pattern.test(text) ? text.replace(pattern, line) : `${text}${text && !text.endsWith("\n") ? "\n" : ""}${line}\n`;
  writeFileSync(".env", next);
}

function connectorUrl(): string | undefined {
  const base = readSendblueEnv().publicBaseUrl;
  return base ? `${new URL(base).origin}${MCP_PATH}` : undefined;
}

const grants = () => new OAuthGrantStore(new FileRuntimeStore(join(defaultWorkspaceRoot(), "runtime")));

function connectOAuth(): void {
  const mode = mcpAuthModeFromEnv();
  const url = connectorUrl();
  if (mode !== "oauth") {
    say(`TOURCORE_MCP_AUTH_MODE is "${typeof mode === "string" ? mode : mode.invalid}". Remove it (or set it to oauth) and restart \`npm run setup\` to use OAuth.`);
    say("");
  }
  say("Add Tour Core to Grok as a custom connector:");
  say(`  URL ............ ${url ?? "(set PUBLIC_BASE_URL to your https tunnel address first)"}`);
  say("  Authentication . OAuth (leave any token or header fields empty)");
  say("");
  say("Grok opens a Tour Core approval page. Approve it on this computer: a Connect Grok");
  say("window opens here with the same code. Nothing needs to be pasted into Grok.");
}

function connectStatic(rotate: boolean): void {
  let token = process.env[TOKEN_KEY]?.trim();
  if (!token || rotate) {
    token = randomBytes(32).toString("base64url");
    setEnvValue(TOKEN_KEY, token);
    say(rotate ? "Replaced the static connector token in .env." : "Created a static connector token and saved it to .env.");
  } else {
    say("A static connector token is already set in .env (add --rotate to replace it).");
  }
  setEnvValue("TOURCORE_MCP_AUTH_MODE", "static");
  say("Set TOURCORE_MCP_AUTH_MODE=static in .env. Restart `npm run setup` to use it.");
  say("");
  say("Development and troubleshooting only. Send it from a script or MCP tool as:");
  say("  Authorization: Bearer <the TOURCORE_OPERATOR_TOKEN value in .env>");
  say("Never paste it into a chat. For the real Grok connector, remove TOURCORE_MCP_AUTH_MODE and use OAuth.");
}

function status(): void {
  const mode = mcpAuthModeFromEnv();
  say("Grok Bot connector on this computer:");
  say(`  Mode ........... ${typeof mode === "string" ? mode : `off (TOURCORE_MCP_AUTH_MODE="${mode.invalid}" isn't oauth or static)`}`);
  say(`  URL ............ ${connectorUrl() ?? "not available (PUBLIC_BASE_URL isn't an https address)"}`);
  if (mode === "static") say(`  Static token ... ${mask(process.env[TOKEN_KEY]?.trim())}`);
  if (mode === "oauth") {
    say(`  Grok legacy .... ${grokLegacyCompatFromEnv() ? "ON (P0 only): Cursor's legacy callbacks accepted; turn off when Grok no longer needs it" : "off (strict)"}`);
    const connections = grants().connections();
    say(`  Connected ...... ${connections.length ? connections.map((c) => `${c.clientName} since ${new Date(c.connectedAt).toLocaleString()}`).join("; ") : "nothing"}`);
  }
  say(`  Tools .......... ${OPERATOR_TOOLS.length}`);
}

function disconnect(): void {
  const removed = grants().revokeAll();
  say(`Disconnected Grok: removed ${removed.grants} approval${removed.grants === 1 ? "" : "s"} and ${removed.clients} registered client${removed.clients === 1 ? "" : "s"}.`);
  say("Their tokens stop working right away, even in a running Tour Core.");
  say("Properties, tour history, Sendblue, visitor sessions and Durin settings are unchanged.");
}

function tools(): void {
  for (const t of OPERATOR_TOOLS) say(`${t.name.padEnd(26)} ${t.kind.padEnd(14)} ${t.title}`);
}

loadLocalEnv();
const [command, ...rest] = process.argv.slice(2);
if (command === "connect") flag(rest, "static") ? connectStatic(flag(rest, "rotate")) : connectOAuth();
else if (command === "status") status();
else if (command === "disconnect") disconnect();
else if (command === "tools") tools();
else {
  say("Usage: npm run grok:connect | grok:status | grok:disconnect | grok:tools");
  process.exit(1);
}
