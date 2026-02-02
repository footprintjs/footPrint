/**
 * FlowChartExecutor.ts
 *
 * Runtime engine that executes a compiled FlowChart.
 * This is the public API wrapper around the internal Pipeline class.
 *
 * FlowChartExecutor provides a cleaner API by accepting a FlowChart object
 * (output of FlowChartBuilder.build()) instead of separate root/stageMap parameters.
 *
 * Usage:
 *   const chart = flowChart('entry', entryFn)
 *     .addFunction('process', processFn)
 *     .build();
 *
 *   const executor = new FlowChartExecutor(chart, scopeFactory);
 *   const result = await executor.run();
 */

import { Pipeline, StageNode, Decider, Selector, isStageNodeReturn } from './Pipeline';
import type {
  PipelineStageFunction,
  StreamHandlers,
  TreeOfFunctionsResponse,
  TraversalExtractor,
  SubflowResult,
  ExtractorError,
} from './types';
import type { ScopeFactory } from '../memory/types';
import type { PipelineRuntime, RuntimeSnapshot } from '../memory/PipelineRuntime';
import type { ScopeProtectionMode } from '../../scope/protection/types';

/**
 * Compiled flowchart ready for execution.
 * This is the output of FlowChartBuilder.build().
 */
export type FlowChart<TOut = any, TScope = any> = {
  /** Root node of the flowchart tree */
  root: StageNode<TOut, TScope>;
  /** Map of stage names to their functions */
  stageMap: Map<string, PipelineStageFunction<TOut, TScope>>;
  /** Optional traversal extractor for data extraction */
  extractor?: TraversalExtractor;
  /** Memoized subflow definitions (key → subflow root). Used for reference-based subflows. */
  subflows?: Record<string, { root: StageNode<TOut, TScope> }>;
};


/**
 * FlowChartExecutor
 * ------------------------------------------------------------------
 * Runtime engine that executes a compiled FlowChart.
 * Renamed from Pipeline for API consistency with FlowChartBuilder.
 *
 * The executor accepts a FlowChart object (from FlowChartBuilder.build())
 * and provides methods to run the flowchart and inspect results.
 *
 * @example
 * ```typescript
 * // Build a flowchart
 * const chart = flowChart('entry', entryFn)
 *   .addFunction('process', processFn)
 *   .build();
 *
 * // Create executor and run
 * const executor = new FlowChartExecutor(chart, scopeFactory);
 * const result = await executor.run();
 *
 * // Access execution data
 * const contextTree = executor.getContextTree();
 * const extractedData = executor.getExtractedResults();
 * ```
 */
export class FlowChartExecutor<TOut = any, TScope = any> {
  private readonly pipeline: Pipeline<TOut, TScope>;

  /**
   * Create a new FlowChartExecutor.
   *
   * @param flowChart - Compiled flowchart from FlowChartBuilder.build()
   * @param scopeFactory - Factory function to create scope instances for each stage
   * @param defaultValuesForContext - Optional default values for the context
   * @param initialContext - Optional initial context values
   * @param readOnlyContext - Optional read-only context values
   * @param throttlingErrorChecker - Optional function to detect throttling errors
   * @param streamHandlers - Optional handlers for streaming stages
   * @param scopeProtectionMode - Optional protection mode for scope access ('error' | 'warn' | 'off', default: 'error')
   */
  constructor(
    flowChart: FlowChart<TOut, TScope>,
    scopeFactory: ScopeFactory<TScope>,
    defaultValuesForContext?: unknown,
    initialContext?: unknown,
    readOnlyContext?: unknown,
    throttlingErrorChecker?: (error: unknown) => boolean,
    streamHandlers?: StreamHandlers,
    scopeProtectionMode?: ScopeProtectionMode,
  ) {
    // Extract components from FlowChart and create internal Pipeline
    this.pipeline = new Pipeline<TOut, TScope>(
      flowChart.root,
      flowChart.stageMap,
      scopeFactory,
      defaultValuesForContext,
      initialContext,
      readOnlyContext,
      throttlingErrorChecker,
      streamHandlers,
      flowChart.extractor,
      scopeProtectionMode,
      flowChart.subflows,
    );
  }

  /**
   * Execute the flowchart and return results.
   * This is the primary method for running a flowchart.
   *
   * @returns Promise resolving to the execution result
   */
  async run(): Promise<TreeOfFunctionsResponse> {
    return await this.pipeline.execute();
  }

  // ───────────────────────── Introspection Methods ─────────────────────────

  /**
   * Returns the full context tree (global + stage contexts) for observability panels.
   */
  getContextTree(): RuntimeSnapshot {
    return this.pipeline.getContextTree();
  }

  /**
   * Returns the PipelineRuntime (root holder of StageContexts).
   */
  getContext(): PipelineRuntime {
    return this.pipeline.getContext();
  }

  /**
   * Sets a root object value into the global context (utility).
   */
  setRootObject(path: string[], key: string, value: unknown): void {
    this.pipeline.setRootObject(path, key, value);
  }

  /**
   * Returns pipeline ids inherited under this root (for debugging fan-out).
   */
  getInheritedPipelines(): string[] {
    return this.pipeline.getInheritedPipelines();
  }

  /**
   * Returns the current pipeline root node (including runtime modifications).
   *
   * This is useful for serializing the pipeline structure after execution,
   * which includes any dynamic children or loop targets added at runtime.
   */
  getRuntimeRoot(): StageNode {
    return this.pipeline.getRuntimeRoot();
  }

  /**
   * Returns the collected SubflowResultsMap after execution.
   * Used by the service layer to include subflow data in API responses.
   */
  getSubflowResults(): Map<string, SubflowResult> {
    return this.pipeline.getSubflowResults();
  }

  /**
   * Returns the collected extracted results after execution.
   * Map keys are stage paths (e.g., "root.child.grandchild").
   */
  getExtractedResults<TResult = unknown>(): Map<string, TResult> {
    return this.pipeline.getExtractedResults<TResult>();
  }

  /**
   * Returns any errors that occurred during extraction.
   * Useful for debugging extractor issues.
   */
  getExtractorErrors(): ExtractorError[] {
    return this.pipeline.getExtractorErrors();
  }
}

// Re-export types that consumers need
export { StageNode, Decider, Selector, isStageNodeReturn };
