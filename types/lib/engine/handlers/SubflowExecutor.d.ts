/**
 * SubflowExecutor — Isolation boundary for subflow execution.
 *
 * Responsibilities:
 * - Create isolated ExecutionRuntime for each subflow
 * - Apply input/output mapping via SubflowInputMapper
 * - Delegate traversal to a factory-created FlowchartTraverser
 * - Track subflow results for debugging/visualization
 *
 * Each subflow gets its own GlobalStore for isolation.
 * Traversal uses the SAME 7-phase algorithm as the top-level traverser
 * (via SubflowTraverserFactory), so deciders, selectors, loops, lazy subflows,
 * and abort signals all work inside subflows automatically.
 */
import type { StageContext } from '../../memory/StageContext.js';
import type { StageNode } from '../graph/StageNode.js';
import type { TraversalContext } from '../narrative/types.js';
import type { HandlerDeps, SubflowResult, SubflowTraverserFactory } from '../types.js';
export declare class SubflowExecutor<TOut = any, TScope = any> {
    private deps;
    private traverserFactory;
    constructor(deps: HandlerDeps<TOut, TScope>, traverserFactory: SubflowTraverserFactory<TOut, TScope>);
    /**
     * Execute a subflow with isolated context.
     *
     * 1. Creates a fresh ExecutionRuntime for the subflow
     * 2. Applies input mapping to seed the subflow's GlobalStore
     * 3. Delegates traversal to a factory-created FlowchartTraverser
     * 4. Applies output mapping to write results back to parent scope
     * 5. Stores execution data for debugging/visualization
     */
    executeSubflow(node: StageNode<TOut, TScope>, parentContext: StageContext, breakFlag: {
        shouldBreak: boolean;
    }, branchPath: string | undefined, subflowResultsMap: Map<string, SubflowResult>, parentTraversalContext?: TraversalContext): Promise<any>;
}
