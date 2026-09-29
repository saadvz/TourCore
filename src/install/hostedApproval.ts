import { timingSafeEqual } from "node:crypto";
import type { McpOAuth } from "../mcp/oauth";
import type { Installation } from "./installation";
import { ownerCsrfOk, ownerFromCookie } from "./hostedOwner";

/**
 * The hosted approval API. Allow and Deny run only when the browser has a
 * valid owner session and names a real pending authorization request.
 * The request id is not proof of ownership. Grok's MCP bearer token is not
 * an owner session. A bare /connect (no request) is refused.
 */

export interface ApprovalResult {
  status: number;
  json: unknown;
}

const fail = (status: number, message: string): ApprovalResult => ({ status, json: { ok: false, error: { message } } });

const one = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);

function codesMatch(given: string, expected: string): boolean {
  const a = Buffer.from(given.replace(/\s+/g, ""));
  const b = Buffer.from(expected.replace(/\s+/g, ""));
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

const sessionMessage = (reason: "missing" | "unknown" | "expired") =>
  reason === "expired"
    ? "This owner session has expired. The distributor has to issue a new owner claim."
    : "Tour Core needs you to confirm ownership of this hosted installation before you can approve connections.";

const requestMessage = (state: "missing" | "expired" | "used") =>
  state === "expired"
    ? "This connection request has expired. Start connecting again."
    : state === "used"
      ? "That request was already used. Start connecting again."
      : "That request isn't waiting. Start connecting again.";

export function handleHostedApproval(installation: Installation, oauth: McpOAuth | undefined, method: string, url: URL, headers: Record<string, string | string[] | undefined>, body: unknown): ApprovalResult {
  if (!oauth) return fail(404, "Tour Core isn't waiting for an approval.");
  if (one(headers.authorization)) return fail(401, "Connecting to Tour Core is not approval. Open the approval page and click Allow.");
  const cookie = one(headers.cookie);
  const session = ownerFromCookie(installation, cookie);
  if (!session.ok) return fail(401, sessionMessage(session.reason));

  const path = url.pathname;
  const listed = path === "/api/connect" && method === "GET";
  const deciding = (path === "/api/connect/approve" || path === "/api/connect/deny") && method === "POST";
  if (!listed && !deciding) return fail(404, "That page doesn't exist.");

  if (deciding) {
    const origin = one(headers.origin);
    const base = installation.publicBaseUrl();
    if (origin && base && origin !== new URL(base).origin) return fail(403, "This approval page couldn't be verified.");
    if (!ownerCsrfOk(installation, cookie, one(headers["x-tourcore-csrf"]))) return fail(403, "This approval page couldn't be verified.");
  }

  const parsed = body as { requestId?: unknown; matchCode?: unknown } | undefined;
  const requestId = listed ? (url.searchParams.get("request") ?? "") : typeof parsed?.requestId === "string" ? parsed.requestId : "";
  if (!requestId) return fail(400, "This approval link is missing or was opened without its code.");
  const state = oauth.provider.requestDisposition(requestId);
  if (state !== "pending") return fail(404, requestMessage(state));
  const pending = oauth.provider.pendingRequests().find((request) => request.id === requestId);
  if (!pending) return fail(404, requestMessage("missing"));

  if (listed) {
    return { status: 200, json: { ok: true, request: { id: pending.id, matchCode: pending.matchCode, clientName: pending.clientName } } };
  }

  const matchCode = typeof parsed?.matchCode === "string" ? parsed.matchCode : "";
  if (!codesMatch(matchCode, pending.matchCode)) return fail(403, "That code doesn't match. Check the code and try again.");
  const decision = path === "/api/connect/deny" ? "denied" : "approved";
  if (!oauth.provider.decide(requestId, decision)) return fail(404, "That request isn't waiting any more. Start connecting again.");
  return { status: 200, json: { ok: true } };
}
