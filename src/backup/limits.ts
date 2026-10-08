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

/** Plain size for the assistant to relay, such as "50 MB" or "1 MB". */
export function restoreUploadLimitLabel(bytes: number): string {
  const mib = bytes / (1024 * 1024);
  if (Number.isInteger(mib)) return `${mib} MB`;
  const mb = bytes / 1_000_000;
  if (Number.isInteger(mb)) return `${mb} MB`;
  return `${bytes} bytes`;
}

export function restoreUploadTooLargeMessage(bytes: number = restoreUploadMaxBytes()): string {
  return `That backup is too large to restore. The limit is ${restoreUploadLimitLabel(bytes)}.`;
}

export class RestoreUploadTooLargeError extends Error {
  readonly maxBytes: number;
  constructor(maxBytes: number = restoreUploadMaxBytes()) {
    super(restoreUploadTooLargeMessage(maxBytes));
    this.name = "RestoreUploadTooLargeError";
    this.maxBytes = maxBytes;
  }
}
