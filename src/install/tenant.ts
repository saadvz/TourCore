import type { InstallationFiles, InstallState } from "./manifest";

/**
 * HOSTED_RAILWAY_P0 is one demo installation. The installation id is the
 * tenant key a future Marketplace service will resolve before any business
 * read. This milestone does not isolate a second landlord.
 *
 * The first approved operator client is bound to that installation. A
 * different client is refused. Reconnects of the same client are allowed.
 * Clearing the binding is an explicit distributor action
 * (TOURCORE_HOSTED_TENANT_RESET=reset-demo-tenant) and does not delete
 * Drive records.
 */

export const HOSTED_TENANT_RESET = "reset-demo-tenant";

export const SECOND_TENANT_MESSAGE =
  "This hosted Tour Core demo already belongs to one installation. A second account isn't supported here. Marketplace publication requires tenant isolation.";

export function hostedTenantDecision(state: InstallState, clientId: string): { allowed: true } | { allowed: false; message: string } {
  const bound = state.hostedTenant?.clientId;
  if (!bound || bound === clientId) return { allowed: true };
  return { allowed: false, message: SECOND_TENANT_MESSAGE };
}

export function bindHostedTenant(files: InstallationFiles, clientId: string, now: Date): void {
  const state = files.state();
  if (state.hostedTenant?.clientId) return;
  files.writeState({ ...state, hostedTenant: { clientId, boundAt: now.toISOString() } });
}

export function clearHostedTenant(files: InstallationFiles): boolean {
  const state = files.state();
  if (!state.hostedTenant) return false;
  const next = { ...state };
  delete next.hostedTenant;
  files.writeState(next);
  return true;
}
