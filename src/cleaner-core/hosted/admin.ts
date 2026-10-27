import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { rmSync } from "node:fs";
import { parsePhone } from "../../core/phone";
import { forgetLiveDesk } from "../liveDesk";
import { ADMIN_HEADERS, invitePage, loginPage, messagePage, tenantPage, tenantsPage } from "./adminPages";
import { RegistryError, tenantFolder, type Tenant } from "./registry";
import type { HostedCleaner } from "./router";
import { findIncomingNumber, pointSmsWebhook } from "./twilioNumbers";

/**
 * Saad's admin page on the multi-tenant Cleaner Core: add a host and its number, hand out invite
 * codes, pick the primary chat, disconnect, turn off, delete. Off (404) unless
 * CLEANER_CORE_ADMIN_PASSWORD is set. Sessions live in memory, so a redeploy signs out.
 */

export interface AdminDeps {
  h: HostedCleaner;
  password(): string | undefined;
  revokeGrant(grantId: string): void;
  grantIds(): Set<string>;
  /** False on a plain-http request behind the proxy. */
  https: boolean;
}

const SESSION_MS = 12 * 60 * 60_000;
const LOCK_MS = 15 * 60_000;
const MAX_FAILURES = 5;
const MAX_BODY = 8 * 1024;
const COOKIE = "cc_admin";
const EXPIRED = "That form expired. Reload the page.";
const REGISTRY_WORDS: Record<RegistryError["reason"], string> = {
  "bad-label": "Add a label.",
  "bad-number": "That isn't a phone number.",
  "number-taken": "Another tenant already uses that number.",
  "unknown-tenant": "That tenant doesn't exist.",
};

const sessions = new Map<string, { csrf: string; expiresAt: number }>();
const failures = new Map<string, { count: number; since: number }>();

/** For tests: forget every session and lockout. */
export function resetAdminSessions(): void {
  sessions.clear();
  failures.clear();
}

const digest = (value: string) => createHash("sha256").update(value, "utf8").digest();

function passwordMatches(given: string, expected: string): boolean {
  return timingSafeEqual(digest(given), digest(expected));
}

function sameToken(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && left.length > 0 && timingSafeEqual(left, right);
}

/** The address Railway's proxy saw: the last X-Forwarded-For entry, which a client can't set. */
function clientKey(req: IncomingMessage): string {
  const forwarded = String(req.headers["x-forwarded-for"] ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  return forwarded.at(-1) ?? req.socket.remoteAddress ?? "unknown";
}

function cookieValue(req: IncomingMessage): string | undefined {
  for (const part of String(req.headers.cookie ?? "").split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === COOKIE) return rest.join("=");
  }
  return undefined;
}

function readForm(req: IncomingMessage): Promise<URLSearchParams | undefined> {
  return new Promise((resolve) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size <= MAX_BODY) chunks.push(chunk);
    });
    req.on("end", () => resolve(size > MAX_BODY ? undefined : new URLSearchParams(Buffer.concat(chunks).toString("utf8"))));
    req.on("error", () => resolve(undefined));
  });
}

export async function handleAdmin(req: IncomingMessage, res: ServerResponse, url: URL, deps: AdminDeps): Promise<boolean> {
  const path = url.pathname;
  if (path !== "/admin" && !path.startsWith("/admin/")) return false;
  const method = req.method ?? "GET";
  const html = (status: number, body: string, extra: Record<string, string> = {}) => {
    res.writeHead(status, { ...ADMIN_HEADERS, ...extra });
    res.end(body);
    return true;
  };
  const redirect = (to: string, extra: Record<string, string> = {}) => {
    res.writeHead(303, { Location: to, "Cache-Control": "no-store", ...extra });
    res.end();
    return true;
  };
  const password = deps.password()?.trim();
  if (!password || !deps.https) {
    res.writeHead(404, { "Content-Type": "text/plain", "Cache-Control": "no-store" });
    res.end("Not found");
    return true;
  }
  const now = deps.h.now().getTime();
  const { h } = deps;

  if (path === "/admin/login") {
    if (method !== "POST") return redirect("/admin");
    const key = clientKey(req);
    const record = failures.get(key);
    if (record && now - record.since > LOCK_MS) failures.delete(key);
    const form = await readForm(req);
    if ((failures.get(key)?.count ?? 0) >= MAX_FAILURES) return html(429, loginPage("Too many tries. Wait 15 minutes."));
    if (!form || !passwordMatches(form.get("password") ?? "", password)) {
      const current = failures.get(key);
      failures.set(key, { count: (current?.count ?? 0) + 1, since: current?.since ?? now });
      h.log("A wrong Cleaner Core admin password was entered.");
      return html(401, loginPage("That password isn't right."));
    }
    failures.delete(key);
    const id = randomBytes(32).toString("base64url");
    sessions.set(id, { csrf: randomBytes(24).toString("base64url"), expiresAt: now + SESSION_MS });
    return redirect("/admin", { "Set-Cookie": `${COOKIE}=${id}; Path=/admin; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_MS / 1000}` });
  }

  const sessionId = cookieValue(req);
  const session = sessionId ? sessions.get(sessionId) : undefined;
  if (session && session.expiresAt <= now) sessions.delete(sessionId!);
  const live = session && session.expiresAt > now ? session : undefined;

  if (method === "GET") {
    if (!live) return path === "/admin" ? html(200, loginPage()) : redirect("/admin");
    if (path === "/admin") {
      prune(deps);
      return html(200, tenantsPage(h.registry.list(), live.csrf));
    }
    const tenant = tenantFrom(deps, path);
    if (!tenant || path !== `/admin/tenants/${tenant.id}`) return html(404, messagePage("Not found", "That page doesn't exist."));
    return html(200, tenantPage(tenant, live.csrf));
  }

  if (method !== "POST") return html(405, messagePage("Not allowed", "That isn't something this page does."));
  const form = await readForm(req);
  if (!live || !form || !sameToken(form.get("csrf") ?? "", live.csrf)) return html(403, messagePage("Form expired", EXPIRED));

  if (path === "/admin/logout") {
    sessions.delete(sessionId!);
    return redirect("/admin", { "Set-Cookie": `${COOKIE}=; Path=/admin; HttpOnly; Secure; SameSite=Strict; Max-Age=0` });
  }

  if (path === "/admin/tenants") return createTenant(deps, form, live.csrf, html);

  const tenant = tenantFrom(deps, path);
  if (!tenant) return html(404, messagePage("Not found", "That tenant doesn't exist."));
  const verb = path.slice(`/admin/tenants/${tenant.id}/`.length);
  const back = `/admin/tenants/${tenant.id}`;
  const grantId = form.get("grantId") ?? "";
  switch (verb) {
    case "invite":
      return html(200, invitePage(tenant, h.registry.invite(tenant.id), connectorUrl(h)));
    case "primary":
      if (!tenant.connections.some((c) => c.grantId === grantId)) return html(400, tenantPage(tenant, live.csrf, "That connection isn't on this tenant."));
      h.registry.setPrimary(tenant.id, grantId);
      return redirect(back);
    case "disconnect":
      if (!tenant.connections.some((c) => c.grantId === grantId)) return html(400, tenantPage(tenant, live.csrf, "That connection isn't on this tenant."));
      deps.revokeGrant(grantId);
      h.secrets.deleteConnection(tenant.id, grantId);
      h.registry.disconnect(tenant.id, grantId);
      h.log(`Disconnected one connection from ${tenant.id}.`);
      return redirect(back);
    case "disable":
    case "enable":
      h.registry.setDisabled(tenant.id, verb === "disable");
      h.log(`Turned ${tenant.id} ${verb === "disable" ? "off" : "on"}.`);
      return redirect(back);
    case "delete":
      if ((form.get("confirm") ?? "") !== tenant.label) return html(400, tenantPage(tenant, live.csrf, "Type the label to delete."));
      await deleteTenant(deps, tenant);
      return redirect("/admin");
    default:
      return html(404, messagePage("Not found", "That page doesn't exist."));
  }
}

