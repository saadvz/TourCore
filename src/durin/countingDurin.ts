import type { DurinAccessAdapter } from "./DurinAccessAdapter";

export type CountingDurin = DurinAccessAdapter & { readonly requestCount: number; readonly revokeCount: number };

/** Wraps any Durin adapter so demos and tests can prove when Durin was (not) asked to open a door. */
export function countDurinCalls(inner: DurinAccessAdapter): CountingDurin {
  let requests = 0;
  let revokes = 0;
  return {
    get requestCount() {
      return requests;
    },
    get revokeCount() {
      return revokes;
    },
    requestAccess(req) {
      requests++;
      return inner.requestAccess(req);
    },
    revokeAccess(req) {
      revokes++;
      return inner.revokeAccess(req);
    },
    getHealth: () => inner.getHealth(),
  };
}
