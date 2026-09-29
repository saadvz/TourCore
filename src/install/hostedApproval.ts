import { timingSafeEqual } from "node:crypto";
import type { McpOAuth } from "../mcp/oauth";
import { APPROVAL_CSRF_HEADER, APPROVAL_SESSION_HEADER } from "./approvalSessions";
import type { Installation } from "./installation";

/**
 * The hosted approval page. A person holding the short-lived session confirms
 * the pairing code and clicks Allow. An anonymous request, a CSRF miss, or
 * Grok's MCP bearer token cannot approve.
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

const sessionMessage = (reason: "missing" | "unknown" | "expired" | "used" | "csrf") =>
  reason === "expired" || reason === "used"
    ? "This approval link has expired. Start connecting again."
    : reason === "csrf"
      ? "This approval page couldn't be verified. Start connecting again."
      : "This page needs the approval link from Tour Core.";

export function handleHostedApproval(installation: Installation, oauth: McpOAuth | undefined, method: string, path: string, headers: Record<string, string | string[] | undefined>, body: unknown): ApprovalResult {
  if (!oauth) return fail(404, "Tour Core isn't waiting for an approval.");
  if (one(headers.authorization)) return fail(401, "Connecting to Tour Core is not approval. Open the approval page and click Allow.");
  const token = one(headers[APPROVAL_SESSION_HEADER]);
  const csrf = one(headers[APPROVAL_CSRF_HEADER]);
  if (method === "GET" && path === "/api/connect") {
    const session = installation.approvals.check(token, csrf);
    if (!session.ok) return fail(401, sessionMessage(session.reason));
    return {
      status: 200,
      json: {
        ok: true,
        pending: oauth.provider.pendingRequests().map(({ id, matchCode, clientName }) => ({ id, matchCode, clientName })),
      },
    };
  }
  if (method === "POST" && path === "/api/connect/approve") {
    const origin = one(headers.origin);
    const base = installation.publicBaseUrl();
    if (origin && base && origin !== new URL(base).origin) return fail(403, "This approval page couldn't be verified.");
    const session = installation.approvals.check(token, csrf);
    if (!session.ok) return fail(401, sessionMessage(session.reason));
    const parsed = body as { requestId?: unknown; matchCode?: unknown } | undefined;
    const requestId = typeof parsed?.requestId === "string" ? parsed.requestId : "";
    const matchCode = typeof parsed?.matchCode === "string" ? parsed.matchCode : "";
    const pending = oauth.provider.pendingRequests().find((request) => request.id === requestId);
    if (!pending || !codesMatch(matchCode, pending.matchCode)) return fail(403, "That code doesn't match. Check the code and try again.");
    const used = installation.approvals.consume(token, csrf);
    if (!used.ok) return fail(401, sessionMessage(used.reason));
    if (!oauth.provider.decide(requestId, "approved")) return fail(404, "That request isn't waiting any more. Start connecting again.");
    return { status: 200, json: { ok: true } };
  }
  return fail(404, "That page doesn't exist.");
}
