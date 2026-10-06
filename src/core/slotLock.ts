/** One critical section per property so a booking and an extension cannot interleave. */
const tails = new Map<string, Promise<void>>();

export function withPropertySlotLock<T>(propertyId: string, fn: () => Promise<T>): Promise<T> {
  const previous = tails.get(propertyId) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>((resolve) => {
    release = resolve;
  });
  tails.set(propertyId, previous.then(() => next, () => next));
  return previous.then(fn, fn).finally(() => {
    release();
    if (tails.get(propertyId) === next) tails.delete(propertyId);
  });
}
