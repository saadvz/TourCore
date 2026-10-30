import { z } from "zod";
import type { CleanerAssistant } from "../cleaner-core/assistant";
import { tourCoreTenants } from "../cleaner-core/flag";
import type { Tenant, TenantService } from "../cleaner-core/hosted/registry";
import type { HostedCleaner } from "../cleaner-core/hosted/router";
import type { TouringInbox } from "./touringForward";
import type { TouringSupervisor } from "./touringSupervisor";

/**
 * The tools the shared service answers itself, around whichever service a tenant's number runs:
 * choosing a service, switching it, standing it down, and the touring alert routine. Everything else
 * goes to the active service.
 */

export type ToolState = "unset" | TenantService;

export function toolsFor(tenant: Tenant): ToolState {
  return tenant.service ?? "unset";
}

interface FrontTool {
  name: string;
  title: string;
  description: string;
  input: z.ZodObject;
}

const Service = z.enum(["touring", "cleaning"]);

const GET_STATE: FrontTool = {
  name: "get_state",
  title: "What's next",
  description: "Call this first. Says this number has no service yet and what each service does. Then ask the host which one to set up and call choose_service.",
  input: z.object({}),
};
const CHOOSE: FrontTool = {
  name: "choose_service",
  title: "Choose a service",
  description: "Sets this number up for touring or cleaning, after the host chooses. It answers for that service only until the host asks to switch.",
  input: z.object({ service: Service }),
};
const SWITCH: FrontTool = {
  name: "switch_service",
  title: "Switch the number's service",
  description:
    "Moves this number to the other service, only when the host asks and nothing is live. Call once without confirmation to get what's still live or the question and a code, ask the host that question, and call again with the code only after the host says yes. No texts go out.",
  input: z.object({ to: Service, confirmation: z.string().max(40).optional() }),
};
const STAND_DOWN: FrontTool = {
  name: "stand_down_service",
  title: "Stand the service down",
  description:
    "Stops what's live on this number's service so it can switch, keeping the setup. Call once without confirmation to get a preview of what stops and the exact texts that go out, show the host, and call again with the code only after the host says yes.",
  input: z.object({ confirmation: z.string().max(40).optional() }),
};
const SAVE_ALERT_ROUTINE: FrontTool = {
  name: "save_alert_routine",
  title: "Connect touring alerts",
  description: "Gives a private link where the host pastes the touring alert routine's webhook address and key. Send the host the link. Never put the address or key in chat.",
  input: z.object({}),
};

const BY_STATE: Record<ToolState, FrontTool[]> = {
  unset: [GET_STATE, CHOOSE],
  cleaning: [SWITCH, STAND_DOWN],
  touring: [SAVE_ALERT_ROUTINE, SWITCH, STAND_DOWN],
};

/** Every name the front answers in some state. A call to one of them in another state is refused, never forwarded. */
export const FRONT_TOOL_NAMES = new Set([GET_STATE, CHOOSE, SWITCH, STAND_DOWN, SAVE_ALERT_ROUTINE].map((tool) => tool.name));

export function frontToolsFor(state: ToolState): FrontTool[] {
  return BY_STATE[state];
}

/** The front tools as tools/list shows them. */
export function listedFrontTools(state: ToolState): Record<string, unknown>[] {
  return frontToolsFor(state).map((tool) => {
    const { $schema: _schema, ...inputSchema } = z.toJSONSchema(tool.input) as Record<string, unknown>;
    return { name: tool.name, title: tool.title, description: tool.description, inputSchema };
  });
}

/** A chat still holding the other service's tools after a choice or a switch. */
export const wrongServiceLine = (service: TenantService) => `This number is set up for ${service} now. Start a new chat to see its tools.`;

export const CHOSEN_LINE = (service: TenantService) => `Set up for ${service}. Your tools have changed. If you don't see the new ones, start a new chat.`;

const UNSET_BOTH =
  "This number isn't set up yet. Ask the host which service to set up: touring (visitors text this number to book a self-guided tour) or cleaning (turnover cleanings from the host's booking calendar). Then call choose_service.";
const UNSET_CLEANING_ONLY = "This number isn't set up yet. It can run cleaning: turnover cleanings from the host's booking calendar. Call choose_service with cleaning.";

/** The initialize instructions for a tenant that hasn't chosen yet. */
export const UNSET_INSTRUCTIONS = "Call get_state first and follow its next step. Ask the host which service to set up before anything else.";

/** What the shared service holds for touring tenants. Absent until the service runs touring at all. */
export interface TouringFront {
  supervisor: TouringSupervisor;
  inbox: TouringInbox;
  /** TOUR_CORE_TENANTS. */
  enabled(): boolean;
  /** The shared Twilio account's auth token, for checking and re-signing texts. */
  authToken(): string | undefined;
  /** Starts the tenant's process and hands it any texts that waited. */
  start(tenant: Tenant): Promise<void>;
}

export interface FrontContext {
  h: HostedCleaner;
  tenant: Tenant;
  caller: { grantId: string; assistant: CleanerAssistant };
  noteToolsChanged(): void;
}

export interface FrontReply {
  text: string;
  structured?: Record<string, unknown>;
  isError: boolean;
}

const fail = (text: string): FrontReply => ({ text, isError: true });
const done = (structured: Record<string, unknown>): FrontReply => ({ text: JSON.stringify(structured), structured, isError: false });

/** How long a choice waits for a touring process before answering anyway. */
const START_WAIT_MS = 30_000;

/** Answers a front tool. Undefined when the name isn't one of this state's front tools. */
export async function handleFrontTool(ctx: FrontContext, name: string, args: unknown): Promise<FrontReply | undefined> {
  const state = toolsFor(ctx.tenant);
  const tool = frontToolsFor(state).find((item) => item.name === name);
  if (!tool) return undefined;
  const parsed = tool.input.safeParse(args ?? {});
  if (!parsed.success) return fail("That was missing something I need.");
  const touringOn = tourCoreTenants(ctx.h.baseEnv()) && !!ctx.h.touring;
  if (name === "get_state") return done({ next: touringOn ? UNSET_BOTH : UNSET_CLEANING_ONLY, services: touringOn ? ["touring", "cleaning"] : ["cleaning"] });
  if (name === "choose_service") {
    const service = (parsed.data as { service: TenantService }).service;
    if (service === "touring" && !touringOn) return fail("Touring isn't available on this service yet. Choose cleaning.");
    ctx.h.registry.setService(ctx.tenant.id, service);
    if (service === "touring") {
      const tenant = ctx.h.registry.get(ctx.tenant.id)!;
      await Promise.race([ctx.h.touring!.start(tenant), new Promise((resolve) => setTimeout(resolve, START_WAIT_MS).unref())]);
    }
    ctx.h.log(`${ctx.tenant.id} chose ${service}.`);
    ctx.noteToolsChanged();
    return { text: CHOSEN_LINE(service), structured: { service }, isError: false };
  }
  return fail("That isn't ready on this service yet.");
}
