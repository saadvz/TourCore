export const REVIEW_KINDS = [
  "stale-source",
  "airbnb-exception",
  "same-day-capacity",
  "missed-reminder",
  "conflicting-replies",
  "failed-sms",
  "uncertain-sms",
  "shared-chat-routing",
  "possible-code-exposure",
] as const;

export type ReviewKind = (typeof REVIEW_KINDS)[number];

export type ReviewStatus = "open" | "resolved";

export interface ReviewItem {
  id: string;
  kind: ReviewKind;
  subject: string;
  status: ReviewStatus;
  at: string;
  version: number;
}

export interface AuditEvent {
  actor: string;
  source: string;
  version: number;
  reason: string;
  at: string;
  action: string;
}

export function isReviewKind(value: string): value is ReviewKind {
  return (REVIEW_KINDS as readonly string[]).includes(value);
}

/** Host-facing review alerts. None of these repeat a door code or a full phone number. */
export function reviewAlert(kind: ReviewKind, address: string): string {
  switch (kind) {
    case "stale-source":
      return `The booking feed for ${address} is stale, so I did not offer a new cleaning or send the door code. I will use the feed again after a fresh read.`;
    case "airbnb-exception":
      return `I saved a manual Airbnb booking exception for ${address}. I did not change the cleaning until you confirm it.`;
    case "same-day-capacity":
      return `Same-day cleaning at ${address} may be too tight. I saved it for your review and did not add another offer.`;
    case "missed-reminder":
      return `A cleaning reminder for ${address} did not go out. I saved it for your review.`;
    case "conflicting-replies":
      return `I got conflicting replies about the cleaning at ${address}. I did not change the job.`;
    case "failed-sms":
      return `A text failed to send. I saved it for your review and did not count it as delivered.`;
    case "uncertain-sms":
      return `A text may not have gone out. I did not send it again. Please check, then tell me if I should retry.`;
    case "shared-chat-routing":
      return `I could not tell who should get the cleaning texts at ${address}. I did not start a group or send the door code.`;
    case "possible-code-exposure":
      return `A text may include the door code. I saved it for your review and did not repeat the digits.`;
  }
}

/** Host-facing rotation and offboarding steps. The demo does not change the lock. */
export function codeHandlingText(address: string): string {
  return `To change the outdoor code at ${address}, set the new code on the lock yourself, then tell me the new code in a private text. I store only a sealed reference. I do not change the lock. To offboard a cleaner, reply STOP from their number or tell me to remove them. I will not send the code again until you confirm a new cleaner and the guests have left.`;
}

export const HEALTH_NOTE = "Cleaner Core health. This check does not send texts.";

export function reviewId(kind: ReviewKind, subject: string): string {
  return `review:${kind}:${subject}`;
}
