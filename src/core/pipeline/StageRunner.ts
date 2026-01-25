/**
 * StageRunner.ts
 *
 * Runs a single stage function with scope protection and streaming support.
 * Extracted from Pipeline.ts for Single Responsibility Principle.
 *
 * Responsibilities:
 * - Create scope via ScopeFactory
 * - Apply scope protection (createProtectedScope)
 * - Handle streaming stages (onStart, onToken, onEnd lifecycle)
 * - Handle sync+async safety (only await real Promises)
 *
 * Does NOT handle:
 * - Commit logic (caller handles via context.commitPatch())
 * - Extractor calls (caller handles via callExtractor())
 * - Break flag propagation (caller checks breakFlag after run)
 *
 * _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6_
 */

import { StageContext } from '../context/StageContext';
import { createProtectedScope } from '../../scope/protection/createProtectedScope';
import type { StageNode } from './GraphTraverser';
import type { PipelineContext, PipelineStageFunction, StreamCallback } from './types';

/**
 * StageRunner
 * ------------------------------------------------------------------
 * Runs a single stage function with scope protection and streaming support.
 *
 * @template TOut - The output type of stage functions
 * @template TScope - The scope type passed to stage functions
 */
export class StageRunner<TOut = any, TScope = any> {
  constructor(private readonly ctx: PipelineContext<TOut, TScope>) {}

  /**
   * Run a single stage function.
   *
   * Handles:
   * - Scope creation via ScopeFactory
   * - Scope protection via createProtectedScope
   * - Streaming stages (onStart, onToken, onEnd lifecycle)
   * - Sync+async safety (only await real Promises)
   *
   * @param node - The stage node to execute
   * @param stageFunc - The stage function to run
   * @param context - The stage context
   * @param breakFn - Function to call to trigger break
   * @returns The stage output (may be undefined)
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
    const rawScope = this.ctx.ScopeFactory(context, node.name, this.ctx.readOnlyContext);

    // Wrap scope with protection to intercept direct property assignments
    const scope = createProtectedScope(rawScope as object, {
      mode: this.ctx.scopeProtectionMode,
      stageName: node.name,
    }) as TScope;

    // Determine if this is a streaming stage and create the appropriate callback
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
