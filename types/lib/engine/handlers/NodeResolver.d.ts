/**
 * NodeResolver — DFS node lookup + subflow reference resolution.
 *
 * Responsibilities:
 * - Find nodes by ID via recursive depth-first search (for back-edge/loop support)
 * - Resolve subflow reference nodes to actual subflow structures
 * - Evaluate deciders to determine next node in branching scenarios
 */
import type { StageNode } from '../graph/StageNode.js';
import type { HandlerDeps } from '../types.js';
export declare class NodeResolver<TOut = any, TScope = any> {
    private deps;
    private readonly nodeIdMap;
    constructor(deps: HandlerDeps<TOut, TScope>, nodeIdMap?: Map<string, StageNode<TOut, TScope>>);
    /**
     * O(1) node lookup via pre-built ID map.
     * Falls back to DFS from startNode (for dynamic nodes added at runtime
     * or subflow-local lookups that use an explicit startNode).
     */
    findNodeById(nodeId: string, startNode?: StageNode<TOut, TScope>): StageNode<TOut, TScope> | undefined;
    /**
     * DFS search for a node by ID.
     * Used as fallback when the node is not in the pre-built map.
     */
    private _dfs;
    /**
     * Resolve a subflow reference node to its actual structure.
     *
     * Reference nodes are lightweight placeholders (isSubflowRoot but no fn/children).
     * The actual structure lives in the subflows dictionary.
     */
    resolveSubflowReference(node: StageNode<TOut, TScope>): StageNode<TOut, TScope>;
}
