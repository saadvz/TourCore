import { parsePhone } from "../core/phone";
import { twilioHttpClient, type TwilioClient } from "../messaging/twilio/client";
import { GroupNotConfirmed } from "./groupThread";

/** Off unless CLEANER_CORE_LIVE_SMS is exactly "1" or "true". */
export function liveSmsOn(env: NodeJS.ProcessEnv): boolean {
  const raw = env.CLEANER_CORE_LIVE_SMS?.trim().toLowerCase();
  return raw === "1" || raw === "true";
}

export function smsAllowlist(env: NodeJS.ProcessEnv): string[] {
  const raw = env.CLEANER_CORE_SMS_ALLOWLIST ?? "";
  const phones: string[] = [];
  for (const part of raw.split(",")) {
    const phone = parsePhone(part.trim());
    if (phone) phones.push(phone);
  }
  return phones;
}

export function isAllowlisted(env: NodeJS.ProcessEnv, phone: string): boolean {
  const parsed = parsePhone(phone);
  if (!parsed) return false;
  return smsAllowlist(env).includes(parsed);
}

let clientOverride: TwilioClient | undefined;

/** Tests replace the Cleaner Core Twilio client. Unset uses the account in the environment. */
export function setCleanerTwilioClient(client: TwilioClient | undefined): void {
  clientOverride = client;
}

export function cleanerTwilioClient(env: NodeJS.ProcessEnv): TwilioClient {
  if (clientOverride) return clientOverride;
  const accountSid = env.CLEANER_CORE_TWILIO_ACCOUNT_SID?.trim();
  const authToken = env.CLEANER_CORE_TWILIO_AUTH_TOKEN?.trim();
  if (!accountSid || !authToken) throw new Error("not sent");
  return twilioHttpClient({ accountSid, authToken });
}

export const CLEANER_PIN_STATUS_PATH = "/webhooks/twilio/cleaner-core/status";

export function cleanerPinStatusUrl(env: NodeJS.ProcessEnv): string | undefined {
  const base = env.PUBLIC_BASE_URL?.trim().replace(/\/$/, "");
  if (!base) return undefined;
  return `${base}${CLEANER_PIN_STATUS_PATH}`;
}

/** Sends one text when live texts are on and the number is allowed. A failed Twilio status throws. */
export async function sendLiveSms(env: NodeJS.ProcessEnv, text: { to: string; body: string; statusCallback?: string }): Promise<string | undefined> {
  if (!liveSmsOn(env) || !isAllowlisted(env, text.to)) return undefined;
  const from = parsePhone(env.CLEANER_CORE_TWILIO_PHONE_NUMBER ?? "");
  if (!from) throw new Error("not sent");
  const result = await cleanerTwilioClient(env).sendSms({
    to: text.to,
    from,
    body: text.body,
    ...(text.statusCallback ? { statusCallback: text.statusCallback } : {}),
  });
  const status = (result.status ?? "").toLowerCase();
  if (status === "failed" || status === "undelivered" || status === "canceled") throw new Error("not sent");
  return result.sid;
}

let groupFetch: typeof fetch | undefined;

export function setCleanerGroupFetch(impl: typeof fetch | undefined): void {
  groupFetch = impl;
}

const CONVERSATIONS_ROOT = "https://conversations.twilio.com/v1";

interface BoundMember {
  sid: string;
  address: string;
}

export async function sendLiveGroup(
  env: NodeJS.ProcessEnv,
  input: { audience: string[]; body: string; conversationSid?: string },
): Promise<{ sid?: string; conversationSid?: string } | undefined> {
  if (!liveSmsOn(env)) return undefined;
  const allow = smsAllowlist(env);
  if (allow.length === 0) return undefined;
  const audience = [...new Set(input.audience.map((phone) => parsePhone(phone)).filter((phone): phone is string => Boolean(phone)))];
  if (audience.length === 0 || audience.some((phone) => !allow.includes(phone))) return undefined;
  const accountSid = env.CLEANER_CORE_TWILIO_ACCOUNT_SID?.trim();
  const authToken = env.CLEANER_CORE_TWILIO_AUTH_TOKEN?.trim();
  const from = parsePhone(env.CLEANER_CORE_TWILIO_PHONE_NUMBER ?? "");
  if (!accountSid || !authToken || !from) throw new Error("not sent");
  const fetchImpl = groupFetch ?? fetch;
  const auth = `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString("base64")}`;
  const conversationSid = await openConversation(fetchImpl, auth, input.conversationSid);
  await reconcileMembers(fetchImpl, auth, conversationSid, audience, from);
  const message = await postFields(fetchImpl, auth, `${CONVERSATIONS_ROOT}/Conversations/${encodeURIComponent(conversationSid)}/Messages`, {
    Body: input.body,
    Author: from,
  });
  if (!message.sid) throw new Error("not sent");
  return { sid: message.sid, conversationSid };
}

