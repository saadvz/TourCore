import { chmodSync, existsSync, readFileSync, statSync } from "node:fs";
import { writeJsonAtomic } from "../storage/atomicWrite";

/**
 * Where provider credentials live. Values are written here only by the
 * secure setup page on the Tour Core computer (or a developer's `.env`), and
 * are read only by the adapters that need them. They never appear in the
 * installation manifest, MCP arguments or results, audit, exports or logs.
 *
 * Each setting has a stable environment-variable name so `.env` keeps working
 * for developers; a value saved through secure setup takes precedence.
 */

export const SETTINGS = {
  SENDBLUE_API_API_KEY: { secret: true },
  SENDBLUE_API_API_SECRET: { secret: true },
  SENDBLUE_WEBHOOK_SECRET: { secret: true },
  /** The texting number; not a credential, but entered with the Sendblue account. */
  SENDBLUE_FROM_NUMBER: { secret: false },
  /** Grok Routine webhook address. Treated as a secret: it's a capability to wake the routine. */
  TOURCORE_GROK_ROUTINE_URL: { secret: true },
  TOURCORE_GROK_ROUTINE_KEY: { secret: true },
} as const satisfies Record<string, { secret: boolean }>;

export type SettingName = keyof typeof SETTINGS;
export const SETTING_NAMES = Object.keys(SETTINGS) as SettingName[];
export const SECRET_SETTING_NAMES = SETTING_NAMES.filter((n) => SETTINGS[n].secret);

/** Environment-only secrets that also must never leave Tour Core. */
export const OTHER_SECRET_ENV = ["TOURCORE_OPERATOR_TOKEN", "TOURCORE_INTENT_MODEL_KEY"] as const;

export interface SecretStore {
  get(name: SettingName): string | undefined;
  /** Saves the given values; blank values are ignored (use `delete` to remove). */
  set(values: Partial<Record<SettingName, string>>, now?: Date): void;
  delete(names: SettingName[], now?: Date): void;
  /** When each stored value was last changed. No values. */
  updatedAt(name: SettingName): string | undefined;
}

interface SecretFile {
  schemaVersion: 1;
  values: Partial<Record<SettingName, string>>;
  updatedAt: Partial<Record<SettingName, string>>;
}

const empty = (): SecretFile => ({ schemaVersion: 1, values: {}, updatedAt: {} });

/**
 * One JSON file inside the git-ignored runtime folder, readable only by the
 * account running Tour Core where the file system supports it. Read on every
 * use so a value saved by the secure setup page takes effect immediately.
 */
export class LocalSecretStore implements SecretStore {
  /** Re-read only when the file changes; adapters look settings up on every request. */
  private cached?: { stamp: string; doc: SecretFile };

  constructor(
    readonly path: string,
    private readonly clock: () => number = Date.now,
  ) {}

  private read(): SecretFile {
    if (!existsSync(this.path)) return empty();
    const { mtimeMs, size } = statSync(this.path);
    const stamp = `${mtimeMs}:${size}`;
    if (this.cached?.stamp === stamp) return structuredClone(this.cached.doc);
    try {
      const raw = JSON.parse(readFileSync(this.path, "utf8")) as SecretFile;
      const doc: SecretFile = { schemaVersion: 1, values: raw.values ?? {}, updatedAt: raw.updatedAt ?? {} };
      this.cached = { stamp, doc };
      return structuredClone(doc);
    } catch {
      throw new Error("The saved provider settings couldn't be read. Re-enter them on the secure setup page.");
    }
  }

  private write(doc: SecretFile): void {
    this.cached = undefined;
    writeJsonAtomic(this.path, doc);
    try {
      chmodSync(this.path, 0o600);
    } catch {
      // Not every file system has POSIX permissions (e.g. Windows); the folder is still git-ignored.
    }
  }

  get(name: SettingName): string | undefined {
    return this.read().values[name]?.trim() || undefined;
  }

  set(values: Partial<Record<SettingName, string>>, now = new Date(this.clock())): void {
    const doc = this.read();
    for (const [name, value] of Object.entries(values) as [SettingName, string | undefined][]) {
      if (!(name in SETTINGS)) throw new Error(`Unknown provider setting ${name}.`);
      const clean = value?.trim();
      if (!clean) continue;
      doc.values[name] = clean;
      doc.updatedAt[name] = now.toISOString();
    }
    this.write(doc);
  }

  delete(names: SettingName[], now = new Date(this.clock())): void {
    const doc = this.read();
    for (const name of names) {
      delete doc.values[name];
      doc.updatedAt[name] = now.toISOString();
    }
    this.write(doc);
  }

  updatedAt(name: SettingName): string | undefined {
    return this.read().updatedAt[name];
  }
}

/** Same contract, memory only. For tests. */
export class MemorySecretStore implements SecretStore {
  private readonly doc = empty();

  get(name: SettingName): string | undefined {
    return this.doc.values[name];
  }

  set(values: Partial<Record<SettingName, string>>, now = new Date()): void {
    for (const [name, value] of Object.entries(values) as [SettingName, string | undefined][]) {
      const clean = value?.trim();
      if (!clean) continue;
      this.doc.values[name] = clean;
      this.doc.updatedAt[name] = now.toISOString();
    }
  }

  delete(names: SettingName[], now = new Date()): void {
    for (const name of names) {
      delete this.doc.values[name];
      this.doc.updatedAt[name] = now.toISOString();
    }
  }

  updatedAt(name: SettingName): string | undefined {
    return this.doc.updatedAt[name];
  }
}
