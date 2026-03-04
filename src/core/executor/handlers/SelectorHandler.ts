/**
 * SelectorHandler.ts
 *
 * WHY: Handles scope-based selector evaluation and multi-choice branching for the Pipeline.
 * This module mirrors the DeciderHandler pattern — extracted into its own file
 * following the Single Responsibility Principle so Pipeline.ts stays an orchestrator.
 *
 * RESPONSIBILITIES:
 * - Execute scope-based selector nodes (stage → commit → resolve children → parallel execution)
 * - The selector function IS a stage: it reads from scope and returns an array of branch IDs
 * - Log flow control decisions for selector branches
 * - Delegate parallel execution of selected children to ChildrenExecutor
 *
 * DESIGN DECISIONS:
 * - Scope-based selector: fn receives (scope, breakFn) and returns string[] of branch IDs
 * - Unlike the output-based `addSelector` (which reads previous stage's return value),
 *   this handler reads from scope — consistent with addDeciderFunction pattern
 * - Child resolution is array-based (multiple selections) vs single selection in DeciderHandler
 * - Selected children execute in parallel via ChildrenExecutor
 *
 * DOES NOT HANDLE:
 * - Stage execution (uses runStage callback)
 * - Commit logic (caller handles via context.commitPatch())
 * - Extractor calls (caller handles via callExtractor())
 *
 * RELATED:
 * - {@link DeciderHandler} - Sister module for single-choice branching
 * - {@link ChildrenExecutor} - Used for parallel execution of selected children
 * - {@link Pipeline} - Orchestrates when selectors are evaluated
 * - {@link StageContext} - Used for debug info and context creation
 *
 */

import { StageContext } from '../../memory/StageContext';
import type { StageNode } from '../Pipeline';
import type { PipelineContext, PipelineStageFunction, NodeResultType } from '../types';
import type { ChildrenExecutor } from './ChildrenExecutor';
import type {
  RunStageFn,
  ExecuteNodeFn,
  CallExtractorFn,
  GetStagePathFn,
} from './DeciderHandler';

/**
 * SelectorHandler
 * ------------------------------------------------------------------
 * Handles scope-based selector evaluation and multi-choice branching.
 *
 * WHY: Scope-based selectors (created via `addSelectorFunction`) are first-class
 * stage functions — the selector IS the stage. Unlike the output-based `addSelector`,
 * this handler reads from scope and returns an array of branch IDs, consistent with
 * addDeciderFunction's pattern.
 *
 * DESIGN: Uses callbacks for stage execution and node execution to avoid
 * circular dependencies with Pipeline. Delegates parallel child execution
 * to ChildrenExecutor.
 *
 * @template TOut - The output type of stage functions
 * @template TScope - The scope type passed to stage functions
 *
 */
export class SelectorHandler<TOut = any, TScope = any> {
  constructor(
    private readonly ctx: PipelineContext<TOut, TScope>,
    private readonly childrenExecutor: ChildrenExecutor<TOut, TScope>,
  ) {}

