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
 */

import type { StageContext } from '../../memory/StageContext.js';
import type { StageNode } from '../graph/StageNode.js';
import type { TraversalContext } from '../narrative/types.js';
import type { HandlerDeps } from '../types.js';
import type { NodeResolver } from './NodeResolver.js';
import type { ExecuteNodeFn } from './types.js';

export const DEFAULT_MAX_ITERATIONS = 1000;

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
   * Resolve a dynamic continuation.
   * Dispatches to handleStringReference, handleDirectNode, or handleNodeReference
   * based on the dynamicNext type.
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
    if (typeof dynamicNext === 'string') {
      return this.handleStringReference(
        dynamicNext,
        node,
        context,
        breakFlag,
        branchPath,
        executeNode,
        traversalContext,
      );
    }

    if (dynamicNext.fn) {
      return this.handleDirectNode(dynamicNext, context, breakFlag, branchPath, executeNode);
    }

    return this.handleNodeReference(dynamicNext, node, context, breakFlag, branchPath, executeNode, traversalContext);
  }

  /** dynamicNext is a string ID → resolve from graph, track iteration. */
  private async handleStringReference(
    nodeId: string,
    currentNode: StageNode<TOut, TScope>,
    context: StageContext,
    breakFlag: { shouldBreak: boolean },
    branchPath: string | undefined,
    executeNode: ExecuteNodeFn<TOut, TScope>,
    traversalContext?: TraversalContext,
  ): Promise<any> {
    const targetNode = this.nodeResolver.findNodeById(nodeId);
    if (!targetNode) {
      const errorMessage = `dynamicNext target node not found: ${nodeId}`;
      this.deps.logger.error(`Error in pipeline (${branchPath}) stage [${currentNode.name}]:`, { error: errorMessage });
      throw new Error(errorMessage);
    }

    const iteration = this.getAndIncrementIteration(nodeId);
    const iteratedStageName = this.getIteratedStageName(targetNode.name, iteration);
    context.addLog('dynamicNextTarget', nodeId);
    context.addLog('dynamicNextIteration', iteration);

    context.addFlowDebugMessage('loop', `Looping back to ${targetNode.name} (iteration ${iteration + 1})`, {
      targetStage: targetNode.name,
      iteration: iteration + 1,
    });

    this.deps.narrativeGenerator.onLoop(targetNode.name, iteration + 1, targetNode.description, traversalContext);

    const nextStageContext = context.createNext(branchPath as string, iteratedStageName, targetNode.id);
    return executeNode(targetNode, nextStageContext, breakFlag, branchPath);
  }

  /** dynamicNext is a StageNode with fn → execute directly (truly dynamic). */
  private async handleDirectNode(
    dynamicNode: StageNode<TOut, TScope>,
    context: StageContext,
    breakFlag: { shouldBreak: boolean },
    branchPath: string | undefined,
    executeNode: ExecuteNodeFn<TOut, TScope>,
  ): Promise<any> {
    context.addLog('dynamicNextDirect', true);
    context.addLog('dynamicNextName', dynamicNode.name);

    context.addFlowDebugMessage('next', `Moving to ${dynamicNode.name} stage (dynamic)`, {
      targetStage: dynamicNode.name,
    });

    const nextStageContext = context.createNext(branchPath as string, dynamicNode.name, dynamicNode.id);
    return executeNode(dynamicNode, nextStageContext, breakFlag, branchPath);
  }

  /** dynamicNext is a StageNode without fn → reference by ID, resolve + track iteration. */
  private async handleNodeReference(
    dynamicNode: StageNode<TOut, TScope>,
    currentNode: StageNode<TOut, TScope>,
    context: StageContext,
    breakFlag: { shouldBreak: boolean },
    branchPath: string | undefined,
    executeNode: ExecuteNodeFn<TOut, TScope>,
    traversalContext?: TraversalContext,
  ): Promise<any> {
    const nextNodeId = dynamicNode.id;
    if (!nextNodeId) {
      const errorMessage = 'dynamicNext node must have an id when used as reference';
      this.deps.logger.error(`Error in pipeline (${branchPath}) stage [${currentNode.name}]:`, { error: errorMessage });
      throw new Error(errorMessage);
    }

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
    return executeNode(targetNode, nextStageContext, breakFlag, branchPath);
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
