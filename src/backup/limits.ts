/**
 * Restore upload cap. A real installation backup is about 10 MB; 50 MB
 * leaves room for that file and for the backup to grow.
 * Override with TOURCORE_RESTORE_UPLOAD_MAX_BYTES.
 */
export const RESTORE_UPLOAD_MAX_BYTES = 50_000_000;

const ENV = "TOURCORE_RESTORE_UPLOAD_MAX_BYTES";

/** Bytes accepted on the restore upload. Invalid values keep the default. */
export function restoreUploadMaxBytes(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[ENV]?.trim();
  if (!raw || !/^[1-9]\d*$/.test(raw)) return RESTORE_UPLOAD_MAX_BYTES;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : RESTORE_UPLOAD_MAX_BYTES;
}

/**
 * Plain size for the assistant to relay. Decimal megabytes, rounded down:
 * 50_000_000 is "50 MB" and 1_000_000 is "1 MB".
 */
export function restoreUploadLimitLabel(bytes: number): string {
  const mb = Math.floor(bytes / 1_000_000);
  if (mb > 0) return `${mb} MB`;
  return `${bytes} bytes`;
}

export function restoreUploadTooLargeMessage(bytes: number = restoreUploadMaxBytes()): string {
  const cap = restoreUploadLimitLabel(bytes);
  return `That file is too big to restore. Backups can be up to ${cap}, so check that it's the Tour Core backup file and try again.`;
}

export class RestoreUploadTooLargeError extends Error {
  readonly maxBytes: number;
  constructor(maxBytes: number = restoreUploadMaxBytes()) {
    super(restoreUploadTooLargeMessage(maxBytes));
    this.name = "RestoreUploadTooLargeError";
    this.maxBytes = maxBytes;
  }
}
