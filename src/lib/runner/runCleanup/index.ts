import type { ArmedRun } from '../deadline.js';

/** How long a run's own flush may take: the run's time left (at least 1 s), never past {@link AUTO_FLUSH_MS}. */
export function autoFlushMs(deadline: number | undefined): number {
  return deadline === undefined ? AUTO_FLUSH_MS : Math.min(AUTO_FLUSH_MS, Math.max(1_000, deadline - Date.now()));
}

/** The bound on a run's own flush when it has no deadline: 30 s. */
const AUTO_FLUSH_MS = 30_000;

/** Run `build`; if it throws, release the armed run first (no deadline timer outlives a refused entry). */
export function disposeOnThrow<T>(armed: ArmedRun, build: () => T): T {
  try {
    return build();
  } catch (error) {
    armed.dispose();
    throw error;
  }
}