function connectorUrl(h: HostedCleaner): string {
  return `${h.origin() ?? ""}/mcp/cleaner-core`;
}

function tenantFrom(deps: AdminDeps, path: string): Tenant | undefined {
  const id = /^\/admin\/tenants\/([^/]+)/.exec(path)?.[1];
  return id ? deps.h.registry.get(id) : undefined;
}

/** Drops connections whose grant no longer exists (revoked, or expired out of the store). */
function prune(deps: AdminDeps): void {
  const live = deps.grantIds();
  for (const tenant of deps.h.registry.list()) {
    for (const connection of tenant.connections) {
      if (live.has(connection.grantId)) continue;
      deps.h.secrets.deleteConnection(tenant.id, connection.grantId);
      deps.h.registry.disconnect(tenant.id, connection.grantId);
    }
  }
}

async function createTenant(deps: AdminDeps, form: URLSearchParams, csrf: string, html: (status: number, body: string) => boolean): Promise<boolean> {
  const { h } = deps;
  const list = () => h.registry.list();
  const label = form.get("label") ?? "";
  const raw = form.get("number") ?? "";
  // Validate before asking Twilio, so a typo doesn't cost a network call.
  if (!label.trim()) return html(400, tenantsPage(list(), csrf, REGISTRY_WORDS["bad-label"]));
  let created: { tenant: Tenant; inviteCode: string };
  try {
    const probe = h.registry.byNumber(raw);
    if (probe) throw new RegistryError("number-taken");
    const e164 = parsePhone(raw);
    if (!e164) throw new RegistryError("bad-number");
    const env = h.baseEnv();
    const number = await findIncomingNumber(env, e164);
    if (!number) return html(400, tenantsPage(list(), csrf, "That number isn't on the Twilio account."));
    created = h.registry.create({ label, twilioNumber: e164 });
    if (!(await pointSmsWebhook(env, number.sid, `${h.origin() ?? ""}/webhooks/twilio/cleaner-core`))) {
      h.log(`Created ${created.tenant.id}, but Twilio didn't take the webhook. Set it in the Twilio console.`);
    }
  } catch (err) {
    if (err instanceof RegistryError) return html(400, tenantsPage(list(), csrf, REGISTRY_WORDS[err.reason]));
    throw err;
  }
  h.log(`Created ${created.tenant.id}.`);
  return html(200, invitePage(created.tenant, created.inviteCode, connectorUrl(h)));
}

async function deleteTenant(deps: AdminDeps, tenant: Tenant): Promise<void> {
  const { h } = deps;
  for (const connection of tenant.connections) deps.revokeGrant(connection.grantId);
  // Off first, so no request or drain starts work on the folder while it goes.
  h.registry.setDisabled(tenant.id, true);
  const env = h.baseEnv();
  const number = await findIncomingNumber(env, tenant.twilioNumber);
  if (number) await pointSmsWebhook(env, number.sid, "");
  const folder = tenantFolder(h.dataRoot, tenant.id);
  forgetLiveDesk(folder);
  rmSync(folder, { recursive: true, force: true });
  h.registry.remove(tenant.id);
  h.log(`Deleted ${tenant.id}.`);
}
