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
import { isPauseSignal } from '../../pause/types.js';
import type { StageNode } from '../graph/StageNode.js';
import type { TraversalContext } from '../narrative/types.js';
import type { HandlerDeps, NodeResultType, StageFunction } from '../types.js';
import type { ChildrenExecutor } from './ChildrenExecutor.js';
import type { CallExtractorFn, ExecuteNodeFn, GetStagePathFn, RunStageFn } from './types.js';

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
    breakFlag: { shouldBreak: boolean },
    branchPath: string | undefined,
    runStage: RunStageFn<TOut, TScope>,
    executeNode: ExecuteNodeFn<TOut, TScope>,
    callExtractor: CallExtractorFn<TOut, TScope>,
    getStagePath: GetStagePathFn<TOut, TScope>,
    traversalContext?: TraversalContext,
  ): Promise<Record<string, NodeResultType>> {
    const breakFn = () => (breakFlag.shouldBreak = true);

    let selectedIds: string[];
    let selectionEvidence: SelectionEvidence | undefined;
    try {
      const stageOutput = await runStage(node, stageFunc, context, breakFn);
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
        context.commit();
        throw error;
      }
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
    callExtractor(node, context, getStagePath(node, branchPath, context.stageName), selectedIds);

    if (breakFlag.shouldBreak) {
      this.deps.logger.info(`Execution stopped in pipeline (${branchPath}) after ${node.name} due to break condition.`);
      return {};
    }

    context.addLog('selectedChildIds', selectedIds);
    context.addLog('selectorPattern', 'scope-based-multi-choice');

    if (selectedIds.length === 0) {
      context.addLog('skippedAllChildren', true);
      context.addFlowDebugMessage('selected', 'No children selected — skipping all branches.', {
        count: 0,
        targetStage: [],
      });
      this.deps.narrativeGenerator.onSelected(node.name, [], (node.children ?? []).length, traversalContext);
      return {};
    }

    // Resolve children by matching selected IDs against node.children.
    // Match branchId first (original unprefixed ID), fall back to id for backward compat.
    const children = node.children as StageNode<TOut, TScope>[];
    const selectedChildren = children.filter((c) => selectedIds.includes(c.branchId ?? c.id!));

    // Validate all IDs exist (fail fast)
    if (selectedChildren.length !== selectedIds.length) {
      const childIds = children.map((c) => c.branchId ?? c.id);
      const missing = selectedIds.filter((id) => !childIds.includes(id));
      const errorMessage = `Scope-based selector '${node.name}' returned unknown child IDs: ${missing.join(
        ', ',
      )}. Available: ${childIds.join(', ')}`;
      this.deps.logger.error(`Error in pipeline (${branchPath}):`, { error: errorMessage });
      context.addError('selectorError', errorMessage);
      throw new Error(errorMessage);
    }

    const skippedIds = children
      .filter((c) => !selectedIds.includes(c.branchId ?? c.id!))
      .map((c) => c.branchId ?? c.id);
    if (skippedIds.length > 0) {
      context.addLog('skippedChildIds', skippedIds);
    }

    const selectedNames = selectedChildren.map((c) => c.name).join(', ');
    context.addFlowDebugMessage(
      'selected',
      `Running ${selectedNames} (${selectedChildren.length} of ${children.length} matched)`,
      { count: selectedChildren.length, targetStage: selectedChildren.map((c) => c.name) },
    );

    const selectedDisplayNames = selectedChildren.map((c) => c.name);
    this.deps.narrativeGenerator.onSelected(
      node.name,
      selectedDisplayNames,
      children.length,
      traversalContext,
      selectionEvidence,
    );

    const tempNode: StageNode<TOut, TScope> = {
      name: 'selector-temp',
      id: 'selector-temp',
      children: selectedChildren,
    };
    return await this.childrenExecutor.executeNodeChildren(tempNode, context, undefined, branchPath, traversalContext);
  }
}
