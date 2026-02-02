/**
 * LoopHandler.ts
 *
 * WHY: Handles dynamic next, iteration counting, and loop-back logic for the Pipeline.
 * This module is extracted from Pipeline.ts following the Single Responsibility Principle,
 * isolating the concerns of loop handling from pipeline traversal.
 *
 * RESPONSIBILITIES:
 * - Manage iteration counters (iterationCounters map)
 * - Generate iterated stage names (e.g., "askLLM.1", "askLLM.2")
 * - Resolve dynamicNext (string reference, StageNode with fn, StageNode without fn)
 * - Log flow control decisions for loop-backs
 *
 * DESIGN DECISIONS:
 * - Iteration counters are per-node-ID, enabling multiple loops to the same node
 * - First visit uses base name, subsequent visits append iteration number
 * - Supports three dynamicNext patterns: string ID, StageNode with fn, StageNode reference
 *
 * DOES NOT HANDLE:
 * - Stage execution (uses executeNode callback)
 * - Commit logic (caller handles)
 * - Extractor calls (caller handles)
 *
 * RELATED:
 * - {@link Pipeline} - Orchestrates when loops are executed
 * - {@link NodeResolver} - Used to find target nodes by ID
 * - {@link StageContext} - Used for debug info and context creation
 *
 * _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8_
 */

import { StageContext } from '../../memory/StageContext';
import { logger } from '../../../utils/logger';
import type { StageNode } from '../Pipeline';
import type { NodeResolver } from './NodeResolver';
import type { PipelineContext } from '../types';

/**
 * Callback type for executing a node.
 *
 * WHY: Used by LoopHandler to continue execution after resolving dynamicNext.
 * This avoids circular dependency with Pipeline.
 */
export type ExecuteNodeFn<TOut = any, TScope = any> = (
  node: StageNode<TOut, TScope>,
  context: StageContext,
  breakFlag: { shouldBreak: boolean },
  branchPath?: string,
) => Promise<any>;

/**
 * LoopHandler
 * ------------------------------------------------------------------
 * Handles dynamic next, iteration counting, and loop-back logic.
 *
 * WHY: Loops are a common pattern in pipelines (e.g., retry logic, iterative
 * refinement). This class centralizes all loop-related logic in one place.
 *
 * DESIGN: Uses iteration counters to generate unique stage names for each
 * visit to a node, enabling the context tree to track multiple executions.
 *
 * @template TOut - The output type of stage functions
 * @template TScope - The scope type passed to stage functions
 *
 * @example
 * ```typescript
 * const handler = new LoopHandler(pipelineContext, nodeResolver);
 * const result = await handler.handle(dynamicNext, node, context, breakFlag, branchPath, executeNode);
 * ```
 */
export class LoopHandler<TOut = any, TScope = any> {
  /**
   * Iteration counter for loop support.
   * Tracks how many times each node ID has been visited (for context path generation).
   * Key: node.id, Value: iteration count (0 = first visit)
   */
  private iterationCounters: Map<string, number> = new Map();

  constructor(
    private readonly ctx: PipelineContext<TOut, TScope>,
    private readonly nodeResolver: NodeResolver<TOut, TScope>,
  ) {}

  /**
   * Handle dynamic next (loop-back or dynamic continuation).
   *
   * WHY: Resolves dynamicNext based on its type to support multiple patterns:
   * - String: Reference to existing node by ID (resolve via NodeResolver.findNodeById)
   * - StageNode with fn: Execute directly (truly dynamic)
   * - StageNode without fn: Reference by ID (resolve via NodeResolver.findNodeById)
   *
   * @param dynamicNext - The dynamic next target (string ID or StageNode)
   * @param node - The current node (for error messages)
   * @param context - The stage context
   * @param breakFlag - Break flag for propagation
   * @param branchPath - Branch path for logging
   * @param executeNode - Callback to execute the target node
   * @returns The result of executing the target node
   *
   * _Requirements: 3.4, 3.5, 3.6, 3.7_
   */
  async handle(
    dynamicNext: string | StageNode<TOut, TScope>,
    node: StageNode<TOut, TScope>,
    context: StageContext,
    breakFlag: { shouldBreak: boolean },
    branchPath: string | undefined,
    executeNode: ExecuteNodeFn<TOut, TScope>,
  ): Promise<any> {
    // If dynamicNext is a string, it's a reference to an existing node by ID
    if (typeof dynamicNext === 'string') {
      return this.handleStringReference(dynamicNext, node, context, breakFlag, branchPath, executeNode);
    }

    // If dynamicNext is a StageNode with fn, execute it directly (truly dynamic)
    if (dynamicNext.fn) {
      return this.handleDirectNode(dynamicNext, context, breakFlag, branchPath, executeNode);
    }

    // If dynamicNext is a StageNode without fn, it's a reference - look up by ID
    return this.handleNodeReference(dynamicNext, node, context, breakFlag, branchPath, executeNode);
  }

