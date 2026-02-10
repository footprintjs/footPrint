/**
 * DeciderHandler.ts
 *
 * WHY: Handles decider evaluation and branching for the Pipeline.
 * This module is extracted from Pipeline.ts following the Single Responsibility Principle,
 * isolating the concerns of decider handling from pipeline traversal.
 *
 * RESPONSIBILITIES:
 * - Execute decider nodes (stage → commit → decider → chosen child)
 * - Create decider scope context when stage function exists
 * - Log flow control decisions for decider branches
 * - Use NodeResolver.getNextNode to pick chosen child
 *
 * DESIGN DECISIONS:
 * - Decider evaluation happens AFTER stage execution (if present)
 * - Decider context is created right before invoking the decider for proper scoping
 * - Flow control messages include rationale when available for debugging
 *
 * DOES NOT HANDLE:
 * - Stage execution (uses runStage callback)
 * - Commit logic (caller handles via context.commitPatch())
 * - Extractor calls (caller handles via callExtractor())
 *
 * RELATED:
 * - {@link Pipeline} - Orchestrates when deciders are evaluated
 * - {@link NodeResolver} - Used to pick the chosen child via getNextNode
 * - {@link StageContext} - Used for debug info and context creation
 *
 * _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6_
 */

import { StageContext } from '../../memory/StageContext';
import { logger } from '../../../utils/logger';
import type { Decider, StageNode } from '../Pipeline';
import type { NodeResolver } from './NodeResolver';
import type { PipelineContext, PipelineStageFunction, StageSnapshot } from '../types';

/**
 * Callback type for running a stage with commit and extractor.
 *
 * WHY: Used by DeciderHandler to run the optional stage before decider evaluation.
 * This avoids circular dependency with Pipeline.
 */
export type RunStageFn<TOut = any, TScope = any> = (
  node: StageNode<TOut, TScope>,
  stageFunc: PipelineStageFunction<TOut, TScope>,
  context: StageContext,
  breakFn: () => void,
) => Promise<TOut>;

/**
 * Callback type for executing a node.
 *
 * WHY: Used by DeciderHandler to continue execution after choosing a branch.
 * This avoids circular dependency with Pipeline.
 */
export type ExecuteNodeFn<TOut = any, TScope = any> = (
  node: StageNode<TOut, TScope>,
  context: StageContext,
  breakFlag: { shouldBreak: boolean },
  branchPath?: string,
) => Promise<any>;

/**
 * Callback type for calling the extractor.
 *
 * WHY: Used by DeciderHandler to call the extractor after stage execution.
 * This avoids circular dependency with Pipeline.
 */
export type CallExtractorFn<TOut = any, TScope = any> = (
  node: StageNode<TOut, TScope>,
  context: StageContext,
  stagePath: string,
) => void;

/**
 * Callback type for getting the stage path.
 *
 * WHY: Used by DeciderHandler to generate the stage path for extractor.
 * This avoids circular dependency with Pipeline.
 */
export type GetStagePathFn<TOut = any, TScope = any> = (
  node: StageNode<TOut, TScope>,
  branchPath?: string,
) => string;

/**
 * DeciderHandler
 * ------------------------------------------------------------------
 * Handles decider evaluation and branching.
 *
 * WHY: Deciders are a common pattern in pipelines for conditional branching.
 * This class centralizes all decider-related logic in one place.
 *
 * DESIGN: Uses callbacks for stage execution and node execution to avoid
 * circular dependencies with Pipeline.
 *
 * @template TOut - The output type of stage functions
 * @template TScope - The scope type passed to stage functions
 *
 * @example
 * ```typescript
 * const handler = new DeciderHandler(pipelineContext, nodeResolver);
 * const result = await handler.handle(node, stageFunc, context, breakFlag, branchPath, ...callbacks);
 * ```
 */
export class DeciderHandler<TOut = any, TScope = any> {
  constructor(
    private readonly ctx: PipelineContext<TOut, TScope>,
    private readonly nodeResolver: NodeResolver<TOut, TScope>,
  ) {}

