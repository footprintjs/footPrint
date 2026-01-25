/**
 * ChildrenExecutor.ts
 *
 * Handles parallel children execution and selector-based branching for the Pipeline.
 * Extracted from Pipeline.ts to follow Single Responsibility Principle.
 *
 * Responsibilities:
 * - Execute all children in parallel using Promise.allSettled
 * - Execute selected children based on selector output
 * - Handle throttling error flagging
 * - Aggregate results into { childId: { result, isError } } structure
 *
 * _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5_
 */

import { StageContext } from '../context/StageContext';
import { logger } from '../logger';
import { PipelineContext, NodeResultType } from './types';
import type { StageNode, Selector } from './GraphTraverser';

/**
 * ExecuteNodeFn
 * ------------------------------------------------------------------
 * Callback type for executing a single node.
 * Passed from Pipeline to avoid circular dependency.
 */
export type ExecuteNodeFn<TOut = any, TScope = any> = (
  node: StageNode<TOut, TScope>,
  context: StageContext,
  breakFlag: { shouldBreak: boolean },
  branchPath?: string,
) => Promise<any>;

/**
 * ChildrenExecutor
 * ------------------------------------------------------------------
 * Handles parallel children execution and selector-based branching.
 * Uses PipelineContext for access to throttling checker.
 *
 * @template TOut - Output type of pipeline stages
 * @template TScope - Scope type passed to stages
 */
export class ChildrenExecutor<TOut = any, TScope = any> {
  constructor(
    private ctx: PipelineContext<TOut, TScope>,
    private executeNode: ExecuteNodeFn<TOut, TScope>,
  ) {}

  /**
   * Execute all children in parallel; always commit each child patch on settle.
   * Aggregates a `{ childId: { result, isError } }` object (similar to `Promise.allSettled`).
   * If `throttlingErrorChecker` is provided, we flag `monitor.isThrottled = true`
   * in the child context when it matches the thrown error.
   *
   * @param node - Parent node containing children to execute
   * @param context - Parent stage context
   * @param parentBreakFlag - Optional break flag to propagate when all children break
   * @param pipelineId - Pipeline ID for child context creation
   * @returns Object mapping child IDs to their results
   *
   * _Requirements: 2.1, 2.3_
   */
  async executeNodeChildren(
    node: StageNode<TOut, TScope>,
    context: StageContext,
    parentBreakFlag?: { shouldBreak: boolean },
    pipelineId?: string,
  ): Promise<Record<string, NodeResultType>> {
    let breakCount = 0;
    const totalChildren = node.children?.length ?? 0;

    const childPromises: Promise<NodeResultType>[] = (node.children ?? []).map((child: StageNode<TOut, TScope>) => {
      const pipelineIdForChild = pipelineId || child.id;
      const childContext = context.createChildContext(pipelineIdForChild as string, child.id as string, child.name);
      const childBreakFlag = { shouldBreak: false };

      const updateParentBreakFlag = () => {
        if (childBreakFlag.shouldBreak) breakCount += 1;
        if (parentBreakFlag && breakCount === totalChildren) parentBreakFlag.shouldBreak = true;
      };

      return this.executeNode(child, childContext, childBreakFlag, pipelineIdForChild)
        .then((result) => {
          childContext.commitPatch();
          updateParentBreakFlag();
          return { id: child.id!, result, isError: false };
        })
        .catch((error) => {
          childContext.commitPatch();
          updateParentBreakFlag();
          logger.info(`TREE PIPELINE: executeNodeChildren - Error for id: ${child?.id}`, { error });
          if (this.ctx.throttlingErrorChecker && this.ctx.throttlingErrorChecker(error)) {
            childContext.updateObject(['monitor'], 'isThrottled', true);
          }
          return { id: child.id!, result: error, isError: true };
        });
    });

    const settled = await Promise.allSettled(childPromises);

    const childrenResults: Record<string, NodeResultType> = {};
    settled.forEach((s) => {
      if (s.status === 'fulfilled') {
        const { id, result, isError } = s.value;
        // Store the full NodeResultType including id
        childrenResults[id] = { id, result, isError: isError ?? false };
      } else {
        logger.error(`Execution failed: ${s.reason}`);
      }
    });

    return childrenResults;
  }

  /**
   * Execute selected children based on selector result.
   * Selector can return: single ID, array of IDs, or empty array.
   *
   * Unlike executeNodeChildren (which executes ALL children), this method:
   * 1. Invokes the selector to determine which children to execute
   * 2. Validates all returned IDs exist in the children array
   * 3. Executes only the selected children in parallel
   * 4. Records selection info in context debug info
   *
   * @param selector - Function that returns selected child ID(s)
   * @param children - Array of child nodes to select from
   * @param input - Input to pass to the selector function
   * @param context - Current stage context
   * @param branchPath - Pipeline branch path for logging
   * @returns Object mapping child IDs to their results
   *
   * _Requirements: 2.2_
   */
  async executeSelectedChildren(
    selector: Selector,
    children: StageNode<TOut, TScope>[],
    input: any,
    context: StageContext,
    branchPath: string,
  ): Promise<Record<string, NodeResultType>> {
    // Invoke selector
    const selectorResult = await selector(input);

    // Normalize to array
    const selectedIds = Array.isArray(selectorResult) ? selectorResult : [selectorResult];

    // Record selection in debug info
    context.addDebugInfo('selectedChildIds', selectedIds);
    context.addDebugInfo('selectorPattern', 'multi-choice');

    // Empty selection - skip children execution
    if (selectedIds.length === 0) {
      context.addDebugInfo('skippedAllChildren', true);
      return {};
    }

    // Filter to selected children
    const selectedChildren = children.filter((c) => selectedIds.includes(c.id!));

    // Validate all IDs found
    if (selectedChildren.length !== selectedIds.length) {
      const childIds = children.map((c) => c.id);
      const missing = selectedIds.filter((id) => !childIds.includes(id));
      const errorMessage = `Selector returned unknown child IDs: ${missing.join(', ')}. Available: ${childIds.join(', ')}`;
      logger.error(`Error in pipeline (${branchPath}):`, { error: errorMessage });
      context.addErrorInfo('selectorError', errorMessage);
      throw new Error(errorMessage);
    }

    // Record skipped children for visualization
    const skippedIds = children.filter((c) => !selectedIds.includes(c.id!)).map((c) => c.id);
    if (skippedIds.length > 0) {
      context.addDebugInfo('skippedChildIds', skippedIds);
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

    // Execute selected children in parallel using existing logic
    const tempNode: StageNode<TOut, TScope> = { name: 'selector-temp', children: selectedChildren };
    return await this.executeNodeChildren(tempNode, context, undefined, branchPath);
  }
}
