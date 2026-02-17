/**
 * SubflowExecutor.ts
 *
 * WHY: Handles subflow execution with isolated PipelineRuntime contexts.
 * This module is extracted from Pipeline.ts following the Single Responsibility Principle,
 * isolating the concerns of subflow execution from main pipeline traversal.
 *
 * RESPONSIBILITIES:
 * - Execute subflows with isolated PipelineRuntime contexts
 * - Handle stage execution within subflow contexts
 * - Execute children within subflow contexts (fork, decider, selector patterns)
 * - Apply input/output mapping for subflows (via SubflowInputMapper)
 *
 * DESIGN DECISIONS:
 * - Each subflow gets its own PipelineRuntime with its own GlobalStore for isolation
 * - Nested subflows are detected and delegated back to executeSubflow for proper isolation
 * - Input mapping seeds the subflow's GlobalStore before execution
 * - Output mapping writes back to parent scope after successful completion
 *
 * RELATED:
 * - {@link Pipeline} - Orchestrates when subflows are executed
 * - {@link PipelineRuntime} - Provides isolated context for subflow execution
 * - {@link SubflowInputMapper} - Handles input/output mapping between parent and subflow
 * - {@link NodeResolver} - Resolves subflow references and node lookups
 *
 * _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6_
 * _Requirements: subflow-input-mapping 8.5_
 */

import { StageContext } from '../../memory/StageContext';
import { PipelineRuntime } from '../../memory/PipelineRuntime';
import { PipelineContext, SubflowResult, NodeResultType, PipelineStageFunction } from '../types';
import { logger } from '../../../utils/logger';
import type { StageNode, Selector, Decider } from '../Pipeline';
import { isStageNodeReturn } from '../Pipeline';
import { NodeResolver } from './NodeResolver';
import { StageRunner } from './StageRunner';
import {
  getInitialScopeValues,
  seedSubflowGlobalStore,
  applyOutputMapping,
  createSubflowPipelineContext,
} from './SubflowInputMapper';

/**
 * ExecuteStageFn
 * ------------------------------------------------------------------
 * Callback type for executing a stage function.
 *
 * WHY: Passed from Pipeline to avoid circular dependency. This allows
 * SubflowExecutor to execute stages without importing Pipeline.
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
 *
 * WHY: Passed from Pipeline to avoid circular dependency. This allows
 * SubflowExecutor to call the extractor without importing Pipeline.
 *
 * @param node - The stage node
 * @param context - The stage context (after commit)
 * @param stagePath - The full path to this stage
 * @param stageOutput - The stage function's return value (undefined on error or no-function nodes)
 *   _Requirements: single-pass-debug-structure 1.3_
 * @param errorInfo - Error details when the stage threw during execution
 *   _Requirements: single-pass-debug-structure 1.4_
 */
export type CallExtractorFn<TOut = any, TScope = any> = (
  node: StageNode<TOut, TScope>,
  context: StageContext,
  stagePath: string,
  stageOutput?: unknown,
  errorInfo?: { type: string; message: string },
) => void;

/**
 * GetStageFnFn
 * ------------------------------------------------------------------
 * Callback type for getting a stage function from the stage map.
 *
 * WHY: Passed from Pipeline to avoid circular dependency. This allows
 * SubflowExecutor to resolve stage functions without importing Pipeline.
 */
export type GetStageFnFn<TOut = any, TScope = any> = (
  node: StageNode<TOut, TScope>,
) => PipelineStageFunction<TOut, TScope> | undefined;

/**
 * SubflowExecutor
 * ------------------------------------------------------------------
 * Handles subflow execution with isolated PipelineRuntime contexts.
 *
 * WHY: Subflows need their own isolated context to prevent state pollution
 * between the parent pipeline and the subflow. This class manages that isolation
 * while still allowing data to flow between parent and subflow via input/output mapping.
 *
 * DESIGN: Uses PipelineContext for access to shared pipeline state, enabling
 * dependency injection for testing.
 *
 * @template TOut - Output type of pipeline stages
 * @template TScope - Scope type passed to stages
 *
 * @example
 * ```typescript
 * const executor = new SubflowExecutor(ctx, nodeResolver, executeStage, callExtractor, getStageFn);
 * const result = await executor.executeSubflow(subflowNode, parentContext, breakFlag, branchPath, resultsMap);
 * ```
 */
