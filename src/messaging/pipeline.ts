import type { InboundMessage } from "./inbound";
import { runInboundSmsTiming, smsCorrelationId } from "./inboundTiming";
import type { MessagingLedger } from "./ledger";
import type { MessagingProvider, WebhookHttpRequest } from "./provider";

export interface WebhookResult {
  status: number;
  body: Record<string, unknown>;
  contentType?: string;
}

/**
 * Sendblue's ledger already uses this prefix. Keeping it means a retried
 * webhook from before this refactor is still recognized.
 */
export function inboundLedgerKey(provider: string, providerMessageId: string): string {
  if (provider === "sendblue") return `sendblue:in:${providerMessageId}`;
  return `${provider}:${providerMessageId}`;
}

/**
 * Verify, parse, and de-duplicate one provider webhook into the visitor
 * pipeline. A repeat delivery is acknowledged and not run again.
 */
export async function handleProviderWebhook(
  provider: MessagingProvider,
  request: WebhookHttpRequest,
  deps: {
    ledger: MessagingLedger;
    receive: (message: InboundMessage) => Promise<{ correlationId?: string } | void>;
    now?: () => Date;
    log?: (line: string) => void;
    /** When false, a verified webhook is acknowledged and not applied. */
    active?: boolean;
  },
): Promise<WebhookResult> {
  const now = deps.now?.() ?? new Date();
  const auth = provider.verifyWebhook(request);
  if (!auth.ok) {
    deps.log?.(`${provider.displayName} webhook rejected (${auth.code}).`);
    return { status: 401, body: { error: "unauthorized" } };
  }
  if (deps.active === false) return { status: 200, body: { ignored: "inactive provider" } };

  const parsed = provider.parseInbound(request.rawBody, now);
  if ("ignored" in parsed) return { status: 200, body: { ignored: parsed.ignored } };

  const key = inboundLedgerKey(provider.id, parsed.message.providerMessageId);
  if (!deps.ledger.claim(key, now, { provider: provider.id, messageId: parsed.message.providerMessageId })) {
    return { status: 200, body: { duplicate: true } };
  }
  try {
    const handled = await runInboundSmsTiming(
      smsCorrelationId(provider.id, parsed.message.providerMessageId),
      deps.log ?? (() => undefined),
      () => deps.receive(parsed.message),
    );
    deps.ledger.complete(key, undefined, { correlationId: handled?.correlationId, at: deps.now?.() });
    return { status: 200, body: { ok: true } };
  } catch (err) {
    deps.ledger.fail(key);
    deps.log?.(`Couldn't process a ${provider.displayName} message: ${err instanceof Error ? err.message : "unknown error"}`);
    return { status: 200, body: { ok: false } };
  }
}
