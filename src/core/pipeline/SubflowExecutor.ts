/**
 * SubflowExecutor.ts
 *
 * Handles subflow execution with isolated PipelineRuntime contexts.
 * Extracted from Pipeline.ts to follow Single Responsibility Principle.
 *
 * Responsibilities:
 * - Execute subflows with isolated PipelineRuntime contexts
 * - Handle stage execution within subflow contexts
 * - Execute children within subflow contexts
 * - Execute selected children within subflow contexts
 *
 * _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6_
 */

import { StageContext } from '../context/StageContext';
import { PipelineRuntime } from '../context/PipelineRuntime';
import { PipelineContext, SubflowResult, NodeResultType, PipelineStageFunction } from './types';
import { logger } from '../logger';
import type { StageNode, Selector, Decider } from './GraphTraverser';
import { NodeResolver } from './NodeResolver';

/**
 * ExecuteStageFn
 * ------------------------------------------------------------------
 * Callback type for executing a stage function.
 * Passed from Pipeline to avoid circular dependency.
 */
export type ExecuteStageFn<TOut = any, TScope = any> = (
  node: StageNode<TOut, TScope>,
  stageFunc: PipelineStageFunction<TOut, TScope>,
  context: StageContext,
  breakFn: () => void,
) => Promise<TOut>;

/**
 * CallExtractorFn
 * ------------------------------------------------------------------
 * Callback type for calling the traversal extractor.
 * Passed from Pipeline to avoid circular dependency.
 */
export type CallExtractorFn<TOut = any, TScope = any> = (
  node: StageNode<TOut, TScope>,
  context: StageContext,
  stagePath: string,
) => void;

/**
 * GetStageFnFn
 * ------------------------------------------------------------------
 * Callback type for getting a stage function from the stage map.
 * Passed from Pipeline to avoid circular dependency.
 */
export type GetStageFnFn<TOut = any, TScope = any> = (
  node: StageNode<TOut, TScope>,
) => PipelineStageFunction<TOut, TScope> | undefined;

/**
 * SubflowExecutor
 * ------------------------------------------------------------------
 * Handles subflow execution with isolated PipelineRuntime contexts.
 * Uses PipelineContext for access to shared pipeline state.
 *
 * @template TOut - Output type of pipeline stages
 * @template TScope - Scope type passed to stages
 */
export class SubflowExecutor<TOut = any, TScope = any> {
  constructor(
    private ctx: PipelineContext<TOut, TScope>,
    private nodeResolver: NodeResolver<TOut, TScope>,
    private executeStage: ExecuteStageFn<TOut, TScope>,
    private callExtractor: CallExtractorFn<TOut, TScope>,
    private getStageFn: GetStageFnFn<TOut, TScope>,
  ) {}