export class SubflowExecutor<TOut = any, TScope = any> {
  /**
   * The current subflow's PipelineContext.
   * Set during executeSubflow and used by executeSubflowInternal for stage execution.
   * This ensures stages within the subflow use the subflow's readOnlyContext.
   * _Requirements: subflow-scope-isolation 1.3, 2.2_
   */
  private currentSubflowCtx?: PipelineContext<TOut, TScope>;

  constructor(
    private ctx: PipelineContext<TOut, TScope>,
    private nodeResolver: NodeResolver<TOut, TScope>,
    private executeStage: ExecuteStageFn<TOut, TScope>,
    private callExtractor: CallExtractorFn<TOut, TScope>,
    private getStageFn: GetStageFnFn<TOut, TScope>,
  ) {}

  /**
   * Execute a subflow with isolated context.
   *
   * WHY: Subflows need their own PipelineRuntime to prevent state pollution.
   * This method creates the isolated context, applies input mapping, executes
   * the subflow, and applies output mapping.
   *
   * DESIGN: This method:
   * 1. Creates a fresh PipelineRuntime for the subflow
   * 2. Applies input mapping to seed the subflow's GlobalStore
   * 3. Executes the subflow's internal structure using the nested context
   * 4. Applies output mapping to write results back to parent scope
   * 5. Stores the subflow's execution data for debugging/visualization
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
    parentContext.addFlowDebugMessage('subflow', `Entering ${subflowName} subflow`, {
      targetStage: subflowId,
    });

    // Narrative: mark subflow entry for human-readable story
    // WHY: Captures the nesting boundary so the reader can follow nested execution contexts
    // _Requirements: 7.1_
    this.ctx.narrativeGenerator.onSubflowEntry(subflowName);

    // Mark parent stage as subflow container
    parentContext.addLog('isSubflowContainer', true);
    parentContext.addLog('subflowId', subflowId);
    parentContext.addLog('subflowName', subflowName);

    // ─────────────────────────── Input Mapping ───────────────────────────
    // Compute mapped input BEFORE creating PipelineRuntime so it can be
    // passed as initialContext. This ensures the data is in the GlobalStore
    // from the start, avoiding WriteBuffer base-snapshot staleness issues.
    const mountOptions = node.subflowMountOptions;
    let mappedInput: Record<string, unknown> = {};
    
    if (mountOptions) {
      try {
        const parentScope = parentContext.getScope();
        mappedInput = getInitialScopeValues(parentScope, mountOptions);
        
        if (Object.keys(mappedInput).length > 0) {
          parentContext.addLog('mappedInput', mappedInput);
        }
      } catch (error: any) {
        parentContext.addError('inputMapperError', error.toString());
        logger.error(`Error in inputMapper for subflow (${subflowId}):`, { error });
        throw error;
      }
    }

    // Create isolated context for subflow
    // WHY: Each subflow gets its own PipelineRuntime with its own GlobalStore.
    const nestedContext = new PipelineRuntime(node.name);
    let nestedRootContext = nestedContext.rootStageContext;

    // Seed subflow's GlobalStore with inputMapper data
    // WHY: The inputMapper transforms parent scope data into the subflow's
    // initial state. We seed THEN refresh the rootStageContext so its
    // WriteBuffer base snapshot includes the seeded data.
    if (Object.keys(mappedInput).length > 0) {
      seedSubflowGlobalStore(nestedContext, mappedInput);
      // Refresh rootStageContext so its WriteBuffer sees the committed data
      // WHY: seedSubflowGlobalStore commits to GlobalStore, but the original
      // rootStageContext's WriteBuffer has a stale base snapshot from before
      // seeding. Creating a fresh context from the updated GlobalStore ensures
      // downstream stages (SeedScope, AssemblePrompt) can read the seeded values.
      nestedRootContext = new StageContext('', nestedRootContext.stageName, nestedContext.globalStore, '', nestedContext.executionHistory);
      nestedContext.rootStageContext = nestedRootContext;
    }

    // ─────────────────────── Create Subflow PipelineContext ───────────────────────
    // WHY: Create a new PipelineContext for the subflow with readOnlyContext = mappedInput
    // This ensures StageRunner passes mappedInput to ScopeFactory, so subflow stages
    // can access inputMapper values via their scope.
    const subflowCtx = createSubflowPipelineContext(this.ctx, nestedContext, mappedInput);
    
    // Log the readOnlyContext for debugging
    parentContext.addLog('subflowReadOnlyContext', mappedInput);

    // Create isolated break flag (subflow break doesn't propagate to parent)
    const subflowBreakFlag = { shouldBreak: false };

    let subflowOutput: any;
    let subflowError: Error | undefined;

    // Create a copy of the node for subflow execution
    // Clear isSubflowRoot to prevent infinite recursion in executeSubflowInternal
    // 
    // WHY: We need to determine if `next` is part of the subflow's internal structure
    // or a continuation after the subflow.
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
      
      // Store the subflow root for node resolution within the subflow
      this.currentSubflowRoot = subflowNode;
      
      // Store the subflow context for stage execution within the subflow
      this.currentSubflowCtx = subflowCtx;
      
      // Execute subflow using nested context
      subflowOutput = await this.executeSubflowInternal(
        subflowNode,
        nestedRootContext,
        subflowBreakFlag,
        subflowId,
      );
    } catch (error: any) {
      subflowError = error;
      parentContext.addError('subflowError', error.toString());
      logger.error(`Error in subflow (${subflowId}):`, { error });
    } finally {
      // Clear the subflow root reference to avoid stale references
      this.currentSubflowRoot = undefined;
      // Clear the subflow context reference
      this.currentSubflowCtx = undefined;
    }

    // Serialize subflow's execution data
    const subflowTreeContext = nestedContext.getSnapshot();

    // ─────────────────────────── Output Mapping ───────────────────────────
    // Apply output mapping if subflow completed successfully and outputMapper is provided.
    //
    // WHY: The subflow's output must be written to the CALLER's scope, not the
    // child branch's scope. When a subflow runs inside a ChildrenExecutor child
    // (e.g., tool-social-media-agent), parentContext has a tool-specific pipelineId
    // like 'tool-social-media-agent'. Writing to that namespace puts data at
    // ['pipelines', 'tool-social-media-agent', 'agent', 'messages'] — unreachable
    // by the parent agent which reads from ['agent', 'messages'] (root namespace).
    //
    // FIX: Walk up the context tree to find the ancestor with the root pipelineId
    // (empty string). This is the context that owns the parent agent's scope.
    // The output mapping writes go there so the parent agent sees the sub-agent's
    // result in its conversation history.
    if (!subflowError && mountOptions?.outputMapper) {
      try {
        // Find the correct context for output mapping writes.
        // When parentContext is a child branch (non-empty pipelineId), walk up
        // to the ancestor that owns the caller's scope (root pipelineId = '').
        let outputContext = parentContext;
        if (parentContext.pipelineId && parentContext.pipelineId !== '' && parentContext.parent) {
          outputContext = parentContext.parent;
        }

        const parentScope = outputContext.getScope();
        const mappedOutput = applyOutputMapping(subflowOutput, parentScope, outputContext, mountOptions);
        
        // Log mapped output for debugging (on the original parentContext for visibility)
        if (mappedOutput && Object.keys(mappedOutput).length > 0) {
          parentContext.addLog('mappedOutput', mappedOutput);
          parentContext.addLog('outputMappingTarget', outputContext.pipelineId || '(root)');
        }
        
        // Commit the output context's writes (may be different from parentContext)
        outputContext.commit();
      } catch (error: any) {
        // Log outputMapper error but don't re-throw (non-fatal)
        parentContext.addError('outputMapperError', error.toString());
        logger.error(`Error in outputMapper for subflow (${subflowId}):`, { error });
        // Don't re-throw - output mapping errors are non-fatal
      }
    }

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

    // Attach the subflow's buildTimeStructure if available in the subflows dictionary.
    // WHY: Enables the debug UI to render the subflow's flowchart as a nested
    // visualization. The buildTimeStructure is stored alongside the root node
    // when the subflow was registered (e.g., by AgentBuilder for sub-agent tools).
    const subflowDef = this.ctx.subflows?.[subflowId];
    if (subflowDef && (subflowDef as any).buildTimeStructure) {
      subflowResult.pipelineStructure = (subflowDef as any).buildTimeStructure;
    }

    // Store in parent stage's debugInfo for drill-down
    parentContext.addLog('subflowResult', subflowResult);
    parentContext.addLog('hasSubflowData', true);

    // Add to collection for API response
    subflowResultsMap.set(subflowId, subflowResult);

    // Log flow control decision for subflow exit
    parentContext.addFlowDebugMessage('subflow', `Exiting ${subflowName} subflow`, {
      targetStage: subflowId,
    });

    // Narrative: mark subflow exit for human-readable story
    // WHY: Marks the return from a nested context back to the parent flow
    // _Requirements: 7.2_
    this.ctx.narrativeGenerator.onSubflowExit(subflowName);

    // Commit parent context patch
    parentContext.commit();

    // Re-throw if subflow errored
    if (subflowError) {
      throw subflowError;
    }

    return subflowOutput;
  }

  /**
   * Reference to the current subflow's root node.
   * Used for node resolution within the subflow's structure (e.g., dynamic next loop-back).
   */
  private currentSubflowRoot?: StageNode<TOut, TScope>;