async function openConversation(fetchImpl: typeof fetch, auth: string, existing: string | undefined): Promise<string> {
  if (existing) return existing;
  try {
    const created = await postFields(fetchImpl, auth, `${CONVERSATIONS_ROOT}/Conversations`, { FriendlyName: "Cleaning group" });
    if (!created.sid) throw new GroupNotConfirmed();
    return created.sid;
  } catch (err) {
    if (err instanceof GroupNotConfirmed) throw err;
    throw new GroupNotConfirmed();
  }
}

async function reconcileMembers(fetchImpl: typeof fetch, auth: string, conversationSid: string, wanted: string[], from: string): Promise<void> {
  const wantedSet = new Set(wanted);
  const current = await listMembers(fetchImpl, auth, conversationSid);
  const seen = new Set<string>();
  for (const person of current) {
    if (wantedSet.has(person.address) && !seen.has(person.address)) {
      seen.add(person.address);
      continue;
    }
    await removeMember(fetchImpl, auth, conversationSid, person.sid);
  }
  for (const phone of wanted) {
    if (seen.has(phone)) continue;
    await addMember(fetchImpl, auth, conversationSid, phone, from);
  }
  const confirmed = await listMembers(fetchImpl, auth, conversationSid);
  const addresses = confirmed.map((person) => person.address);
  const matched = confirmed.length === wanted.length && new Set(addresses).size === wanted.length && addresses.every((phone) => wantedSet.has(phone));
  if (!matched) throw new GroupNotConfirmed(conversationSid);
}

async function listMembers(fetchImpl: typeof fetch, auth: string, conversationSid: string): Promise<BoundMember[]> {
  const found: BoundMember[] = [];
  let url: string | undefined = `${CONVERSATIONS_ROOT}/Conversations/${encodeURIComponent(conversationSid)}/Participants?PageSize=50`;
  const seen = new Set<string>();
  while (url) {
    if (seen.has(url) || !url.startsWith("https://conversations.twilio.com/")) throw new GroupNotConfirmed(conversationSid);
    seen.add(url);
    let res: Response;
    try {
      res = await fetchImpl(url, { method: "GET", headers: { Authorization: auth } });
    } catch {
      throw new GroupNotConfirmed(conversationSid);
    }
    if (!res.ok) throw new GroupNotConfirmed(conversationSid);
    const body = (await res.json().catch(() => undefined)) as {
      participants?: { sid?: string; messaging_binding?: { address?: string } }[];
      meta?: { next_page_url?: string | null };
    } | undefined;
    if (!body || !Array.isArray(body.participants)) throw new GroupNotConfirmed(conversationSid);
    for (const item of body.participants) {
      const address = parsePhone(item.messaging_binding?.address ?? "");
      if (!item.sid || !address) throw new GroupNotConfirmed(conversationSid);
      found.push({ sid: item.sid, address });
    }
    const next = body.meta?.next_page_url;
    url = typeof next === "string" && next.length > 0 ? next : undefined;
  }
  return found;
}

async function addMember(fetchImpl: typeof fetch, auth: string, conversationSid: string, phone: string, from: string): Promise<void> {
  const url = `${CONVERSATIONS_ROOT}/Conversations/${encodeURIComponent(conversationSid)}/Participants`;
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: "POST",
      headers: { Authorization: auth, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ "MessagingBinding.Address": phone, "MessagingBinding.ProxyAddress": from }).toString(),
    });
  } catch {
    throw new GroupNotConfirmed(conversationSid);
  }
  if (res.ok || res.status === 409) return;
  throw new GroupNotConfirmed(conversationSid);
}

async function removeMember(fetchImpl: typeof fetch, auth: string, conversationSid: string, participantSid: string): Promise<void> {
  const url = `${CONVERSATIONS_ROOT}/Conversations/${encodeURIComponent(conversationSid)}/Participants/${encodeURIComponent(participantSid)}`;
  let res: Response;
  try {
    res = await fetchImpl(url, { method: "DELETE", headers: { Authorization: auth } });
  } catch {
    throw new GroupNotConfirmed(conversationSid);
  }
  if (res.ok || res.status === 404) return;
  throw new GroupNotConfirmed(conversationSid);
}

async function postFields(fetchImpl: typeof fetch, auth: string, url: string, fields: Record<string, string>): Promise<{ sid?: string }> {
  const res = await fetchImpl(url, {
    method: "POST",
    headers: { Authorization: auth, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
  });
  if (!res.ok) throw new Error("not sent");
  return (await res.json()) as { sid?: string };
}
