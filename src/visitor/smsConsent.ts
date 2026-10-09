import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { formatPhone, normalizePhone } from "../core/phone";
import { visitorTeamName } from "../sms/templates";
import { complianceLinkPair, publicBrandName } from "../web/compliance/config";
import { campaignConfirmation, campaignDisclosure, MESSAGE_RATES } from "../web/compliance/pages";
import { writeJsonAtomic } from "../storage/atomicWrite";

/**
 * SMS campaign consent. A phone number, or an older tour, is not consent.
 * Only an explicit keyword event writes a record. That YES also covers
 * messages about the tour and a record of the visit.
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

/**
 * The line that replaces "Reply YES..." when START arrives on a draft-only
 * line. Same help-number choice as the not-ready reply. The rest of the
 * disclosure stays as it is.
 */
export function draftStartLine(team?: string, visitorContact?: string): string {
  const number = visitorContact?.trim() ? formatPhone(visitorContact.trim()) : undefined;
  if (number) {
    return `Tours by text aren't available right now. You can call the ${visitorTeamName(team)} at ${number}. Reply HELP for help or STOP to opt out.`;
  }
  return `Tours by text aren't available right now. Please check back soon. Reply HELP for help or STOP to opt out.`;
}

export function draftStartDisclosure(
  publicBaseUrl: string | undefined,
  team?: string,
  visitorContact?: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return smsDisclosure(publicBaseUrl, env).replace(SMS_GATE_REMINDER, draftStartLine(team, visitorContact));
}

export function smsOptInConfirmation(env: NodeJS.ProcessEnv = process.env): string {
  return campaignConfirmation(publicBrandName(env));
}

/**
 * Visitor HELP text. The program name comes from TOURCORE_PUBLIC_BRAND_NAME.
 * Lists the visitor help number when set, then always "or reply here".
 * Visitors never see env-var names, email, or "not configured".
 */
export function smsHelpBody(
  env: NodeJS.ProcessEnv = process.env,
  contact: { visitorContact?: string } = {},
): string {
  const number = contact.visitorContact ? formatPhone(contact.visitorContact) : undefined;
  const help = number
    ? `For help with your property tour, call ${number} or reply here.`
    : "For help with your property tour, reply here.";
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
