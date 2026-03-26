/**
 * handlers/types.ts — Shared callback types for all handler modules.
 *
 * Avoids duplicate definitions of ExecuteNodeFn / CallExtractorFn / etc.
 * across ChildrenExecutor, DeciderHandler, ContinuationResolver, SubflowExecutor.
 * All types are callbacks that break circular dependencies with FlowchartTraverser.
 */

import type { StageContext } from '../../memory/StageContext.js';
import type { StageNode } from '../graph/StageNode.js';
import type { StageFunction } from '../types.js';

/** Recursive node execution — avoids circular dep with FlowchartTraverser. */
export type ExecuteNodeFn<TOut = any, TScope = any> = (
  node: StageNode<TOut, TScope>,
  context: StageContext,
  breakFlag: { shouldBreak: boolean },
  branchPath?: string,
) => Promise<any>;

/** Run a stage function with commit + extractor. */
export type RunStageFn<TOut = any, TScope = any> = (
  node: StageNode<TOut, TScope>,
  stageFunc: StageFunction<TOut, TScope>,
  context: StageContext,
  breakFn: () => void,
) => Promise<TOut>;

/** Call the traversal extractor after stage execution. */
export type CallExtractorFn<TOut = any, TScope = any> = (
  node: StageNode<TOut, TScope>,
  context: StageContext,
  stagePath: string,
  stageOutput?: unknown,
  errorInfo?: { type: string; message: string },
) => void;

/** Compute the stage path string for extractor and narrative. */
export type GetStagePathFn<TOut = any, TScope = any> = (
  node: StageNode<TOut, TScope>,
  branchPath?: string,
  contextStageName?: string,
) => string;
