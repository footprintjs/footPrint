/**
 * FlowChartExecutor — Public API for executing a compiled FlowChart.
 *
 * Wraps FlowchartTraverser. Pairs with FlowChartBuilder:
 *   const chart = flowChart('entry', entryFn).addFunction('process', processFn).build();
 *   const executor = new FlowChartExecutor(chart);          // uses default ScopeFacade
 *   const executor = new FlowChartExecutor(chart, myFactory); // custom scope factory
 *   const result = await executor.run();
 */

import type { CombinedNarrativeEntry } from '../engine/narrative/CombinedNarrativeBuilder';
import { CombinedNarrativeRecorder } from '../engine/narrative/CombinedNarrativeRecorder';
import { NarrativeFlowRecorder } from '../engine/narrative/NarrativeFlowRecorder';
import type { ManifestEntry } from '../engine/narrative/recorders/ManifestFlowRecorder';
import { ManifestFlowRecorder } from '../engine/narrative/recorders/ManifestFlowRecorder';
import type { FlowRecorder } from '../engine/narrative/types';
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
import { ScopeFacade } from '../scope/ScopeFacade';
import type { RedactionPolicy, RedactionReport } from '../scope/types';
import { ExecutionRuntime } from './ExecutionRuntime';
import { validateInput } from './validateInput';

/** Default scope factory — creates a plain ScopeFacade for each stage. */
const defaultScopeFactory: ScopeFactory = (ctx, stageName, readOnly, env) =>
  new ScopeFacade(ctx, stageName, readOnly, env);

export class FlowChartExecutor<TOut = any, TScope = any> {
  private traverser: FlowchartTraverser<TOut, TScope>;
  private narrativeEnabled = false;
  private combinedRecorder: CombinedNarrativeRecorder | undefined;
  private flowRecorders: FlowRecorder[] = [];
  private redactionPolicy: RedactionPolicy | undefined;
  private sharedRedactedKeys = new Set<string>();
  private sharedRedactedFieldsByKey = new Map<string, Set<string>>();

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
    scopeFactory: ScopeFactory<TScope> = defaultScopeFactory as ScopeFactory<TScope>,
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
      scopeFactory: scopeFactory ?? (defaultScopeFactory as ScopeFactory<TScope>),
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

  private createTraverser(
    signal?: AbortSignal,
    readOnlyContextOverride?: unknown,
    env?: import('../engine/types').ExecutionEnv,
  ): FlowchartTraverser<TOut, TScope> {
    const args = this.flowChartArgs;
    const fc = args.flowChart;
    const narrativeFlag = this.narrativeEnabled || (fc.enableNarrative ?? false);

    // When narrative is enabled, create a CombinedNarrativeRecorder that implements
    // BOTH FlowRecorder (control flow) and Recorder (scope data). It builds the
    // combined narrative inline during traversal — no post-processing merge needed.
    let scopeFactory = args.scopeFactory;
    if (narrativeFlag) {
      this.combinedRecorder = new CombinedNarrativeRecorder();
      const recorder = this.combinedRecorder;
      const originalFactory = args.scopeFactory;
      scopeFactory = ((ctx: any, stageName: string, readOnly?: unknown, envArg?: any) => {
        const scope = originalFactory(ctx, stageName, readOnly, envArg);
        if (scope && typeof (scope as any).attachRecorder === 'function') {
          (scope as any).attachRecorder(recorder);
        }
        return scope;
      }) as ScopeFactory<TScope>;
    } else {
      this.combinedRecorder = undefined;
    }

    // Share redacted keys across all scope instances in this pipeline run.
    // This ensures that once a key is marked as redacted in one stage,
    // subsequent stages' recorders also see it as redacted.
    // Also injects the RedactionPolicy if one has been set.
    {
      this.sharedRedactedKeys = new Set<string>();
      this.sharedRedactedFieldsByKey = new Map<string, Set<string>>();
      const sharedRedactedKeys = this.sharedRedactedKeys;
      const policy = this.redactionPolicy;
      const prevFactory = scopeFactory;
      scopeFactory = ((ctx: any, stageName: string, readOnly?: unknown, envArg?: any) => {
        const scope = prevFactory(ctx, stageName, readOnly, envArg);
        if (scope && typeof (scope as any).useSharedRedactedKeys === 'function') {
          (scope as any).useSharedRedactedKeys(sharedRedactedKeys);
        }
        if (policy && scope && typeof (scope as any).useRedactionPolicy === 'function') {
          (scope as any).useRedactionPolicy(policy);
        }
        return scope;
      }) as ScopeFactory<TScope>;
    }

    const runtime = new ExecutionRuntime(fc.root.name, args.defaultValuesForContext, args.initialContext);

    return new FlowchartTraverser<TOut, TScope>({
      root: fc.root,
      stageMap: fc.stageMap,
      scopeFactory,
      executionRuntime: runtime,
      readOnlyContext: readOnlyContextOverride ?? args.readOnlyContext,
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
      executionEnv: env,
      flowRecorders: this.buildFlowRecordersList(),
    });
  }

