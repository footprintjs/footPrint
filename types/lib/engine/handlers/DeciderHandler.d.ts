/**
 * DeciderHandler — Single-choice conditional branching.
 *
 * Handles scope-based deciders (stage IS the decider, returns branch ID).
 * Logs flow control decisions and narrative sentences.
 */
import type { StageContext } from '../../memory/StageContext.js';
import type { StageNode } from '../graph/StageNode.js';
import type { TraversalContext } from '../narrative/types.js';
import type { HandlerDeps, StageFunction } from '../types.js';
import type { CallExtractorFn, ExecuteNodeFn, GetStagePathFn, RunStageFn } from './types.js';
export type { CallExtractorFn, ExecuteNodeFn, GetStagePathFn, RunStageFn };
export declare class DeciderHandler<TOut = any, TScope = any> {
    private readonly deps;
    constructor(deps: HandlerDeps<TOut, TScope>);
    /**
     * Handle a scope-based decider (created via addDeciderFunction).
     * The stage function IS the decider — its return value is the branch ID.
     * Execution order: runStage(fn) → commit → resolve child → log → executeNode(child).
     */
    handleScopeBased(node: StageNode<TOut, TScope>, stageFunc: StageFunction<TOut, TScope>, context: StageContext, breakFlag: {
        shouldBreak: boolean;
    }, branchPath: string | undefined, runStage: RunStageFn<TOut, TScope>, executeNode: ExecuteNodeFn<TOut, TScope>, callExtractor: CallExtractorFn<TOut, TScope>, getStagePath: GetStagePathFn<TOut, TScope>, traversalContext?: TraversalContext): Promise<any>;
}