  /**
   * Handle a decider node.
   *
   * WHY: Decider nodes need special handling because they:
   * 1. May have an optional stage function that runs first
   * 2. Evaluate a decider function to pick exactly one child
   * 3. Continue execution with only the chosen child
   *
   * DESIGN: Execution order: stage (optional) → commit → decider → chosen child
   *
   * @param node - The decider node (has nextNodeDecider)
   * @param stageFunc - The stage function (may be undefined)
   * @param context - The stage context
   * @param breakFlag - Break flag for propagation
   * @param branchPath - Branch path for logging
   * @param runStage - Callback to run the stage function
   * @param executeNode - Callback to execute the chosen child
   * @param callExtractor - Callback to call the extractor
   * @param getStagePath - Callback to get the stage path
   * @returns The result of executing the chosen child
   *
   * _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5_
   */
  async handle(
    node: StageNode<TOut, TScope>,
    stageFunc: PipelineStageFunction<TOut, TScope> | undefined,
    context: StageContext,
    breakFlag: { shouldBreak: boolean },
    branchPath: string | undefined,
    runStage: RunStageFn<TOut, TScope>,
    executeNode: ExecuteNodeFn<TOut, TScope>,
    callExtractor: CallExtractorFn<TOut, TScope>,
    getStagePath: GetStagePathFn<TOut, TScope>,
  ): Promise<any> {
    const breakFn = () => (breakFlag.shouldBreak = true);
    let stageOutput: TOut | undefined;

    // Execute stage if present (stage → commit → decider → chosen child)
    if (stageFunc) {
      try {
        stageOutput = await runStage(node, stageFunc, context, breakFn);
      } catch (error: any) {
        context.commit(); // commit partial patch for forensic data
        callExtractor(node, context, getStagePath(node, branchPath));
        logger.error(`Error in pipeline (${branchPath}) stage [${node.name}]:`, { error });
        context.addError('stageExecutionError', error.toString());
        throw error;
      }
      context.commit();
      callExtractor(node, context, getStagePath(node, branchPath));

      if (breakFlag.shouldBreak) {
        logger.info(`Execution stopped in pipeline (${branchPath}) after ${node.name} due to break condition.`);
        return stageOutput;
      }
    }

    // Create/mark decider scope right before invoking the decider
    // WHY: Proper scoping ensures decider debug info is in the right context
    const deciderStageContext = stageFunc
      ? context.createDecider(branchPath as string, 'decider')
      : context.setAsDecider();

    // Use NodeResolver to pick the chosen child
    const chosen = await this.nodeResolver.getNextNode(
      node.nextNodeDecider as Decider,
      node.children as StageNode<TOut, TScope>[],
      stageOutput,
      context,
    );

    // Log flow control decision for decider branch
    // WHY: Narrative style helps with debugging ("decided based on [data] and chose [path]")
    const rationale = context.getValue([], 'deciderRationale') as string | undefined;
    const chosenName = chosen.displayName || chosen.name;
    const branchDescription = rationale
      ? `Decided based on: ${rationale}. Chose ${chosenName} path.`
      : `Evaluated conditions and chose ${chosenName} path.`;
    context.addFlowDebugMessage('branch', branchDescription, {
      targetStage: chosen.name,
      rationale,
    });

    deciderStageContext.commit();

    // Continue execution with the chosen child
    // WHY: We create the next context from deciderStageContext (not the original context)
    // so the chosen child gets its own node in the context tree. Previously, calling
    // context.createNext() would return the already-set decider context (since createNext
    // returns existing this.next if set), causing the chosen child to share the decider's
    // context node and be invisible in the execution order / treeContext serialization.
    const nextStageContext = deciderStageContext.createNext(branchPath as string, chosen.name);
    return executeNode(chosen, nextStageContext, breakFlag, branchPath);
  }
}
