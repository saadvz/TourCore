import { randomUUID } from "node:crypto";
import { isLiveMessaging } from "../config/tourCoreConfig";
import { handleProviderWebhook } from "../messaging/pipeline";
import { LOCAL_PROVIDER_REQUIRED, LocalMessagingProvider } from "../messaging/local/provider";
import { localSmsOutbox, type LocalOutboxBubble } from "../messaging/local/outbox";
import { MessagingLedger } from "../messaging/ledger";
import { toE164 } from "../messaging/Messenger";
import { anyPropertyUsesLocal, localLoopbackNumber, usesLocalMessaging } from "../messaging/propertyScope";
import { activeFromNumber, createMessagingProvider, selectionFromInstallation } from "../messaging/registry";
import { SetupInputError } from "../setup/setupActions";
import { resolvePropertyId } from "./resolve";
import type { ToolContext } from "./tools";

export { LOCAL_PROVIDER_REQUIRED };

function installationProvider(ctx: ToolContext): string | undefined {
  if (ctx.installation) return selectionFromInstallation(ctx.installation).provider;
  return ctx.services.installedMessaging?.()?.provider;
}

/** True when this property is live on the local loopback — either its own override or the installation. */
export function isLocalMessagingProperty(ctx: ToolContext, propertyId: string): boolean {
  const { draft } = ctx.services.workspace.openDraft(propertyId);
  const installed = ctx.services.installedMessaging?.()?.provider ?? installationProvider(ctx);
  if (usesLocalMessaging(draft, { provider: installed })) return true;
  if (!isLiveMessaging(draft.messagingMode)) return false;
  const attached = ctx.services.endpoints?.forProperty(propertyId)?.provider;
  if (attached && attached !== "local") return false;
  return installed === "local";
}

export function requireLocalMessagingProperty(ctx: ToolContext, propertyId: string): void {
  if (!isLocalMessagingProperty(ctx, propertyId)) {
    throw new SetupInputError("LOCAL_PROVIDER_REQUIRED", LOCAL_PROVIDER_REQUIRED);
  }
}

function lineFor(ctx: ToolContext, propertyId: string, to?: string): string {
  if (to) {
    const e164 = toE164(to);
    if (!e164) throw new SetupInputError("LINE_INVALID", "That messaging number isn't a valid phone number.");
    return e164;
  }
  const attached = ctx.services.endpoints?.forProperty(propertyId)?.address;
  if (attached) return attached;
  if (isLocalMessagingProperty(ctx, propertyId)) return localLoopbackNumber(ctx.installation?.env());
  const line = ctx.services.messagingLine?.() ?? (ctx.installation ? activeFromNumber(ctx.installation) : undefined);
  if (line) return line;
  throw new SetupInputError("LINE_MISSING", "This property doesn't have a local touring number yet.");
}

function bubblesView(bubbles: LocalOutboxBubble[]) {
  return bubbles.map((b) => ({ body: b.body, sentAt: b.sentAt }));
}

export async function injectLocalSms(
  ctx: ToolContext,
  input: { from: string; text: string; to?: string; property?: string; id?: string },
): Promise<Record<string, unknown>> {
  const propertyId = resolvePropertyId(ctx.services.workspace, input.property);
  requireLocalMessagingProperty(ctx, propertyId);
  const from = toE164(input.from);
  if (!from) throw new SetupInputError("PHONE_INVALID", "That visitor phone number isn't a valid phone number.");
  const to = lineFor(ctx, propertyId, input.to);
  if (ctx.services.endpoints) {
    try {
      ctx.services.endpoints.attach({ address: to, provider: "local", propertyId }, ctx.now());
    } catch (err) {
      if (err instanceof SetupInputError) throw err;
      throw err;
    }
  }
  const receive = ctx.services.receiveInbound;
  if (!receive) {
    throw new SetupInputError("LOCAL_PIPELINE_UNAVAILABLE", "Local SMS inject needs Tour Core's visitor pipeline. Start Tour Core and try again.");
  }
  const before = localSmsOutbox().forVisitor(from).length;
  const provider = ctx.installation
    ? createMessagingProvider("local", { env: () => ctx.installation!.env(), ledger: ctx.messagingLedger, now: ctx.now })
    : new LocalMessagingProvider({ now: ctx.now, ledger: ctx.messagingLedger });
  const id = input.id?.trim() || randomUUID();
  const result = await handleProviderWebhook(
    provider,
    { rawBody: Buffer.from(JSON.stringify({ id, from, to, text: input.text }), "utf8"), headers: { "content-type": "application/json" } },
    { ledger: ctx.messagingLedger ?? new MessagingLedger(), receive, now: ctx.now },
  );
  if (result.status !== 200 || result.body.ok === false) {
    throw new SetupInputError("LOCAL_INJECT_FAILED", "Tour Core couldn't deliver that visitor text.");
  }
  const bubbles = localSmsOutbox().forVisitor(from).slice(before);
  return {
    summary: result.body.duplicate ? "That visitor text was already delivered." : "Delivered the visitor text.",
    from,
    to,
    text: input.text,
    bubbles: bubblesView(bubbles),
    ...(result.body.duplicate ? { duplicate: true } : {}),
  };
}

export function readLocalOutbox(ctx: ToolContext, input: { from?: string; property?: string }): Record<string, unknown> {
  const ids = ctx.services.workspace.propertyIds();
  const propertyId = input.property ? resolvePropertyId(ctx.services.workspace, input.property) : ids.length === 1 ? ids[0] : undefined;
  if (propertyId) requireLocalMessagingProperty(ctx, propertyId);
  else if (installationProvider(ctx) !== "local" && !anyPropertyUsesLocal(ctx.services.workspace)) {
    throw new SetupInputError("LOCAL_PROVIDER_REQUIRED", LOCAL_PROVIDER_REQUIRED);
  }
  const phone = input.from ? toE164(input.from) : undefined;
  if (input.from && !phone) throw new SetupInputError("PHONE_INVALID", "That visitor phone number isn't a valid phone number.");
  const bubbles = phone ? localSmsOutbox().forVisitor(phone) : localSmsOutbox().all().filter((b) => b.audience === "PROSPECT");
  return {
    summary: bubbles.length ? `${bubbles.length} outbound text${bubbles.length === 1 ? "" : "s"}.` : "No outbound texts in the local outbox.",
    bubbles: bubblesView(bubbles),
  };
}
