import { z } from "zod";
import type { Prospect } from "../domain/model";
import { normalizePhone } from "../core/phone";

/**
 * Shape of one completed "basic identity" form response. The demo simulates
 * it; the next iteration maps a real Google Form response onto this schema.
 * It records who the visitor says they are. It does not prove identity.
 */
export const BasicFormResponseSchema = z.object({
  responseId: z.string().min(1),
  submittedAt: z.iso.datetime({ offset: true }),
  answers: z.object({
    governmentFirstName: z.string().trim().min(1),
    governmentLastName: z.string().trim().min(1),
    email: z.email(),
    phone: z.string().trim().min(7),
  }),
});
export type BasicFormResponse = z.infer<typeof BasicFormResponseSchema>;

export type VerificationOutcome =
  | { passed: true; reference: string; claimed: { firstName: string; lastName: string; email: string; phone: string } }
  | { passed: false; reference: string; reason: string };

export interface VerificationProvider {
  readonly method: "basic-form" | "mock";
  /** True when no visitor action is needed; Tour Core completes the check itself. */
  readonly automatic: boolean;
  /** What the visitor is told when the check is requested. */
  requestText(prospect: Prospect): string;
  evaluate(submission: unknown, prospect: Prospect): VerificationOutcome;
}

export class BasicFormVerification implements VerificationProvider {
  readonly method = "basic-form" as const;
  readonly automatic = false;
  constructor(private readonly formUrl: string) {}

  linkFor(prospect: Prospect): string {
    return `${this.formUrl}?ref=${encodeURIComponent(prospect.id)}`;
  }

  requestText(prospect: Prospect): string {
    return `Thanks! One last step before your tour: please fill out this short form with your legal name, email and phone.\n${this.linkFor(prospect)}`;
  }

  evaluate(submission: unknown, prospect: Prospect): VerificationOutcome {
    const parsed = BasicFormResponseSchema.safeParse(submission);
    const reference = typeof (submission as { responseId?: unknown })?.responseId === "string"
      ? (submission as { responseId: string }).responseId
      : "unknown";
    if (!parsed.success) return { passed: false, reference, reason: "form response is incomplete or invalid" };

    const { answers } = parsed.data;
    if (normalizePhone(answers.phone) !== prospect.phone) {
      return { passed: false, reference, reason: "phone number on the form does not match the texting number" };
    }
    return {
      passed: true,
      reference: parsed.data.responseId,
      claimed: {
        firstName: answers.governmentFirstName,
        lastName: answers.governmentLastName,
        email: answers.email,
        phone: normalizePhone(answers.phone),
      },
    };
  }
}

/** Everyone passes. For trying Tour Core out; never for real visitors. */
export class PracticeVerification implements VerificationProvider {
  readonly method = "mock" as const;
  readonly automatic = true;

  requestText(): string {
    return "Thanks! This is a practice setup, so there's no ID step. You're checked in automatically.";
  }

  evaluate(_submission: unknown, prospect: Prospect): VerificationOutcome {
    const [firstName = prospect.name, ...rest] = prospect.name.trim().split(/\s+/);
    return {
      passed: true,
      reference: `practice_${prospect.id}`,
      claimed: { firstName, lastName: rest.join(" "), email: "", phone: prospect.phone },
    };
  }
}
