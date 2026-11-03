/** Joined lifecycle control shared by owned roots, raw roots and mounts. */
import { observeNativeFailure } from '../attempt/observerDiagnostics.js';

/** Native component leg terminal, including failed cancellation.
 * WHY: paused cleanup may preserve adapter resources; it must not imply remote closure.
 * SAME and FRESH resumes open new cells/subscriptions and need explicit admitted-data restore.
 */
export type ComponentEnd = { readonly kind: 'completed' } | { readonly kind: 'paused' } | { readonly kind: 'failed' };
export type ComponentFinalizer = (end: ComponentEnd) => void | Promise<void>;
export interface FinalizationFailures {
  readonly count: number;
  readonly first?: { readonly reason: unknown };
}

/** One once/reverse/awaited implementation; control never runs through recorder hooks. */
export class FinalizationBook {
  private callbacks: ComponentFinalizer[] = [];
  private closed = false;
  private result?: Promise<FinalizationFailures>;

  register(callback: ComponentFinalizer): void {
    if (this.closed) throw new TypeError('Component finalizer registration has closed');
    if (typeof callback !== 'function') throw new TypeError('Component finalizer must be a function');
    this.callbacks.push(callback);
  }

  finish(end: ComponentEnd): Promise<FinalizationFailures> {
    if (this.result) return this.result;
    this.closed = true;
    const terminal: ComponentEnd = Object.freeze({ kind: end.kind });
    const callbacks = this.callbacks;
    this.callbacks = [];
    this.result = (async () => {
      let count = 0;
      let first: { readonly reason: unknown } | undefined;
      for (let i = callbacks.length - 1; i >= 0; i -= 1) {
        try {
          await callbacks[i](terminal);
        } catch (reason) {
          count = Math.min(Number.MAX_SAFE_INTEGER, count + 1);
          first ??= { reason };
        }
      }
      callbacks.length = 0;
      return { count, ...(first && { first }) };
    })();
    return this.result;
  }
}

/** Value-free diagnostics never await or probe a foreign thenable. */
export function reportFinalizationFailures(
  logger: { warn(message: string, facts: { secondaryPhaseFailures: number; cleanupFailures: number }): unknown },
  secondaryPhaseFailures: number,
  cleanupFailures: number,
): void {
  if (secondaryPhaseFailures === 0 && cleanupFailures === 0) return;
  try {
    const returned = logger.warn('Run finalization observed failures', { secondaryPhaseFailures, cleanupFailures });
    observeNativeFailure(returned, () => undefined);
  } catch {
    // Reporting cannot replace the original failure or retain ownership.
  }
}
