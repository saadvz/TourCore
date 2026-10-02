import { MessagingError } from "../Messenger";
import { sendPhotonText } from "./sdkSend";

export const PHOTON_API = "https://spectrum.photon.codes";

export interface PhotonLine {
  id: string;
  phoneNumber: string;
  status: "available" | "unavailable" | "unknown";
}

export interface PhotonWebhookRecord {
  id: string;
  webhookUrl: string;
  status?: string;
}

export interface PhotonClient {
  getProject(): Promise<{ name: string }>;
  getImessageInfo(): Promise<{ type: "shared" | "dedicated" }>;
  listLines(): Promise<PhotonLine[]>;
  listWebhooks(): Promise<PhotonWebhookRecord[]>;
  registerWebhook(url: string): Promise<{ id: string; signingSecret: string; standardSigningSecret: string }>;
  deleteWebhook(id: string): Promise<void>;
  rotateStandardSecret(id: string): Promise<{ standardSigningSecret: string }>;
  sendText(input: { to: string; text: string; from?: string }): Promise<{ providerMessageId: string }>;
}

type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{ status: number; json(): Promise<unknown> }>;

function mapStatus(status: number): MessagingError {
  if (status === 401 || status === 403) return new MessagingError("PHOTON_AUTH_FAILED", "Photon didn't accept the project details.", { status });
  if (status === 404) return new MessagingError("PHOTON_NOT_FOUND", "Photon couldn't find that project.", { status });
  if (status === 409) return new MessagingError("PHOTON_WEBHOOK_EXISTS", "That incoming-message address is already registered.", { status });
  if (status >= 500) return new MessagingError("PHOTON_UNAVAILABLE", "Photon is having trouble right now.", { status, retryable: true });
  return new MessagingError("PHOTON_REJECTED", "Photon didn't accept that request.", { status });
}

export function photonHttpClient(credentials: { projectId: string; projectSecret: string }, fetchImpl: FetchLike = fetch as unknown as FetchLike): PhotonClient {
  const root = `${PHOTON_API}/projects/${encodeURIComponent(credentials.projectId)}`;
  const auth = `Basic ${Buffer.from(`${credentials.projectId}:${credentials.projectSecret}`).toString("base64")}`;

  async function call(url: string, init?: { method?: string; body?: string }, allow?: number[]): Promise<unknown> {
    let res: { status: number; json(): Promise<unknown> };
    try {
      res = await fetchImpl(url, {
        method: init?.method ?? "GET",
        headers: { Authorization: auth, Accept: "application/json", ...(init?.body ? { "Content-Type": "application/json" } : {}) },
        body: init?.body,
      });
    } catch {
      throw new MessagingError("PHOTON_UNREACHABLE", "Couldn't reach Photon.", { retryable: true });
    }
    if (res.status >= 400 && !allow?.includes(res.status)) throw mapStatus(res.status);
    const body = await res.json().catch(() => ({}));
    if (res.status >= 400) return { __status: res.status, body };
    return body;
  }

  return {
    async getProject() {
      const body = (await call(`${root}/`)) as { data?: { name?: string } };
      if (!body.data?.name) throw new MessagingError("PHOTON_NOT_FOUND", "Photon couldn't find that project.");
      return { name: body.data.name };
    },
    async getImessageInfo() {
      const body = (await call(`${root}/imessage/`)) as { data?: { type?: string } };
      if (body.data?.type !== "shared" && body.data?.type !== "dedicated") throw new MessagingError("PHOTON_REJECTED", "Photon didn't say whether this project uses a shared or dedicated line.");
      return { type: body.data.type };
    },
    async listLines() {
      const body = (await call(`${root}/lines/?platform=imessage`)) as { data?: { lines?: Array<{ id?: string; phoneNumber?: string; status?: string; platform?: string }> } };
      return (body.data?.lines ?? [])
        .filter((line) => line.platform === "imessage" && line.id && line.phoneNumber)
        .map((line) => ({
          id: line.id!,
          phoneNumber: line.phoneNumber!,
          status: line.status === "available" || line.status === "unavailable" ? line.status : "unknown",
        }));
    },
    async listWebhooks() {
      const body = (await call(`${root}/webhooks/`)) as { data?: Array<{ id?: string; webhookUrl?: string; status?: string }> };
      const rows = Array.isArray(body.data) ? body.data : [];
      return rows.filter((row) => row.id && row.webhookUrl).map((row) => ({ id: row.id!, webhookUrl: row.webhookUrl!, ...(row.status ? { status: row.status } : {}) }));
    },
    async registerWebhook(url) {
      const result = await call(
        `${root}/webhooks/`,
        { method: "POST", body: JSON.stringify({ webhookUrl: url, schemaVersion: "normalized-events.v1", eventTypes: ["message.received"] }) },
        [409],
      );
      const wrapped = result as { __status?: number; data?: { id?: string; signingSecret?: string; standardSigningSecret?: string } };
      if (wrapped.__status === 409) throw new MessagingError("PHOTON_WEBHOOK_EXISTS", "That incoming-message address is already registered.");
      const data = wrapped.data;
      if (!data?.id || !data.signingSecret || !data.standardSigningSecret) throw new MessagingError("PHOTON_REJECTED", "Photon didn't return the incoming-message secret.");
      return { id: data.id, signingSecret: data.signingSecret, standardSigningSecret: data.standardSigningSecret };
    },
    async deleteWebhook(id) {
      await call(`${root}/webhooks/${encodeURIComponent(id)}`, { method: "DELETE" });
    },
    async rotateStandardSecret(id) {
      const body = (await call(`${root}/webhooks/${encodeURIComponent(id)}/secret/rotate`, { method: "POST" })) as { data?: { standardSigningSecret?: string } };
      if (!body.data?.standardSigningSecret) throw new MessagingError("PHOTON_REJECTED", "Photon didn't return a new incoming-message secret.");
      return { standardSigningSecret: body.data.standardSigningSecret };
    },
    sendText(input) {
      return sendPhotonText(credentials, input);
    },
  };
}