  enableNarrative(): void {
    this.narrativeEnabled = true;
  }

  /**
   * Set a declarative redaction policy that applies to all stages.
   * Must be called before run().
   */
  setRedactionPolicy(policy: RedactionPolicy): void {
    this.redactionPolicy = policy;
  }

  /**
   * Returns a compliance-friendly report of all redaction activity from the
   * most recent run. Never includes actual values.
   */
  getRedactionReport(): RedactionReport {
    const fieldRedactions: Record<string, string[]> = {};
    for (const [key, fields] of this.sharedRedactedFieldsByKey) {
      fieldRedactions[key] = [...fields];
    }
    return {
      redactedKeys: [...this.sharedRedactedKeys],
      fieldRedactions,
      patterns: (this.redactionPolicy?.patterns ?? []).map((p) => p.source),
    };
  }

  // ─── FlowRecorder Management ───

  /**
   * Attach a FlowRecorder to observe control flow events.
   * Automatically enables narrative if not already enabled.
   * Must be called before run() — recorders are passed to the traverser at creation time.
   */
  attachFlowRecorder(recorder: FlowRecorder): void {
    this.flowRecorders.push(recorder);
    this.narrativeEnabled = true;
  }

  /** Detach all FlowRecorders with the given ID. */
  detachFlowRecorder(id: string): void {
    this.flowRecorders = this.flowRecorders.filter((r) => r.id !== id);
  }

  /** Returns a defensive copy of attached FlowRecorders. */
  getFlowRecorders(): FlowRecorder[] {
    return [...this.flowRecorders];
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
    // Combined recorder builds the narrative inline during traversal — just read it
    if (this.combinedRecorder) {
      return this.combinedRecorder.getNarrative();
    }
    return this.traverser.getNarrative();
  }

  /**
   * Returns structured narrative entries for programmatic consumption.
   * Each entry has a type (stage, step, condition, fork, etc.), text, and depth.
   */
  getNarrativeEntries(): CombinedNarrativeEntry[] {
    if (this.combinedRecorder) {
      return this.combinedRecorder.getEntries();
    }
    const flowSentences = this.traverser.getNarrative();
    return flowSentences.map((text) => ({ type: 'stage' as const, text, depth: 0 }));
  }

  /**
   * Returns the combined FlowRecorders list. When narrative is enabled, includes:
   * - CombinedNarrativeRecorder (builds merged flow+data narrative inline)
   * - NarrativeFlowRecorder (keeps flow-only sentences for getFlowNarrative())
   * Plus any user-attached recorders.
   */
  private buildFlowRecordersList(): FlowRecorder[] | undefined {
    const recorders: FlowRecorder[] = [];
    if (this.combinedRecorder) {
      recorders.push(this.combinedRecorder);
      // Keep the default NarrativeFlowRecorder so getFlowNarrative() still works
      recorders.push(new NarrativeFlowRecorder());
    }
    recorders.push(...this.flowRecorders);
    return recorders.length > 0 ? recorders : undefined;
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

    // Validate input against inputSchema if both are present
    let validatedInput = options?.input;
    if (validatedInput && this.flowChartArgs.flowChart.inputSchema) {
      validatedInput = validateInput(this.flowChartArgs.flowChart.inputSchema, validatedInput);
    }

    // Clear stateful recorders before re-run to prevent cross-run accumulation
    for (const r of this.flowRecorders) {
      r.clear?.();
    }

    this.traverser = this.createTraverser(signal, validatedInput, options?.env);
    try {
      return await this.traverser.execute();
    } finally {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
    }
  }

  // ─── Introspection ───

  getSnapshot() {
    const snapshot = this.traverser.getSnapshot();
    const sfResults = this.traverser.getSubflowResults();
    if (sfResults.size > 0) {
      snapshot.subflowResults = Object.fromEntries(sfResults);
    }
    return snapshot;
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

  /**
   * Returns the subflow manifest from an attached ManifestFlowRecorder.
   * Returns empty array if no ManifestFlowRecorder is attached.
   */
  getSubflowManifest(): ManifestEntry[] {
    const recorder = this.flowRecorders.find((r) => r instanceof ManifestFlowRecorder) as
      | ManifestFlowRecorder
      | undefined;
    return recorder?.getManifest() ?? [];
  }

  /**
   * Returns the full spec for a dynamically-registered subflow.
   * Requires an attached ManifestFlowRecorder that observed the registration.
   */
  getSubflowSpec(subflowId: string): unknown | undefined {
    const recorder = this.flowRecorders.find((r) => r instanceof ManifestFlowRecorder) as
      | ManifestFlowRecorder
      | undefined;
    return recorder?.getSpec(subflowId);
  }
}
