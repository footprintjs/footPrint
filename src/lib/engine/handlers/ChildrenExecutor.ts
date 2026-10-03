/**
 * ChildrenExecutor — Parallel fan-out via Promise.allSettled.
 *
 * Responsibilities:
 * - Execute all children in parallel (fork pattern)
 * - Execute selected children based on selector output (multi-choice)
 * - Name a child's throttling error as an `onThrottled` flow event (9.39.0)
 * - Aggregate results into { childId: { result, isError } }
 */

import type { StageContext } from '../../memory/StageContext.js';
import type { PauseSignal } from '../../pause/types.js';
import { isPauseSignal } from '../../pause/types.js';
import type { Selector, StageNode } from '../graph/StageNode.js';
import type { TraversalContext } from '../narrative/types.js';
import type { HandlerDeps, NodeResultType } from '../types.js';
import type { ExecuteNodeFn } from './types.js';

export type { ExecuteNodeFn };

/**
 * The ONE pause a fan-out raises when several of its children paused (9.28.0).
 *
 * Only one question is asked at a time, so the FIRST child's pause (child
 * order) is the one raised; every other child's pause — and any pause already
 * waiting behind it — is queued on it (`PauseSignal.pendingPauses`) and rides
 * the checkpoint as `pendingPauses`. Before 9.28.0 the others were dropped
 * silently: the checkpoint asked one child, and the resume never asked the
 * rest (or, on 9.27.0, re-ran the whole fan-out forever).
 *
 * Every queued entry is relative to the fan-out's level — the same level the
 * first signal is at — so the bubble-up grows them together.
 */
function raisePauses(pauses: readonly PauseSignal[]): PauseSignal {
  const [first, ...others] = pauses;
  for (const other of others) {
    first.addPendingPause(other.toPendingPause());
    for (const waiting of other.pendingPauses) first.addPendingPause(waiting);
  }
  return first;
}

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
    traversalContext?: TraversalContext,
  ): Promise<Record<string, NodeResultType>> {
    let breakCount = 0;
    const totalChildren = node.children?.length ?? 0;
    const allChildren = node.children ?? [];

    // Narrative: capture the fan-out
    const childDisplayNames = allChildren.map((c) => c.name);
    this.deps.narrativeGenerator.onFork(node.name, childDisplayNames, traversalContext);
    // Proposal #003: fire onStageExecuted for the fork parent AFTER
    // the specialized event so consumers tracking "did this stage run"
    // work uniformly. Fires BEFORE children execute — matching the
    // "decision made" semantic (the fork's main work is the decision
    // to fan out; children are separate stages with their own lifecycles).
    this.deps.narrativeGenerator.onStageExecuted(node.name, node.description, traversalContext, 'fork');

    const childPromises: Promise<NodeResultType>[] = allChildren.map((child) => {
      const childBranchPath = branchPath || child.id;
      const childContext = context.createChild(childBranchPath as string, child.id as string, child.name, child.id);
      const childBreakFlag = { shouldBreak: false };

      const updateParentBreakFlag = () => {
        if (childBreakFlag.shouldBreak) breakCount += 1;
        if (parentBreakFlag && breakCount === totalChildren) parentBreakFlag.shouldBreak = true;
      };

      return this.executeNode(child, childContext, childBreakFlag, childBranchPath)
        .then((result) => {
          // The fan-out's settle commit is a CONTINUATION of the child's
          // execution — named on the record (9.39.0), never inferred.
          childContext.commit('repeat');
          updateParentBreakFlag();
          return { id: child.id!, result, isError: false };
        })
        .catch((error) => {
          // PauseSignal is expected control flow — re-throw immediately.
          if (isPauseSignal(error)) throw error;
          childContext.commit('repeat');
          updateParentBreakFlag();
          this.deps.logger.info(`TREE PIPELINE: executeNodeChildren - Error for id: ${child?.id}`, { error });
          // Throttling is telemetry (R9): an event, not a state key. Before
          // 9.39.0 this wrote `monitor.isThrottled` AFTER the child's last
          // commit, so it landed nowhere.
          if (this.deps.throttlingErrorChecker && this.deps.throttlingErrorChecker(error)) {
            this.deps.narrativeGenerator.onThrottled?.(child.name, child.id as string, error, traversalContext);
          }
          return { id: child.id!, result: error, isError: true };
        });
    });

    const childrenResults: Record<string, NodeResultType> = {};
    // Every child that paused, by CHILD index (not settle order) — see raisePauses.
    const pausedAt: (PauseSignal | undefined)[] = [];

    if (node.failFast) {
      // Fail-fast: first child ERROR rejects immediately (unwrapped). A pause
      // is not an error: it settles like a result, so the fork waits for its
      // siblings before it pauses — their writes land before the checkpoint
      // is taken, and a second pausing sibling is seen, not raced past.
      const results = await Promise.all(
        allChildren.map((child, i) =>
          childPromises[i].then(
            (r) => {
              if (r.isError) throw r.result;
              return r;
            },
            (error: unknown) => {
              if (!isPauseSignal(error)) throw error;
              pausedAt[i] = error;
              return undefined;
            },
          ),
        ),
      );
      for (const r of results) {
        if (r === undefined) continue; // a paused child
        childrenResults[r.id] = { id: r.id, result: r.result, isError: r.isError ?? false };
      }
    } else {
      // Default: run all children to completion even if some fail
      const settled = await Promise.allSettled(childPromises);
      settled.forEach((s, i) => {
        if (s.status === 'fulfilled') {
          const { id, result, isError } = s.value;
          childrenResults[id] = { id, result, isError: isError ?? false };
        } else if (isPauseSignal(s.reason)) {
          // PauseSignal from a child — re-thrown after all children settle.
          pausedAt[i] = s.reason;
        } else {
          this.deps.logger.error(`Execution failed: ${s.reason}`);
        }
      });
    }

    // Re-throw after every child has settled.
    const pauses = pausedAt.filter((p): p is PauseSignal => p !== undefined);
    if (pauses.length > 0) throw raisePauses(pauses);

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
    traversalContext?: TraversalContext,
    failFast?: boolean,
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
    const selectorName = context.stageName || 'selector';
    this.deps.narrativeGenerator.onSelected(selectorName, selectedDisplayNames, children.length, traversalContext);
    // Proposal #003: fire onStageExecuted AFTER the specialized event.
    this.deps.narrativeGenerator.onStageExecuted(selectorName, undefined, traversalContext, 'selector');

    const tempNode: StageNode<TOut, TScope> = {
      name: 'selector-temp',
      id: 'selector-temp',
      children: selectedChildren,
      // Honor the selector node's fan-out error mode (Promise.all vs allSettled).
      failFast,
    };
    return await this.executeNodeChildren(tempNode, context, undefined, branchPath, traversalContext);
  }
}