  /**
   * Execute a subflow with isolated context.
   * Creates a new PipelineRuntime for the subflow.
   *
   * This method:
   * 1. Creates a fresh PipelineRuntime for the subflow
   * 2. Executes the subflow's internal structure (root fn + children) using the nested context
   * 3. Stores the subflow's execution data in the parent stage's debugInfo
   * 4. Returns control to parent, which continues with node.next if present
   *
   * IMPORTANT: The subflow's `next` chain is NOT executed inside the subflow.
   * After executeSubflow returns, the parent's executeNode continues with node.next.
   * This ensures stages after a subflow execute in the parent's context.
   *
   * @param subflowRoot - The subflow root node (has isSubflowRoot: true)
   * @param parentContext - The parent pipeline's StageContext
   * @param breakFlag - Break flag from parent (subflow break doesn't propagate up)
   * @param branchPath - Parent's branch path for logging
   * @param subflowResultsMap - Map to store subflow results (from parent Pipeline)
   * @returns The subflow's final output
   *
   * _Requirements: 1.1, 1.5_
   */
  async executeSubflow(
    node: StageNode<TOut, TScope>,
    parentContext: StageContext,
    breakFlag: { shouldBreak: boolean },
    branchPath: string | undefined,
    subflowResultsMap: Map<string, SubflowResult>,
  ): Promise<any> {
    const subflowId = node.subflowId!;
    const subflowName = node.subflowName ?? node.name;

    // Log flow control decision for subflow entry
    // _Requirements: flow-control-narrative REQ-3 (Task 6)
    parentContext.addFlowDebugMessage('subflow', `Entering ${subflowName} subflow`, {
      targetStage: subflowId,
    });

    // Mark parent stage as subflow container
    parentContext.addDebugInfo('isSubflowContainer', true);
    parentContext.addDebugInfo('subflowId', subflowId);
    parentContext.addDebugInfo('subflowName', subflowName);

    // Create isolated context for subflow
    // Each subflow gets its own PipelineRuntime with its own GlobalStore,
    // so all stages within the subflow share the same state at the root level.
    // We do NOT set pipelineId here - the subflow's isolation comes from having
    // its own GlobalStore, not from namespacing within a shared store.
    const nestedContext = new PipelineRuntime(node.name);
    const nestedRootContext = nestedContext.rootStageContext;

    // Create isolated break flag (subflow break doesn't propagate to parent)
    const subflowBreakFlag = { shouldBreak: false };

    let subflowOutput: any;
    let subflowError: Error | undefined;

    // Create a copy of the node for subflow execution
    // Clear isSubflowRoot to prevent infinite recursion in executeSubflowInternal
    // 
    // IMPORTANT: We need to determine if `next` is part of the subflow's internal structure
    // or a continuation after the subflow.
    //
    // For reference-based subflows (resolved from subflows dictionary):
    // - The resolved node's `next` is the subflow's internal chain (from the definition)
    // - The original reference node's `next` (if any) is the continuation
    // - Since we receive the resolved node here, its `next` is internal
    //
    // For inline subflows (node has fn/children directly):
    // - If the subflow has `children` (fork pattern), `next` is typically the continuation
    // - If the subflow has no `children` (linear pattern), `next` is the internal chain
    //
    // We use a heuristic: if the node has `children`, strip `next` (it's continuation).
    // Otherwise, keep `next` (it's internal chain).
    const hasChildren = Boolean(node.children && node.children.length > 0);
    
    const subflowNode: StageNode<TOut, TScope> = {
      ...node,
      isSubflowRoot: false, // Clear to prevent re-detection as subflow
      // For subflows with children (fork pattern), strip `next` - it's the continuation
      // For subflows without children (linear pattern), keep `next` - it's internal chain
      next: hasChildren ? undefined : node.next,
    };

    try {
      // Store reference to subflowResultsMap for nested subflows
      this.subflowResultsMap = subflowResultsMap;
      
      // Execute subflow using nested context
      // Executes the subflow's internal structure (root fn + children + next chain)
      subflowOutput = await this.executeSubflowInternal(
        subflowNode,
        nestedRootContext,
        subflowBreakFlag,
        subflowId,
      );
    } catch (error: any) {
      subflowError = error;
      parentContext.addErrorInfo('subflowError', error.toString());
      logger.error(`Error in subflow (${subflowId}):`, { error });
    }

    // Serialize subflow's execution data
    const subflowTreeContext = nestedContext.getContextTree();
    // NOTE: pipelineStructure removed - structure comes from build-time `subflows` dictionary
    // The TraversalExtractor generates stepNumber for each stage (same as main pipeline)

    // Create SubflowResult (execution data only, no structure)
    const subflowResult: SubflowResult = {
      subflowId,
      subflowName,
      treeContext: {
        globalContext: subflowTreeContext.globalContext,
        stageContexts: subflowTreeContext.stageContexts as unknown as Record<string, unknown>,
        history: subflowTreeContext.history,
      },
      parentStageId: parentContext.getStageId(),
    };

    // Store in parent stage's debugInfo for drill-down
    parentContext.addDebugInfo('subflowResult', subflowResult);
    parentContext.addDebugInfo('hasSubflowData', true);

    // Add to collection for API response
    subflowResultsMap.set(subflowId, subflowResult);

    // Log flow control decision for subflow exit
    // _Requirements: flow-control-narrative REQ-3 (Task 6)
    parentContext.addFlowDebugMessage('subflow', `Exiting ${subflowName} subflow`, {
      targetStage: subflowId,
    });

    // Commit parent context patch
    parentContext.commitPatch();

    // Re-throw if subflow errored
    if (subflowError) {
      throw subflowError;
    }

    // NOTE: The parent's continuation is handled by executeNode after this returns.
    // For reference-based subflows, the original reference node's `next` is used.
    // For old-style subflows, the node passed here already has `next` stripped by the caller.
    return subflowOutput;
  }

