/**
 * Pipeline.ts
 *
 * Engine for FootPrint traversal with a **programmer-friendly order**:
 *
 *   // prep        →     parallel gather     →     aggregate/continue
 *   const pre = await prep();
 *   const [x, y] = await Promise.all([fx(pre), fy(pre)]);
 *   return await next(x, y);
 *
 * Concretely, for each node shape we execute:
 *
 * 1) Linear node (no children; may have `next`)
 *    • Run **this node's stage** (if any) → commit → (break?) → **next**
 *
 * 2) Fork-only (has `children`, **no** `next`, not a decider)
 *    • Run **stage** (if any) → commit
 *    • Run **ALL children in parallel** (each child commits after it settles)
 *    • **RETURN** children bundle: `{ [childId]: { result, isError } }`
 *
 * 3) Fork + next (has `children` and `next`, not a decider)
 *    • Run **stage** (if any) → commit
 *    • Run **ALL children in parallel** (commit on settle)
 *    • **Continue** to `next` (downstream stages read children's committed writes)
 *
 * 4) Decider (has `children` and `nextNodeDecider`)
 *    • Run **stage** (if any) → commit
 *    • **Decider** picks EXACTLY ONE child `id`
 *    • **Continue** into that chosen child (only that branch runs)
 *
 * Break semantics:
 *    If a stage calls `breakFn()`, we commit and **STOP** at this node:
 *      – for fork-only: children do **not** run; nothing continues
 *      – for fork + next: children and next do **not** run
 *      – for linear: next does **not** run
 *      – for decider: we do **not** evaluate the decider; no child runs
 *
 * Patch/visibility model:
 *   – A stage writes into a local patch; we always `commitPatch()` after it returns or throws
 *   – Children always `commitPatch()` after they settle; throttled children can flag
 *     `monitor.isThrottled = true` via `throttlingErrorChecker`
 *
 * Sync + Async stages:
 *   – We keep the original engine's behavior: **only** `await` real Promises
 *     (using `output instanceof Promise`), otherwise return the value directly.
 *     This avoids "thenable assimilation" side-effects/probes on arbitrary objects.
 */

import { StageContext } from '../context/StageContext';
import { RuntimeSnapshot, PipelineRuntime, ContextTreeType } from '../context/PipelineRuntime';
import { ScopeFactory } from '../context/types';
import { logger } from '../logger';
import {
  NodeResultType,
  PipelineStageFunction,
  SerializedPipelineNode,
  StreamCallback,
  StreamHandlers,
  SubflowResult,
  TreeOfFunctionsResponse,
  TraversalExtractor,
  ExtractorError,
  StageSnapshot,
} from './types';
import { createProtectedScope } from '../../scope/protection/createProtectedScope';
import { ScopeProtectionMode } from '../../scope/protection/types';

export type Decider = (nodeArgs: any) => string | Promise<string>;

/**
 * Selector
 * ------------------------------------------------------------------
 * A function that picks ONE OR MORE children from a children array to execute.
 * Unlike Decider (which picks exactly one), Selector can return:
 * - A single string ID (behaves like Decider)
 * - An array of string IDs (selected children execute in parallel)
 * - An empty array (skip all children, continue to next if present)
 *
 * This enables selective parallel branching where only a subset of
 * children are executed based on runtime conditions.
 *
 * @param nodeArgs - The stage output or input passed to the selector
 * @returns Single ID, array of IDs, or Promise resolving to either
 *
 * _Requirements: 8.1, 8.2_
 */
export type Selector = (nodeArgs: any) => string | string[] | Promise<string | string[]>;

export type StageNode<TOut = any, TScope = any> = {
  /** Human-readable stage name; also used as the stageMap key */
  name: string;
  /** Optional stable id (required by decider/fork aggregation) */
  id?: string;
  /** Human-readable display name for UI visualization (e.g., "User Prompt" instead of "useQuestion") */
  displayName?: string;
  /** Linear continuation */
  next?: StageNode<TOut, TScope>;
  /** Parallel children (fork) */
  children?: StageNode<TOut, TScope>[];
  /** Decider (mutually exclusive with `next`); must select a child `id` */
  nextNodeDecider?: Decider;
  /**
   * Selector for multi-choice branching.
   * Unlike Decider (picks ONE), Selector can pick MULTIPLE children to execute in parallel.
   * Mutually exclusive with `nextNodeDecider`.
   *
   * _Requirements: 8.1_
   */
  nextNodeSelector?: Selector;
  /** Optional embedded function for this node; otherwise resolved from stageMap by `name` */
  fn?: PipelineStageFunction<TOut, TScope>;
  /**
   * Indicates this stage emits tokens incrementally via a stream callback.
   * When true, TreePipeline will inject a streamCallback as the 3rd parameter to the stage function.
   */
  isStreaming?: boolean;
  /**
   * Unique identifier for the stream, used to route tokens to the correct handler.
   * Defaults to the stage name if not provided when using addStreamingFunction.
   */
  streamId?: string;
  /** True if this is the root node of a mounted subflow */
  isSubflowRoot?: boolean;
  /** Mount id of the subflow (e.g., "llm-core") */
  subflowId?: string;
  /** Display name of the subflow (e.g., "LLM Core") */
  subflowName?: string;
  /**
   * Reference to a subflow definition in the `subflows` dictionary.
   * When present, this node is a lightweight reference that should be resolved
   * by looking up `subflows[$ref]` to get the actual subflow structure.
   * 
   * Used by reference-based subflow architecture to avoid deep-copying.
   */
  $ref?: string;
  /**
   * Unique identifier for this mount instance.
   * Distinguishes multiple mounts of the same subflow definition.
   */
  mountId?: string;
};

