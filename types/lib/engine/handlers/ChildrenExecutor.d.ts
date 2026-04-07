/**
 * ChildrenExecutor — Parallel fan-out via Promise.allSettled.
 *
 * Responsibilities:
 * - Execute all children in parallel (fork pattern)
 * - Execute selected children based on selector output (multi-choice)
 * - Handle throttling error flagging for rate-limited operations
 * - Aggregate results into { childId: { result, isError } }
 */
import type { StageContext } from '../../memory/StageContext.js';
import type { Selector, StageNode } from '../graph/StageNode.js';
import type { TraversalContext } from '../narrative/types.js';
import type { HandlerDeps, NodeResultType } from '../types.js';
import type { ExecuteNodeFn } from './types.js';
export type { ExecuteNodeFn };
export declare class ChildrenExecutor<TOut = any, TScope = any> {
    private deps;
    private executeNode;
    constructor(deps: HandlerDeps<TOut, TScope>, executeNode: ExecuteNodeFn<TOut, TScope>);
    /**
     * Execute all children in parallel. Each child commits on settle.
     * Uses Promise.allSettled to ensure all children complete even if some fail.
     */
    executeNodeChildren(node: StageNode<TOut, TScope>, context: StageContext, parentBreakFlag?: {
        shouldBreak: boolean;
    }, branchPath?: string, traversalContext?: TraversalContext): Promise<Record<string, NodeResultType>>;
    /**
     * Execute selected children based on selector result.
     * Validates IDs, records selection info, then delegates to executeNodeChildren.
     */
    executeSelectedChildren(selector: Selector, children: StageNode<TOut, TScope>[], input: any, context: StageContext, branchPath: string, traversalContext?: TraversalContext): Promise<Record<string, NodeResultType>>;
}