  /**
   * Internal execution within subflow context.
   *
   * WHY: This method mirrors Pipeline.executeNode but operates within the subflow's
   * isolated PipelineRuntime. It handles all the same patterns (stage execution,
   * children, decider, selector, linear next) but within the subflow's context.
   *
   * DESIGN: Handles:
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
    // WHY: Nested subflows need their own isolated context
    if (node.isSubflowRoot && node.subflowId) {
      const resolvedNode = this.nodeResolver.resolveSubflowReference(node);
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
        // Use StageRunner with subflow context to ensure stages
        // receive mappedInput values via readOnlyContext → ScopeFactory
        if (this.currentSubflowCtx) {
          const subflowStageRunner = new StageRunner<TOut, TScope>(this.currentSubflowCtx);
          stageOutput = await subflowStageRunner.run(node, stageFunc, context, breakFn);
        } else {
          // Fallback to parent context (shouldn't happen in normal flow)
          stageOutput = await this.executeStage(node, stageFunc, context, breakFn);
        }
      } catch (error: any) {
        context.commit();
        // Pass undefined for stageOutput and error details for enrichment
        // WHY: On error path, there's no successful output, but we capture
        // the error info so enriched snapshots include what went wrong.
        // _Requirements: single-pass-debug-structure 1.4_
        this.callExtractor(node, context, this.getStagePath(node, branchPath, context.stageName), undefined, {
          type: 'stageExecutionError',
          message: error.toString(),
        });
        context.addError('stageExecutionError', error.toString());
        throw error;
      }
      context.commit();
      // Pass stageOutput so enriched snapshots capture the stage's return value
      // _Requirements: single-pass-debug-structure 1.3_
      this.callExtractor(node, context, this.getStagePath(node, branchPath, context.stageName), stageOutput);

      if (breakFlag.shouldBreak) {
        return stageOutput;
      }

      // ───────────────────────── Handle dynamic stages ─────────────────────────
      // Check if the handler's return object is a StageNode for dynamic continuation.
      if (stageOutput && typeof stageOutput === 'object' && isStageNodeReturn(stageOutput)) {
        const dynamicNode = stageOutput as StageNode<TOut, TScope>;
        context.addLog('isDynamic', true);
        context.addLog('dynamicPattern', 'StageNodeReturn');

        // Handle dynamic children (fork pattern)
        if (dynamicNode.children && dynamicNode.children.length > 0) {
          node.children = dynamicNode.children;
          context.addLog('dynamicChildCount', dynamicNode.children.length);
          context.addLog('dynamicChildIds', dynamicNode.children.map(c => c.id || c.name));

          // Handle dynamic selector (multi-choice branching)
          if (typeof dynamicNode.nextNodeSelector === 'function') {
            node.nextNodeSelector = dynamicNode.nextNodeSelector;
            context.addLog('hasSelector', true);
          }
          // Handle dynamic decider (single-choice branching)
          else if (typeof dynamicNode.nextNodeDecider === 'function') {
            node.nextNodeDecider = dynamicNode.nextNodeDecider;
            context.addLog('hasDecider', true);
          }
        }

        // Handle dynamic next (linear continuation / loop-back)
        if (dynamicNode.next) {
          node.next = dynamicNode.next;
          context.addLog('hasDynamicNext', true);
          const loopTargetId = dynamicNode.next.id || dynamicNode.next.name;
          if (loopTargetId) {
            context.addLog('loopTarget', loopTargetId);
          }
        }

        // Clear stageOutput since the StageNode is the continuation, not the output
        stageOutput = undefined;
      }
    }

    // ───────────────────────── Children (if any) ─────────────────────────
    const hasChildrenAfterStage = Boolean(node.children?.length);
    const hasNextAfterStage = Boolean(node.next);
    const isDeciderNodeAfterStage = Boolean(node.nextNodeDecider);

    // Handle children (fork pattern)
    if (hasChildrenAfterStage) {
      if (isDeciderNodeAfterStage) {
        // Decider picks one child
        const chosen = await this.nodeResolver.getNextNode(
          node.nextNodeDecider as Decider,
          node.children!,
          stageOutput,
          context,
        );
        const nextStageContext = context.createNext('', chosen.name);
        const deciderResult = await this.executeSubflowInternal(chosen, nextStageContext, breakFlag, branchPath);
        if (!hasNextAfterStage) return deciderResult;
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
        if (!hasNextAfterStage) return nodeChildrenResults;
      } else {
        // Execute all children in parallel
        const nodeChildrenResults = await this.executeNodeChildrenInternal(
          node,
          context,
          branchPath,
          breakFlag,
        );
        if (!hasNextAfterStage) return nodeChildrenResults;
      }
    }

    // Handle linear next (including dynamic next from StageNode return)
    if (hasNextAfterStage) {
      let nextNode = node.next!;
      
      // If the next node is a reference (has id but no fn), resolve it from the subflow structure
      // WHY: Critical for loop-back scenarios where the dynamic next only has name/id
      if (nextNode.id && !nextNode.fn) {
        let resolvedNode: StageNode<TOut, TScope> | undefined;
        if (this.currentSubflowRoot) {
          resolvedNode = this.nodeResolver.findNodeById(nextNode.id, this.currentSubflowRoot);
          if (resolvedNode) {
            context.addLog('dynamicNextResolvedFrom', 'subflow');
          }
        }
        
        // Fallback to main pipeline if not found in subflow
        if (!resolvedNode) {
          resolvedNode = this.nodeResolver.findNodeById(nextNode.id);
          if (resolvedNode) {
            context.addLog('dynamicNextResolvedFrom', 'mainPipeline');
          }
        }
        
        if (resolvedNode) {
          nextNode = resolvedNode;
          context.addLog('dynamicNextResolved', true);
          context.addLog('dynamicNextTarget', nextNode.id);
        } else {
          logger.info(`Dynamic next node '${nextNode.id}' not found in subflow or main pipeline`);
          context.addLog('dynamicNextResolved', false);
          context.addLog('dynamicNextNotFound', nextNode.id);
        }
      }
      
      const nextStageContext = context.createNext('', nextNode.name);
      return await this.executeSubflowInternal(nextNode, nextStageContext, breakFlag, branchPath);
    }

    return stageOutput;
  }

  /**
   * Generate the stage path for extractor results.
   * Uses contextStageName (which includes iteration suffix) when it differs from base name.
   */
  private getStagePath(node: StageNode<TOut, TScope>, branchPath?: string, contextStageName?: string): string {
    const baseName = node.id ?? node.name;
    const nodeId = (contextStageName && contextStageName !== node.name) ? contextStageName : baseName;
    if (!branchPath) return nodeId;
    return `${branchPath}.${nodeId}`;
  }