  /**
   * Internal execution within subflow context.
   * Handles stage execution within the subflow's isolated context.
   *
   * This method mirrors Pipeline.executeNode but operates within the subflow's
   * isolated PipelineRuntime. It handles:
   * - Nested subflow detection (delegates back to executeSubflow)
   * - Stage function execution
   * - Children execution (fork, decider, selector patterns)
   * - Linear next continuation
   *
   * @param node - The current node to execute within the subflow
   * @param context - The subflow's stage context
   * @param breakFlag - Break flag for the subflow (doesn't propagate to parent)
   * @param branchPath - Branch path for logging
   * @returns Promise resolving to the stage output or children results
   *
   * _Requirements: 1.2_
   */
  private async executeSubflowInternal(
    node: StageNode<TOut, TScope>,
    context: StageContext,
    breakFlag: { shouldBreak: boolean },
    branchPath: string,
  ): Promise<any> {
    // Detect nested subflows and delegate to executeSubflow
    // This ensures nested subflows get their own isolated context AND
    // are added to the parent Pipeline's subflowResults map
    if (node.isSubflowRoot && node.subflowId) {
      // Resolve reference node if needed (nested subflows may also be references)
      const resolvedNode = this.nodeResolver.resolveSubflowReference(node);
      // Note: For nested subflows, we need to call back to the parent Pipeline's executeSubflow
      // This is handled by the executeSubflow method which stores results in subflowResultsMap
      return await this.executeSubflow(resolvedNode, context, breakFlag, branchPath, this.subflowResultsMap!);
    }

    // Get the stage function for the subflow root (if any)
    const stageFunc = this.getStageFn(node);
    const hasStageFunction = Boolean(stageFunc);
    const hasChildren = Boolean(node.children?.length);
    const hasNext = Boolean(node.next);
    const isDeciderNode = Boolean(node.nextNodeDecider);

    const breakFn = () => (breakFlag.shouldBreak = true);

    // Execute the subflow root's stage function if present
    let stageOutput: TOut | undefined;
    if (stageFunc) {
      try {
        stageOutput = await this.executeStage(node, stageFunc, context, breakFn);
      } catch (error: any) {
        context.commitPatch();
        this.callExtractor(node, context, this.getStagePath(node, branchPath));
        context.addErrorInfo('stageExecutionError', error.toString());
        throw error;
      }
      context.commitPatch();
      this.callExtractor(node, context, this.getStagePath(node, branchPath));

      if (breakFlag.shouldBreak) {
        return stageOutput;
      }
    }

    // Handle children (fork pattern)
    if (hasChildren) {
      if (isDeciderNode) {
        // Decider picks one child
        const chosen = await this.nodeResolver.getNextNode(
          node.nextNodeDecider as Decider,
          node.children!,
          stageOutput,
          context,
        );
        // Use empty string for pipelineId to keep writes at root level of subflow's GlobalStore
        const nextStageContext = context.createNextContext('', chosen.name);
        const deciderResult = await this.executeSubflowInternal(chosen, nextStageContext, breakFlag, branchPath);
        // After decider branch completes, continue with node.next if present
        // This allows stages to be added after a subflow that ends with a decider
        if (!hasNext) return deciderResult;
        // Fall through to handle linear next below
      } else if (node.nextNodeSelector) {
        // Selector picks multiple children
        const nodeChildrenResults = await this.executeSelectedChildrenInternal(
          node.nextNodeSelector,
          node.children!,
          stageOutput,
          context,
          branchPath,
          breakFlag,
        );
        if (!hasNext) return nodeChildrenResults;
      } else {
        // Execute all children in parallel (using internal version for subflow context)
        const nodeChildrenResults = await this.executeNodeChildrenInternal(
          node,
          context,
          branchPath,
          breakFlag,
        );
        if (!hasNext) return nodeChildrenResults;
      }
    }

    // Handle linear next
    if (hasNext) {
      const nextNode = node.next!;
      // Use empty string for pipelineId to keep writes at root level of subflow's GlobalStore
      const nextStageContext = context.createNextContext('', nextNode.name);
      return await this.executeSubflowInternal(nextNode, nextStageContext, breakFlag, branchPath);
    }

    return stageOutput;
  }

