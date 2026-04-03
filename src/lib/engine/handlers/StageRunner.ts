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
import { isPauseResult, PauseSignal } from '../../pause/types.js';
import { BREAK_SETTER, IS_TYPED_SCOPE } from '../../reactive/types.js';
import { createProtectedScope } from '../../scope/protection/createProtectedScope.js';
import type { StageNode } from '../graph/StageNode.js';
import type { HandlerDeps, StageFunction, StreamCallback } from '../types.js';

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

    // Wrap scope with protection to intercept direct property assignments.
    // Skip for TypedScope — it already has its own Proxy with proper set traps
    // that delegate to setValue().
    const isTypedScope = rawScope && (rawScope as any)[IS_TYPED_SCOPE] === true;
    const scope = isTypedScope
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

    // Inject breakPipeline into TypedScope via BREAK_SETTER (if the scope supports it)
    if (rawScope && typeof (rawScope as any)[BREAK_SETTER] === 'function') {
      (rawScope as any)[BREAK_SETTER](breakFn);
    }

    // Notify recorders of stage start (if scope supports it)
    if (rawScope && typeof (rawScope as any).notifyStageStart === 'function') {
      (rawScope as any).notifyStageStart();
    }

    // Execute the stage function
    const output = stageFunc(scope, breakFn, streamCallback);

    // Sync+async safety: only await real Promises to avoid thenable assimilation
    let result: TOut;
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

    // Notify recorders of stage end (if scope supports it)
    if (rawScope && typeof (rawScope as any).notifyStageEnd === 'function') {
      (rawScope as any).notifyStageEnd();
    }

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
      if (rawScope && typeof (rawScope as any).notifyPause === 'function') {
        (rawScope as any).notifyPause(node.id, pauseData);
      }
      throw new PauseSignal(pauseData, node.id);
    }

    return result;
  }
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