  /**
   * Reference to the subflow results map from the parent Pipeline.
   */
  private subflowResultsMap?: Map<string, SubflowResult>;

  /**
   * Execute children within a subflow's context.
   *
   * WHY: Similar to ChildrenExecutor.executeNodeChildren but uses executeSubflowInternal
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
      const childContext = context.createChild('', child.id as string, child.name);
      const childBreakFlag = { shouldBreak: false };

      return this.executeSubflowInternal(child, childContext, childBreakFlag, branchPath)
        .then((result) => {
          childContext.commit();
          return { id: child.id!, result, isError: false };
        })
        .catch((error) => {
          childContext.commit();
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
   *
   * WHY: Similar to ChildrenExecutor.executeSelectedChildren but uses executeSubflowInternal
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
    context.addLog('selectedChildIds', selectedIds);
    context.addLog('selectorPattern', 'multi-choice');

    // Empty selection - skip children execution
    if (selectedIds.length === 0) {
      context.addLog('skippedAllChildren', true);
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
      context.addError('selectorError', errorMessage);
      throw new Error(errorMessage);
    }

    // Record skipped children for visualization
    const skippedIds = children.filter((c) => !selectedIds.includes(c.id!)).map((c) => c.id);
    if (skippedIds.length > 0) {
      context.addLog('skippedChildIds', skippedIds);
    }

    // Execute selected children using internal version (for subflow context)
    const tempNode: StageNode<TOut, TScope> = { name: 'selector-temp', children: selectedChildren };
    return await this.executeNodeChildrenInternal(tempNode, context, branchPath, breakFlag);
  }
}
