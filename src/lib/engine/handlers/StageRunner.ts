/**
 * StageRunner — Executes individual stage functions.
 *
 * Responsibilities:
 * - Create scope via ScopeFactory for each stage
 * - Apply scope protection (createProtectedScope) to intercept direct assignments
 * - Handle streaming stages (onStart, onToken, onEnd lifecycle)
 * - Sync+async safety: only await real Promises (instanceof check)
 */

import type { StageContext } from '../../memory/StageContext.js';
import { isInterruptSignal } from '../../pause/interrupt.js';
import { isPauseResult, isPauseSignal, PauseSignal } from '../../pause/types.js';
import { createProtectedScope } from '../../scope/protection/createProtectedScope.js';
import { requireScopeRuntime } from '../../scope/runtime.js';
import type { StageNode } from '../graph/StageNode.js';
import type { HandlerDeps, StageFunction, StreamCallback } from '../types.js';
import { servedPause } from './servedPause.js';

export class StageRunner<TOut = any, TScope = any> {
  constructor(private readonly deps: HandlerDeps<TOut, TScope>) {}

  async run(
    node: StageNode<TOut, TScope>,
    stageFunc: StageFunction<TOut, TScope>,
    context: StageContext,
    breakFn: () => void,
  ): Promise<TOut> {
    // Create scope via ScopeFactory — each stage gets its own scope instance
    const rawScope = this.deps.scopeFactory(context, node.name, this.deps.readOnlyContext, this.deps.executionEnv);
    const runtime = requireScopeRuntime(rawScope);

    // Wrap scope with protection to intercept direct property assignments.
    // Providers declare whether their own assignment traps already manage writes.
    const scope = runtime.handlesAssignments
      ? rawScope
      : (createProtectedScope(rawScope as object, {
          mode: this.deps.scopeProtectionMode,
          stageName: node.name,
        }) as TScope);

    // Set up streaming callback if this is a streaming stage
    let streamCallback: StreamCallback | undefined;
    let accumulatedText = '';

    if (node.isStreaming) {
      const streamId = node.streamId ?? node.name;
      streamCallback = (token: string) => {
        accumulatedText += token;
        this.deps.streamHandlers?.onToken?.(streamId, token);
      };
      this.deps.streamHandlers?.onStart?.(streamId);
    }

    runtime.setBreak?.(breakFn);

    // Notify recorders of stage start (if scope supports it)
    runtime.target.notifyStageStart?.();

    // ── Execute the stage function ──
    //
    // THE stage boundary for `interrupt()` (design: docs/design/execution-control.md
    // D3). Every stage function in the engine funnels through this one call —
    // linear stages, decider and selector stages (their handlers are handed
    // `executeStage`), fork children, subflow bodies — so converting here is
    // what makes `interrupt()` work in ALL of them. Catching it in a traverser
    // phase instead would have left decider/selector stages silently unable to
    // interrupt.
    //
    // The conversion is deliberately total: an InterruptSignal becomes the
    // library's existing PauseSignal, stamped with the node id the free
    // function could not know and with `pausedBy: 'interrupt'` so resume()
    // re-enters the stage from its top. Everything downstream — commit-then-
    // rethrow, onPause, subflow scope capture, invoker stamping, the one
    // detached checkpoint clone — is the shipped pause machinery, untouched.
    //
    // `notifyStageEnd` deliberately does NOT fire on this path: the stage
    // function did not return, exactly like the error path below it. (The
    // pausable-handler path further down DOES fire it — there the function
    // returned normally and the engine turned its value into a pause.)
    let result: TOut;
    try {
      const output = stageFunc(scope, breakFn, streamCallback);

      // Sync+async safety: only await real Promises to avoid thenable assimilation
      if (output instanceof Promise) {
        // Race against AbortSignal if provided
        if (this.deps.signal) {
          result = (await raceAbort(output, this.deps.signal)) as TOut;
        } else {
          result = (await output) as TOut;
        }
      } else {
        result = output as TOut;
      }
    } catch (error: unknown) {
      if (isInterruptSignal(error)) {
        runtime.target.notifyPause?.(servedPause(context, error.payload));
        throw stampedPause(new PauseSignal(error.payload, node.id, 'interrupt'), context);
      }
      if (isPauseSignal(error) && error instanceof PauseSignal) stampedPause(error, context);
      throw error;
    }

    // Notify recorders of stage end (if scope supports it)
    runtime.target.notifyStageEnd?.();

    // Call onEnd lifecycle hook for streaming stages
    if (node.isStreaming) {
      const streamId = node.streamId ?? node.name;
      this.deps.streamHandlers?.onEnd?.(streamId, accumulatedText);
    }

    // ── Pause detection ──
    // Pausable stages: any non-void return = pause with that data.
    // Also supports explicit pause({ ... }) for backward compat.
    if (node.isPausable && result !== undefined) {
      const pauseData = isPauseResult(result) ? (result as any).data : result;
      // Notify scope recorders before throwing
      runtime.target.notifyPause?.(servedPause(context, pauseData));
      throw stampedPause(new PauseSignal(pauseData, node.id), context);
    }

    return result;
  }
}

/**
 * Record WHICH execution paused on the signal (first stamp wins) — the stage
 * boundary is the one place that knows its runtimeStageId (the run is added
 * when the checkpoint is built — `PauseSignal · completeExecution`); the
 * checkpoint carries it so a resume can link to the paused execution
 * (`TraversalContext.resumedFrom`). Synchronous on purpose: an extra await
 * here would reorder parallel siblings' microtasks.
 */
function stampedPause(signal: PauseSignal, context: StageContext): PauseSignal {
  signal.stampExecution(context.runtimeStageId);
  return signal;
}

/** Race a promise against an AbortSignal. Rejects with the signal's reason on abort. */
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error(signal.reason ?? 'Aborted'));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () =>
      reject(signal.reason instanceof Error ? signal.reason : new Error(signal.reason ?? 'Aborted'));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (val) => {
        signal.removeEventListener('abort', onAbort);
        resolve(val);
      },
      (err) => {
        signal.removeEventListener('abort', onAbort);
        reject(err);
      },
    );
  });
}