  /**
   * Handle dynamicNext as a string reference to an existing node.
   */
  private async handleStringReference(
    nodeId: string,
    currentNode: StageNode<TOut, TScope>,
    context: StageContext,
    breakFlag: { shouldBreak: boolean },
    branchPath: string | undefined,
    executeNode: ExecuteNodeFn<TOut, TScope>,
  ): Promise<any> {
    const targetNode = this.nodeResolver.findNodeById(nodeId);
    if (!targetNode) {
      const errorMessage = `dynamicNext target node not found: ${nodeId}`;
      logger.error(`Error in pipeline (${branchPath}) stage [${currentNode.name}]:`, { error: errorMessage });
      throw new Error(errorMessage);
    }

    const iteration = this.getAndIncrementIteration(nodeId);
    const iteratedStageName = this.getIteratedStageName(targetNode.name, iteration);
    context.addLog('dynamicNextTarget', nodeId);
    context.addLog('dynamicNextIteration', iteration);

    // Log flow control decision for loop
    context.addFlowDebugMessage('loop',
      `Looping back to ${targetNode.displayName || targetNode.name} (iteration ${iteration + 1})`, {
        targetStage: targetNode.name,
        iteration: iteration + 1,
      });

    const nextStageContext = context.createNext(branchPath as string, iteratedStageName);
    return executeNode(targetNode, nextStageContext, breakFlag, branchPath);
  }

  /**
   * Handle dynamicNext as a direct StageNode with fn (truly dynamic).
   */
  private async handleDirectNode(
    dynamicNode: StageNode<TOut, TScope>,
    context: StageContext,
    breakFlag: { shouldBreak: boolean },
    branchPath: string | undefined,
    executeNode: ExecuteNodeFn<TOut, TScope>,
  ): Promise<any> {
    context.addLog('dynamicNextDirect', true);
    context.addLog('dynamicNextName', dynamicNode.name);

    // Log flow control decision for dynamic next
    context.addFlowDebugMessage('next', `Moving to ${dynamicNode.displayName || dynamicNode.name} stage (dynamic)`, {
      targetStage: dynamicNode.name,
    });

    const nextStageContext = context.createNext(branchPath as string, dynamicNode.name);
    return executeNode(dynamicNode, nextStageContext, breakFlag, branchPath);
  }

  /**
   * Handle dynamicNext as a StageNode reference (no fn, look up by ID).
   */
  private async handleNodeReference(
    dynamicNode: StageNode<TOut, TScope>,
    currentNode: StageNode<TOut, TScope>,
    context: StageContext,
    breakFlag: { shouldBreak: boolean },
    branchPath: string | undefined,
    executeNode: ExecuteNodeFn<TOut, TScope>,
  ): Promise<any> {
    const nextNodeId = dynamicNode.id;
    if (!nextNodeId) {
      const errorMessage = 'dynamicNext node must have an id when used as reference';
      logger.error(`Error in pipeline (${branchPath}) stage [${currentNode.name}]:`, { error: errorMessage });
      throw new Error(errorMessage);
    }

    const targetNode = this.nodeResolver.findNodeById(nextNodeId);
    if (!targetNode) {
      const errorMessage = `dynamicNext target node not found: ${nextNodeId}`;
      logger.error(`Error in pipeline (${branchPath}) stage [${currentNode.name}]:`, { error: errorMessage });
      throw new Error(errorMessage);
    }

    const iteration = this.getAndIncrementIteration(nextNodeId);
    const iteratedStageName = this.getIteratedStageName(targetNode.name, iteration);
    context.addLog('dynamicNextTarget', nextNodeId);
    context.addLog('dynamicNextIteration', iteration);

    // Log flow control decision for loop
    context.addFlowDebugMessage('loop',
      `Looping back to ${targetNode.displayName || targetNode.name} (iteration ${iteration + 1})`, {
        targetStage: targetNode.name,
        iteration: iteration + 1,
      });

    const nextStageContext = context.createNext(branchPath as string, iteratedStageName);
    return executeNode(targetNode, nextStageContext, breakFlag, branchPath);
  }

  /**
   * Get the next iteration number for a node and increment the counter.
   *
   * WHY: Enables tracking multiple visits to the same node in the context tree.
   * Returns 0 for first visit, 1 for second, etc.
   *
   * _Requirements: 3.2_
   */
  getAndIncrementIteration(nodeId: string): number {
    const current = this.iterationCounters.get(nodeId) ?? 0;
    this.iterationCounters.set(nodeId, current + 1);
    return current;
  }

  /**
   * Generate an iterated stage name for context tree.
   *
   * WHY: Creates unique names for each visit to enable proper context tree structure.
   * First visit: "askLLM", second: "askLLM.1", third: "askLLM.2"
   *
   * _Requirements: 3.3_
   */
  getIteratedStageName(baseName: string, iteration: number): string {
    return iteration === 0 ? baseName : `${baseName}.${iteration}`;
  }
}