  /**
   * Generate the stage path for extractor results.
   * Uses node.id if available, otherwise node.name.
   * Combines with branchPath for nested stages.
   */
  private getStagePath(node: StageNode<TOut, TScope>, branchPath?: string): string {
    const nodeId = node.id ?? node.name;
    if (!branchPath) return nodeId;
    return `${branchPath}.${nodeId}`;
  }

  /**
   * Reference to the subflow results map from the parent Pipeline.
   * Set during executeSubflow to allow nested subflows to store their results.
   */
  private subflowResultsMap?: Map<string, SubflowResult>;

  /**
   * Execute children within a subflow's context.
   * Similar to ChildrenExecutor.executeNodeChildren but uses executeSubflowInternal
   * for recursion, ensuring nested subflows are properly detected.
   *
   * @param node - Parent node containing children to execute
   * @param context - Current stage context within the subflow
   * @param branchPath - Branch path for logging
   * @param breakFlag - Break flag for the subflow
   * @returns Object mapping child IDs to their results
   *
   * _Requirements: 1.3_
   */
  private async executeNodeChildrenInternal(
    node: StageNode<TOut, TScope>,
    context: StageContext,
    branchPath: string,
    breakFlag: { shouldBreak: boolean },
  ): Promise<Record<string, NodeResultType>> {
    const childPromises: Promise<NodeResultType>[] = (node.children ?? []).map((child: StageNode<TOut, TScope>) => {
      // Use empty string for pipelineId to keep writes at root level of subflow's GlobalStore
      // branchPath is still passed to executeSubflowInternal for logging purposes
      const childContext = context.createChildContext('', child.id as string, child.name);
      const childBreakFlag = { shouldBreak: false };

      return this.executeSubflowInternal(child, childContext, childBreakFlag, branchPath)
        .then((result) => {
          childContext.commitPatch();
          return { id: child.id!, result, isError: false };
        })
        .catch((error) => {
          childContext.commitPatch();
          logger.info(`TREE PIPELINE: executeNodeChildrenInternal - Error for id: ${child?.id}`, { error });
          return { id: child.id!, result: error, isError: true };
        });
    });

    const settled = await Promise.allSettled(childPromises);

    const childrenResults: Record<string, NodeResultType> = {};
    settled.forEach((s) => {
      if (s.status === 'fulfilled') {
        const { id, result, isError } = s.value;
        childrenResults[id] = { id, result, isError };
      } else {
        logger.error(`Execution failed: ${s.reason}`);
      }
    });

    return childrenResults;
  }

  /**
   * Execute selected children within a subflow's context.
   * Similar to ChildrenExecutor.executeSelectedChildren but uses executeSubflowInternal
   * for recursion, ensuring nested subflows are properly detected.
   *
   * @param selector - Function that returns selected child ID(s)
   * @param children - Array of child nodes to select from
   * @param input - Input to pass to the selector function
   * @param context - Current stage context within the subflow
   * @param branchPath - Branch path for logging
   * @param breakFlag - Break flag for the subflow
   * @returns Object mapping child IDs to their results
   *
   * _Requirements: 1.4_
   */
  private async executeSelectedChildrenInternal(
    selector: Selector,
    children: StageNode<TOut, TScope>[],
    input: any,
    context: StageContext,
    branchPath: string,
    breakFlag: { shouldBreak: boolean },
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
      logger.error(`Error in subflow (${branchPath}):`, { error: errorMessage });
      context.addErrorInfo('selectorError', errorMessage);
      throw new Error(errorMessage);
    }

    // Record skipped children for visualization
    const skippedIds = children.filter((c) => !selectedIds.includes(c.id!)).map((c) => c.id);
    if (skippedIds.length > 0) {
      context.addDebugInfo('skippedChildIds', skippedIds);
    }

    // Execute selected children using internal version (for subflow context)
    const tempNode: StageNode<TOut, TScope> = { name: 'selector-temp', children: selectedChildren };
    return await this.executeNodeChildrenInternal(tempNode, context, branchPath, breakFlag);
  }
}
