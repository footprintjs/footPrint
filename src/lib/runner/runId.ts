/**
 * runId — per-`executor.run()` identifier generator.
 *
 * Pattern: monotonic counter + clock-guarded timestamp. One id per
 *          call to `executor.run()` (or `executor.resume()`). Stable
 *          for the duration of that run; unique across consecutive
 *          runs.
 * Role:    primitive that solves the "two consecutive runs of the
 *          same executor produce identical runtimeStageIds" class of
 *          bugs. Recorders that accumulate state across runs detect
 *          "new run" via `runId` change and reset transient
 *          bookkeeping.
 *
 * Format: `${timestamp}-${counter}`.
 *   - `timestamp` is `Date.now()` clamped to a monotonic-clock guard
 *     (never decreases — protects against NTP / system-clock
 *     adjustments).
 *   - `counter` is a process-local incrementing integer, ZERO-PADDED
 *     to 10 digits so lexicographic sort matches numeric order
 *     (`"...001"` < `"...010"` < `"...100"`). 10 digits = 10 billion
 *     runs in a single process — sufficient for any real workload.
 *
 * Lexicographic ordering of `runId` strings matches chronological
 * ordering for runs that are at least 1ms apart, AND for runs that
 * happen within the same millisecond (because the padded counter
 * tie-breaks). The counter NEVER resets — it is process-global.
 *
 * Process-local only. Cross-process correlation uses
 * `getEnv().traceId` (consumer-supplied), not `runId`. Documented
 * in `docs/design/v5-recorder-redesign.md` Section 8.1.
 */

let _counter = 0;
let _lastTimestamp = 0;

/**
 * Generate a fresh runId. Called once per `executor.run()` and once
 * per `executor.resume()`. Pure (deterministic for a given clock +
 * counter state); no side effects beyond advancing the counter and
 * monotonic-clock guard.
 */
export function generateRunId(): string {
  // Monotonic-clock guard: if Date.now() ticks backward (NTP slew,
  // VM pause + resume, etc.), pin to the last seen timestamp so
  // sort order never breaks.
  const now = Date.now();
  if (now > _lastTimestamp) {
    _lastTimestamp = now;
  }
  // Counter is process-global, monotonic. Never resets across runs.
  // Even if two runs share the same `_lastTimestamp` value, their
  // counter values differ, so runIds remain unique.
  // Pad to 10 digits so lexicographic sort matches numeric order.
  const counter = (++_counter).toString().padStart(10, '0');
  return `${_lastTimestamp}-${counter}`;
}

/**
 * Reset the runId state. Test-only. NEVER call from production code —
 * runIds must be process-globally monotonic.
 *
 * @internal
 */
export function _resetRunIdStateForTesting(): void {
  _counter = 0;
  _lastTimestamp = 0;
}
