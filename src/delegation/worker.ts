import type { DelegationPrototype } from "./prototype";

/** One sweep at a time, independent of agent traffic. Persistence errors stay visible. */
export function startDelegationWorker(engine: Pick<DelegationPrototype, "tick">, options: { intervalMs?: number; onError: () => void }) {
  const interval = options.intervalMs ?? 1000;
  if (!Number.isSafeInteger(interval) || interval <= 0) throw new Error("Worker interval must be a positive integer.");
  let running: Promise<void> | undefined;
  let stopped = false;
  const sweep = () => {
    if (running || stopped) return;
    running = engine.tick().catch(() => options.onError()).finally(() => { running = undefined; });
  };
  const timer = setInterval(sweep, interval);
  timer.unref();
  sweep();
  return { stop: async () => { stopped = true; clearInterval(timer); await running; } };
}
