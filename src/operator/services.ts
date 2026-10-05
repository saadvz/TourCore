import type { InboundMessage } from "../messaging/inbound";
import type { MessagingProviderId } from "../messaging/provider";
import type { MessagingEndpoints } from "../messaging/endpoints";
import type { PropertyWorkspace } from "../setup/workspace";
import type { RuntimeStore } from "../storage/runtimeStore";
import type { VisitorDemoRegistry, VisitorDemoSession } from "../visitor/session";

/** The installation's real visitor texting, as property setup and publishing need it. Never a credential. */
export interface InstalledMessaging {
  /** The property uses real phones. Which company carries them is `provider`. */
  mode: "live";
  provider: MessagingProviderId;
  /** Connected and tested. */
  ready: boolean;
  /** Grok-managed installs: a property can't be published while it still uses demo messaging. */
  requiredForPublish: boolean;
}

/**
 * What every operator surface (browser, terminal, Grok Bot) runs against:
 * the same workspace, live conversations and runtime records. Canonical
 * state lives here, never in the surface.
 */
export interface OperatorServices {
  workspace: PropertyWorkspace;
  /** Live visitor conversations for this process. */
  visitors?: VisitorDemoRegistry;
  /** Where running tours are saved; checked by readiness for real-phone properties. */
  runtime?: RuntimeStore;
  /** Which property answers on which texting number. */
  endpoints?: MessagingEndpoints;
  /** The texting number this computer sends from. */
  messagingLine?: () => string | undefined;
  /** Saves a conversation's records (and, for text messages, its resume snapshot). */
  persist?: (session: VisitorDemoSession) => Promise<void>;
  /** Opens a text-message conversation so Tour Core can text first. */
  openMessagingSession?: (propertyId: string, phone: string) => Promise<VisitorDemoSession>;
  /** Releases operator-set tours the visitor never confirmed. */
  releaseUnconfirmedTours?: () => Promise<void>;
  /** Text-message tours that couldn't be picked up after a restart. */
  needsAttention?: (propertyId: string) => { visitorPhone: string; problem: string; at?: string }[];
  /** Real visitor texting set up for this installation, if any. New properties use it. */
  installedMessaging?: () => InstalledMessaging | undefined;
  /** Hands a verified inbound SMS to the same visitor pipeline the webhooks use. */
  receiveInbound?: (message: InboundMessage) => Promise<{ correlationId?: string } | void>;
  now?: () => Date;
}

/** Messaging a new property starts with: the installation's real texting when it has any, otherwise demo. */
export function defaultMessagingMode(installed: InstalledMessaging | undefined): "live" | "demo" {
  return installed && (installed.ready || installed.requiredForPublish) ? "live" : "demo";
}

export async function persistSession(services: OperatorServices, session: VisitorDemoSession): Promise<void> {
  if (services.persist) return services.persist(session);
  const { record, bundle } = await session.record();
  services.workspace.recordVisitorDemo(session.propertyId, record, bundle);
}
