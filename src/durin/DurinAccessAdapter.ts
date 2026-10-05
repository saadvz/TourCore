/**
 * The only way Tour Core touches physical access. Tour Core is built on the
 * Durin Access Platform: it asks Durin for a scoped, time-boxed grant on one
 * of its own door ids; Durin owns the mapping to real hardware. Tour Core
 * never unlocks anything itself.
 */
export interface DurinAccessAdapter {
  requestAccess(request: DurinAccessRequest): Promise<DurinAccessResult>;
  revokeAccess(request: DurinRevokeRequest): Promise<void>;
  getHealth(): Promise<DurinHealth>;
}

export interface DurinAccessRequest {
  reservationId: string;
  prospectId: string;
  /** Tour Core door id, e.g. "entrance". */
  doorId: string;
  validFrom: string;
  validUntil: string;
  /** Same key => same grant. Lets retries be safe end to end. */
  idempotencyKey: string;
}

export type DurinAccessResult = { ok: true; grantRef: string } | { ok: false; reason: string };

export interface DurinRevokeRequest {
  reservationId: string;
  doorId: string;
  grantRef: string;
}

export interface DurinHealth {
  healthy: boolean;
  checkedAt: string;
  detail?: string;
}