// Note: Dynamic behavior is detected via isStageNodeReturn() duck-typing on stage output.
// No isDynamic flag needed on node definition - stages that return StageNode are automatically
// treated as dynamic continuations.

/**
 * isStageNodeReturn
 * ------------------------------------------------------------------
 * Detects if a stage output is a StageNode for dynamic continuation.
 * Uses duck-typing: must have 'name' (string) AND at least one continuation property.
 *
 * This enables stage functions to return a StageNode directly for dynamic
 * pipeline continuation (parallel children, loops, etc.).
 *
 * Note: This function safely handles proxy objects (like Zod scopes) that may
 * throw when accessing unknown properties.
 *
 * @param output - The stage function's return value
 * @returns true if the output is a StageNode for dynamic continuation
 *
 * _Requirements: 1.1, 1.2, 1.3_
 */
export function isStageNodeReturn(output: unknown): output is StageNode {
  // Must be a non-null object
  if (!output || typeof output !== 'object') return false;

  // Use try-catch to safely handle proxy objects that throw on property access
  try {
    const obj = output as Record<string, unknown>;

    // Must have 'name' property as a string
    if (typeof obj.name !== 'string') return false;

    // Must have at least one continuation property
    // Note: children must be a non-empty array to count as continuation
    const hasContinuation =
      (Array.isArray(obj.children) && obj.children.length > 0) ||
      obj.next !== undefined ||
      typeof obj.nextNodeDecider === 'function' ||
      typeof obj.nextNodeSelector === 'function';

    return hasContinuation;
  } catch {
    // If property access throws (e.g., Zod scope proxy), it's not a StageNode
    return false;
  }
}

export class Pipeline<TOut, TScope> {
  private stageMap: Map<string, PipelineStageFunction<TOut, TScope>>;
  private root: StageNode;
  private pipelineRuntime: PipelineRuntime;

  /** Normalized scope factory injected by the caller (class | factory | plugin → factory) */
  private readonly ScopeFactory: ScopeFactory<TScope>;

  private readonly readOnlyContext?: unknown;
  private readonly throttlingErrorChecker?: (error: unknown) => boolean;

  /**
   * Stream handlers for streaming stages.
   * Contains callbacks for token emission and lifecycle events (start/end).
   */
  private readonly streamHandlers?: StreamHandlers;

  /**
   * Iteration counter for loop support.
   * Tracks how many times each node ID has been visited (for context path generation).
   * Key: node.id, Value: iteration count (0 = first visit)
   */
  private iterationCounters: Map<string, number> = new Map();

  /**
   * Collected subflow execution results during pipeline run.
   * Keyed by subflowId for lookup during API response construction.
   *
   * _Requirements: 4.1, 4.2_
   */
  private subflowResults: Map<string, SubflowResult> = new Map();

  /**
   * Optional traversal extractor function.
   * Called after each stage completes to extract data.
   */
  private readonly extractor?: TraversalExtractor;

  /**
   * Collected extracted results during pipeline run.
   * Keyed by stage path (e.g., "root.child.grandchild").
   */
  private extractedResults: Map<string, unknown> = new Map();

  /**
   * Errors encountered during extraction.
   * Logged but don't stop pipeline execution.
   */
  private extractorErrors: ExtractorError[] = [];

  /**
   * Protection mode for scope access.
   * When 'error' (default), throws on direct property assignment.
   * When 'warn', logs warning but allows assignment.
   * When 'off', no protection is applied.
   *
   * _Requirements: 5.1, 5.2, 5.3_
   */
  private readonly scopeProtectionMode: ScopeProtectionMode;

  /**
   * Memoized subflow definitions.
   * Key is the subflow's root name, value contains the subflow root node.
   * Used to resolve reference nodes (nodes with `isSubflowRoot` but no `fn`).
   */
  private readonly subflows?: Record<string, { root: StageNode<TOut, TScope> }>;

  constructor(
    root: StageNode,
    stageMap: Map<string, PipelineStageFunction<TOut, TScope>>,
    scopeFactory: ScopeFactory<TScope>,
    defaultValuesForContext?: unknown,
    initialContext?: unknown,
    readOnlyContext?: unknown,
    throttlingErrorChecker?: (error: unknown) => boolean,
    streamHandlers?: StreamHandlers,
    extractor?: TraversalExtractor,
    scopeProtectionMode?: ScopeProtectionMode,
    subflows?: Record<string, { root: StageNode<TOut, TScope> }>,
  ) {
    this.root = root;
    this.stageMap = stageMap;
    this.readOnlyContext = readOnlyContext;
    this.pipelineRuntime = new PipelineRuntime(this.root.name, defaultValuesForContext, initialContext);
    this.throttlingErrorChecker = throttlingErrorChecker;
    this.ScopeFactory = scopeFactory;
    this.streamHandlers = streamHandlers;
    this.extractor = extractor;
    this.scopeProtectionMode = scopeProtectionMode ?? 'error';
    this.subflows = subflows;
  }

  /** Execute the pipeline from the root node. */
  async execute(): Promise<TreeOfFunctionsResponse> {
    const context = this.pipelineRuntime.rootStageContext;
    return await this.executeNode(this.root, context, { shouldBreak: false }, '');
  }

  /** Resolve a stage function: prefer embedded `node.fn`, else look up by `node.name` in `stageMap`. */
  private getStageFn(node: StageNode<TOut, TScope>): PipelineStageFunction<TOut, TScope> | undefined {
    if (typeof node.fn === 'function') return node.fn as PipelineStageFunction<TOut, TScope>;
    return this.stageMap.get(node.name);
  }

