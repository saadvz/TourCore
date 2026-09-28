import type { MessagingEndpoints } from "../messaging/endpoints";
import type { PropertyWorkspace } from "../setup/workspace";
import type { RuntimeStore } from "../storage/runtimeStore";
import type { VisitorDemoRegistry, VisitorDemoSession } from "../visitor/session";

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
  /** The texting number this computer sends from (Sendblue today). */
  messagingLine?: () => string | undefined;
  /** Saves a conversation's records (and, for text messages, its resume snapshot). */
  persist?: (session: VisitorDemoSession) => Promise<void>;
  /** Text-message tours that couldn't be picked up after a restart. */
  needsAttention?: (propertyId: string) => { visitorPhone: string; problem: string; at?: string }[];
  now?: () => Date;
}

export async function persistSession(services: OperatorServices, session: VisitorDemoSession): Promise<void> {
  if (services.persist) return services.persist(session);
  const { record, bundle } = await session.record();
  services.workspace.recordVisitorDemo(session.propertyId, record, bundle);
}
