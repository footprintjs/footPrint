/**
 * ChildrenExecutor — Parallel fan-out via Promise.allSettled.
 *
 * Responsibilities:
 * - Execute all children in parallel (fork pattern)
 * - Execute selected children based on selector output (multi-choice)
 * - Handle throttling error flagging for rate-limited operations
 * - Aggregate results into { childId: { result, isError } }
 */

import type { StageContext } from '../../memory/StageContext';
import type { Selector, StageNode } from '../graph/StageNode';
import type { HandlerDeps, NodeResultType } from '../types';

/** Callback for recursive node execution. Avoids circular dependency with traverser. */
export type ExecuteNodeFn<TOut = any, TScope = any> = (
  node: StageNode<TOut, TScope>,
  context: StageContext,
  breakFlag: { shouldBreak: boolean },
  branchPath?: string,
) => Promise<any>;

export class ChildrenExecutor<TOut = any, TScope = any> {
  constructor(private deps: HandlerDeps<TOut, TScope>, private executeNode: ExecuteNodeFn<TOut, TScope>) {}

  /**
   * Execute all children in parallel. Each child commits on settle.
   * Uses Promise.allSettled to ensure all children complete even if some fail.
   */
  async executeNodeChildren(
    node: StageNode<TOut, TScope>,
    context: StageContext,
    parentBreakFlag?: { shouldBreak: boolean },
    branchPath?: string,
  ): Promise<Record<string, NodeResultType>> {
    let breakCount = 0;
    const totalChildren = node.children?.length ?? 0;
    const allChildren = node.children ?? [];

    // Narrative: capture the fan-out
    const childDisplayNames = allChildren.map((c) => c.name);
    this.deps.narrativeGenerator.onFork(node.name, childDisplayNames);

    const childPromises: Promise<NodeResultType>[] = allChildren.map((child) => {
      const childBranchPath = branchPath || child.id;
      const childContext = context.createChild(childBranchPath as string, child.id as string, child.name);
      const childBreakFlag = { shouldBreak: false };

      const updateParentBreakFlag = () => {
        if (childBreakFlag.shouldBreak) breakCount += 1;
        if (parentBreakFlag && breakCount === totalChildren) parentBreakFlag.shouldBreak = true;
      };

      return this.executeNode(child, childContext, childBreakFlag, childBranchPath)
        .then((result) => {
          childContext.commit();
          updateParentBreakFlag();
          return { id: child.id!, result, isError: false };
        })
        .catch((error) => {
          childContext.commit();
          updateParentBreakFlag();
          this.deps.logger.info(`TREE PIPELINE: executeNodeChildren - Error for id: ${child?.id}`, { error });
          if (this.deps.throttlingErrorChecker && this.deps.throttlingErrorChecker(error)) {
            childContext.updateObject(['monitor'], 'isThrottled', true);
          }
          return { id: child.id!, result: error, isError: true };
        });
    });

    const childrenResults: Record<string, NodeResultType> = {};

    if (node.failFast) {
      // Fail-fast: first child error rejects immediately (unwrapped)
      const results = await Promise.all(
        allChildren.map((child, i) =>
          childPromises[i].then((r) => {
            if (r.isError) throw r.result;
            return r;
          }),
        ),
      );
      for (const { id, result, isError } of results) {
        childrenResults[id] = { id, result, isError: isError ?? false };
      }
    } else {
      // Default: run all children to completion even if some fail
      const settled = await Promise.allSettled(childPromises);
      settled.forEach((s) => {
        if (s.status === 'fulfilled') {
          const { id, result, isError } = s.value;
          childrenResults[id] = { id, result, isError: isError ?? false };
        } else {
          this.deps.logger.error(`Execution failed: ${s.reason}`);
        }
      });
    }

    return childrenResults;
  }

  /**
   * Execute selected children based on selector result.
   * Validates IDs, records selection info, then delegates to executeNodeChildren.
   */
  async executeSelectedChildren(
    selector: Selector,
    children: StageNode<TOut, TScope>[],
    input: any,
    context: StageContext,
    branchPath: string,
  ): Promise<Record<string, NodeResultType>> {
    const selectorResult = await selector(input);
    const selectedIds = Array.isArray(selectorResult) ? selectorResult : [selectorResult];

    context.addLog('selectedChildIds', selectedIds);
    context.addLog('selectorPattern', 'multi-choice');

    if (selectedIds.length === 0) {
      context.addLog('skippedAllChildren', true);
      return {};
    }

    const selectedChildren = children.filter((c) => selectedIds.includes(c.id!));

    // Validate all IDs exist (fail fast)
    if (selectedChildren.length !== selectedIds.length) {
      const childIds = children.map((c) => c.id);
      const missing = selectedIds.filter((id) => !childIds.includes(id));
      const errorMessage = `Selector returned unknown child IDs: ${missing.join(', ')}. Available: ${childIds.join(
        ', ',
      )}`;
      this.deps.logger.error(`Error in pipeline (${branchPath}):`, { error: errorMessage });
      context.addError('selectorError', errorMessage);
      throw new Error(errorMessage);
    }

    const skippedIds = children.filter((c) => !selectedIds.includes(c.id!)).map((c) => c.id);
    if (skippedIds.length > 0) {
      context.addLog('skippedChildIds', skippedIds);
    }

    const selectedNames = selectedChildren.map((c) => c.name).join(', ');
    context.addFlowDebugMessage(
      'selected',
      `Running ${selectedNames} (${selectedChildren.length} of ${children.length} matched)`,
      { count: selectedChildren.length, targetStage: selectedChildren.map((c) => c.name) },
    );

    // Narrative: capture the selection
    const selectedDisplayNames = selectedChildren.map((c) => c.name);
    this.deps.narrativeGenerator.onSelected(context.stageName || 'selector', selectedDisplayNames, children.length);

    const tempNode: StageNode<TOut, TScope> = {
      name: 'selector-temp',
      id: 'selector-temp',
      children: selectedChildren,
    };
    return await this.executeNodeChildren(tempNode, context, undefined, branchPath);
  }
}
