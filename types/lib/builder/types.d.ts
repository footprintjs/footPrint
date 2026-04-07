/**
 * builder/types.ts — All types used by the builder library.
 *
 * Shared types (StageNode, StageFunction, etc.) are imported from the engine.
 * Builder-specific types (FlowChartSpec, FlowChart, SerializedPipelineStructure)
 * are defined locally — they carry builder-only fields (description, outputMapper, etc.).
 *
 * NOTE: All engine imports are `import type` — zero runtime dependency.
 * The builder remains standalone at runtime.
 */
import type { StageNode } from '../engine/graph/StageNode.js';
import type { ILogger, ScopeFactory, StageFunction, TraversalExtractor } from '../engine/types.js';
import type { ScopeProtectionMode } from '../scope/protection/types.js';
export type { ResumeFn, StageNode } from '../engine/graph/StageNode.js';
export type { ILogger, StageFunction, StreamCallback, StreamHandlers, StreamLifecycleHandler, StreamTokenHandler, SubflowMountOptions, } from '../engine/types.js';
export { ArrayMergeMode } from '../engine/types.js';
/** Relaxed-generic alias for builder ergonomics. */
export type StageFn = StageFunction<any, any>;
export type { ScopeProtectionMode };
export interface SerializedPipelineStructure {
    name: string;
    id: string;
    type: 'stage' | 'decider' | 'selector' | 'fork' | 'streaming' | 'subflow' | 'loop';
    /** Semantic icon hint for visualization (e.g., "llm", "tool", "rag", "agent", "start") */
    icon?: string;
    description?: string;
    children?: SerializedPipelineStructure[];
    next?: SerializedPipelineStructure;
    hasDecider?: boolean;
    hasSelector?: boolean;
    branchIds?: string[];
    loopTarget?: string;
    isStreaming?: boolean;
    streamId?: string;
    isParallelChild?: boolean;
    parallelGroupId?: string;
    isSubflowRoot?: boolean;
    subflowId?: string;
    subflowName?: string;
    /**
     * Nested pipeline structure for a subflow node.
     * WARNING: Any future walker that traverses this field recursively must apply its own
     * depth guard (see MAX_WALK_DEPTH in contract/openapi.ts). The current `buildDescription`
     * walk in openapi.ts does NOT traverse subflowStructure — if it ever does, the depth
     * guard must cover both the `next` chain and this nested structure.
     */
    subflowStructure?: SerializedPipelineStructure;
    iterationCount?: number;
    /** True when this subflow uses lazy resolution (deferred until execution). */
    isLazy?: boolean;
    /** True when this node is a back-edge reference created by loopTo() — not an executable stage. */
    isLoopReference?: boolean;
    /** When true, this stage can pause execution (PausableHandler pattern). */
    isPausable?: boolean;
}
export interface FlowChartSpec {
    name: string;
    id: string;
    /** Node type — matches `SerializedPipelineStructure.type` for visualization alignment. */
    type?: 'stage' | 'decider' | 'selector' | 'fork' | 'streaming' | 'subflow' | 'loop';
    /** Semantic icon hint for visualization (e.g., "llm", "tool", "rag", "agent", "start") */
    icon?: string;
    description?: string;
    children?: FlowChartSpec[];
    next?: FlowChartSpec;
    hasDecider?: boolean;
    hasSelector?: boolean;
    branchIds?: string[];
    loopTarget?: string;
    isStreaming?: boolean;
    streamId?: string;
    isParallelChild?: boolean;
    parallelGroupId?: string;
    isSubflowRoot?: boolean;
    subflowId?: string;
    subflowName?: string;
    /** True when this node is a back-edge reference created by loopTo() — not an executable stage. */
    isLoopReference?: boolean;
}
/** Metadata provided to the build-time extractor for each node. */
export type BuildTimeNodeMetadata = FlowChartSpec;
export type BuildTimeExtractor<TResult = FlowChartSpec> = (metadata: BuildTimeNodeMetadata) => TResult;
export type { TraversalExtractor } from '../engine/types.js';
export type FlowChart<TOut = any, TScope = any> = {
    root: StageNode<TOut, TScope>;
    stageMap: Map<string, StageFunction<TOut, TScope>>;
    extractor?: TraversalExtractor;
    subflows?: Record<string, {
        root: StageNode<TOut, TScope>;
    }>;
    buildTimeStructure: SerializedPipelineStructure;
    enableNarrative?: boolean;
    logger?: ILogger;
    description: string;
    stageDescriptions: Map<string, string>;
    /** Input schema (Zod or JSON Schema) — declared via setInputSchema() or .contract(). */
    inputSchema?: unknown;
    /** Output schema (Zod or JSON Schema) — declared via setOutputSchema() or .contract(). */
    outputSchema?: unknown;
    /** Output mapper — extracts response from final scope. */
    outputMapper?: (finalScope: Record<string, unknown>) => unknown;
    /** Scope factory — auto-embedded by flowChart<T>(). Executor reads this if no factory param. */
    scopeFactory?: ScopeFactory<TScope>;
};
export type SimplifiedParallelSpec<TOut = any, TScope = any> = {
    id: string;
    name: string;
    fn?: StageFunction<TOut, TScope>;
};
export type ExecOptions = {
    defaults?: unknown;
    initial?: unknown;
    readOnly?: unknown;
    throttlingErrorChecker?: (e: unknown) => boolean;
    scopeProtectionMode?: ScopeProtectionMode;
    enableNarrative?: boolean;
};
export interface SubflowRef {
    $ref: string;
    mountId: string;
}
