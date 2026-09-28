import SendblueAPI from "sendblue";
import { toE164 } from "../Messenger";

/**
 * Everything Sendblue-specific that comes from the environment. Secrets are
 * read only from environment variables (a local .env is loaded into them at
 * startup) and never written to config, records or logs.
 */
export interface SendblueEnv {
  apiKey?: string;
  apiSecret?: string;
  /** The Sendblue line Tour Core sends from, E.164. */
  fromNumber?: string;
  /** Raw value, kept so readiness can explain a badly formatted number. */
  fromNumberRaw?: string;
  webhookSecret?: string;
  /** https://... base the phone can reach: webhooks and identity-form links hang off it. */
  publicBaseUrl?: string;
  publicBaseUrlRaw?: string;
}

export function readSendblueEnv(env: NodeJS.ProcessEnv = process.env): SendblueEnv {
  const value = (k: string) => env[k]?.trim() || undefined;
  const fromRaw = value("SENDBLUE_FROM_NUMBER");
  const baseRaw = value("PUBLIC_BASE_URL");
  return {
    apiKey: value("SENDBLUE_API_API_KEY"),
    apiSecret: value("SENDBLUE_API_API_SECRET"),
    fromNumberRaw: fromRaw,
    fromNumber: fromRaw ? toE164(fromRaw) : undefined,
    webhookSecret: value("SENDBLUE_WEBHOOK_SECRET"),
    publicBaseUrlRaw: baseRaw,
    publicBaseUrl: publicBase(baseRaw),
  };
}

/** Only https URLs count; the phone and Sendblue must reach them. Trailing slashes are dropped. */
export function publicBase(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:") return undefined;
    return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
  } catch {
    return undefined;
  }
}

export const SENDBLUE_WEBHOOK_PATH = "/webhooks/sendblue";
export const webhookUrlFor = (env: SendblueEnv) => (env.publicBaseUrl ? `${env.publicBaseUrl}${SENDBLUE_WEBHOOK_PATH}` : undefined);

type ReceiveHook = string | { url: string; secret?: string; sendblue_numbers?: string[] };

/** The slice of the official SDK Tour Core uses. Tests replace it with a fake at this boundary. */
export interface SendblueClient {
  messages: {
    send(
      params: { from_number: string; number: string; content: string; status_callback?: string },
      options?: { maxRetries?: number },
    ): Promise<{ message_handle?: string; status?: string; error_code?: number | null; error_message?: string | null; service?: string | null }>;
  };
  lines: { getState(): Promise<{ data: Array<{ sendblue_number: string | null; status: string; assignment?: string }> }> };
  webhooks: {
    list(): Promise<{ webhooks?: { receive?: ReceiveHook[] } }>;
    create(body: { webhooks: ReceiveHook[]; type?: "receive" }): Promise<unknown>;
    delete(body: { webhooks: string[]; type?: "receive" }): Promise<unknown>;
  };
  verifiedContacts: {
    create(body: { phone_number: string }): Promise<{ data?: SendblueContactData }>;
    retrieve(phone: string): Promise<{ data?: SendblueContactData }>;
    list(): Promise<{ data?: { contacts: SendblueContact[]; line: { phone_number: string | null; type: string } | null } }>;
  };
}
export interface SendblueContact {
  phone_number: string;
  verified: boolean;
  verification_status: "pending" | "verified";
}
export interface SendblueContactData {
  contact: SendblueContact | null;
  line: { phone_number: string | null; type: string } | null;
  verification_instructions?: string | null;
}

let clientFactory: (env: SendblueEnv) => SendblueClient = (env) =>
  new SendblueAPI({ apiKey: env.apiKey, apiSecret: env.apiSecret, maxRetries: 2, timeout: 20_000, logLevel: "off" }) as unknown as SendblueClient;
let envReader: () => SendblueEnv = () => readSendblueEnv();

export const sendblueRuntime = {
  env: () => envReader(),
  client: (env: SendblueEnv) => clientFactory(env),
};

/** Tests (and only tests) swap the SDK and environment here. */
export function setSendblueRuntime(overrides: { env?: () => SendblueEnv; client?: (env: SendblueEnv) => SendblueClient }): () => void {
  const previous = { envReader, clientFactory };
  if (overrides.env) envReader = overrides.env;
  if (overrides.client) clientFactory = overrides.client;
  return () => {
    envReader = previous.envReader;
    clientFactory = previous.clientFactory;
  };
}

/** For logs: shows that a value is set without revealing it. */
export const mask = (value: string | undefined) => (value ? `set (${value.length} characters)` : "not set");
