/**
 * FlowchartTraverser — Pre-order DFS traversal of StageNode graph.
 *
 * Unified traversal algorithm for all node shapes:
 *   const pre = await prep();
 *   const [x, y] = await Promise.all([fx(pre), fy(pre)]);
 *   return await next(x, y);
 *
 * For each node, executeNode follows 7 phases:
 *   0. CLASSIFY  — subflow detection, early delegation
 *   1. VALIDATE  — node invariants, role markers
 *   2. EXECUTE   — run stage fn, commit, break check
 *   3. DYNAMIC   — StageNode return detection, subflow auto-registration, structure updates
 *   4. CHILDREN  — fork/selector/decider dispatch
 *   5. CONTINUE  — dynamic next / linear next resolution
 *   6. LEAF      — no continuation, return output
 *
 * Break semantics: If a stage calls breakFn(), commit and STOP.
 * Patch model: Stage writes into local patch; commitPatch() after return or throw.
 */
/// <reference types="node" />
import type { ScopeProtectionMode } from '../../scope/protection/types.js';
import { FlowRecorderDispatcher } from '../narrative/FlowRecorderDispatcher.js';
import type { FlowRecorder, IControlFlowNarrative } from '../narrative/types.js';
import type { ExtractorError, IExecutionRuntime, ILogger, ScopeFactory, SerializedPipelineStructure, StageFunction, StageNode, StreamHandlers, SubflowResult, TraversalExtractor, TraversalResult } from '../types.js';
export interface TraverserOptions<TOut = any, TScope = any> {
    root: StageNode<TOut, TScope>;
    stageMap: Map<string, StageFunction<TOut, TScope>>;
    scopeFactory: ScopeFactory<TScope>;
    executionRuntime: IExecutionRuntime;
    readOnlyContext?: unknown;
    /** Execution environment — propagates to subflows automatically. */
    executionEnv?: import('../../engine/types').ExecutionEnv;
    throttlingErrorChecker?: (error: unknown) => boolean;
    streamHandlers?: StreamHandlers;
    extractor?: TraversalExtractor;
    scopeProtectionMode?: ScopeProtectionMode;
    subflows?: Record<string, {
        root: StageNode<TOut, TScope>;
    }>;
    enrichSnapshots?: boolean;
    narrativeEnabled?: boolean;
    buildTimeStructure?: SerializedPipelineStructure;
    logger: ILogger;
    signal?: AbortSignal;
    /** Pre-configured FlowRecorders to attach when narrative is enabled. */
    flowRecorders?: FlowRecorder[];
    /**
     * Pre-configured narrative generator. If provided, takes precedence over
     * flowRecorders and narrativeEnabled. Used by the subflow traverser factory
     * to share the parent's narrative generator with subflow traversers.
     */
    narrativeGenerator?: IControlFlowNarrative;
    /**
     * Maximum recursive executeNode depth. Defaults to FlowchartTraverser.MAX_EXECUTE_DEPTH (500).
     * Override in tests or unusually deep pipelines.
     */
    maxDepth?: number;
    /**
     * When this traverser runs inside a subflow, set this to the subflow's ID.
     * Propagated to TraversalContext so narrative entries carry the correct subflowId.
     */
    parentSubflowId?: string;
}
export declare class FlowchartTraverser<TOut = any, TScope = any> {
    private readonly root;
    private stageMap;
    private readonly executionRuntime;
    private subflows;
    private readonly logger;
    private readonly signal?;
    private readonly parentSubflowId?;
    private readonly nodeResolver;
    private readonly childrenExecutor;
    private readonly subflowExecutor;
    private readonly stageRunner;
    private readonly continuationResolver;
    private readonly deciderHandler;
    private readonly selectorHandler;
    private readonly structureManager;
    private readonly extractorRunner;
    private readonly narrativeGenerator;
    private readonly flowRecorderDispatcher;
    private subflowResults;
    /**
     * Per-traverser set of lazy subflow IDs that have been resolved by THIS run.
     * Used instead of writing `node.subflowResolver = undefined` back to the shared
     * StageNode graph — avoids a race where a concurrent traverser clears the shared
     * resolver before another traverser has finished using it.
     */
    private readonly resolvedLazySubflows;
    /**
     * Recursion depth counter for executeNode.
     * Each recursive executeNode call increments this; decrements on exit (try/finally).
     * Prevents call-stack overflow on infinite loops or excessively deep stage chains.
     */
    private _executeDepth;
    /**
     * Per-instance maximum depth (set from TraverserOptions.maxDepth or the class default).
     */
    private readonly _maxDepth;
    /**
     * Default maximum recursive executeNode depth before an error is thrown.
     * 500 comfortably covers any realistic pipeline depth (including deeply nested
     * subflows) while preventing call-stack overflow (~10 000 frames in V8).
     *
     * **Note on counting:** the counter increments once per `executeNode` call, not once per
     * logical user stage. Subflow root entry and subflow continuation after return each cost
     * one tick. For pipelines with many nested subflows, budget roughly 2 × (avg stages per
     * subflow) of headroom when computing a custom `maxDepth` via `RunOptions.maxDepth`.
     *
     * **Note on loops:** for `loopTo()` pipelines, this depth guard and `ContinuationResolver`'s
     * iteration limit are independent — the lower one fires first. The default depth guard (500)
     * fires before the default iteration limit (1000) for loop-heavy pipelines.
     *
     * @remarks Not safe for concurrent `.execute()` calls on the same instance — concurrent
     * executions race on `_executeDepth`. Use a separate `FlowchartTraverser` per concurrent
     * execution. `FlowChartExecutor.run()` always creates a fresh traverser per call.
     */
    static readonly MAX_EXECUTE_DEPTH = 500;
    constructor(opts: TraverserOptions<TOut, TScope>);
    /**
     * Create a factory that produces FlowchartTraverser instances for subflow execution.
     * Captures parent config in closure — SubflowExecutor provides subflow-specific overrides.
     * Each subflow gets a full traverser with all 7 phases (deciders, selectors, loops, etc.).
     */
    private createSubflowTraverserFactory;
    private createDeps;
    execute(branchPath?: string): Promise<TraversalResult>;
    getRuntimeStructure(): SerializedPipelineStructure | undefined;
    getSnapshot(): {
        sharedState: Record<string, unknown>;
        executionTree: unknown;
        commitLog: unknown[];
        subflowResults?: Record<string, unknown> | undefined;
        recorders?: {
            id: string;
            name: string;
            data: unknown;
        }[] | undefined;
    };
    getRuntime(): IExecutionRuntime;
    setRootObject(path: string[], key: string, value: unknown): void;
    getBranchIds(): string[];
    getRuntimeRoot(): StageNode;
    getSubflowResults(): Map<string, SubflowResult>;
    getExtractedResults<TResult = unknown>(): Map<string, TResult>;
    getExtractorErrors(): ExtractorError[];
    getNarrative(): string[];
    /** Returns the FlowRecorderDispatcher, or undefined if narrative is disabled. */
    getFlowRecorderDispatcher(): FlowRecorderDispatcher | undefined;
    /**
     * Build an O(1) ID→node map from the root graph.
     * Used by NodeResolver to avoid repeated DFS on every loopTo() call.
     * Depth-guarded at MAX_EXECUTE_DEPTH to prevent infinite recursion on cyclic graphs.
     * Dynamic subflows and lazy-resolved nodes are added to stageMap at runtime but not to this map —
     * those use the DFS fallback in NodeResolver.
     */
    private buildNodeIdMap;
    private getStageFn;
    private executeStage;
    /**
     * Pre-order DFS traversal — the core algorithm.
     * Each call processes one node through all 7 phases.
     */
    private executeNode;
    private captureDynamicChildrenResult;
    private computeContextDepth;
    private prefixNodeTree;
    private autoRegisterSubflowDef;
}
