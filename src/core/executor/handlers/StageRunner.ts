/**
 * StageRunner.ts
 *
 * WHY: Executes individual stage functions with scope protection and streaming support.
 * This module is extracted from Pipeline.ts following the Single Responsibility Principle,
 * isolating the concerns of stage execution from pipeline traversal.
 *
 * RESPONSIBILITIES:
 * - Create scope via ScopeFactory for each stage
 * - Apply scope protection (createProtectedScope) to intercept direct property assignments
 * - Handle streaming stages (onStart, onToken, onEnd lifecycle)
 * - Handle sync+async safety (only await real Promises to avoid thenable assimilation)
 *
 * DESIGN DECISIONS:
 * - Scope protection is applied at the stage level, not globally, to allow per-stage configuration
 * - Streaming callbacks are created lazily only for streaming stages to minimize overhead
 * - Sync+async safety uses `instanceof Promise` rather than duck-typing to avoid side effects
 *
 * DOES NOT HANDLE:
 * - Commit logic (caller handles via context.commitPatch())
 * - Extractor calls (caller handles via callExtractor())
 * - Break flag propagation (caller checks breakFlag after run)
 *
 * RELATED:
 * - {@link Pipeline} - Orchestrates stage execution order and calls StageRunner
 * - {@link StageContext} - Provides stage-scoped state access
 * - {@link createProtectedScope} - Wraps scope to intercept direct assignments
 *
 * _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6_
 */

import { StageContext } from '../../memory/StageContext';
import { createProtectedScope } from '../../../scope/protection/createProtectedScope';
import type { StageNode } from '../Pipeline';
import type { PipelineContext, PipelineStageFunction, StreamCallback } from '../types';

/**
 * StageRunner
 * ------------------------------------------------------------------
 * Runs a single stage function with scope protection and streaming support.
 *
 * WHY: Isolates the complexity of stage execution (scope creation, protection,
 * streaming) from the pipeline traversal logic. This makes both Pipeline and
 * StageRunner easier to test and maintain.
 *
 * DESIGN: Uses PipelineContext for shared state access rather than direct
 * field access, enabling dependency injection for testing.
 *
 * @template TOut - The output type of stage functions
 * @template TScope - The scope type passed to stage functions
 *
 * @example
 * ```typescript
 * const runner = new StageRunner(pipelineContext);
 * const output = await runner.run(node, stageFunc, context, breakFn);
 * ```
 */
export class StageRunner<TOut = any, TScope = any> {
  constructor(private readonly ctx: PipelineContext<TOut, TScope>) {}

  /**
   * Run a single stage function.
   *
   * WHY: Centralizes the stage execution logic including scope creation,
   * protection, and streaming support in one place.
   *
   * DESIGN: The method handles both sync and async stages uniformly by
   * only awaiting real Promises (using instanceof check). This avoids
   * "thenable assimilation" side-effects on arbitrary objects.
   *
   * @param node - The stage node to execute
   * @param stageFunc - The stage function to run
   * @param context - The stage context for state access
   * @param breakFn - Function to call to trigger break (early termination)
   * @returns The stage output (may be undefined for void stages)
   *
   * _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6_
   */
  async run(
    node: StageNode<TOut, TScope>,
    stageFunc: PipelineStageFunction<TOut, TScope>,
    context: StageContext,
    breakFn: () => void,
  ): Promise<TOut> {
    // Create scope via ScopeFactory
    // WHY: Each stage gets its own scope instance for isolation
    const rawScope = this.ctx.ScopeFactory(context, node.name, this.ctx.readOnlyContext);

    // Wrap scope with protection to intercept direct property assignments
    // WHY: Prevents accidental mutations that bypass the WriteBuffer
    const scope = createProtectedScope(rawScope as object, {
      mode: this.ctx.scopeProtectionMode,
      stageName: node.name,
    }) as TScope;

    // Determine if this is a streaming stage and create the appropriate callback
    // WHY: Streaming stages need a callback to emit tokens incrementally
    let streamCallback: StreamCallback | undefined;
    let accumulatedText = '';

    if (node.isStreaming) {
      const streamId = node.streamId ?? node.name;

      // Create bound callback that routes tokens to the handler with the correct streamId
      streamCallback = (token: string) => {
        accumulatedText += token;
        this.ctx.streamHandlers?.onToken?.(streamId, token);
      };

      // Call onStart lifecycle hook before execution
      this.ctx.streamHandlers?.onStart?.(streamId);
    }

    // Execute the stage function
    const output = stageFunc(scope, breakFn, streamCallback);

    // Sync+async safety: only await real Promises
    // WHY: Avoids "thenable assimilation" side-effects on arbitrary objects
    // that happen to have a .then() method
    let result: TOut;
    if (output instanceof Promise) {
      result = await output;
    } else {
      result = output;
    }

    // Call onEnd lifecycle hook after execution for streaming stages
    if (node.isStreaming) {
      const streamId = node.streamId ?? node.name;
      this.ctx.streamHandlers?.onEnd?.(streamId, accumulatedText);
    }

    return result;
  }
}
