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

/** Callback for running a stage with commit + extractor. Avoids circular dep with traverser. */
export type RunStageFn<TOut = any, TScope = any> = (
  node: StageNode<TOut, TScope>,
  stageFunc: StageFunction<TOut, TScope>,
  context: StageContext,
  breakFn: () => void,
) => Promise<TOut>;

/** Callback for recursive node execution. Avoids circular dep with traverser. */
export type ExecuteNodeFn<TOut = any, TScope = any> = (
  node: StageNode<TOut, TScope>,
  context: StageContext,
  breakFlag: { shouldBreak: boolean },
  branchPath?: string,
) => Promise<any>;

/** Callback for calling the extractor after stage execution. */
export type CallExtractorFn<TOut = any, TScope = any> = (
  node: StageNode<TOut, TScope>,
  context: StageContext,
  stagePath: string,
  stageOutput?: unknown,
  errorInfo?: { type: string; message: string },
) => void;

/** Callback for computing the stage path for extractor. */
export type GetStagePathFn<TOut = any, TScope = any> = (
  node: StageNode<TOut, TScope>,
  branchPath?: string,
  contextStageName?: string,
) => string;

export class DeciderHandler<TOut = any, TScope = any> {
  constructor(private readonly deps: HandlerDeps<TOut, TScope>) {}

  /**
   * Handle a scope-based decider (created via addDeciderFunction).
   * The stage function IS the decider — its return value is the branch ID.
   * Execution order: runStage(fn) → commit → resolve child → log → executeNode(child).
   */
  async handleScopeBased(
    node: StageNode<TOut, TScope>,
    stageFunc: StageFunction<TOut, TScope>,
    context: StageContext,
    breakFlag: { shouldBreak: boolean },
    branchPath: string | undefined,
    runStage: RunStageFn<TOut, TScope>,
    executeNode: ExecuteNodeFn<TOut, TScope>,
    callExtractor: CallExtractorFn<TOut, TScope>,
    getStagePath: GetStagePathFn<TOut, TScope>,
    traversalContext?: TraversalContext,
  ): Promise<any> {
    const breakFn = () => (breakFlag.shouldBreak = true);

    let branchId: string;
    try {
      const stageOutput = await runStage(node, stageFunc, context, breakFn);
      branchId = String(stageOutput);
    } catch (error: any) {
      context.commit();
      callExtractor(node, context, getStagePath(node, branchPath, context.stageName), undefined, {
        type: 'stageExecutionError',
        message: error.toString(),
      });
      this.deps.logger.error(`Error in pipeline (${branchPath}) stage [${node.name}]:`, { error });
      context.addError('stageExecutionError', error.toString());
      this.deps.narrativeGenerator.onError(node.name, error.toString(), error, traversalContext);
      throw error;
    }

    context.commit();
    callExtractor(node, context, getStagePath(node, branchPath, context.stageName), branchId);

    if (breakFlag.shouldBreak) {
      this.deps.logger.info(`Execution stopped in pipeline (${branchPath}) after ${node.name} due to break condition.`);
      return branchId;
    }

    // Resolve child by matching branch ID against node.children
    const children = node.children as StageNode<TOut, TScope>[];
    let chosen = children.find((child) => child.id === branchId);

    // Fall back to default branch
    if (!chosen) {
      const defaultChild = children.find((child) => child.id === 'default');
      if (defaultChild) {
        chosen = defaultChild;
      } else {
        const errorMessage = `Scope-based decider '${node.name}' returned branch ID '${branchId}' which doesn't match any child and no default branch is set`;
        context.addError('deciderError', errorMessage);
        throw new Error(errorMessage);
      }
    }

    const chosenName = chosen.name;
    const wasDefault = chosen.id !== branchId;
    const rationale = context.debug?.logContext?.deciderRationale as string | undefined;
    let branchReason: string;
    if (wasDefault) {
      branchReason = `Returned '${branchId}' (no match), fell back to default → ${chosenName} path.`;
    } else if (rationale) {
      branchReason = `Based on: ${rationale} → chose ${chosenName} path.`;
    } else {
      branchReason = `Evaluated scope and returned '${branchId}' → chose ${chosenName} path.`;
    }
    context.addFlowDebugMessage('branch', branchReason, {
      targetStage: chosen.name,
      rationale: rationale || `returned branchId: ${branchId}`,
    });

    this.deps.narrativeGenerator.onDecision(node.name, chosen.name, rationale, node.description, traversalContext);

    const branchContext = context.createChild(branchPath as string, chosen.id, chosen.name, chosen.id);
    return executeNode(chosen, branchContext, breakFlag, branchPath);
  }
}
