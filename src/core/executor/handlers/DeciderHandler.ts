/**
 * DeciderHandler.ts
 *
 * WHY: Handles decider evaluation and branching for the Pipeline.
 * This module is extracted from Pipeline.ts following the Single Responsibility Principle,
 * isolating the concerns of decider handling from pipeline traversal.
 *
 * RESPONSIBILITIES:
 * - Execute decider nodes (stage → commit → decider → chosen child)
 * - Create decider scope context when stage function exists
 * - Log flow control decisions for decider branches
 * - Use NodeResolver.getNextNode to pick chosen child
 *
 * DESIGN DECISIONS:
 * - Decider evaluation happens AFTER stage execution (if present)
 * - Decider context is created right before invoking the decider for proper scoping
 * - Flow control messages include rationale when available for debugging
 *
 * DOES NOT HANDLE:
 * - Stage execution (uses runStage callback)
 * - Commit logic (caller handles via context.commitPatch())
 * - Extractor calls (caller handles via callExtractor())
 *
 * RELATED:
 * - {@link Pipeline} - Orchestrates when deciders are evaluated
 * - {@link NodeResolver} - Used to pick the chosen child via getNextNode
 * - {@link StageContext} - Used for debug info and context creation
 *
 */

import { StageContext } from '../../memory/StageContext';
import type { StageNode, Decider } from '../Pipeline';
import type { NodeResolver } from './NodeResolver';
import type { PipelineContext, PipelineStageFunction, StageSnapshot } from '../types';

/**
 * Callback type for running a stage with commit and extractor.
 *
 * WHY: Used by DeciderHandler to run the optional stage before decider evaluation.
 * This avoids circular dependency with Pipeline.
 */
export type RunStageFn<TOut = any, TScope = any> = (
  node: StageNode<TOut, TScope>,
  stageFunc: PipelineStageFunction<TOut, TScope>,
  context: StageContext,
  breakFn: () => void,
) => Promise<TOut>;

/**
 * Callback type for executing a node.
 *
 * WHY: Used by DeciderHandler to continue execution after choosing a branch.
 * This avoids circular dependency with Pipeline.
 */
export type ExecuteNodeFn<TOut = any, TScope = any> = (
  node: StageNode<TOut, TScope>,
  context: StageContext,
  breakFlag: { shouldBreak: boolean },
  branchPath?: string,
) => Promise<any>;

/**
 * Callback type for calling the extractor.
 *
 * WHY: Used by DeciderHandler to call the extractor after stage execution.
 * This avoids circular dependency with Pipeline.
 *
 * @param node - The stage node
 * @param context - The stage context (after commit)
 * @param stagePath - The full path to this stage
 * @param stageOutput - The stage function's return value (undefined on error or no-function nodes)
 * @param errorInfo - Error details when the stage threw during execution
 */
export type CallExtractorFn<TOut = any, TScope = any> = (
  node: StageNode<TOut, TScope>,
  context: StageContext,
  stagePath: string,
  stageOutput?: unknown,
  errorInfo?: { type: string; message: string },
) => void;

/**
 * Callback type for getting the stage path.
 *
 * WHY: Used by DeciderHandler to generate the stage path for extractor.
 * This avoids circular dependency with Pipeline.
 *
 * @param node - The stage node
 * @param branchPath - The branch path prefix
 * @param contextStageName - Optional stage name from StageContext (includes iteration suffix)
 */
export type GetStagePathFn<TOut = any, TScope = any> = (
  node: StageNode<TOut, TScope>,
  branchPath?: string,
  contextStageName?: string,
) => string;

/**
 * DeciderHandler
 * ------------------------------------------------------------------
 * Handles decider evaluation and branching.
 *
 * WHY: Deciders are a common pattern in pipelines for conditional branching.
 * This class centralizes all decider-related logic in one place.
 *
 * DESIGN: Uses callbacks for stage execution and node execution to avoid
 * circular dependencies with Pipeline.
 *
 * @template TOut - The output type of stage functions
 * @template TScope - The scope type passed to stage functions
 *
 * @example
 * ```typescript
 * const handler = new DeciderHandler(pipelineContext, nodeResolver);
 * const result = await handler.handle(node, stageFunc, context, breakFlag, branchPath, ...callbacks);
 * ```
 */
export class DeciderHandler<TOut = any, TScope = any> {
  constructor(
    private readonly ctx: PipelineContext<TOut, TScope>,
    private readonly nodeResolver: NodeResolver<TOut, TScope>,
  ) {}

