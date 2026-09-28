import type { SendblueClient, SendblueEnv } from "../src/messaging/sendblue/runtime";

export const LINE = "+15550009999";
export const PUBLIC = "https://tour.example";
export const SECRET = "test-webhook-secret";

export const sendblueEnv = (overrides: Partial<SendblueEnv> = {}): SendblueEnv => ({
  apiKey: "key-id",
  apiSecret: "secret-key",
  fromNumber: LINE,
  fromNumberRaw: LINE,
  webhookSecret: SECRET,
  publicBaseUrl: PUBLIC,
  publicBaseUrlRaw: PUBLIC,
  ...overrides,
});

export function apiError(status: number, name = "APIError"): Error {
  return Object.assign(new Error(`${status} {"message":"nope"}`), { status, name });
}

/** Stands in for the official SDK at the network boundary; records every send. */
export function fakeSendblue(options: {
  sendError?: () => Error | undefined;
  listError?: Error;
  hooks?: Array<string | { url: string; secret?: string }>;
  lines?: Array<{ sendblue_number: string | null; status: string }>;
} = {}) {
  const sent: Array<{ from_number: string; number: string; content: string }> = [];
  const created: unknown[] = [];
  const client: SendblueClient = {
    messages: {
      async send(params) {
        const err = options.sendError?.();
        if (err) throw err;
        sent.push(params);
        return { message_handle: `out_${sent.length}`, status: "QUEUED" };
      },
    },
    lines: { getState: async () => ({ data: options.lines ?? [{ sendblue_number: LINE, status: "ONLINE", assignment: "shared" }] }) },
    webhooks: {
      async list() {
        if (options.listError) throw options.listError;
        return { webhooks: { receive: options.hooks ?? [{ url: `${PUBLIC}/webhooks/sendblue`, secret: SECRET }] } };
      },
      async create(body) {
        created.push(body);
        return {};
      },
      delete: async () => ({}),
    },
    verifiedContacts: {
      create: async ({ phone_number }) => ({ data: { contact: { phone_number, verified: false, verification_status: "pending" }, line: { phone_number: LINE, type: "shared" } } }),
      retrieve: async (phone) => ({ data: { contact: { phone_number: phone, verified: true, verification_status: "verified" }, line: { phone_number: LINE, type: "shared" } } }),
      list: async () => ({ data: { contacts: [], line: { phone_number: LINE, type: "shared" } } }),
    },
  };
  return { client, sent, created };
}

/** A Sendblue receive-webhook payload, shaped like the documented example. */
export function inbound(from: string, content: string, handle: string, service = "iMessage") {
  return {
    accountEmail: "dev@example.com",
    content,
    is_outbound: false,
    status: "RECEIVED",
    message_handle: handle,
    date_sent: new Date().toISOString(),
    from_number: from,
    number: from,
    to_number: LINE,
    sendblue_number: LINE,
    service,
    message_type: "message",
    group_id: "",
    opted_out: false,
  };
}
