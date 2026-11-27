/**
 * SelectorHandler — Multi-choice filtered fan-out.
 *
 * Responsibilities:
 * - Execute scope-based selector nodes (stage → commit → resolve children → parallel execution)
 * - The selector function IS a stage: reads scope, returns string[] of branch IDs
 * - Delegates parallel execution of selected children to ChildrenExecutor
 */

import type { SelectionEvidence } from '../../decide/types.js';
import { DECISION_RESULT } from '../../decide/types.js';
import type { StageContext } from '../../memory/StageContext.js';
import { storedControlFor } from '../../memory/storedControlLifecycle.js';
import { isPauseSignal } from '../../pause/types.js';
import type { StageNode } from '../graph/StageNode.js';
import type { TraversalContext } from '../narrative/types.js';
import type { HandlerDeps, NodeResultType, StageFunction } from '../types.js';
import { createBreakHandler } from './breakFlag.js';
import type { ChildrenExecutor } from './ChildrenExecutor.js';
import { commitStage, commitStageWrites } from './commitStage.js';
import { selectionProblem } from './selectionProblem.js';
import { servedPause } from './servedPause.js';
import { captureStageFailure, loggableStageError, recordStageError } from './stageError.js';
import type { BreakFlag, ExecuteNodeFn, RunStageFn } from './types.js';

export class SelectorHandler<TOut = any, TScope = any> {
  constructor(
    private readonly deps: HandlerDeps<TOut, TScope>,
    private readonly childrenExecutor: ChildrenExecutor<TOut, TScope>,
  ) {}

  /**
   * Handle a scope-based selector node (created via addSelectorFunction).
   * The stage function IS the selector — its return value contains branch IDs.
   * Execution order: runStage(fn) → commit → resolve children → parallel execute.
   */
  async handleScopeBased(
    node: StageNode<TOut, TScope>,
    stageFunc: StageFunction<TOut, TScope>,
    context: StageContext,
    breakFlag: BreakFlag,
    branchPath: string | undefined,
    runStage: RunStageFn<TOut, TScope>,
    executeNode: ExecuteNodeFn<TOut, TScope>,
    traversalContext?: TraversalContext,
  ): Promise<Record<string, NodeResultType> | undefined> {
    const breakFn = createBreakHandler(breakFlag, context, this.deps.readOnlyContext);

    let selectedIds: string[];
    let selectionEvidence: SelectionEvidence | undefined;
    try {
      const stageOutput = await runStage(node, stageFunc, context, breakFn, traversalContext);
      // Detect SelectionResult from select() helper via Symbol brand
      if (
        stageOutput &&
        typeof stageOutput === 'object' &&
        Reflect.has(stageOutput as object, DECISION_RESULT) &&
        Array.isArray((stageOutput as any).branches)
      ) {
        selectedIds = (stageOutput as any).branches;
        selectionEvidence = (stageOutput as any).evidence;
      } else {
        selectedIds = Array.isArray(stageOutput) ? stageOutput.map(String) : [String(stageOutput)];
      }
    } catch (error: any) {
      // PauseSignal is expected control flow — commit and re-throw without error logging.
      if (isPauseSignal(error)) {
        commitStageWrites(context);
        this.deps.narrativeGenerator.onPause(
          node.name,
          node.id,
          servedPause(context, error.pauseData),
          error.subflowPath,
          traversalContext,
        );
        throw error;
      }
      captureStageFailure(context, error);
      commitStageWrites(context);
      const served = recordStageError(context, error);
      this.deps.logger.error(`Error in pipeline (${branchPath}) stage [${node.name}]:`, {
        error: loggableStageError(context, error),
      });
      this.deps.narrativeGenerator.onError(node.name, served.message, served.structuredError, traversalContext);
      throw error;
    }

    commitStage(context, this.deps.narrativeGenerator, node.name, traversalContext);

    if (breakFlag.shouldBreak) {
      // The selector completed, but it did not select or dispatch branches.
      this.deps.narrativeGenerator.onStageExecuted(node.name, node.description, traversalContext, 'selector');
      this.deps.narrativeGenerator.onBreak(node.name, traversalContext, breakFlag.reason);
      // No branches ran: do not manufacture a result map. In a subflow,
      // undefined lets SubflowExecutor use the stage's committed state.
      return undefined;
    }

    context.addLog('selectedChildIds', selectedIds);
    context.addLog('selectorPattern', 'scope-based-multi-choice');

    // Resolve children by matching selected IDs against node.children.
    // Match branchId first (original unprefixed ID), fall back to id for backward compat.
    const children = node.children ?? [];
    const selectedChildren = selectedIds.length
      ? children.filter((c) => selectedIds.includes(c.branchId ?? c.id!))
      : [];

    const selectedCount = selectedChildren.length;
    // Validate all IDs exist (fail fast)
    if (selectedCount !== selectedIds.length) {
      const childIds = children.map((c) => c.branchId ?? c.id);
      const missing = selectedIds.filter((id) => !childIds.includes(id));
      const errorMessage = `Scope-based selector '${node.name}' returned ${selectionProblem(
        selectedIds,
        missing,
      )}. Available: ${childIds.join(', ')}`;
      this.deps.logger.error(`Error in pipeline (${branchPath}):`, { error: errorMessage });
      context.addError('selectorError', errorMessage);
      const error = new Error(errorMessage);
      // Reported like any failed stage (the stage already committed).
      const served = recordStageError(context, error);
      this.deps.narrativeGenerator.onError(node.name, served.message, served.structuredError, traversalContext);
      throw error;
    }

    const selectedDisplayNames = selectedChildren.map((c) => c.name);
    if (selectedCount) {
      const skippedIds = children
        .filter((c) => !selectedIds.includes(c.branchId ?? c.id!))
        .map((c) => c.branchId ?? c.id);
      if (skippedIds.length > 0) context.addLog('skippedChildIds', skippedIds);
      context.addFlowDebugMessage(
        'selected',
        `Running ${selectedDisplayNames.join(', ')} (${selectedCount} of ${children.length} matched)`,
        { count: selectedCount, targetStage: [...selectedDisplayNames] },
      );
    } else {
      context.addLog('skippedAllChildren', true);
      context.addFlowDebugMessage('selected', 'No children selected — skipping all branches.', {
        count: 0,
        targetStage: [],
      });
    }

    storedControlFor(context)?.selection(context, children, selectedDisplayNames);
    this.deps.narrativeGenerator.onSelected(
      node.name,
      selectedDisplayNames,
      children.length,
      traversalContext,
      selectionEvidence,
    );
    // Proposal #003: the stage ran even when it selected no children.
    this.deps.narrativeGenerator.onStageExecuted(node.name, node.description, traversalContext, 'selector');
    if (!selectedCount) return {};

    const tempNode: StageNode<TOut, TScope> = {
      name: 'selector-temp',
      id: 'selector-temp',
      children: selectedChildren,
      // Propagate the selector's fan-out error mode. Without this, ChildrenExecutor
      // reads `tempNode.failFast` (undefined) and always uses Promise.allSettled —
      // silently swallowing a required branch's error. See builder `failFast` option.
      failFast: node.failFast,
    };
    try {
      return await this.childrenExecutor.executeNodeChildren(
        tempNode,
        context,
        undefined,
        branchPath,
        traversalContext,
      );
    } catch (error: unknown) {
      // Stamp invoker context on PauseSignal during bubble-up.
      if (isPauseSignal(error)) {
        error.setInvoker(node.id!);
        throw error;
      }
      throw error;
    }
  }
}
