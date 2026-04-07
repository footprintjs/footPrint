/**
 * RuntimeStructureManager — Mutable structure tracking for visualization.
 *
 * During execution, dynamic events (new children, subflows, next chains,
 * loop iterations) modify the pipeline. This manager keeps a serialized
 * structure in sync so consumers get the complete picture.
 *
 * Deep-clones build-time structure at init, then maintains O(1) lookup map.
 */
import type { StageNode } from '../graph/StageNode.js';
import type { SerializedPipelineStructure } from '../types.js';
/**
 * Compute the node type from node properties.
 * Shared by RuntimeStructureManager (serialization) and ExtractorRunner (metadata).
 */
export declare function computeNodeType(node: StageNode): 'stage' | 'decider' | 'selector' | 'fork' | 'streaming' | 'subflow' | 'loop';
export declare class RuntimeStructureManager {
    private runtimePipelineStructure?;
    private structureNodeMap;
    /** Initialize from build-time structure. Deep-clones via JSON round-trip. */
    init(buildTimeStructure?: SerializedPipelineStructure): void;
    /** Returns the current runtime structure (mutated during execution). */
    getStructure(): SerializedPipelineStructure | undefined;
    private static readonly MAX_NODE_MAP_DEPTH;
    /** Recursively registers all nodes in the O(1) lookup map. */
    private buildNodeMap;
    /** Convert a runtime StageNode into a SerializedPipelineStructure node. */
    stageNodeToStructure(node: StageNode): SerializedPipelineStructure;
    /** Update structure when dynamic children are discovered at runtime. */
    updateDynamicChildren(parentNodeId: string, dynamicChildren: StageNode[], hasSelector?: boolean, hasDecider?: boolean): void;
    /** Update structure when a dynamic subflow is registered at runtime. */
    updateDynamicSubflow(mountNodeId: string, subflowId: string, subflowName?: string, subflowBuildTimeStructure?: unknown): void;
    /** Update structure when a dynamic next chain is discovered at runtime. */
    updateDynamicNext(currentNodeId: string, dynamicNext: StageNode): void;
    /** Update the iteration count for a node (loop support). */
    updateIterationCount(nodeId: string, count: number): void;
}
