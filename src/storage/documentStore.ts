import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { SchemaVersionError, StorageConflictError } from "./errors";

/** Every canonical document this process understands. Unknown versions fail closed. */
export const STORE_SCHEMA_VERSION = 1;

export interface StoredDocument {
  path: string;
  schemaVersion: number;
  kind: string;
  body: unknown;
  /** Changes whenever the body changes. Writers must send it back to update. */
  revision: string;
  sha256: string;
}

export interface PutOptions {
  schemaVersion: number;
  kind: string;
  /** Required when the path already exists. Omit only to create. */
  ifRevision?: string;
}

/**
 * Provider-neutral canonical documents. Async on purpose: a network store
 * must be awaited, never hidden behind a blocking wrapper.
 * Local demo and Google Drive both implement this.
 */
export interface DocumentStore {
  get(path: string): Promise<StoredDocument | undefined>;
  put(path: string, body: unknown, options: PutOptions): Promise<StoredDocument>;
  list(prefix?: string): Promise<StoredDocument[]>;
  delete(path: string, options?: { ifRevision?: string }): Promise<void>;
}

export function sha256Json(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

export function assertStoreSchema(version: number): void {
  if (version !== STORE_SCHEMA_VERSION) throw new SchemaVersionError(version);
}

interface MemoryEntry {
  schemaVersion: number;
  kind: string;
  body: unknown;
  revision: string;
  sha256: string;
}

/** In-process store for tests and for fakes of the contract. */
export class MemoryDocumentStore implements DocumentStore {
  private readonly docs = new Map<string, MemoryEntry>();

  async get(path: string): Promise<StoredDocument | undefined> {
    const doc = this.docs.get(path);
    return doc ? { path, ...structuredClone(doc) } : undefined;
  }

  async put(path: string, body: unknown, options: PutOptions): Promise<StoredDocument> {
    assertStoreSchema(options.schemaVersion);
    const current = this.docs.get(path);
    if (current) {
      if (!options.ifRevision || options.ifRevision !== current.revision) throw new StorageConflictError();
    } else if (options.ifRevision) {
      throw new StorageConflictError("That record is no longer there.");
    }
    const sha256 = sha256Json(body);
    const revision = randomUUID();
    const entry: MemoryEntry = { schemaVersion: options.schemaVersion, kind: options.kind, body: structuredClone(body), revision, sha256 };
    this.docs.set(path, entry);
    return { path, ...structuredClone(entry) };
  }

  async list(prefix = ""): Promise<StoredDocument[]> {
    return [...this.docs.entries()].filter(([path]) => path.startsWith(prefix)).map(([path, doc]) => ({ path, ...structuredClone(doc) }));
  }

  async delete(path: string, options?: { ifRevision?: string }): Promise<void> {
    const current = this.docs.get(path);
    if (!current) return;
    if (options?.ifRevision && options.ifRevision !== current.revision) throw new StorageConflictError();
    this.docs.delete(path);
  }
}

interface FileEnvelope {
  schemaVersion: number;
  kind: string;
  body: unknown;
  revision: string;
  sha256: string;
}

/**
 * LOCAL_DEMO documents on disk. Async filesystem calls, so the same contract
 * as Google Drive. Not a cache of Drive and not portable off this computer.
 */
export class LocalDocumentStore implements DocumentStore {
  constructor(readonly root: string) {}

  private file(path: string): string {
    if (path.includes("..") || path.startsWith("/") || path.includes("\\")) throw new StorageConflictError("That record path isn't allowed.");
    return join(this.root, path);
  }

  async get(path: string): Promise<StoredDocument | undefined> {
    try {
      const envelope = JSON.parse(await readFile(this.file(path), "utf8")) as FileEnvelope;
      assertStoreSchema(envelope.schemaVersion);
      if (envelope.sha256 !== sha256Json(envelope.body)) throw new StorageConflictError("A saved record didn't match its checksum.");
      return { path, ...envelope };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw err;
    }
  }

  async put(path: string, body: unknown, options: PutOptions): Promise<StoredDocument> {
    assertStoreSchema(options.schemaVersion);
    const current = await this.get(path);
    if (current) {
      if (!options.ifRevision || options.ifRevision !== current.revision) throw new StorageConflictError();
    } else if (options.ifRevision) throw new StorageConflictError("That record is no longer there.");
    const envelope: FileEnvelope = { schemaVersion: options.schemaVersion, kind: options.kind, body, revision: randomUUID(), sha256: sha256Json(body) };
    const target = this.file(path);
    await mkdir(dirname(target), { recursive: true });
    const text = JSON.stringify(envelope);
    JSON.parse(text);
    await writeFile(target, text);
    return { path, ...envelope };
  }

  async list(prefix = ""): Promise<StoredDocument[]> {
    const found: StoredDocument[] = [];
    const walk = async (dir: string, rel: string) => {
      let names: string[];
      try {
        names = await readdir(dir);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
        throw err;
      }
      for (const name of names) {
        const path = rel ? `${rel}/${name}` : name;
        const full = join(dir, name);
        if ((await stat(full)).isDirectory()) await walk(full, path);
        else if (path.startsWith(prefix)) {
          const doc = await this.get(path);
          if (doc) found.push(doc);
        }
      }
    };
    await walk(this.root, "");
    return found;
  }

  async delete(path: string, options?: { ifRevision?: string }): Promise<void> {
    const current = await this.get(path);
    if (!current) return;
    if (options?.ifRevision && options.ifRevision !== current.revision) throw new StorageConflictError();
    await rm(this.file(path), { force: true });
  }
}
