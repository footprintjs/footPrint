/**
 * DeciderHandler — Single-choice conditional branching.
 *
 * Handles scope-based deciders (stage IS the decider, returns branch ID).
 * Logs flow control decisions and narrative sentences.
 *
 * Two entry points:
 * - `prepareDispatch` — runs the decider stage, commits, resolves the chosen
 *   branch, fires narrative, and returns the chosen node + branch context
 *   WITHOUT executing it. The traverser's trampoline driver uses this so a
 *   decider with no continuation of its own can hand the branch to the
 *   driver as a flat hop (loop-heavy decider charts stay flat-stacked).
 * - `handleScopeBased` — prepareDispatch + immediate branch execution via
 *   the provided `executeNode` callback. Kept for direct/advanced callers
 *   and for deciders whose own `.next` must run after the branch completes.
 */

import type { DecisionEvidence } from '../../decide/types.js';
import { DECISION_RESULT } from '../../decide/types.js';
import type { StageContext } from '../../memory/StageContext.js';
import { isPauseSignal } from '../../pause/types.js';
import type { StageNode } from '../graph/StageNode.js';
import type { TraversalContext } from '../narrative/types.js';
import type { HandlerDeps, StageFunction } from '../types.js';
import type { ExecuteNodeFn, RunStageFn } from './types.js';

export type { ExecuteNodeFn, RunStageFn };

/**
 * Result of `prepareDispatch` — either the decider stage broke (no branch
 * runs; `branchId` is the decider's return value), or a branch was chosen
 * and is ready to execute in `branchContext`.
 */
export type DeciderDispatch<TOut = any, TScope = any> =
  | { kind: 'break'; branchId: string }
  | { kind: 'dispatch'; chosen: StageNode<TOut, TScope>; branchContext: StageContext };

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
    traversalContext?: TraversalContext,
  ): Promise<any> {
    const dispatch = await this.prepareDispatch(
      node,
      stageFunc,
      context,
      breakFlag,
      branchPath,
      runStage,
      traversalContext,
    );

    if (dispatch.kind === 'break') {
      return dispatch.branchId;
    }

    try {
      return await executeNode(dispatch.chosen, dispatch.branchContext, breakFlag, branchPath);
    } catch (error: unknown) {
      // Stamp invoker context on PauseSignal during bubble-up.
      // The decider (node) is the invoker; its .next is the continuation target.
      if (isPauseSignal(error)) {
        error.setInvoker(node.id!, node.next?.id);
        throw error;
      }
      throw error;
    }
  }

  /**
   * Run the decider stage and resolve the chosen branch WITHOUT executing it.
   * Everything up to (and including) the `onDecision`/`onStageExecuted`
   * narrative and the branch context creation happens here — only the
   * branch execution itself is left to the caller.
   */
  async prepareDispatch(
    node: StageNode<TOut, TScope>,
    stageFunc: StageFunction<TOut, TScope>,
    context: StageContext,
    breakFlag: { shouldBreak: boolean },
    branchPath: string | undefined,
    runStage: RunStageFn<TOut, TScope>,
    traversalContext?: TraversalContext,
  ): Promise<DeciderDispatch<TOut, TScope>> {
    const breakFn = () => (breakFlag.shouldBreak = true);

    let branchId: string;
    let decisionEvidence: DecisionEvidence | undefined;
    try {
      const stageOutput = await runStage(node, stageFunc, context, breakFn);
      // Detect DecisionResult from decide() helper via Symbol brand
      if (stageOutput && typeof stageOutput === 'object' && Reflect.has(stageOutput as object, DECISION_RESULT)) {
        branchId = (stageOutput as any).branch;
        decisionEvidence = (stageOutput as any).evidence;
      } else {
        branchId = String(stageOutput);
      }
    } catch (error: any) {
      // PauseSignal is expected control flow — commit and re-throw without error logging.
      if (isPauseSignal(error)) {
        context.commit();
        throw error;
      }
      context.commit();
      this.deps.logger.error(`Error in pipeline (${branchPath}) stage [${node.name}]:`, { error });
      context.addError('stageExecutionError', error.toString());
      this.deps.narrativeGenerator.onError(node.name, error.toString(), error, traversalContext);
      throw error;
    }

    context.commit();

    if (breakFlag.shouldBreak) {
      return { kind: 'break', branchId };
    }

    // Resolve child by matching branch ID against node.children.
    // Match branchId first (original unprefixed ID), fall back to id for backward compat.
    const children = node.children as StageNode<TOut, TScope>[];
    let chosen = children.find((child) => (child.branchId ?? child.id) === branchId);

    // Fall back to default branch
    if (!chosen) {
      const defaultChild = children.find((child) => (child.branchId ?? child.id) === 'default');
      if (defaultChild) {
        chosen = defaultChild;
      } else {
        const errorMessage = `Scope-based decider '${node.name}' returned branch ID '${branchId}' which doesn't match any child and no default branch is set`;
        context.addError('deciderError', errorMessage);
        throw new Error(errorMessage);
      }
    }

    const chosenName = chosen.name;
    const wasDefault = (chosen.branchId ?? chosen.id) !== branchId;
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

    this.deps.narrativeGenerator.onDecision(
      node.name,
      chosen.name,
      rationale,
      node.description,
      traversalContext,
      decisionEvidence,
    );
    // Proposal #003: fire onStageExecuted AFTER the specialized event
    // so consumers tracking "did this stage run" work uniformly.
    this.deps.narrativeGenerator.onStageExecuted(node.name, node.description, traversalContext, 'decider');

    const branchContext = context.createChild(branchPath as string, chosen.id, chosen.name, chosen.id);

    return { kind: 'dispatch', chosen, branchContext };
  }
}
