import { DEMO_VERIFICATION_FORM_URL, type TourCoreConfig } from "./config/tourCoreConfig";
import { systemClock, type Clock } from "./core/clock";
import { TourCore, type TourCoreDeps } from "./core/TourCore";
import type { DurinAccessAdapter } from "./durin/DurinAccessAdapter";
import { MockDurinAccessAdapter } from "./durin/MockDurinAccessAdapter";
import { DemoMessagingAdapter, type Messenger } from "./messaging/Messenger";
import type { MessagingLedger } from "./messaging/ledger";
import { SendblueMessagingAdapter } from "./messaging/sendblue/adapter";
import { checkSendblue, type MessagingCheck } from "./messaging/sendblue/readiness";
import { sendblueRuntime } from "./messaging/sendblue/runtime";
import { InMemoryStore, type TourCoreStore } from "./storage/Store";
import { BasicFormVerification, PracticeVerification, type VerificationProvider } from "./verification/basicForm";

/** A configured choice this build can't run yet. Message is operator-facing. */
export class UnavailableModeError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

type Log = (line: string) => void;

// Each config mode maps to an adapter here and nowhere else.

export function createStore(config: TourCoreConfig): TourCoreStore {
  if (config.storageMode === "memory") return new InMemoryStore();
  throw new UnavailableModeError("STORAGE_UNAVAILABLE", "Google Drive is connected for the whole installation, not as a per-property mode. Tour records follow the installation storage setting.");
}

export function createMessenger(config: TourCoreConfig, log?: Log, options: { ledger?: MessagingLedger } = {}): Messenger {
  if (config.messagingMode === "demo") return new DemoMessagingAdapter(log);
  return createLiveMessagingTransport(options.ledger);
}

/** The real-phone transport (Sendblue today), created from the environment when the first message needs it. */
export function createLiveMessagingTransport(ledger?: MessagingLedger): SendblueMessagingAdapter {
  const env = sendblueRuntime.env();
  if (!env.apiKey || !env.apiSecret || !env.fromNumber) {
    throw new UnavailableModeError("SENDBLUE_NOT_CONFIGURED", "Visitor messaging isn't connected yet: Sendblue isn't set up on this computer.");
  }
  return new SendblueMessagingAdapter({ client: sendblueRuntime.client(env), fromNumber: env.fromNumber, ledger });
}

/** Whether the chosen messaging can reach visitors, as plain-language checks. Demo messaging always can. */
export async function checkMessaging(config: TourCoreConfig): Promise<MessagingCheck[]> {
  if (config.messagingMode === "demo") return [];
  return checkSendblue();
}

export function createVerificationProvider(config: TourCoreConfig): VerificationProvider {
  if (config.verificationMode === "basic-form") return new BasicFormVerification(config.verificationFormUrl ?? DEMO_VERIFICATION_FORM_URL);
  if (config.verificationMode === "mock") return new PracticeVerification();
  throw new UnavailableModeError("VERIFICATION_UNAVAILABLE", "Full ID checks aren't available yet. Choose the basic identity form or practice verification.");
}

export function createDurin(config: TourCoreConfig, clock: Clock, log?: Log): DurinAccessAdapter {
  if (config.accessMode === "durin-mock") {
    return new MockDurinAccessAdapter({
      doorNames: Object.fromEntries(config.doors.map((d) => [d.id, d.name])),
      timeZone: config.property.timezone,
      now: () => clock.now(),
      log,
    });
  }
  throw new UnavailableModeError("ACCESS_UNAVAILABLE", "Real door access through Durin isn't available yet. Choose Durin demo mode for now.");
}

export function createTourCore(config: TourCoreConfig, overrides: Partial<TourCoreDeps> = {}): TourCore {
  const clock = overrides.clock ?? systemClock;
  return new TourCore({
    config,
    clock,
    store: overrides.store ?? createStore(config),
    messenger: overrides.messenger ?? createMessenger(config),
    verification: overrides.verification ?? createVerificationProvider(config),
    durin: overrides.durin ?? createDurin(config, clock),
  });
}
