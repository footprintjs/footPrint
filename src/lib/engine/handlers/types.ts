/**
 * handlers/types.ts — Shared callback types for all handler modules.
 *
 * Avoids duplicate definitions of ExecuteNodeFn / RunStageFn / etc.
 * across ChildrenExecutor, DeciderHandler, ContinuationResolver, SubflowExecutor.
 * All types are callbacks that break circular dependencies with FlowchartTraverser.
 */

import type { StageContext } from '../../memory/StageContext.js';
import type { StageNode } from '../graph/StageNode.js';
import type { TraversalContext } from '../narrative/types.js';
import type { StageFunction } from '../types.js';

/**
 * Traverser break flag — mutable struct passed through the traversal recursion.
 *
 * `shouldBreak` flips when any stage calls `scope.$break()`. The traverser
 * checks this before scheduling the next node; when set, the stack unwinds
 * cleanly without running subsequent stages.
 *
 * `reason` is the optional string argument passed to `$break(reason)`. It
 * travels alongside `shouldBreak` so downstream code (FlowRecorder onBreak
 * events, subflow-propagation to parent scope) can surface the reason.
 *
 * Adding fields here is backward compatible — existing callers only read
 * `shouldBreak`, and `reason` is optional.
 */
export interface BreakFlag {
  shouldBreak: boolean;
  reason?: string;
}

/** Recursive node execution — avoids circular dep with FlowchartTraverser. */
export type ExecuteNodeFn<TOut = any, TScope = any> = (
  node: StageNode<TOut, TScope>,
  context: StageContext,
  breakFlag: BreakFlag,
  branchPath?: string,
) => Promise<any>;

/**
 * Run a stage function. Bound to `FlowchartTraverser.executeStage`, which is
 * also where a stage's declarative `retry` policy is honoured — so a handler
 * that passes `traversalContext` gets retry evidence stamped with the right
 * stage automatically. The parameter is optional purely for compatibility with
 * hand-written callers; the engine's own handlers always pass it.
 */
export type RunStageFn<TOut = any, TScope = any> = (
  node: StageNode<TOut, TScope>,
  stageFunc: StageFunction<TOut, TScope>,
  context: StageContext,
  breakFn: () => void,
  traversalContext?: TraversalContext,
) => Promise<TOut>;
