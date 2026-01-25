/**
 * DeciderHandler.ts
 *
 * Handles decider evaluation and branching.
 * Extracted from Pipeline.ts for Single Responsibility Principle.
 *
 * Responsibilities:
 * - Execute decider nodes (stage → commit → decider → chosen child)
 * - Create decider scope context when stage function exists
 * - Log flow control decisions for decider branches
 * - Use NodeResolver.getNextNode to pick chosen child
 *
 * Does NOT handle:
 * - Stage execution (uses runStage callback)
 * - Commit logic (caller handles via context.commitPatch())
 * - Extractor calls (caller handles via callExtractor())
 *
 * _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6_
 */

import { StageContext } from '../context/StageContext';
import { logger } from '../logger';
import type { Decider, StageNode } from './GraphTraverser';
import type { NodeResolver } from './NodeResolver';
import type { PipelineContext, PipelineStageFunction, StageSnapshot } from './types';

/**
 * Callback type for running a stage with commit and extractor.
 * Used by DeciderHandler to run the optional stage before decider evaluation.
 */
export type RunStageFn<TOut = any, TScope = any> = (
  node: StageNode<TOut, TScope>,
  stageFunc: PipelineStageFunction<TOut, TScope>,
  context: StageContext,
  breakFn: () => void,
) => Promise<TOut>;

/**
 * Callback type for executing a node.
 * Used by DeciderHandler to continue execution after choosing a branch.
 */
export type ExecuteNodeFn<TOut = any, TScope = any> = (
  node: StageNode<TOut, TScope>,
  context: StageContext,
  breakFlag: { shouldBreak: boolean },
  branchPath?: string,
) => Promise<any>;

/**
 * Callback type for calling the extractor.
 * Used by DeciderHandler to call the extractor after stage execution.
 */
export type CallExtractorFn<TOut = any, TScope = any> = (
  node: StageNode<TOut, TScope>,
  context: StageContext,
  stagePath: string,
) => void;

/**
 * Callback type for getting the stage path.
 * Used by DeciderHandler to generate the stage path for extractor.
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
 * @template TOut - The output type of stage functions
 * @template TScope - The scope type passed to stage functions
 */
export class DeciderHandler<TOut = any, TScope = any> {
  constructor(
    private readonly ctx: PipelineContext<TOut, TScope>,
    private readonly nodeResolver: NodeResolver<TOut, TScope>,
  ) {}

  /**
   * Handle a decider node.
   *
   * Execution order: stage (optional) → commit → decider → chosen child
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
        context.commitPatch(); // commit partial patch for forensic data
        callExtractor(node, context, getStagePath(node, branchPath));
        logger.error(`Error in pipeline (${branchPath}) stage [${node.name}]:`, { error });
        context.addErrorInfo('stageExecutionError', error.toString());
        throw error;
      }
      context.commitPatch();
      callExtractor(node, context, getStagePath(node, branchPath));

      if (breakFlag.shouldBreak) {
        logger.info(`Execution stopped in pipeline (${branchPath}) after ${node.name} due to break condition.`);
        return stageOutput;
      }
    }

    // Create/mark decider scope right before invoking the decider
    const deciderStageContext = stageFunc
      ? context.createDeciderContext(branchPath as string, 'decider')
      : context.setAsDecider();

    // Use NodeResolver to pick the chosen child
    const chosen = await this.nodeResolver.getNextNode(
      node.nextNodeDecider as Decider,
      node.children as StageNode<TOut, TScope>[],
      stageOutput,
      context,
    );

    // Log flow control decision for decider branch
    // _Requirements: flow-control-narrative REQ-3, REQ-4 (Task 3)
    // Narrative style: "decided based on [data] and chose [path]"
    const rationale = context.getValue([], 'deciderRationale') as string | undefined;
    const chosenName = chosen.displayName || chosen.name;
    const branchDescription = rationale
      ? `Decided based on: ${rationale}. Chose ${chosenName} path.`
      : `Evaluated conditions and chose ${chosenName} path.`;
    context.addFlowDebugMessage('branch', branchDescription, {
      targetStage: chosen.name,
      rationale,
    });

    deciderStageContext.commitPatch();

    // Continue execution with the chosen child
    const nextStageContext = context.createNextContext(branchPath as string, chosen.name);
    return executeNode(chosen, nextStageContext, breakFlag, branchPath);
  }
}
