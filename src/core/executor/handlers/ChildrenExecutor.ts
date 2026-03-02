/**
 * ChildrenExecutor.ts
 *
 * WHY: Handles parallel children execution and selector-based branching for the Pipeline.
 * This module is extracted from Pipeline.ts following the Single Responsibility Principle,
 * isolating the concerns of parallel execution from pipeline traversal.
 *
 * RESPONSIBILITIES:
 * - Execute all children in parallel using Promise.allSettled
 * - Execute selected children based on selector output (multi-choice branching)
 * - Handle throttling error flagging for rate-limited operations
 * - Aggregate results into { childId: { result, isError } } structure
 *
 * DESIGN DECISIONS:
 * - Uses Promise.allSettled to ensure all children complete even if some fail
 * - Throttling errors are flagged in context rather than thrown, allowing graceful degradation
 * - Selector validation happens before execution to fail fast on invalid IDs
 *
 * RELATED:
 * - {@link Pipeline} - Orchestrates when children are executed
 * - {@link StageContext} - Provides child context creation and patch management
 * - {@link NodeResolver} - Used for node lookup in selector scenarios
 *
 */

import { StageContext } from '../../memory/StageContext';
import { logger } from '../../../utils/logger';
import { PipelineContext, NodeResultType } from '../types';
import type { StageNode, Selector } from '../Pipeline';

/**
 * ExecuteNodeFn
 * ------------------------------------------------------------------
 * Callback type for executing a single node.
 *
 * WHY: Passed from Pipeline to avoid circular dependency. This allows
 * ChildrenExecutor to recursively execute child nodes without importing Pipeline.
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
 *
 * WHY: Centralizes all parallel execution logic in one place, making it easier
 * to understand and test how children are executed during fork operations.
 *
 * DESIGN: Uses PipelineContext for access to throttling checker, enabling
 * dependency injection for testing.
 *
 * @template TOut - Output type of pipeline stages
 * @template TScope - Scope type passed to stages
 *
 * @example
 * ```typescript
 * const executor = new ChildrenExecutor(pipelineContext, executeNodeFn);
 * const results = await executor.executeNodeChildren(node, context);
 * ```
 */
export class ChildrenExecutor<TOut = any, TScope = any> {
  constructor(
    private ctx: PipelineContext<TOut, TScope>,
    private executeNode: ExecuteNodeFn<TOut, TScope>,
  ) {}

  /**
   * Execute all children in parallel; always commit each child patch on settle.
   *
   * WHY: Fork nodes need to execute all children concurrently for performance.
   * Using Promise.allSettled ensures all children complete even if some fail,
   * allowing the pipeline to continue with partial results.
   *
   * DESIGN: Aggregates a `{ childId: { result, isError } }` object (similar to
   * `Promise.allSettled`). If `throttlingErrorChecker` is provided, we flag
   * `monitor.isThrottled = true` in the child context when it matches the thrown error.
   *
   * @param node - Parent node containing children to execute
   * @param context - Parent stage context
   * @param parentBreakFlag - Optional break flag to propagate when all children break
   * @param pipelineId - Pipeline ID for child context creation
   * @returns Object mapping child IDs to their results
   *
   */
  async executeNodeChildren(
    node: StageNode<TOut, TScope>,
    context: StageContext,
    parentBreakFlag?: { shouldBreak: boolean },
    pipelineId?: string,
  ): Promise<Record<string, NodeResultType>> {
    let breakCount = 0;
    const totalChildren = node.children?.length ?? 0;

    // Append narrative sentence for the fork (all children in parallel)
    // WHY: Captures the fan-out so the reader knows which paths ran concurrently.
    const allChildren = node.children ?? [];
    const childDisplayNames = allChildren.map((c) => c.displayName || c.name);
    this.ctx.narrativeGenerator.onFork(node.displayName || node.name, childDisplayNames);

    const childPromises: Promise<NodeResultType>[] = allChildren.map((child: StageNode<TOut, TScope>) => {
      const pipelineIdForChild = pipelineId || child.id;
      const childContext = context.createChild(pipelineIdForChild as string, child.id as string, child.name);
      const childBreakFlag = { shouldBreak: false };

      // WHY: Track break count to propagate break to parent when ALL children break
      const updateParentBreakFlag = () => {
        if (childBreakFlag.shouldBreak) breakCount += 1;
        if (parentBreakFlag && breakCount === totalChildren) parentBreakFlag.shouldBreak = true;
      };

      return this.executeNode(child, childContext, childBreakFlag, pipelineIdForChild)
        .then((result) => {
          childContext.commit();
          updateParentBreakFlag();
          return { id: child.id!, result, isError: false };
        })
        .catch((error) => {
          childContext.commit();
          updateParentBreakFlag();
          logger.info(`TREE PIPELINE: executeNodeChildren - Error for id: ${child?.id}`, { error });
          // WHY: Flag throttling errors in context for graceful degradation
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
   *
   * WHY: Selector enables multi-choice branching where only a subset of children
   * are executed based on runtime conditions. This is more flexible than decider
   * (which picks exactly one) or fork (which executes all).
   *
   * DESIGN: Unlike executeNodeChildren (which executes ALL children), this method:
   * 1. Invokes the selector to determine which children to execute
   * 2. Validates all returned IDs exist in the children array (fail fast)
   * 3. Executes only the selected children in parallel
   * 4. Records selection info in context debug info for visualization
   *
   * @param selector - Function that returns selected child ID(s)
   * @param children - Array of child nodes to select from
   * @param input - Input to pass to the selector function
   * @param context - Current stage context
   * @param branchPath - Pipeline branch path for logging
   * @returns Object mapping child IDs to their results
   *
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

    // Normalize to array (selector can return single ID or array)
    const selectedIds = Array.isArray(selectorResult) ? selectorResult : [selectorResult];

    // Record selection in debug info for visualization
    context.addLog('selectedChildIds', selectedIds);
    context.addLog('selectorPattern', 'multi-choice');

    // Empty selection - skip children execution
    if (selectedIds.length === 0) {
      context.addLog('skippedAllChildren', true);
      return {};
    }

    // Filter to selected children
    const selectedChildren = children.filter((c) => selectedIds.includes(c.id!));

    // Validate all IDs found (fail fast on invalid IDs)
    if (selectedChildren.length !== selectedIds.length) {
      const childIds = children.map((c) => c.id);
      const missing = selectedIds.filter((id) => !childIds.includes(id));
      const errorMessage = `Selector returned unknown child IDs: ${missing.join(', ')}. Available: ${childIds.join(', ')}`;
      logger.error(`Error in pipeline (${branchPath}):`, { error: errorMessage });
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

    // Append narrative sentence for the selector (subset of children)
    // WHY: Captures which children were selected and how many were available,
    // so the reader understands the selection decision.
    const selectedDisplayNames = selectedChildren.map((c) => c.displayName || c.name);
    this.ctx.narrativeGenerator.onSelected(
      context.stageName || 'selector',
      selectedDisplayNames,
      children.length,
    );

    // Execute selected children in parallel using existing logic
    // WHY: Reuse executeNodeChildren to avoid duplicating parallel execution logic
    const tempNode: StageNode<TOut, TScope> = { name: 'selector-temp', children: selectedChildren };
    return await this.executeNodeChildren(tempNode, context, undefined, branchPath);
  }
}
