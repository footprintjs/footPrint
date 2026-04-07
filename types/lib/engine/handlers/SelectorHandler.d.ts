/**
 * SelectorHandler — Multi-choice filtered fan-out.
 *
 * Responsibilities:
 * - Execute scope-based selector nodes (stage → commit → resolve children → parallel execution)
 * - The selector function IS a stage: reads scope, returns string[] of branch IDs
 * - Delegates parallel execution of selected children to ChildrenExecutor
 */
import type { StageContext } from '../../memory/StageContext.js';
import type { StageNode } from '../graph/StageNode.js';
import type { TraversalContext } from '../narrative/types.js';
import type { HandlerDeps, NodeResultType, StageFunction } from '../types.js';
import type { ChildrenExecutor } from './ChildrenExecutor.js';
import type { CallExtractorFn, ExecuteNodeFn, GetStagePathFn, RunStageFn } from './types.js';
export declare class SelectorHandler<TOut = any, TScope = any> {
    private readonly deps;
    private readonly childrenExecutor;
    constructor(deps: HandlerDeps<TOut, TScope>, childrenExecutor: ChildrenExecutor<TOut, TScope>);
    /**
     * Handle a scope-based selector node (created via addSelectorFunction).
     * The stage function IS the selector — its return value contains branch IDs.
     * Execution order: runStage(fn) → commit → resolve children → parallel execute.
     */
    handleScopeBased(node: StageNode<TOut, TScope>, stageFunc: StageFunction<TOut, TScope>, context: StageContext, breakFlag: {
        shouldBreak: boolean;
    }, branchPath: string | undefined, runStage: RunStageFn<TOut, TScope>, executeNode: ExecuteNodeFn<TOut, TScope>, callExtractor: CallExtractorFn<TOut, TScope>, getStagePath: GetStagePathFn<TOut, TScope>, traversalContext?: TraversalContext): Promise<Record<string, NodeResultType>>;
}