  /**
   * Handle a decider node.
   *
   * WHY: Decider nodes need special handling because they:
   * 1. May have an optional stage function that runs first
   * 2. Evaluate a decider function to pick exactly one child
   * 3. Continue execution with only the chosen child
   *
   * DESIGN: Execution order: stage (optional) → commit → decider → chosen child
   *
   * @param node - The decider node (has nextNodeDecider)
   * @param stageFunc - The stage function (may be undefined)
   * @param context - The stage context
   * @param breakFlag - Break flag for propagation
   * @param branchPath - Branch path for logging
   * @param runStage - Callback to run the stage function
   * @param executeNode - Callback to execute the chosen child
   * @param callExtractor - Callback to call the extractor
   * @param getStagePath - Callback to get the stage path
   * @returns The result of executing the chosen child
   *
   */
  async handle(
    node: StageNode<TOut, TScope>,
    stageFunc: PipelineStageFunction<TOut, TScope> | undefined,
    context: StageContext,
    breakFlag: { shouldBreak: boolean },
    branchPath: string | undefined,
    runStage: RunStageFn<TOut, TScope>,
    executeNode: ExecuteNodeFn<TOut, TScope>,
    callExtractor: CallExtractorFn<TOut, TScope>,
    getStagePath: GetStagePathFn<TOut, TScope>,
  ): Promise<any> {
    const breakFn = () => (breakFlag.shouldBreak = true);
    let stageOutput: TOut | undefined;

    // Execute stage if present (stage → commit → decider → chosen child)
    if (stageFunc) {
      try {
        stageOutput = await runStage(node, stageFunc, context, breakFn);
      } catch (error: any) {
        context.commit(); // commit partial patch for forensic data
        // Pass undefined for stageOutput and error details for enrichment
        // WHY: On error path, there's no successful output, but we capture
        // the error info so enriched snapshots include what went wrong.
        callExtractor(node, context, getStagePath(node, branchPath, context.stageName), undefined, {
          type: 'stageExecutionError',
          message: error.toString(),
        });
        this.ctx.logger.error(`Error in pipeline (${branchPath}) stage [${node.name}]:`, { error });
        context.addError('stageExecutionError', error.toString());
        // Append narrative error sentence for the decider failure
        this.ctx.narrativeGenerator.onError(node.name, error.toString(), node.displayName);
        throw error;
      }
      context.commit();
      // Pass stageOutput so enriched snapshots capture the stage's return value
      callExtractor(node, context, getStagePath(node, branchPath, context.stageName), stageOutput);

      if (breakFlag.shouldBreak) {
        this.ctx.logger.info(`Execution stopped in pipeline (${branchPath}) after ${node.name} due to break condition.`);
        return stageOutput;
      }
    }

    // When there's no stage function, the decider node still needs a snapshot
    // so it appears in the debug UI execution flow (e.g., step 5 "Decider").
    // WHY: Without this, decider-only nodes are invisible in the Incremental_Debug_Map
    // because callExtractor is only called inside the `if (stageFunc)` block above.
    if (!stageFunc) {
      callExtractor(node, context, getStagePath(node, branchPath, context.stageName), undefined);
    }

    // Create/mark decider scope right before invoking the decider
    // WHY: Proper scoping ensures decider debug info is in the right context
    const deciderStageContext = stageFunc
      ? context.createDecider(branchPath as string, 'decider')
      : context.setAsDecider();

    // Use NodeResolver to pick the chosen child
    const chosen = await this.nodeResolver.getNextNode(
      node.nextNodeDecider as Decider,
      node.children as StageNode<TOut, TScope>[],
      stageOutput,
      context,
    );

    // Log flow control decision for decider branch
    // WHY: Narrative style helps with debugging — explain the condition, not just the choice
    const rationale = context.debug?.logContext?.deciderRationale as string | undefined;
    const chosenName = chosen.displayName || chosen.name;
    const branchDescription = rationale
      ? `Based on: ${rationale} → chose ${chosenName} path.`
      : `Evaluated conditions → chose ${chosenName} path.`;
    context.addFlowDebugMessage('branch', branchDescription, {
      targetStage: chosen.name,
      rationale,
    });

    // Append narrative sentence for the decision
    // WHY: Decision points are the most valuable part of the narrative for LLM context
    // engineering — knowing *why* a branch was taken lets even a cheaper model reason
    // about the execution.
    this.ctx.narrativeGenerator.onDecision(node.name, chosen.name, chosen.displayName, rationale, node.description);

    deciderStageContext.commit();

    // Continue execution with the chosen child
    // WHY: We create the next context from deciderStageContext (not the original context)
    // so the chosen child gets its own node in the context tree. Previously, calling
    // context.createNext() would return the already-set decider context (since createNext
    // returns existing this.next if set), causing the chosen child to share the decider's
    // context node and be invisible in the execution order / treeContext serialization.
    const nextStageContext = deciderStageContext.createNext(branchPath as string, chosen.name);
    return executeNode(chosen, nextStageContext, breakFlag, branchPath);
  }

