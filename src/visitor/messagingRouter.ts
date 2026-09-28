import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { normalizePhone } from "../core/phone";
import type { InboundMessage } from "../messaging/inbound";
import type { MessagingAdapter } from "../messaging/Messenger";
import type { PropertyWorkspace } from "../setup/workspace";
import { writeJsonAtomic } from "../storage/atomicWrite";
import type { IntentInterpreter } from "../intent";
import { handleVisitorText, isGreeting } from "./conversation";
import { VisitorDemoSession, type VisitorDemoRegistry } from "./session";
import type { VerificationLinks } from "./verificationLinks";

type Transport = MessagingAdapter & { noteChannel?: (number: string, channel: InboundMessage["channel"]) => void };

/**
 * Hands a verified, de-duplicated inbound message to the right visitor
 * conversation (the same session type the browser phone uses) and saves the
 * records afterwards. Provider-neutral: any messaging webhook can call it.
 */
export class MessagingConversations {
  constructor(
    private readonly deps: {
      workspace: PropertyWorkspace;
      registry: VisitorDemoRegistry;
      /** The live transport, e.g. the Sendblue adapter. */
      transport: () => Transport;
      links: VerificationLinks;
      /** Which saved property answers this line; defaults to the one set to use real messaging. */
      propertyFor?: (line: string | undefined) => string | undefined;
      now?: () => Date;
      /** Real-time source for new conversations (tests move it; production uses the system clock). */
      realNow?: () => number;
      /** Reads what a typed message is trying to do. Defaults to the built-in rules. */
      interpreter?: IntentInterpreter;
      log?: (line: string) => void;
    },
  ) {}

  async receive(message: InboundMessage): Promise<void> {
    const { workspace: ws, registry } = this.deps;
    const propertyId = (this.deps.propertyFor ?? ((line) => this.defaultProperty(line)))(message.to);
    if (!propertyId) {
      this.deps.log?.("A message arrived, but no property is set up to use real messaging.");
      return;
    }
    const transport = this.deps.transport();
    transport.noteChannel?.(message.from, message.channel);
    const meta = { provider: message.provider, providerMessageId: message.providerMessageId, deliveryChannel: message.channel };
    const phone = normalizePhone(message.from);

    let session = registry.latestForPhone(propertyId, phone, "messaging");
    if (session && ["done", "stopped"].includes(await session.stage()) && isGreeting(message.text) && !session.optedOut) session = undefined;

    if (!session) {
      const { config, state } = ws.load(propertyId);
      const ready = state.readiness?.passed && state.readiness.configHash === state.configHash;
      if (!ready) {
        await transport.send({ to: phone, audience: "PROSPECT", body: `Thanks for reaching out to ${config.property.name}. Self-guided tours by text aren't available right now. Please contact the property team.` }).catch(() => undefined);
        return;
      }
      session = registry.add(
        new VisitorDemoSession(propertyId, config, ws.newVisitorTourId(propertyId, this.deps.now?.() ?? new Date(), "text"), {
          transport,
          kind: "messaging",
          verificationLinks: this.deps.links,
          realNow: this.deps.realNow,
        }),
      );
      // Someone who texted STOP earlier stays opted out until they text START.
      session.optedOut = this.isOptedOut(propertyId, phone);
    }

    const wasOptedOut = session.optedOut;
    await handleVisitorText(session, phone, message.text, meta, this.deps.interpreter);
    if (session.optedOut !== wasOptedOut) this.setOptOut(propertyId, phone, session.optedOut);
    await this.save(session);
  }

  /** Sends through the live transport, created only when a message actually goes out. */
  private lazyTransport(): Transport {
    return {
      provider: "sendblue",
      presentation: "MESSAGING",
      send: (m) => this.deps.transport().send(m),
      noteChannel: (n, c) => this.deps.transport().noteChannel?.(n, c),
    };
  }

  /**
   * After a restart, brings back text-message tours that were still in
   * progress (the latest one per phone), so a booked visitor can carry on.
   */
  async restoreSaved(): Promise<number> {
    const { workspace: ws, registry } = this.deps;
    let restored = 0;
    for (const saved of ws.list().filter((p) => p.config.messagingMode === "sendblue")) {
      const propertyId = saved.config.property.id;
      const seen = new Set<string>();
      for (const record of ws.listTours(propertyId)) {
        if (record.kind !== "messaging" || !record.visitorPhone || seen.has(record.visitorPhone)) continue;
        seen.add(record.visitorPhone);
        if (record.outcome !== "in-progress" || registry.latestForPhone(propertyId, record.visitorPhone, "messaging")) continue;
        const tour = ws.loadTour(propertyId, record.tourId);
        if (!tour) continue;
        const session = new VisitorDemoSession(propertyId, saved.config, record.tourId, {
          transport: this.lazyTransport(),
          kind: "messaging",
          verificationLinks: this.deps.links,
          realNow: this.deps.realNow,
          id: tour.bundle.messages.find((m) => m.correlationId)?.correlationId,
          startedAt: new Date(record.ranAt),
        });
        await session.hydrate(record, tour.bundle);
        registry.add(session);
        restored++;
      }
    }
    return restored;
  }

  private async save(session: VisitorDemoSession): Promise<void> {
    const { record, bundle } = await session.record();
    this.deps.workspace.recordVisitorDemo(session.propertyId, record, bundle);
  }

  private defaultProperty(_line: string | undefined): string | undefined {
    const candidates = this.deps.workspace.list().filter((p) => p.config.messagingMode === "sendblue");
    return (candidates.find((p) => p.state.status === "PUBLISHED_FOR_DEMO") ?? candidates[0])?.config.property.id;
  }

  // Opt-outs outlive any one conversation, so they're kept per property on disk.
  private optOutFile(propertyId: string): string {
    return join(this.deps.workspace.root, "properties", propertyId, "messaging-opt-outs.json");
  }

  private isOptedOut(propertyId: string, phone: string): boolean {
    const file = this.optOutFile(propertyId);
    if (!existsSync(file)) return false;
    try {
      return !!(JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>)[phone];
    } catch {
      return true;
    }
  }

  private setOptOut(propertyId: string, phone: string, optedOut: boolean): void {
    const file = this.optOutFile(propertyId);
    const current: Record<string, string> = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
    if (optedOut) current[phone] = new Date().toISOString();
    else delete current[phone];
    writeJsonAtomic(file, current);
  }
}
