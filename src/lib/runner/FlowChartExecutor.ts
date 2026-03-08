/**
 * FlowChartExecutor — Public API for executing a compiled FlowChart.
 *
 * Wraps FlowchartTraverser. Pairs with FlowChartBuilder:
 *   const chart = flowChart('entry', entryFn).addFunction('process', processFn).build();
 *   const executor = new FlowChartExecutor(chart, scopeFactory);
 *   const result = await executor.run();
 */

import type { CombinedNarrativeEntry } from '../engine/narrative/CombinedNarrativeBuilder';
import { CombinedNarrativeBuilder } from '../engine/narrative/CombinedNarrativeBuilder';
import { FlowchartTraverser } from '../engine/traversal/FlowchartTraverser';
import {
  type ExtractorError,
  type FlowChart,
  type RunOptions,
  type ScopeFactory,
  type SerializedPipelineStructure,
  type StageNode,
  type StreamHandlers,
  type SubflowResult,
  type TraversalResult,
  defaultLogger,
} from '../engine/types';
import type { ScopeProtectionMode } from '../scope/protection/types';
import { NarrativeRecorder } from '../scope/recorders/NarrativeRecorder';
import { ExecutionRuntime } from './ExecutionRuntime';

export class FlowChartExecutor<TOut = any, TScope = any> {
  private traverser: FlowchartTraverser<TOut, TScope>;
  private narrativeEnabled = false;
  private narrativeRecorder: NarrativeRecorder | undefined;

  private readonly flowChartArgs: {
    flowChart: FlowChart<TOut, TScope>;
    scopeFactory: ScopeFactory<TScope>;
    defaultValuesForContext?: unknown;
    initialContext?: unknown;
    readOnlyContext?: unknown;
    throttlingErrorChecker?: (error: unknown) => boolean;
    streamHandlers?: StreamHandlers;
    scopeProtectionMode?: ScopeProtectionMode;
    enrichSnapshots?: boolean;
  };

  constructor(
    flowChart: FlowChart<TOut, TScope>,
    scopeFactory: ScopeFactory<TScope>,
    defaultValuesForContext?: unknown,
    initialContext?: unknown,
    readOnlyContext?: unknown,
    throttlingErrorChecker?: (error: unknown) => boolean,
    streamHandlers?: StreamHandlers,
    scopeProtectionMode?: ScopeProtectionMode,
    enrichSnapshots?: boolean,
  ) {
    this.flowChartArgs = {
      flowChart,
      scopeFactory,
      defaultValuesForContext,
      initialContext,
      readOnlyContext,
      throttlingErrorChecker,
      streamHandlers,
      scopeProtectionMode,
      enrichSnapshots,
    };
    this.traverser = this.createTraverser();
  }

  private createTraverser(signal?: AbortSignal): FlowchartTraverser<TOut, TScope> {
    const args = this.flowChartArgs;
    const fc = args.flowChart;
    const narrativeFlag = this.narrativeEnabled || (fc.enableNarrative ?? false);

    // When narrative is enabled, create a recorder and wrap the scope factory
    // to auto-attach it to every scope that supports attachRecorder().
    let scopeFactory = args.scopeFactory;
    if (narrativeFlag) {
      this.narrativeRecorder = new NarrativeRecorder();
      const recorder = this.narrativeRecorder;
      const originalFactory = args.scopeFactory;
      scopeFactory = ((ctx: any, stageName: string, readOnly?: unknown) => {
        const scope = originalFactory(ctx, stageName, readOnly);
        if (scope && typeof (scope as any).attachRecorder === 'function') {
          (scope as any).attachRecorder(recorder);
        }
        return scope;
      }) as ScopeFactory<TScope>;
    } else {
      this.narrativeRecorder = undefined;
    }

    const runtime = new ExecutionRuntime(fc.root.name, args.defaultValuesForContext, args.initialContext);

    return new FlowchartTraverser<TOut, TScope>({
      root: fc.root,
      stageMap: fc.stageMap,
      scopeFactory,
      executionRuntime: runtime,
      readOnlyContext: args.readOnlyContext,
      throttlingErrorChecker: args.throttlingErrorChecker,
      streamHandlers: args.streamHandlers,
      extractor: fc.extractor,
      scopeProtectionMode: args.scopeProtectionMode,
      subflows: fc.subflows,
      enrichSnapshots: args.enrichSnapshots ?? fc.enrichSnapshots,
      narrativeEnabled: narrativeFlag,
      buildTimeStructure: fc.buildTimeStructure,
      logger: fc.logger ?? defaultLogger,
      signal,
    });
  }

  enableNarrative(): void {
    this.narrativeEnabled = true;
  }

  /**
   * Returns the execution narrative.
   *
   * When using ScopeFacade-based scopes, returns a combined narrative that
   * interleaves flow events (stages, decisions, forks) with data operations
   * (reads, writes, updates). For plain scopes without attachRecorder support,
   * returns flow-only narrative sentences.
   */
  getNarrative(): string[] {
    const flowSentences = this.traverser.getNarrative();
    if (this.narrativeRecorder && this.narrativeRecorder.getStageData().size > 0) {
      return new CombinedNarrativeBuilder().build(flowSentences, this.narrativeRecorder);
    }
    return flowSentences;
  }

  /**
   * Returns structured narrative entries for programmatic consumption.
   * Each entry has a type (stage, step, condition, fork, etc.), text, and depth.
   */
  getNarrativeEntries(): CombinedNarrativeEntry[] {
    const flowSentences = this.traverser.getNarrative();
    if (this.narrativeRecorder) {
      return new CombinedNarrativeBuilder().buildEntries(flowSentences, this.narrativeRecorder);
    }
    return flowSentences.map((text) => ({ type: 'stage' as const, text, depth: 0 }));
  }

  /**
   * Returns flow-only narrative sentences (without data operations).
   * Use this when you only want control flow descriptions.
   */
  getFlowNarrative(): string[] {
    return this.traverser.getNarrative();
  }

  async run(options?: RunOptions): Promise<TraversalResult> {
    let signal = options?.signal;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    // Create an internal AbortController for timeoutMs
    if (options?.timeoutMs && !signal) {
      const controller = new AbortController();
      signal = controller.signal;
      timeoutId = setTimeout(
        () => controller.abort(new Error(`Execution timed out after ${options.timeoutMs}ms`)),
        options.timeoutMs,
      );
    }

    this.traverser = this.createTraverser(signal);
    try {
      return await this.traverser.execute();
    } finally {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
    }
  }

  // ─── Introspection ───

  getSnapshot() {
    return this.traverser.getSnapshot();
  }

  getRuntime() {
    return this.traverser.getRuntime();
  }

  setRootObject(path: string[], key: string, value: unknown): void {
    this.traverser.setRootObject(path, key, value);
  }

  getBranchIds() {
    return this.traverser.getBranchIds();
  }

  getRuntimeRoot(): StageNode {
    return this.traverser.getRuntimeRoot();
  }

  getRuntimeStructure(): SerializedPipelineStructure | undefined {
    return this.traverser.getRuntimeStructure();
  }

  getSubflowResults(): Map<string, SubflowResult> {
    return this.traverser.getSubflowResults();
  }

  getExtractedResults<TResult = unknown>(): Map<string, TResult> {
    return this.traverser.getExtractedResults<TResult>();
  }

  getEnrichedResults<TResult = unknown>(): Map<string, TResult> {
    return this.traverser.getExtractedResults<TResult>();
  }

  getExtractorErrors(): ExtractorError[] {
    return this.traverser.getExtractorErrors();
  }
}
