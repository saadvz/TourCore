import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { resolveSupportEmail } from "../core/email";
import { formatPhone, normalizePhone } from "../core/phone";
import { complianceLinkPair, publicBrandName } from "../web/compliance/config";
import { campaignConfirmation, campaignDisclosure, MESSAGE_RATES } from "../web/compliance/pages";
import { writeJsonAtomic } from "../storage/atomicWrite";

/**
 * SMS campaign consent is separate from the later tour/record consent.
 * A phone number, or an older tour, is not consent. Only an explicit keyword
 * event writes a record.
 */

export const SmsCampaignConsentSchema = z.object({
  sender: z.string(),
  status: z.enum(["pending", "opted_in", "opted_out"]),
  method: z.literal("keyword"),
  keyword: z.string().optional(),
  updatedAt: z.string(),
  optedInAt: z.string().optional(),
  optedOutAt: z.string().optional(),
});
export type SmsCampaignConsent = z.infer<typeof SmsCampaignConsentSchema>;
export type SmsConsentStatus = SmsCampaignConsent["status"];

const FileSchema = z.object({
  schemaVersion: z.literal(1),
  senders: z.record(z.string(), SmsCampaignConsentSchema),
});

export function smsStopAck(env: NodeJS.ProcessEnv = process.env): string {
  return `${publicBrandName(env)}: You're opted out and won't receive more messages. Reply START to opt back in. Reply HELP for help.`;
}
export const SMS_GATE_REMINDER = "Reply YES to continue, HELP for help, or STOP to opt out.";
export const SMS_KEYWORD_PROMPT = "Text TOUR to ask questions or schedule a self-guided tour. Reply HELP for help or STOP to opt out.";

export function smsDisclosure(publicBaseUrl: string | undefined, env: NodeJS.ProcessEnv = process.env): string {
  const links = complianceLinkPair(publicBaseUrl);
  return campaignDisclosure(links.privacy, links.terms, publicBrandName(env));
}

export function smsOptInConfirmation(env: NodeJS.ProcessEnv = process.env): string {
  return campaignConfirmation(publicBrandName(env));
}

/**
 * Visitor HELP text. The program name comes from TOURCORE_PUBLIC_BRAND_NAME.
 * The support address is the operator setting, with TOURCORE_PUBLIC_CONTACT_EMAIL
 * as a fallback only. Visitors never see env-var names or "not configured".
 */
export function smsHelpBody(
  env: NodeJS.ProcessEnv = process.env,
  contact: { supportEmail?: string; visitorContact?: string } = {},
): string {
  const email = resolveSupportEmail(contact.supportEmail, env);
  const number = contact.visitorContact ? formatPhone(contact.visitorContact) : undefined;
  const contacts = [...(number ? [`call ${number}`] : []), ...(email ? [`email ${email}`] : [])];
  const help =
    contacts.length === 0
      ? "For help with your property tour, reply here."
      : contacts.length === 1
        ? `For help with your property tour, ${contacts[0]} or reply here.`
        : `For help with your property tour, ${contacts.join(", ")}, or reply here.`;
  return `${publicBrandName(env)}: ${help} ${MESSAGE_RATES} Reply STOP to opt out.`;
}

/** Keyword campaign records for one property. Survives process and host restarts because it lives with the property files. */
export class SmsConsentDirectory {
  constructor(private readonly root: string) {}

  private file(propertyId: string): string {
    return join(this.root, "properties", propertyId, "sms-campaign-consent.json");
  }

  private legacyOptOuts(propertyId: string): string {
    return join(this.root, "properties", propertyId, "messaging-opt-outs.json");
  }

  get(propertyId: string, phone: string): SmsCampaignConsent | undefined {
    const sender = normalizePhone(phone);
    const saved = this.read(propertyId);
    if (saved === "unreadable") return optedOut(sender, new Date().toISOString());
    const found = saved?.senders[sender];
    if (found) return found;
    return this.legacyOptOut(propertyId, sender);
  }

  save(propertyId: string, record: SmsCampaignConsent): void {
    const sender = normalizePhone(record.sender);
    const current = this.read(propertyId);
    const senders = current && current !== "unreadable" ? { ...current.senders } : {};
    senders[sender] = { ...record, sender };
    writeJsonAtomic(this.file(propertyId), { schemaVersion: 1, senders });
  }

  private read(propertyId: string): z.infer<typeof FileSchema> | undefined | "unreadable" {
    const file = this.file(propertyId);
    if (!existsSync(file)) return undefined;
    try {
      const parsed = FileSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
      return parsed.success ? parsed.data : "unreadable";
    } catch {
      return "unreadable";
    }
  }

  /** An older STOP file is an explicit opt-out. It is never read as opt-in. */
  private legacyOptOut(propertyId: string, sender: string): SmsCampaignConsent | undefined {
    const file = this.legacyOptOuts(propertyId);
    if (!existsSync(file)) return undefined;
    try {
      const map = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
      const at = map[sender];
      if (typeof at !== "string") return undefined;
      return optedOut(sender, at);
    } catch {
      return optedOut(sender, new Date().toISOString());
    }
  }
}

function optedOut(sender: string, at: string): SmsCampaignConsent {
  return { sender, status: "opted_out", method: "keyword", keyword: "STOP", updatedAt: at, optedOutAt: at };
}
