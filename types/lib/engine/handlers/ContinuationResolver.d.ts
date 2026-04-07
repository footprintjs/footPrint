/**
 * ContinuationResolver — Back-edge resolution + iteration counting.
 *
 * Resolves dynamic continuations (loop-backs, dynamic next) and tracks
 * per-node iteration counts for context tree naming.
 *
 * Supports three dynamicNext patterns:
 * - String ID → reference to existing node (resolve via NodeResolver)
 * - StageNode with fn → truly dynamic node (execute directly)
 * - StageNode without fn → reference by ID (resolve via NodeResolver)
 */
import type { StageContext } from '../../memory/StageContext.js';
import type { StageNode } from '../graph/StageNode.js';
import type { TraversalContext } from '../narrative/types.js';
import type { HandlerDeps } from '../types.js';
import type { NodeResolver } from './NodeResolver.js';
import type { ExecuteNodeFn } from './types.js';
export declare const DEFAULT_MAX_ITERATIONS = 1000;
export declare class ContinuationResolver<TOut = any, TScope = any> {
    private readonly deps;
    private readonly nodeResolver;
    /**
     * Iteration counter per node ID.
     * Key: node.id, Value: visit count (0 = first visit).
     */
    private iterationCounters;
    private readonly onIterationUpdate?;
    private readonly maxIterations;
    constructor(deps: HandlerDeps<TOut, TScope>, nodeResolver: NodeResolver<TOut, TScope>, onIterationUpdate?: (nodeId: string, count: number) => void, maxIterations?: number);
    /**
     * Resolve a dynamic continuation.
     * Dispatches to handleStringReference, handleDirectNode, or handleNodeReference
     * based on the dynamicNext type.
     */
    resolve(dynamicNext: string | StageNode<TOut, TScope>, node: StageNode<TOut, TScope>, context: StageContext, breakFlag: {
        shouldBreak: boolean;
    }, branchPath: string | undefined, executeNode: ExecuteNodeFn<TOut, TScope>, traversalContext?: TraversalContext): Promise<any>;
    /** dynamicNext is a string ID → resolve from graph, track iteration. */
    private handleStringReference;
    /** dynamicNext is a StageNode with fn → execute directly (truly dynamic). */
    private handleDirectNode;
    /** dynamicNext is a StageNode without fn → reference by ID, resolve + track iteration. */
    private handleNodeReference;
    /**
     * Get the next iteration number for a node and increment.
     * Returns 0 for first visit, 1 for second, etc.
     * Throws if maxIterations exceeded (infinite loop guard).
     */
    getAndIncrementIteration(nodeId: string): number;
    /**
     * Generate an iterated stage name for context tree.
     * First visit: "askLLM", second: "askLLM.1", third: "askLLM.2".
     */
    getIteratedStageName(baseName: string, iteration: number): string;
}
