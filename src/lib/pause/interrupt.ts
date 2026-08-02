/**
 * interrupt() — pause from inside ANY stage body, and get an answer back.
 *
 * Design: docs/design/execution-control.md (D3).
 *
 * `addPausableFunction` pauses a stage that was DECLARED pausable, splitting it
 * into execute/resume halves. `interrupt()` is the other shape: an ordinary
 * stage stops mid-body to ask a question, and the answer comes back at the
 * same call site when the run resumes.
 *
 * ```ts
 * const chart = flowChart<State>('Refund', async (scope) => {
 *   scope.amount = 4200;
 *   const approval = interrupt<{ approved: boolean }>(scope, {
 *     reason: `Approve a $${scope.amount} refund?`,
 *     expects: { approved: 'boolean' },
 *   });
 *   scope.approved = approval.approved;   // reached only after resume()
 * }, 'refund').build();
 * ```
 *
 * ## Laws
 *
 * **Scope first.** `interrupt(scope, payload)` takes the scope as its first
 * argument for the same reason `decide(scope, rules, default)` does: this
 * library has no ambient "current stage" register, and inventing one would be
 * unsafe under parallel fan-out where several stages are in flight at once.
 * The scope object identifies the stage.
 *
 * **Stages are atomic — resume re-enters the stage from its TOP.** This is the
 * same law `resumeOnError` states, and it is stated here because it decides how
 * you write the body: everything before the `interrupt()` call runs AGAIN on
 * resume. Keep the pre-interrupt half idempotent (compute, read, stage a value)
 * and put anything that must happen exactly once AFTER the call, or in a later
 * stage. footprintjs never rolls state back (see .claude/rules/backtracking.md),
 * so a write made before the interrupt is committed, and re-writing the same
 * value on resume is a no-op the net-change filter drops.
 *
 * **One answer per call.** The answer is consumed by the FIRST `interrupt()`
 * the re-entered stage reaches. A stage that interrupts twice pauses twice —
 * each question gets its own checkpoint and its own resume, which is what
 * "one question, one answer" has to mean.
 *
 * **`onStageEnd` does not fire for an interrupted stage.** The stage function
 * did not return — it threw, exactly like the error path, which also skips
 * `onStageEnd`. (The `addPausableFunction` path DOES fire it, because there
 * the function returned normally and the engine turned its return value into a
 * pause.) Recorders pairing start/end see an unclosed stage for an interrupt,
 * the same way they do for a throw.
 *
 * **Writes made before the interrupt are committed.** The traverser commits on
 * the pause path before re-throwing, so the checkpoint's `sharedState` contains
 * them — that is what lets the resumed stage see its own earlier work.
 */

/** What an `interrupt()` asks for. Rides the checkpoint as `pauseData`. */
export interface InterruptPayload {
  /** Why execution stopped — the question, in the consumer's own words. */
  reason: string;
  /**
   * Optional shape hint for the answer: a JSON-ish description of what
   * `resume()` should be given. The engine never interprets it — it is carried
   * verbatim to the checkpoint so a UI can render the right form.
   */
  expects?: unknown;
}

/**
 * Thrown by `interrupt()` when no answer is pending. Converted into the
 * library's existing `PauseSignal` at the stage boundary (`StageRunner`), so
 * every downstream pause mechanism — subflow bubble-up, invoker stamping,
 * checkpoint building — is the shipped one, unchanged.
 *
 * Consumers never catch this: a stage body that swallows it turns a pause into
 * a silent continue.
 */
export class InterruptSignal extends Error {
  /** The `{ reason, expects? }` bag handed to `interrupt()`. */
  readonly payload: InterruptPayload;

  constructor(payload: InterruptPayload) {
    super('Execution interrupted');
    this.name = 'InterruptSignal';
    this.payload = payload;
    // Control flow, not a real error — the stack has no diagnostic value.
    this.stack = '';
  }
}

/** Check if an error is an InterruptSignal. instanceof + name brand for cross-realm safety. */
export function isInterruptSignal(error: unknown): error is InterruptSignal {
  return (
    error instanceof InterruptSignal ||
    (error instanceof Error &&
      error.name === 'InterruptSignal' &&
      Object.prototype.hasOwnProperty.call(error, 'payload'))
  );
}

/**
 * Pending resume answers, keyed by the SCOPE OBJECT the stage was handed.
 *
 * A WeakMap keyed by scope identity is what makes this safe under parallel
 * fan-out: every stage gets its own scope instance from the ScopeFactory, so
 * two branches resuming at once cannot read each other's answer — which a
 * module-level "current answer" slot could not promise across an `await`.
 * Entries are one-shot (deleted on read) and the WeakMap holds no scope alive.
 */
const pendingAnswers = new WeakMap<object, { answer: unknown }>();

/**
 * Deposit the resume input for the stage about to re-run with `scope`.
 *
 * Called by `FlowChartExecutor.resume()` when it re-enters an interrupted
 * stage from its top. Internal — consumers reach this through `resume()`.
 */
export function provideInterruptAnswer(scope: unknown, answer: unknown): void {
  if (typeof scope !== 'object' || scope === null) return;
  pendingAnswers.set(scope as object, { answer });
}

/**
 * Pause the run and ask for an answer.
 *
 * On the first pass there is no answer pending, so this THROWS an
 * `InterruptSignal`: the engine commits the stage's writes, builds the normal
 * `FlowchartCheckpoint` with `pauseData` = your payload, and `run()` returns
 * `{ paused: true, checkpoint }`. Hand the checkpoint and the answer to
 * `executor.resume(checkpoint, answer)` and the stage runs again from its top —
 * this time the call returns `answer`.
 *
 * @param scope   The stage's scope (first argument, like `decide()`).
 * @param payload `{ reason, expects? }` — carried verbatim to the checkpoint.
 * @returns The resume input, typed as `T`. The engine does not validate it
 *          against `expects` — declare the shape you want and check it if the
 *          answer comes from somewhere you do not control.
 *
 * @example
 * ```ts
 * const decision = interrupt<{ approved: boolean }>(scope, { reason: 'Ship it?' });
 * if (!decision.approved) scope.$break('rejected by reviewer');
 * ```
 */
export function interrupt<T = unknown>(scope: unknown, payload: InterruptPayload): T {
  if (typeof scope === 'object' && scope !== null) {
    const pending = pendingAnswers.get(scope as object);
    if (pending !== undefined) {
      // One-shot: a second interrupt() in the same stage asks its own question.
      pendingAnswers.delete(scope as object);
      return pending.answer as T;
    }
  }
  throw new InterruptSignal(payload);
}
