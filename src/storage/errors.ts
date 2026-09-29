/** Failures of the canonical record store. Business code branches on these; it never sees Google errors. */

export class StorageError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export class StorageUnavailableError extends StorageError {
  constructor(message = "Tour records can't be saved right now.") {
    super("STORAGE_UNAVAILABLE", message);
  }
}

export class StorageConflictError extends StorageError {
  constructor(message = "Those records were changed somewhere else. Nothing was overwritten.") {
    super("STORAGE_CONFLICT", message);
  }
}

export class SchemaVersionError extends StorageError {
  constructor(readonly found: number) {
    super("SCHEMA_VERSION", `A stored record uses schema version ${found}, which this Tour Core doesn't understand.`);
  }
}

export class StorageTornError extends StorageError {
  constructor(message = "A stored record doesn't match its index. It was not used.") {
    super("STORAGE_TORN", message);
  }
}

/** Another live Tour Core host holds the writer lease. */
export class StoreBusyError extends StorageError {
  constructor(message = "Another Tour Core installation appears to be using this storage.") {
    super("STORE_BUSY", message);
  }
}

export function isTransientStatus(status: number): boolean {
  return status === 408 || status === 429 || status === 500 || status === 502 || status === 503;
}
