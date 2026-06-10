/**
 * ContinuationResolver — Back-edge resolution + iteration counting.
 *
 * Resolves dynamic continuations (loop-backs, dynamic next) and tracks
 * per-node iteration counts for context tree naming.
 *
 * Supports three dynamicNext patterns:
 * - String ID → reference to existing node (resolve via NodeResolver)
 * - StageNode with fn → truly dynamic node (execute directly)
 * - StageNode without fn → reference by ID (resolve via NodeResolver)
 *
 * Two entry points:
 * - `resolveTarget` — resolves the continuation to `{ node, context }` and
 *   fires every side effect (iteration counting, debug logs, `onLoop`
 *   narrative) WITHOUT executing. The traverser's trampoline driver uses
 *   this to follow loop edges iteratively — flat stack, so the iteration
 *   limit (not call-stack depth) is what bounds a loop.
 * - `resolve` — resolveTarget + immediate execution via the provided
 *   `executeNode` callback. Kept for direct/advanced callers.
 */

import type { StageContext } from '../../memory/StageContext.js';
import type { StageNode } from '../graph/StageNode.js';
import type { TraversalContext } from '../narrative/types.js';
import type { HandlerDeps } from '../types.js';
import type { NodeResolver } from './NodeResolver.js';
import type { ExecuteNodeFn } from './types.js';

export const DEFAULT_MAX_ITERATIONS = 1000;

/**
 * A resolved continuation target — the node to execute next plus the
 * StageContext to execute it in. All side effects (iteration counting,
 * debug logs, `onLoop` narrative) have already fired by the time this
 * is returned.
 */
export interface ResolvedContinuation<TOut = any, TScope = any> {
  node: StageNode<TOut, TScope>;
  context: StageContext;
}

export class ContinuationResolver<TOut = any, TScope = any> {
  /**
   * Iteration counter per node ID.
   * Key: node.id, Value: visit count (0 = first visit).
   */
  private iterationCounters: Map<string, number> = new Map();

  private readonly onIterationUpdate?: (nodeId: string, count: number) => void;
  private readonly maxIterations: number;

  constructor(
    private readonly deps: HandlerDeps<TOut, TScope>,
    private readonly nodeResolver: NodeResolver<TOut, TScope>,
    onIterationUpdate?: (nodeId: string, count: number) => void,
    maxIterations?: number,
  ) {
    this.onIterationUpdate = onIterationUpdate;
    this.maxIterations = maxIterations ?? DEFAULT_MAX_ITERATIONS;
  }

  /**
   * Resolve a dynamic continuation and execute it immediately.
   * Equivalent to `executeNode(...resolveTarget(...))` — the traverser's
   * driver loop calls `resolveTarget` directly instead so the continuation
   * becomes a flat trampoline hop rather than a retained recursive frame.
   */
  async resolve(
    dynamicNext: string | StageNode<TOut, TScope>,
    node: StageNode<TOut, TScope>,
    context: StageContext,
    breakFlag: { shouldBreak: boolean },
    branchPath: string | undefined,
    executeNode: ExecuteNodeFn<TOut, TScope>,
    traversalContext?: TraversalContext,
  ): Promise<any> {
    const target = this.resolveTarget(dynamicNext, node, context, branchPath, traversalContext);
    return executeNode(target.node, target.context, breakFlag, branchPath);
  }

  /**
   * Resolve a dynamic continuation to its target node + next StageContext
   * WITHOUT executing it. Fires the same side effects `resolve` always did
   * (iteration counting + limit, `dynamicNext*` logs, loop debug message,
   * `onLoop` narrative), in the same order.
   *
   * Three dynamicNext patterns:
   * - StageNode with fn → truly dynamic node, returned as-is (no iteration
   *   tracking — it is a fresh node, not a back-edge).
   * - String ID → reference to an existing node, resolved via NodeResolver.
   * - StageNode without fn → reference by ID, resolved via NodeResolver.
   */
  resolveTarget(
    dynamicNext: string | StageNode<TOut, TScope>,
    currentNode: StageNode<TOut, TScope>,
    context: StageContext,
    branchPath: string | undefined,
    traversalContext?: TraversalContext,
  ): ResolvedContinuation<TOut, TScope> {
    // Truly dynamic node (has fn) → execute directly, no iteration tracking.
    if (typeof dynamicNext !== 'string' && dynamicNext.fn) {
      context.addLog('dynamicNextDirect', true);
      context.addLog('dynamicNextName', dynamicNext.name);

      context.addFlowDebugMessage('next', `Moving to ${dynamicNext.name} stage (dynamic)`, {
        targetStage: dynamicNext.name,
      });

      const nextStageContext = context.createNext(branchPath as string, dynamicNext.name, dynamicNext.id);
      return { node: dynamicNext, context: nextStageContext };
    }

    // Reference — by string ID or by node-without-fn ID. A node reference
    // without an id is a usage error; a string reference is passed through
    // verbatim (an unknown id surfaces as "target node not found" below).
    if (typeof dynamicNext !== 'string' && !dynamicNext.id) {
      const errorMessage = 'dynamicNext node must have an id when used as reference';
      this.deps.logger.error(`Error in pipeline (${branchPath}) stage [${currentNode.name}]:`, { error: errorMessage });
      throw new Error(errorMessage);
    }
    const nextNodeId = typeof dynamicNext === 'string' ? dynamicNext : dynamicNext.id!;

    const targetNode = this.nodeResolver.findNodeById(nextNodeId);
    if (!targetNode) {
      const errorMessage = `dynamicNext target node not found: ${nextNodeId}`;
      this.deps.logger.error(`Error in pipeline (${branchPath}) stage [${currentNode.name}]:`, { error: errorMessage });
      throw new Error(errorMessage);
    }

    const iteration = this.getAndIncrementIteration(nextNodeId);
    const iteratedStageName = this.getIteratedStageName(targetNode.name, iteration);
    context.addLog('dynamicNextTarget', nextNodeId);
    context.addLog('dynamicNextIteration', iteration);

    context.addFlowDebugMessage('loop', `Looping back to ${targetNode.name} (iteration ${iteration + 1})`, {
      targetStage: targetNode.name,
      iteration: iteration + 1,
    });

    this.deps.narrativeGenerator.onLoop(targetNode.name, iteration + 1, targetNode.description, traversalContext);

    const nextStageContext = context.createNext(branchPath as string, iteratedStageName, targetNode.id);
    return { node: targetNode, context: nextStageContext };
  }

  /**
   * Get the next iteration number for a node and increment.
   * Returns 0 for first visit, 1 for second, etc.
   * Throws if maxIterations exceeded (infinite loop guard).
   */
  getAndIncrementIteration(nodeId: string): number {
    const current = this.iterationCounters.get(nodeId) ?? 0;
    if (current >= this.maxIterations) {
      throw new Error(
        `Maximum loop iterations (${this.maxIterations}) exceeded for node '${nodeId}'. ` +
          'Set maxIterations to increase the limit.',
      );
    }
    this.iterationCounters.set(nodeId, current + 1);

    if (this.onIterationUpdate) {
      this.onIterationUpdate(nodeId, current + 1);
    }

    return current;
  }

  /**
   * Generate an iterated stage name for context tree.
   * First visit: "askLLM", second: "askLLM.1", third: "askLLM.2".
   */
  getIteratedStageName(baseName: string, iteration: number): string {
    return iteration === 0 ? baseName : `${baseName}.${iteration}`;
  }
}
