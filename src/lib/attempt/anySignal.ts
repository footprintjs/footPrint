/**
 * attempt/anySignal.ts — one signal that aborts when ANY of its inputs does.
 *
 * The attempt runner gives each attempt its own signal: the run's signal (cancellation, the deadline) composed
 * with the attempt's own time cap. `AbortSignal.any` does this natively, but not in every browser this library
 * runs in (design §3.1), so the composition is ours: small, and leak-free — every listener it adds to an input
 * is removed the moment it aborts or is disposed, so a long run of attempts leaves nothing on the run's signal.
 */

/** A composed signal and the one call that releases its inputs. */
export interface ComposedSignal {
  readonly signal: AbortSignal;
  /** Remove every listener this composition added to its inputs. Idempotent. */
  dispose(): void;
}

/**
 * Compose `inputs` (undefined entries ignored): the result aborts with the reason of the first input to abort,
 * or at once with the reason of an input that already has. Call `dispose()` when the attempt ends.
 */
export function anySignal(inputs: ReadonlyArray<AbortSignal | undefined>): ComposedSignal {
  const controller = new AbortController();
  const signals = inputs.filter((s): s is AbortSignal => s !== undefined);
  const already = signals.find((s) => s.aborted);
  if (already) {
    controller.abort(already.reason);
    return { signal: controller.signal, dispose: () => undefined };
  }

  let listening = true;
  const listeners = signals.map((source) => {
    const onAbort = () => {
      release();
      controller.abort(source.reason);
    };
    source.addEventListener('abort', onAbort);
    return { source, onAbort };
  });
  function release(): void {
    if (!listening) return;
    listening = false;
    for (const { source, onAbort } of listeners) source.removeEventListener('abort', onAbort);
  }
  return { signal: controller.signal, dispose: release };
}
