import { DEMO_VERIFICATION_FORM_URL, type TourCoreConfig } from "./config/tourCoreConfig";
import { systemClock, type Clock } from "./core/clock";
import { TourCore, type TourCoreDeps } from "./core/TourCore";
import type { DurinAccessAdapter } from "./durin/DurinAccessAdapter";
import { MockDurinAccessAdapter } from "./durin/MockDurinAccessAdapter";
import { ConsoleMessenger, type Messenger } from "./messaging/Messenger";
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
  throw new UnavailableModeError("STORAGE_UNAVAILABLE", "Keeping records in Google Drive isn't available yet. Choose \"On this computer\" for now.");
}

export function createMessenger(config: TourCoreConfig, log?: Log): Messenger {
  if (config.messagingMode === "console") return new ConsoleMessenger(log);
  throw new UnavailableModeError("MESSAGING_UNAVAILABLE", "Sending real text messages isn't available yet. Choose demo messaging for now.");
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