  /**
   * Handle a scope-based selector node (created via `addSelectorFunction` in the builder).
   *
   * WHY: Scope-based selectors are first-class stage functions — the selector IS the stage.
   * The stage function receives (scope, breakFn) and returns a string or string[] of branch IDs.
   * This aligns with addDeciderFunction's pattern where the function reads from scope.
   *
   * DESIGN: Execution order: runStage(fn) → commit → callExtractor → resolve children → parallel execute
   *
   * Key differences from DeciderHandler.handleScopeBased():
   * 1. Return value is string | string[] (multiple branch IDs), not just string
   * 2. Multiple children execute in parallel, not just one
   * 3. Uses ChildrenExecutor for parallel execution
   * 4. Returns aggregated results from all selected children
   *
   * @param node - The selector node (has `selectorFn = true`, `fn` defined, `children` defined)
   * @param stageFunc - The stage function that returns branch ID(s) (required)
   * @param context - The stage context
   * @param breakFlag - Break flag for propagation
   * @param branchPath - Branch path for logging
   * @param runStage - Callback to run the stage function
   * @param executeNode - Callback to execute child nodes (passed through to ChildrenExecutor)
   * @param callExtractor - Callback to call the extractor
   * @param getStagePath - Callback to get the stage path
   * @returns Aggregated results from all selected children: { [childId]: { result, isError } }
   *
   */
  async handleScopeBased(
    node: StageNode<TOut, TScope>,
    stageFunc: PipelineStageFunction<TOut, TScope>,
    context: StageContext,
    breakFlag: { shouldBreak: boolean },
    branchPath: string | undefined,
    runStage: RunStageFn<TOut, TScope>,
    executeNode: ExecuteNodeFn<TOut, TScope>,
    callExtractor: CallExtractorFn<TOut, TScope>,
    getStagePath: GetStagePathFn<TOut, TScope>,
  ): Promise<Record<string, NodeResultType>> {
    const breakFn = () => (breakFlag.shouldBreak = true);

    // Execute the selector's stage function — its return value contains the branch IDs
    // WHY: The selector function reads from scope and returns branch IDs,
    // making it a proper stage with full scope access, step number, and debug visibility.
    let selectedIds: string[];
    try {
      const stageOutput = await runStage(node, stageFunc, context, breakFn);
      // Normalize to array (selector can return single ID or array)
      selectedIds = Array.isArray(stageOutput) ? stageOutput.map(String) : [String(stageOutput)];
    } catch (error: any) {
      // Commit partial patch for forensic data
      // WHY: Even on error, we persist any scope writes the selector made
      // so debug tools can inspect what happened before the failure.
      context.commit();
      callExtractor(node, context, getStagePath(node, branchPath, context.stageName), undefined, {
        type: 'stageExecutionError',
        message: error.toString(),
      });
      this.ctx.logger.error(`Error in pipeline (${branchPath}) stage [${node.name}]:`, { error });
      context.addError('stageExecutionError', error.toString());
      // Append narrative error sentence for the scope-based selector failure
      this.ctx.narrativeGenerator.onError(node.name, error.toString(), node.displayName);
      throw error;
    }

    // Commit the selector's scope writes before selecting branches
    // WHY: Ensures downstream stages see the selector's committed state,
    // and the extractor captures the post-commit scope snapshot.
    context.commit();

    // Call extractor with the selected IDs as stageOutput so it appears in enriched snapshots
    callExtractor(node, context, getStagePath(node, branchPath, context.stageName), selectedIds);

    // If break was called during the selector, stop execution
    if (breakFlag.shouldBreak) {
      this.ctx.logger.info(`Execution stopped in pipeline (${branchPath}) after ${node.name} due to break condition.`);
      return {};
    }

    // Record selection in debug info for visualization
    context.addLog('selectedChildIds', selectedIds);
    context.addLog('selectorPattern', 'scope-based-multi-choice');

    // Handle empty selection - skip children execution
    if (selectedIds.length === 0) {
      context.addLog('skippedAllChildren', true);

      // Log that no children were selected
      context.addFlowDebugMessage('selected', `No children selected — skipping all branches.`, {
        count: 0,
        targetStage: [],
      });

      this.ctx.narrativeGenerator.onSelected(
        node.displayName || node.name,
        [],
        (node.children ?? []).length,
      );

      return {};
    }

    // Resolve children by matching selected IDs against node.children
    const children = node.children as StageNode<TOut, TScope>[];
    const selectedChildren = children.filter((c) => selectedIds.includes(c.id!));

    // Validate all IDs found (fail fast on invalid IDs)
    if (selectedChildren.length !== selectedIds.length) {
      const childIds = children.map((c) => c.id);
      const missing = selectedIds.filter((id) => !childIds.includes(id));
      const errorMessage = `Scope-based selector '${node.name}' returned unknown child IDs: ${missing.join(', ')}. Available: ${childIds.join(', ')}`;
      this.ctx.logger.error(`Error in pipeline (${branchPath}):`, { error: errorMessage });
      context.addError('selectorError', errorMessage);
      throw new Error(errorMessage);
    }

    // Record skipped children for visualization
    const skippedIds = children.filter((c) => !selectedIds.includes(c.id!)).map((c) => c.id);
    if (skippedIds.length > 0) {
      context.addLog('skippedChildIds', skippedIds);
    }

    // Log flow control decision for selector multi-choice
    const selectedNames = selectedChildren.map((c) => c.displayName || c.name).join(', ');
    context.addFlowDebugMessage(
      'selected',
      `Running ${selectedNames} (${selectedChildren.length} of ${children.length} matched)`,
      {
        count: selectedChildren.length,
        targetStage: selectedChildren.map((c) => c.name),
      },
    );

    // Append narrative sentence for the scope-based selector
    // WHY: Captures which children were selected and how many were available,
    // so the reader understands the selection decision.
    const selectedDisplayNames = selectedChildren.map((c) => c.displayName || c.name);
    this.ctx.narrativeGenerator.onSelected(
      node.displayName || node.name,
      selectedDisplayNames,
      children.length,
    );

    // Execute selected children in parallel using ChildrenExecutor
    // WHY: Reuse executeNodeChildren to avoid duplicating parallel execution logic
    const tempNode: StageNode<TOut, TScope> = { name: 'selector-temp', children: selectedChildren };
    return await this.childrenExecutor.executeNodeChildren(tempNode, context, undefined, branchPath);
  }
}
