/**
 * FlowChartBuilder — Fluent API for constructing flowchart execution graphs.
 *
 * Builds StageNode trees and SerializedPipelineStructure (JSON) in tandem.
 * Zero dependencies on old code — only imports from local types.
 *
 * The builder creates two parallel structures:
 * 1. StageNode tree — runtime graph with embedded functions
 * 2. SerializedPipelineStructure — JSON-safe structure for visualization
 *
 * The execute() convenience method is intentionally omitted —
 * it belongs in the runner layer (Phase 5).
 */
import type { ScopeFactory } from '../engine/types.js';
import type { PausableHandler } from '../pause/types.js';
import type { TypedScope } from '../reactive/types.js';
import { type RunnableFlowChart } from '../runner/RunnableChart.js';
import { type TypedStageFunction } from './typedFlowChart.js';
import type { BuildTimeExtractor, FlowChart, FlowChartSpec, ILogger, SerializedPipelineStructure, SimplifiedParallelSpec, StageFunction, StageNode, StreamLifecycleHandler, StreamTokenHandler, SubflowMountOptions, TraversalExtractor } from './types.js';
/**
 * Fluent helper returned by addDeciderFunction to add branches.
 * `end()` sets `deciderFn = true` — the fn IS the decider.
 */
export declare class DeciderList<TOut = any, TScope = any> {
    private readonly b;
    private readonly curNode;
    private readonly curSpec;
    private readonly branchIds;
    private defaultId?;
    private readonly parentDescriptionParts;
    private readonly parentStageDescriptions;
    private readonly reservedStepNumber;
    private readonly deciderDescription?;
    private readonly branchDescInfo;
    constructor(builder: FlowChartBuilder<TOut, TScope>, curNode: StageNode<TOut, TScope>, curSpec: SerializedPipelineStructure, parentDescriptionParts?: string[], parentStageDescriptions?: Map<string, string>, reservedStepNumber?: number, deciderDescription?: string);
    addFunctionBranch(id: string, name: string, fn?: StageFunction<TOut, TScope>, description?: string): DeciderList<TOut, TScope>;
    addSubFlowChartBranch(id: string, subflow: FlowChart<any, any>, mountName?: string, options?: SubflowMountOptions): DeciderList<TOut, TScope>;
    addLazySubFlowChartBranch(id: string, resolver: () => FlowChart<any, any>, mountName?: string, options?: SubflowMountOptions): DeciderList<TOut, TScope>;
    addBranchList(branches: Array<{
        id: string;
        name: string;
        fn?: StageFunction<TOut, TScope>;
    }>): DeciderList<TOut, TScope>;
    setDefault(id: string): DeciderList<TOut, TScope>;
    end(): FlowChartBuilder<TOut, TScope>;
}
export declare class SelectorFnList<TOut = any, TScope = any> {
    private readonly b;
    private readonly curNode;
    private readonly curSpec;
    private readonly branchIds;
    private readonly parentDescriptionParts;
    private readonly parentStageDescriptions;
    private readonly reservedStepNumber;
    private readonly selectorDescription?;
    private readonly branchDescInfo;
    constructor(builder: FlowChartBuilder<TOut, TScope>, curNode: StageNode<TOut, TScope>, curSpec: SerializedPipelineStructure, parentDescriptionParts?: string[], parentStageDescriptions?: Map<string, string>, reservedStepNumber?: number, selectorDescription?: string);
    addFunctionBranch(id: string, name: string, fn?: StageFunction<TOut, TScope>, description?: string): SelectorFnList<TOut, TScope>;
    addSubFlowChartBranch(id: string, subflow: FlowChart<any, any>, mountName?: string, options?: SubflowMountOptions): SelectorFnList<TOut, TScope>;
    addLazySubFlowChartBranch(id: string, resolver: () => FlowChart<any, any>, mountName?: string, options?: SubflowMountOptions): SelectorFnList<TOut, TScope>;
    addBranchList(branches: Array<{
        id: string;
        name: string;
        fn?: StageFunction<TOut, TScope>;
    }>): SelectorFnList<TOut, TScope>;
    end(): FlowChartBuilder<TOut, TScope>;
}
export declare class FlowChartBuilder<TOut = any, TScope = any> {
    private _root?;
    private _rootSpec?;
    private _cursor?;
    private _cursorSpec?;
    private _stageMap;
    _subflowDefs: Map<string, {
        root: StageNode<TOut, TScope>;
    }>;
    private _streamHandlers;
    private _extractor?;
    private _buildTimeExtractor?;
    private _buildTimeExtractorErrors;
    private _enableNarrative;
    private _logger?;
    private _descriptionParts;
    private _stepCounter;
    private _stageDescriptions;
    private _stageStepMap;
    private _knownStageIds;
    private _inputSchema?;
    private _outputSchema?;
    private _outputMapper?;
    private _scopeFactory?;
    constructor(buildTimeExtractor?: BuildTimeExtractor<any>);
    private _appendDescriptionLine;
    private _appendSubflowDescription;
    setLogger(logger: ILogger): this;
    /**
     * Declare the API contract — input validation, output shape, and output mapper.
     * Replaces setInputSchema() + setOutputSchema() + setOutputMapper() in a single call.
     *
     * If a contract with input schema is declared, chart.run() validates input automatically.
     * Contract data is used by chart.toOpenAPI() and chart.toMCPTool().
     */
    contract(opts: {
        input?: unknown;
        output?: unknown;
        mapper?: (finalScope: Record<string, unknown>) => unknown;
    }): this;
    start(name: string, fn: StageFunction<TOut, TScope> | PausableHandler<TScope>, id: string, description?: string): this;
    addFunction(name: string, fn: StageFunction<TOut, TScope>, id: string, description?: string): this;
    addStreamingFunction(name: string, fn: StageFunction<TOut, TScope>, id: string, streamId?: string, description?: string): this;
    /**
     * Add a pausable stage — can pause execution and resume later with input.
     *
     * The handler has two phases:
     * - `execute`: runs first time. Return `{ pause: true }` to pause.
     * - `resume`: runs when the flowchart is resumed with input.
     *
     * @example
     * ```typescript
     * .addPausableFunction('ApproveOrder', {
     *   execute: async (scope) => {
     *     scope.orderId = '123';
     *     return { pause: true, data: { question: 'Approve?' } };
     *   },
     *   resume: async (scope, input) => {
     *     scope.approved = input.approved;
     *   },
     * }, 'approve-order', 'Manager approval gate')
     * ```
     */
    addPausableFunction(name: string, handler: PausableHandler<TScope>, id: string, description?: string): this;
    addDeciderFunction(name: string, fn: StageFunction<any, TScope>, id: string, description?: string): DeciderList<TOut, TScope>;
    addSelectorFunction(name: string, fn: StageFunction<any, TScope>, id: string, description?: string): SelectorFnList<TOut, TScope>;
    addListOfFunction(children: SimplifiedParallelSpec<TOut, TScope>[], options?: {
        failFast?: boolean;
    }): this;
    addSubFlowChart(id: string, subflow: FlowChart<any, any>, mountName?: string, options?: SubflowMountOptions): this;
    addLazySubFlowChart(id: string, resolver: () => FlowChart<TOut, TScope>, mountName?: string, options?: SubflowMountOptions): this;
    addLazySubFlowChartNext(id: string, resolver: () => FlowChart<TOut, TScope>, mountName?: string, options?: SubflowMountOptions): this;
    addSubFlowChartNext(id: string, subflow: FlowChart<any, any>, mountName?: string, options?: SubflowMountOptions): this;
    loopTo(stageId: string): this;
    onStream(handler: StreamTokenHandler): this;
    onStreamStart(handler: StreamLifecycleHandler): this;
    onStreamEnd(handler: StreamLifecycleHandler): this;
    addTraversalExtractor<TResult = unknown>(extractor: TraversalExtractor<TResult>): this;
    addBuildTimeExtractor<TResult = FlowChartSpec>(extractor: BuildTimeExtractor<TResult>): this;
    getBuildTimeExtractorErrors(): Array<{
        message: string;
        error: unknown;
    }>;
    build(): RunnableFlowChart<TOut, TScope>;
    /** Override the scope factory. Rarely needed — auto-embeds TypedScope by default. */
    setScopeFactory(factory: ScopeFactory<TScope>): this;
    toSpec<TResult = SerializedPipelineStructure>(): TResult;
    toMermaid(): string;
    private _needCursor;
    private _needCursorSpec;
    _applyExtractorToNode(spec: SerializedPipelineStructure): SerializedPipelineStructure;
    _stageMapHas(key: string): boolean;
    _addToMap(id: string, fn: StageFunction<TOut, TScope>): void;
    _mergeStageMap(other: Map<string, StageFunction<TOut, TScope>>, prefix?: string): void;
    _prefixNodeTree(node: StageNode<TOut, TScope>, prefix: string): StageNode<TOut, TScope>;
    _mergeSubflows(subflows: Record<string, {
        root: StageNode<TOut, TScope>;
    }> | undefined, prefix: string): void;
}
export declare function flowChart<TState extends object>(name: string, fn: TypedStageFunction<TState> | PausableHandler<TypedScope<TState>>, id: string, buildTimeExtractor?: BuildTimeExtractor<any>, description?: string): FlowChartBuilder<any, TypedScope<TState>>;
export declare function flowChart<TOut = any, TScope = any>(name: string, fn: StageFunction<TOut, TScope> | PausableHandler<TScope>, id: string, buildTimeExtractor?: BuildTimeExtractor<any>, description?: string): FlowChartBuilder<TOut, TScope>;
export declare function specToStageNode(spec: FlowChartSpec): StageNode<any, any>;