  /**
   * Handle a scope-based decider node (created via `addDeciderFunction`).
   *
   * WHY: Scope-based deciders are first-class stage functions — the decider IS the stage.
   * Unlike legacy deciders where the stage and decider are separate invocations,
   * here the stage function receives (scope, breakFn) and returns a branch ID string.
   * This aligns with how LangGraph reads from state and Airflow reads from XCom.
   *
   * DESIGN: Execution order: runStage(fn) → commit → callExtractor → resolve child → log → executeNode(child)
   *
   * Key differences from `handle()`:
   * 1. Stage function is required (it IS the decider)
   * 2. Stage output (string) IS the branch ID — no separate decider invocation
   * 3. Child resolution is direct ID matching against `node.children` with default fallback
   * 4. No `NodeResolver.getNextNode()` call needed
   * 5. No separate `createDecider()` context — the stage context IS the decider context
   *
   * @param node - The decider node (has `deciderFn = true`, `fn` defined, `children` defined)
   * @param stageFunc - The stage function that returns a branch ID string (required)
   * @param context - The stage context
   * @param breakFlag - Break flag for propagation
   * @param branchPath - Branch path for logging
   * @param runStage - Callback to run the stage function
   * @param executeNode - Callback to execute the chosen child
   * @param callExtractor - Callback to call the extractor
   * @param getStagePath - Callback to get the stage path
   * @returns The result of executing the chosen child
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
  ): Promise<any> {
    const breakFn = () => (breakFlag.shouldBreak = true);

    // Execute the decider's stage function — its return value IS the branch ID
    // WHY: The decider function reads from scope and returns a string branch ID,
    // making it a proper stage with full scope access, step number, and debug visibility.
    let branchId: string;
    try {
      const stageOutput = await runStage(node, stageFunc, context, breakFn);
      branchId = String(stageOutput);
    } catch (error: any) {
      // Commit partial patch for forensic data
      // WHY: Even on error, we persist any scope writes the decider made
      // so debug tools can inspect what happened before the failure.
      context.commit();
      callExtractor(node, context, getStagePath(node, branchPath, context.stageName), undefined, {
        type: 'stageExecutionError',
        message: error.toString(),
      });
      this.ctx.logger.error(`Error in pipeline (${branchPath}) stage [${node.name}]:`, { error });
      context.addError('stageExecutionError', error.toString());
      // Append narrative error sentence for the scope-based decider failure
      this.ctx.narrativeGenerator.onError(node.name, error.toString(), node.displayName);
      throw error;
    }

    // Commit the decider's scope writes before selecting the branch
    // WHY: Ensures downstream stages see the decider's committed state,
    // and the extractor captures the post-commit scope snapshot.
    context.commit();

    // Call extractor with the branch ID as stageOutput so it appears in enriched snapshots
    callExtractor(node, context, getStagePath(node, branchPath, context.stageName), branchId);

    // If break was called during the decider, stop execution
    if (breakFlag.shouldBreak) {
      this.ctx.logger.info(`Execution stopped in pipeline (${branchPath}) after ${node.name} due to break condition.`);
      return branchId;
    }

    // Resolve child by matching branch ID against node.children
    // WHY: Direct ID matching with default fallback — no NodeResolver needed
    // because the decider function already returned the exact branch ID.
    const children = node.children as StageNode<TOut, TScope>[];
    let chosen = children.find((child) => child.id === branchId);

    // Fall back to default branch if the returned ID doesn't match any child
    // WHY: The default branch (set via `setDefault()`) acts as a catch-all
    // for unexpected branch IDs, preventing runtime errors.
    if (!chosen) {
      const defaultChild = children.find((child) => child.id === 'default');
      if (defaultChild) {
        chosen = defaultChild;
      } else {
        const errorMessage = `Scope-based decider '${node.name}' returned branch ID '${branchId}' which doesn't match any child and no default branch is set`;
        context.addError('deciderError', errorMessage);
        throw new Error(errorMessage);
      }
    }

    // Log flow control decision for decider branch
    // WHY: Narrative style helps with debugging — the message should explain
    // WHICH condition led to this branch, not just say "chose X path".
    // We read deciderRationale from StageMetadata (debug logs) instead of scope
    // because the WriteBuffer has a stale-read bug: after commit() resets the
    // buffer's workingCopy to baseSnapshot, getValue reads the stale baseSnapshot
    // value from a previous iteration instead of falling through to GlobalStore.
    // StageMetadata is per-context and doesn't have this issue.
    const chosenName = chosen.displayName || chosen.name;
    const wasDefault = chosen.id !== branchId;
    const rationale = context.debug?.logContext?.deciderRationale as string | undefined;
    let branchReason: string;
    if (wasDefault) {
      branchReason = `Returned '${branchId}' (no match), fell back to default → ${chosenName} path.`;
    } else if (rationale) {
      branchReason = `Based on: ${rationale} → chose ${chosenName} path.`;
    } else {
      branchReason = `Evaluated scope and returned '${branchId}' → chose ${chosenName} path.`;
    }
    context.addFlowDebugMessage('branch', branchReason, {
      targetStage: chosen.name,
      rationale: rationale || `returned branchId: ${branchId}`,
    });

    // Append narrative sentence for the scope-based decision
    // WHY: Scope-based deciders are first-class decisions — the narrative should
    // capture the branch chosen and rationale just like legacy deciders.
    this.ctx.narrativeGenerator.onDecision(node.name, chosen.name, chosen.displayName, rationale, node.description);

    // Continue execution with the chosen child
    // WHY: Create next context from the current context so the chosen child
    // gets its own node in the context tree for proper debug visibility.
    const nextStageContext = context.createNext(branchPath as string, chosen.name);
    return executeNode(chosen, nextStageContext, breakFlag, branchPath);
  }
}