  /**
   * Execute a single node with the unified order described in the file header.
   *
   * @param node         Current node to execute
   * @param context      Current StageContext
   * @param breakFlag    Break flag bubbled through recursion
   * @param branchPath   Logical pipeline id/path (for logs); inherited by children
   */
  private async executeNode(
    node: StageNode,
    context: StageContext,
    breakFlag: { shouldBreak: boolean },
    branchPath?: string,
  ): Promise<any> {
    // ───────────────────────── 0) Subflow Detection ─────────────────────────
    // If this node is a subflow root, execute it with an isolated nested context
    if (node.isSubflowRoot && node.subflowId) {
      // Resolve reference node if needed
      // Reference nodes have isSubflowRoot but no fn/children - they point to subflows dictionary
      const resolvedNode = this.resolveSubflowReference(node);
      
      const subflowOutput = await this.executeSubflow(resolvedNode, context, breakFlag, branchPath);
      
      // After subflow completes, continue with node.next in the PARENT context (if present)
      // 
      // IMPORTANT: We need to determine if `next` is a continuation after the subflow
      // or if it was already executed as part of the subflow's internal structure.
      //
      // Heuristic:
      // - If the subflow has `children` (fork pattern), `next` is the continuation
      // - If the subflow has no `children` (linear pattern), `next` was already executed internally
      //
      // For reference-based subflows (resolvedNode !== node), the original reference node's
      // `next` is always the continuation (the subflow's internal structure is in the definition).
      const isReferenceBasedSubflow = resolvedNode !== node;
      const hasChildren = Boolean(node.children && node.children.length > 0);
      const shouldExecuteContinuation = isReferenceBasedSubflow || hasChildren;
      
      if (node.next && shouldExecuteContinuation) {
        const nextStageContext = context.createNextContext(branchPath as string, node.next.name);
        return await this.executeNode(node.next, nextStageContext, breakFlag, branchPath);
      }
      
      return subflowOutput;
    }

    const stageFunc = this.getStageFn(node);
    const hasStageFunction = Boolean(stageFunc);
    const isDeciderNode = Boolean(node.nextNodeDecider);
    const hasChildren = Boolean(node.children?.length);
    const hasNext = Boolean(node.next);
    // Note: Dynamic behavior is detected via isStageNodeReturn() on stage output, not via node flags

    // ───────────────────────── 1) Validation ─────────────────────────
    // A node must provide at least one of: stage, children, or decider.
    if (!hasStageFunction && !isDeciderNode && !hasChildren) {
      const errorMessage = `Node '${node.name}' must define: embedded fn OR a stageMap entry OR have children/decider`;
      logger.error(`Error in pipeline (${branchPath}) stage [${node.name}]:`, { error: errorMessage });
      throw new Error(errorMessage);
    }
    if (isDeciderNode && !hasChildren) {
      const errorMessage = 'Decider node needs to have children to execute';
      logger.error(`Error in pipeline (${branchPath}) stage [${node.name}]:`, { error: errorMessage });
      throw new Error(errorMessage);
    }

    // Mark role when there is no stage function (useful for debug panels)
    if (!hasStageFunction) {
      if (isDeciderNode) context.setAsDecider();
      else if (hasChildren) context.setAsFork();
    }

    const breakFn = () => (breakFlag.shouldBreak = true);

    // ───────────────────────── 2) Decider node ─────────────────────────
    // decider order: stage (optional) → commit → decider → chosen child
    if (isDeciderNode) {
      let stageOutput: TOut | undefined;

      if (stageFunc) {
        try {
          stageOutput = await this.executeStage(node, stageFunc, context, breakFn);
        } catch (error: any) {
          context.commitPatch(); // commit partial patch for forensic data
          this.callExtractor(node, context, this.getStagePath(node, branchPath));
          logger.error(`Error in pipeline (${branchPath}) stage [${node.name}]:`, { error });
          context.addErrorInfo('stageExecutionError', error.toString());
          throw error;
        }
        context.commitPatch();
        this.callExtractor(node, context, this.getStagePath(node, branchPath));

        if (breakFlag.shouldBreak) {
          logger.info(`Execution stopped in pipeline (${branchPath}) after ${node.name} due to break condition.`);
          return stageOutput;
        }
      }

      // Create/mark decider scope right before invoking the decider
      const deciderStageContext = stageFunc
        ? context.createDeciderContext(branchPath as string, 'decider')
        : context.setAsDecider();

      const chosen = await this.getNextNode(
        node.nextNodeDecider as Decider,
        node.children as StageNode[],
        stageOutput,
        context,
      );
      
      // Log flow control decision for decider branch
      // _Requirements: flow-control-narrative REQ-3, REQ-4 (Task 3)
      // Narrative style: "decided based on [data] and chose [path]"
      const rationale = context.getValue([], 'deciderRationale') as string | undefined;
      const chosenName = chosen.displayName || chosen.name;
      const branchDescription = rationale 
        ? `Decided based on: ${rationale}. Chose ${chosenName} path.`
        : `Evaluated conditions and chose ${chosenName} path.`;
      context.addFlowDebugMessage('branch', branchDescription, {
        targetStage: chosen.name,
        rationale,
      });
      
      deciderStageContext.commitPatch();

      const nextStageContext = context.createNextContext(branchPath as string, chosen.name);
      return await this.executeNode(chosen, nextStageContext, breakFlag, branchPath);
    }

    // ───────────────────────── 3) Non-decider: STAGE FIRST ─────────────────────────
    // unified order: stage (optional) → commit → (break?) → children (optional) → dynamicNext (optional) → next (optional)
    let stageOutput: TOut | undefined;
    let dynamicNext: StageNode | undefined;

    if (stageFunc) {
      try {
        stageOutput = await this.executeStage(node, stageFunc, context, breakFn);
      } catch (error: any) {
        context.commitPatch(); // apply patch on error as before
        this.callExtractor(node, context, this.getStagePath(node, branchPath));
        logger.error(`Error in pipeline (${branchPath}) stage [${node.name}]:`, { error });
        context.addErrorInfo('stageExecutionError', error.toString());
        throw error;
      }
      context.commitPatch();
      this.callExtractor(node, context, this.getStagePath(node, branchPath));

      if (breakFlag.shouldBreak) {
        logger.info(`Execution stopped in pipeline (${branchPath}) after ${node.name} due to break condition.`);
        return stageOutput; // leaf/early stop returns the stage's output
      }

      // ───────────────────────── Handle dynamic stages ─────────────────────────
      // Check if the handler's return object is a StageNode for dynamic continuation.
      // Detection uses duck-typing via isStageNodeReturn().
      if (stageOutput && typeof stageOutput === 'object' && isStageNodeReturn(stageOutput)) {
        const dynamicNode = stageOutput as StageNode;
        context.addDebugInfo('isDynamic', true);
        context.addDebugInfo('dynamicPattern', 'StageNodeReturn');

        // Handle dynamic children (fork pattern)
        if (dynamicNode.children && dynamicNode.children.length > 0) {
          node.children = dynamicNode.children;
          context.addDebugInfo('dynamicChildCount', dynamicNode.children.length);
          context.addDebugInfo('dynamicChildIds', dynamicNode.children.map(c => c.id || c.name));

          // Handle dynamic selector (multi-choice branching)
          if (typeof dynamicNode.nextNodeSelector === 'function') {
            node.nextNodeSelector = dynamicNode.nextNodeSelector;
            context.addDebugInfo('hasSelector', true);
          }
          // Handle dynamic decider (single-choice branching)
          else if (typeof dynamicNode.nextNodeDecider === 'function') {
            node.nextNodeDecider = dynamicNode.nextNodeDecider;
            context.addDebugInfo('hasDecider', true);
          }
        }

        // Handle dynamic next (linear continuation)
        if (dynamicNode.next) {
          dynamicNext = dynamicNode.next;
          // Attach to node for serialization visibility (getRuntimeRoot)
          node.next = dynamicNode.next;
          context.addDebugInfo('hasDynamicNext', true);
        }

        // Clear stageOutput since the StageNode is the continuation, not the output
        stageOutput = undefined;
      }
    }

    // ───────────────────────── 4) Children (if any) ─────────────────────────
    // Re-evaluate hasChildren after stage execution, as the stage may have
    // dynamically populated node.children (e.g., toolBranch injects tool nodes)
    const hasChildrenAfterStage = Boolean(node.children?.length);
    
    if (hasChildrenAfterStage) {
      // Breadcrumbs
      context.addDebugInfo('totalChildren', node.children?.length);
      context.addDebugInfo('orderOfExecution', 'ChildrenAfterStage');

      let nodeChildrenResults: Record<string, NodeResultType>;

      // Check for selector (multi-choice) - can pick multiple children
      if (node.nextNodeSelector) {
        nodeChildrenResults = await this.executeSelectedChildren(
          node.nextNodeSelector,
          node.children!,
          stageOutput,
          context,
          branchPath as string,
        );
      }
      // Check for decider (single-choice) - picks exactly one child
      else if (node.nextNodeDecider) {
        // Decider was dynamically injected, execute it
        const chosen = await this.getNextNode(
          node.nextNodeDecider,
          node.children!,
          stageOutput,
          context,
        );
        const nextStageContext = context.createNextContext(branchPath as string, chosen.name);
        return await this.executeNode(chosen, nextStageContext, breakFlag, branchPath);
      }
      // Default: execute all children in parallel (fork pattern)
      else {
        // Log flow control decision for fork children
        // _Requirements: flow-control-narrative REQ-3 (Task 4)
        const childCount = node.children?.length ?? 0;
        const childNames = node.children?.map(c => c.displayName || c.name).join(', ');
        context.addFlowDebugMessage('children', `Executing all ${childCount} children in parallel: ${childNames}`, {
          count: childCount,
          targetStage: node.children?.map(c => c.name),
        });
        
        nodeChildrenResults = await this.executeNodeChildren(node, context, undefined, branchPath);
      }

      // Fork-only (no next, no dynamicNext): return bundle object
      if (!hasNext && !dynamicNext) {
        return nodeChildrenResults;
      }
      // Fork + next or dynamicNext: continue below
    }

    // ───────────────────────── 5) Dynamic Next (loop support) ─────────────────────────
    // If dynamicNext is set, handle it based on whether it's a reference or full node
    if (dynamicNext) {
      
      // If dynamicNext is a string, it's a reference to an existing node by ID
      if (typeof dynamicNext === 'string') {
        const targetNode = this.findNodeById(dynamicNext);
        if (!targetNode) {
          const errorMessage = `dynamicNext target node not found: ${dynamicNext}`;
          logger.error(`Error in pipeline (${branchPath}) stage [${node.name}]:`, { error: errorMessage });
          throw new Error(errorMessage);
        }
        
        const iteration = this.getAndIncrementIteration(dynamicNext);
        const iteratedStageName = this.getIteratedStageName(targetNode.name, iteration);
        context.addDebugInfo('dynamicNextTarget', dynamicNext);
        context.addDebugInfo('dynamicNextIteration', iteration);
        
        // Log flow control decision for loop
        // _Requirements: flow-control-narrative REQ-3 (Task 7)
        context.addFlowDebugMessage('loop', 
          `Looping back to ${targetNode.displayName || targetNode.name} (iteration ${iteration + 1})`, {
          targetStage: targetNode.name,
          iteration: iteration + 1,
        });
        
        const nextStageContext = context.createNextContext(branchPath as string, iteratedStageName);
        return await this.executeNode(targetNode, nextStageContext, breakFlag, branchPath);
      }
      
      // If dynamicNext is a StageNode with fn, execute it directly (truly dynamic)
      if (dynamicNext.fn) {
        context.addDebugInfo('dynamicNextDirect', true);
        context.addDebugInfo('dynamicNextName', dynamicNext.name);
        
        // Log flow control decision for dynamic next
        // _Requirements: flow-control-narrative REQ-3 (Task 7)
        context.addFlowDebugMessage('next', `Moving to ${dynamicNext.displayName || dynamicNext.name} stage (dynamic)`, {
          targetStage: dynamicNext.name,
        });
        
        const nextStageContext = context.createNextContext(branchPath as string, dynamicNext.name);
        return await this.executeNode(dynamicNext, nextStageContext, breakFlag, branchPath);
      }
      
      // If dynamicNext is a StageNode without fn, it's a reference - look up by ID
      const nextNodeId = dynamicNext.id;
      if (!nextNodeId) {
        const errorMessage = 'dynamicNext node must have an id when used as reference';
        logger.error(`Error in pipeline (${branchPath}) stage [${node.name}]:`, { error: errorMessage });
        throw new Error(errorMessage);
      }

      const targetNode = this.findNodeById(nextNodeId);
      if (!targetNode) {
        const errorMessage = `dynamicNext target node not found: ${nextNodeId}`;
        logger.error(`Error in pipeline (${branchPath}) stage [${node.name}]:`, { error: errorMessage });
        throw new Error(errorMessage);
      }

      const iteration = this.getAndIncrementIteration(nextNodeId);
      const iteratedStageName = this.getIteratedStageName(targetNode.name, iteration);
      context.addDebugInfo('dynamicNextTarget', nextNodeId);
      context.addDebugInfo('dynamicNextIteration', iteration);

      // Log flow control decision for loop
      // _Requirements: flow-control-narrative REQ-3 (Task 7)
      context.addFlowDebugMessage('loop', 
        `Looping back to ${targetNode.displayName || targetNode.name} (iteration ${iteration + 1})`, {
        targetStage: targetNode.name,
        iteration: iteration + 1,
      });

      const nextStageContext = context.createNextContext(branchPath as string, iteratedStageName);
      return await this.executeNode(targetNode, nextStageContext, breakFlag, branchPath);
    }

    // ───────────────────────── 6) Linear `next` (if provided) ─────────────────────────
    if (hasNext) {
      const nextNode = node.next!;
      
      // Log flow control decision for linear next
      // _Requirements: flow-control-narrative REQ-3 (Task 2)
      context.addFlowDebugMessage('next', `Moving to ${nextNode.displayName || nextNode.name} stage`, {
        targetStage: nextNode.name,
      });
      
      const nextStageContext = context.createNextContext(branchPath as string, nextNode.name);
      return await this.executeNode(nextNode, nextStageContext, breakFlag, branchPath);
    }

    // ───────────────────────── 7) Leaf ─────────────────────────
    // No children & no next & no dynamicNext → return this node's stage output (may be undefined)
    return stageOutput;
  }

