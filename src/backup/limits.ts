/**
 * Restore upload cap. A real installation backup is about 10 MB; 50 MB
 * leaves room for that file and for the backup to grow.
 */
export const RESTORE_UPLOAD_MAX_BYTES = 50 * 1024 * 1024;

const ENV = "TOURCORE_RESTORE_UPLOAD_MAX_BYTES";

/** Bytes accepted on the restore upload. Invalid values keep the default. */
export function restoreUploadMaxBytes(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[ENV]?.trim();
  if (!raw || !/^[1-9]\d*$/.test(raw)) return RESTORE_UPLOAD_MAX_BYTES;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : RESTORE_UPLOAD_MAX_BYTES;
}

/**
 * Plain size for the assistant to relay. An exact decimal megabyte stays
 * "1 MB". An exact mebibyte that is not a decimal megabyte is "50 MiB",
 * so the default cap is not labeled as 50 MB.
 */
export function restoreUploadLimitLabel(bytes: number): string {
  const mb = bytes / 1_000_000;
  if (Number.isInteger(mb) && mb > 0) return `${mb} MB`;
  const mib = bytes / (1024 * 1024);
  if (Number.isInteger(mib) && mib > 0) return `${mib} MiB`;
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