  /**
   * Execute a subflow with its own isolated PipelineRuntime.
   *
   * This method:
   * 1. Creates a fresh PipelineRuntime for the subflow
   * 2. Executes the subflow's internal structure (root fn + children) using the nested context
   * 3. Stores the subflow's execution data in the parent stage's debugInfo
   * 4. Adds the result to the SubflowResultsMap for API response
   * 5. Returns control to parent, which continues with node.next if present
   *
   * IMPORTANT: The subflow's `next` chain is NOT executed inside the subflow.
   * After executeSubflow returns, the parent's executeNode continues with node.next.
   * This ensures stages after a subflow execute in the parent's context.
   *
   * @param node - The subflow root node (has isSubflowRoot: true)
   * @param parentContext - The parent pipeline's StageContext
   * @param breakFlag - Break flag from parent (subflow break doesn't propagate up)
   * @param branchPath - Parent's branch path for logging
   * @returns The subflow's final output
   *
   * _Requirements: 1.1, 1.2, 1.3, 2.1, 3.1, 3.2, 3.4, 4.2_
   */
  private async executeSubflow(
    node: StageNode,
    parentContext: StageContext,
    breakFlag: { shouldBreak: boolean },
    branchPath?: string,
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
    
    const subflowNode: StageNode = {
      ...node,
      isSubflowRoot: false, // Clear to prevent re-detection as subflow
      // For subflows with children (fork pattern), strip `next` - it's the continuation
      // For subflows without children (linear pattern), keep `next` - it's internal chain
      next: hasChildren ? undefined : node.next,
    };

    try {
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
    const subflowPipelineStructure = this.serializeSubflowStructure(node);

    // Create SubflowResult
    const subflowResult: SubflowResult = {
      subflowId,
      subflowName,
      treeContext: {
        globalContext: subflowTreeContext.globalContext,
        stageContexts: subflowTreeContext.stageContexts as unknown as Record<string, unknown>,
        history: subflowTreeContext.history,
      },
      pipelineStructure: subflowPipelineStructure,
      parentStageId: parentContext.getStageId(),
    };

    // Store in parent stage's debugInfo for drill-down
    parentContext.addDebugInfo('subflowResult', subflowResult);
    parentContext.addDebugInfo('hasSubflowData', true);

    // Add to collection for API response
    this.subflowResults.set(subflowId, subflowResult);

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
   * Execute the internal structure of a subflow using its isolated context.
   * This handles the actual stage execution within the subflow's context.
   *
   * Note: Nested subflows (nodes with isSubflowRoot) are detected and executed
   * via executeSubflow, which adds them to the parent Pipeline's subflowResults map.
   *
   * @param node - The subflow root node
   * @param context - The subflow's root StageContext
   * @param breakFlag - Subflow's isolated break flag
   * @param branchPath - Subflow's branch path for logging
   * @returns The subflow's final output
   *
   * _Requirements: 1.4, 2.2, 2.3_
   */
  private async executeSubflowInternal(
    node: StageNode,
    context: StageContext,
    breakFlag: { shouldBreak: boolean },
    branchPath: string,
  ): Promise<any> {
    // Detect nested subflows and delegate to executeSubflow
    // This ensures nested subflows get their own isolated context AND
    // are added to the parent Pipeline's subflowResults map
    if (node.isSubflowRoot && node.subflowId) {
      // Resolve reference node if needed (nested subflows may also be references)
      const resolvedNode = this.resolveSubflowReference(node);
      return await this.executeSubflow(resolvedNode, context, breakFlag, branchPath);
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
        const chosen = await this.getNextNode(
          node.nextNodeDecider!,
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
   * Execute children within a subflow's context.
   * Similar to executeNodeChildren but uses executeSubflowInternal for recursion,
   * ensuring nested subflows are properly detected.
   */
  private async executeNodeChildrenInternal(
    node: StageNode,
    context: StageContext,
    branchPath: string,
    breakFlag: { shouldBreak: boolean },
  ): Promise<Record<string, NodeResultType>> {
    const childPromises: Promise<NodeResultType>[] = (node.children ?? []).map((child: StageNode) => {
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
   * Similar to executeSelectedChildren but uses executeSubflowInternal for recursion.
   */
  private async executeSelectedChildrenInternal(
    selector: Selector,
    children: StageNode[],
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
      logger.error(`Error in pipeline (${branchPath}):`, { error: errorMessage });
      context.addErrorInfo('selectorError', errorMessage);
      throw new Error(errorMessage);
    }

    // Record skipped children for visualization
    const skippedIds = children.filter((c) => !selectedIds.includes(c.id!)).map((c) => c.id);
    if (skippedIds.length > 0) {
      context.addDebugInfo('skippedChildIds', skippedIds);
    }

    // Execute selected children using internal version
    const tempNode: StageNode = { name: 'selector-temp', children: selectedChildren };
    return await this.executeNodeChildrenInternal(tempNode, context, branchPath, breakFlag);
  }

  /**
   * Execute a node's stage function with **sync+async safety**:
   *  - If it's a real Promise, await it
   *  - Otherwise return the value as-is (no thenable assimilation)
   *
   * For streaming stages (node.isStreaming === true):
   *  - Creates a bound streamCallback that routes tokens to the registered handler
   *  - Calls onStart lifecycle hook before execution
   *  - Accumulates tokens during streaming
   *  - Calls onEnd lifecycle hook after execution with accumulated text
   *
   * Note: Dynamic behavior is detected via isStageNodeReturn() on the stage output,
   * not via node flags. Any stage can return a StageNode for dynamic continuation.
   */
  private async executeStage(
    node: StageNode,
    stageFunc: PipelineStageFunction<TOut, TScope>,
    context: StageContext,
    breakFn: () => void,
  ) {
    const rawScope = this.ScopeFactory(context, node.name, this.readOnlyContext);
    
    // Wrap scope with protection to intercept direct property assignments
    const scope = createProtectedScope(rawScope as object, {
      mode: this.scopeProtectionMode,
      stageName: node.name,
    }) as TScope;

    // Determine if this is a streaming stage and create the appropriate callback
    let streamCallback: StreamCallback | undefined;
    let accumulatedText = '';

    if (node.isStreaming) {
      const streamId = node.streamId ?? node.name;

      // Create bound callback that routes tokens to the handler with the correct streamId
      streamCallback = (token: string) => {
        accumulatedText += token;
        this.streamHandlers?.onToken?.(streamId, token);
      };

      // Call onStart lifecycle hook before execution
      this.streamHandlers?.onStart?.(streamId);
    }

    const output = stageFunc(scope, breakFn, streamCallback);

    let result: TOut;
    if (output instanceof Promise) {
      result = await output;
    } else {
      result = output;
    }

    // Call onEnd lifecycle hook after execution for streaming stages
    if (node.isStreaming) {
      const streamId = node.streamId ?? node.name;
      this.streamHandlers?.onEnd?.(streamId, accumulatedText);
    }

    return result;
  }

  /**
   * Execute all children in parallel; always commit each child patch on settle.
   * Aggregates a `{ childId: { result, isError } }` object (similar to `Promise.allSettled`).
   * If `throttlingErrorChecker` is provided, we flag `monitor.isThrottled = true`
   * in the child context when it matches the thrown error.
   */
  private async executeNodeChildren(
    node: StageNode,
    context: StageContext,
    parentBreakFlag?: { shouldBreak: boolean },
    pipelineId?: string,
  ) {
    let breakCount = 0;
    const totalChildren = node.children?.length ?? 0;

    const childPromises: Promise<NodeResultType>[] = (node.children ?? []).map((child: StageNode) => {
      const pipelineIdForChild = pipelineId || child.id;
      const childContext = context.createChildContext(pipelineIdForChild as string, child.id as string, child.name);
      const childBreakFlag = { shouldBreak: false };

      const updateParentBreakFlag = () => {
        if (childBreakFlag.shouldBreak) breakCount += 1;
        if (parentBreakFlag && breakCount === totalChildren) parentBreakFlag.shouldBreak = true;
      };

      return this.executeNode(child, childContext, childBreakFlag, pipelineIdForChild)
        .then((result) => {
          childContext.commitPatch(); // apply patch after child success
          updateParentBreakFlag();
          return { id: child.id!, result, isError: false };
        })
        .catch((error) => {
          childContext.commitPatch(); // apply patch even if child failed
          updateParentBreakFlag();
          logger.info(`TREE PIPELINE: executeNodeChildren - Error for id: ${child?.id}`, { error });
          if (this.throttlingErrorChecker && this.throttlingErrorChecker(error)) {
            childContext.updateObject(['monitor'], 'isThrottled', true);
          }
          return { id: child.id!, result: error, isError: true };
        });
    });

    const settled = await Promise.allSettled(childPromises);

    const childrenResults: { [key: string]: any } = {};
    settled.forEach((s) => {
      if (s.status === 'fulfilled') {
        const { id, result, isError } = s.value;
        childrenResults[id] = { result, isError };
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
   * _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5_
   */
  private async executeSelectedChildren(
    selector: Selector,
    children: StageNode[],
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
    // _Requirements: flow-control-narrative REQ-3 (Task 5)
    const selectedNames = selectedChildren.map(c => c.displayName || c.name).join(', ');
    context.addFlowDebugMessage('selected', 
      `Running ${selectedNames} (${selectedChildren.length} of ${children.length} matched)`, {
      count: selectedChildren.length,
      targetStage: selectedChildren.map(c => c.name),
    });

    // Execute selected children in parallel using existing logic
    const tempNode: StageNode = { name: 'selector-temp', children: selectedChildren };
    return await this.executeNodeChildren(tempNode, context, undefined, branchPath);
  }

  /**
   * Evaluate decider and pick the next child by id; throws if not found.
   */
  private async getNextNode(
    nextNodeDecider: Decider,
    children: StageNode[],
    input?: TOut,
    context?: StageContext,
  ): Promise<StageNode> {
    const deciderResp = nextNodeDecider(input);
    const nextNodeId = deciderResp instanceof Promise ? await deciderResp : deciderResp;

    context?.addDebugInfo('nextNode', nextNodeId);

    const nextNode = children.find((child) => child.id === nextNodeId);
    if (!nextNode) {
      const errorMessage = `Next Stage not found for ${nextNodeId}`;
      context?.addErrorInfo('deciderError', errorMessage);
      throw Error(errorMessage);
    }
    return nextNode;
  }

  // ───────────────────────── Node lookup helpers ─────────────────────────

  /**
   * Find a node by its ID in the tree (recursive search).
   * Used by dynamicNext to loop back to existing nodes.
   */
  private findNodeById(nodeId: string, startNode: StageNode = this.root): StageNode | undefined {
    // Check current node
    if (startNode.id === nodeId) {
      return startNode;
    }

    // Check children
    if (startNode.children) {
      for (const child of startNode.children) {
        const found = this.findNodeById(nodeId, child);
        if (found) return found;
      }
    }

    // Check next
    if (startNode.next) {
      const found = this.findNodeById(nodeId, startNode.next);
      if (found) return found;
    }

    return undefined;
  }

  /**
   * Resolve a subflow reference node to its actual subflow structure.
   * 
   * Reference nodes are lightweight placeholders created by the builder:
   * - They have `isSubflowRoot: true` and `subflowId`
   * - But they have NO `fn`, NO `children`, NO internal `next`
   * - The actual subflow structure is in `this.subflows[subflowKey]`
   * 
   * This method looks up the subflow definition and creates a merged node
   * that combines the reference metadata with the actual subflow structure.
   * 
   * @param node - The reference node to resolve
   * @returns A node with the subflow's actual structure, preserving reference metadata
   */
  private resolveSubflowReference(node: StageNode): StageNode {
    // If node already has fn or children, it's not a reference - return as-is
    if (node.fn || (node.children && node.children.length > 0)) {
      return node;
    }
    
    // Check if we have subflows dictionary
    if (!this.subflows) {
      // No subflows dictionary - node might be using old deep-copy approach
      return node;
    }
    
    // Try to find subflow definition using multiple keys in order of preference:
    // 1. subflowId (the mount id, used by FlowChartBuilder)
    // 2. subflowName (for backward compatibility)
    // 3. name (fallback)
    const keysToTry = [node.subflowId, node.subflowName, node.name].filter(Boolean) as string[];
    let subflowDef: { root: StageNode } | undefined;
    let usedKey: string | undefined;
    
    for (const key of keysToTry) {
      if (this.subflows[key]) {
        subflowDef = this.subflows[key];
        usedKey = key;
        break;
      }
    }
    
    if (!subflowDef) {
      // Subflow not found in dictionary - might be using old approach
      logger.info(`Subflow not found in subflows dictionary for node '${node.name}' (tried keys: ${keysToTry.join(', ')})`);
      return node;
    }
    
    // Create a merged node that combines reference metadata with actual structure
    // IMPORTANT: We preserve the reference node's metadata (subflowId, subflowName, etc.)
    // but use the subflow definition's structure (fn, children, internal next)
    const resolvedNode: StageNode = {
      ...subflowDef.root,
      // Preserve reference metadata
      isSubflowRoot: node.isSubflowRoot,
      subflowId: node.subflowId,
      subflowName: node.subflowName,
      // Use reference node's display name if provided
      displayName: node.displayName || subflowDef.root.displayName,
      // Use reference node's id (mountId) for uniqueness
      id: node.id || subflowDef.root.id,
    };
    
    return resolvedNode;
  }

  /**
   * Get the next iteration number for a node and increment the counter.
   * Returns 0 for first visit, 1 for second, etc.
   */
  private getAndIncrementIteration(nodeId: string): number {
    const current = this.iterationCounters.get(nodeId) ?? 0;
    this.iterationCounters.set(nodeId, current + 1);
    return current;
  }

  // ───────────────────────── Subflow serialization helpers ─────────────────────────

  /**
   * Serialize a subflow's StageNode tree for frontend consumption.
   * Converts the internal StageNode structure to SerializedPipelineNode format.
   *
   * _Requirements: 5.2, 5.3_
   */
  private serializeSubflowStructure(subflowRoot: StageNode): SerializedPipelineNode {
    return this.nodeToSerializedNode(subflowRoot);
  }

  /**
   * Recursively convert a StageNode to SerializedPipelineNode.
   * Includes subflow metadata for frontend drill-down navigation.
   */
  private nodeToSerializedNode(node: StageNode): SerializedPipelineNode {
    // Determine node type for frontend rendering
    let type: SerializedPipelineNode['type'] = 'stage';
    if (node.nextNodeDecider || node.nextNodeSelector) {
      type = 'decider';
    } else if (node.children && node.children.length > 0) {
      type = 'fork';
    } else if (node.isStreaming) {
      type = 'streaming';
    }

    const serialized: SerializedPipelineNode = {
      name: node.name,
      type,
    };

    // Add optional properties only if present
    if (node.id) serialized.id = node.id;
    if (node.displayName) serialized.displayName = node.displayName;
    if (node.isStreaming) serialized.isStreaming = true;
    if (node.nextNodeDecider) serialized.hasDecider = true;
    if (node.nextNodeSelector) serialized.hasSelector = true;

    // Add subflow metadata for frontend drill-down navigation
    if (node.isSubflowRoot) serialized.isSubflowRoot = true;
    if (node.subflowId) serialized.subflowId = node.subflowId;
    if (node.subflowName) serialized.subflowName = node.subflowName;

    // Recursively serialize children
    if (node.children && node.children.length > 0) {
      serialized.children = node.children.map((c) => this.nodeToSerializedNode(c));
    }

    // Recursively serialize next
    if (node.next) {
      serialized.next = this.nodeToSerializedNode(node.next);
    }

    return serialized;
  }

  /**
   * Generate an iterated stage name for context tree.
   * First visit: "askLLM", second: "askLLM.1", third: "askLLM.2"
   */
  private getIteratedStageName(baseName: string, iteration: number): string {
    return iteration === 0 ? baseName : `${baseName}.${iteration}`;
  }

  // ───────────────────────── Extractor helpers ─────────────────────────

  /**
   * Call the extractor for a stage and store the result.
   * Handles errors gracefully - logs and continues execution.
   * 
   * @param node - The stage node
   * @param context - The stage context (after commitPatch)
   * @param stagePath - The full path to this stage (e.g., "root.child")
   */
  private callExtractor(
    node: StageNode,
    context: StageContext,
    stagePath: string,
  ): void {
    if (!this.extractor) return;
    
    try {
      const snapshot: StageSnapshot = { node, context };
      const result = this.extractor(snapshot);
      
      // Only store if extractor returned a value
      if (result !== undefined && result !== null) {
        this.extractedResults.set(stagePath, result);
      }
    } catch (error: any) {
      // Log error but don't stop execution
      logger.error(`Extractor error at stage '${stagePath}':`, { error });
      this.extractorErrors.push({
        stagePath,
        message: error?.message ?? String(error),
        error,
      });
    }
  }

  /**
   * Generate the stage path for extractor results.
   * Uses node.id if available, otherwise node.name.
   * Combines with branchPath for nested stages.
   */
  private getStagePath(node: StageNode, branchPath?: string): string {
    const nodeId = node.id ?? node.name;
    if (!branchPath) return nodeId;
    return `${branchPath}.${nodeId}`;
  }

  // ───────────────────────── Introspection helpers ─────────────────────────

  /** Returns the full context tree (global + stage contexts) for observability panels. */
  getContextTree(): ContextTreeType {
    return this.pipelineRuntime.getContextTree();
  }

  /** Returns the PipelineRuntime (root holder of StageContexts). */
  getContext(): PipelineRuntime {
    return this.pipelineRuntime;
  }

  /** Sets a root object value into the global context (utility). */
  setRootObject(path: string[], key: string, value: unknown) {
    this.pipelineRuntime.setRootObject(path, key, value);
  }

  /** Returns pipeline ids inherited under this root (for debugging fan-out). */
  getInheritedPipelines() {
    return this.pipelineRuntime.getPipelines();
  }

  /**
   * Returns the current pipeline root node (including runtime modifications).
   * 
   * This is useful for serializing the pipeline structure after execution,
   * which includes any dynamic children or loop targets added at runtime
   * by stages that return StageNode.
   * 
   * @returns The root StageNode with runtime modifications
   */
  getRuntimeRoot(): StageNode {
    return this.root;
  }

  /**
   * Returns the collected SubflowResultsMap after pipeline execution.
   * Used by the service layer to include subflow data in API responses.
   *
   * _Requirements: 4.3_
   */
  getSubflowResults(): Map<string, SubflowResult> {
    return this.subflowResults;
  }

  /**
   * Returns the collected extracted results after pipeline execution.
   * Map keys are stage paths (e.g., "root.child.grandchild").
   */
  getExtractedResults<TResult = unknown>(): Map<string, TResult> {
    return this.extractedResults as Map<string, TResult>;
  }

  /**
   * Returns any errors that occurred during extraction.
   * Useful for debugging extractor issues.
   */
  getExtractorErrors(): ExtractorError[] {
    return this.extractorErrors;
  }
}
