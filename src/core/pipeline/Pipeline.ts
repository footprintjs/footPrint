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
import { ContextTreeType, TreePipelineContext } from '../context/TreePipelineContext';
import { ScopeFactory } from '../context/types';
import { logger } from '../logger';
import {
  NodeResultType,
  PipelineStageFunction,
  StreamCallback,
  StreamHandlers,
  TreeOfFunctionsResponse,
} from './types';

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
  private treePipelineContext: TreePipelineContext;

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

  constructor(
    root: StageNode,
    stageMap: Map<string, PipelineStageFunction<TOut, TScope>>,
    scopeFactory: ScopeFactory<TScope>,
    defaultValuesForContext?: unknown,
    initialContext?: unknown,
    readOnlyContext?: unknown,
    throttlingErrorChecker?: (error: unknown) => boolean,
    streamHandlers?: StreamHandlers,
  ) {
    this.root = root;
    this.stageMap = stageMap;
    this.readOnlyContext = readOnlyContext;
    this.treePipelineContext = new TreePipelineContext(this.root.name, defaultValuesForContext, initialContext);
    this.throttlingErrorChecker = throttlingErrorChecker;
    this.ScopeFactory = scopeFactory;
    this.streamHandlers = streamHandlers;
  }

  /** Execute the pipeline from the root node. */
  async execute(): Promise<TreeOfFunctionsResponse> {
    const context = this.treePipelineContext.rootStageContext;
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
          logger.error(`Error in pipeline (${branchPath}) stage [${node.name}]:`, { error });
          context.addErrorInfo('stageExecutionError', error.toString());
          throw error;
        }
        context.commitPatch();

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
        logger.error(`Error in pipeline (${branchPath}) stage [${node.name}]:`, { error });
        context.addErrorInfo('stageExecutionError', error.toString());
        throw error;
      }
      context.commitPatch();

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
        
        const nextStageContext = context.createNextContext(branchPath as string, iteratedStageName);
        return await this.executeNode(targetNode, nextStageContext, breakFlag, branchPath);
      }
      
      // If dynamicNext is a StageNode with fn, execute it directly (truly dynamic)
      if (dynamicNext.fn) {
        context.addDebugInfo('dynamicNextDirect', true);
        context.addDebugInfo('dynamicNextName', dynamicNext.name);
        
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

      const nextStageContext = context.createNextContext(branchPath as string, iteratedStageName);
      return await this.executeNode(targetNode, nextStageContext, breakFlag, branchPath);
    }

    // ───────────────────────── 6) Linear `next` (if provided) ─────────────────────────
    if (hasNext) {
      const nextNode = node.next!;
      const nextStageContext = context.createNextContext(branchPath as string, nextNode.name);
      return await this.executeNode(nextNode, nextStageContext, breakFlag, branchPath);
    }

    // ───────────────────────── 7) Leaf ─────────────────────────
    // No children & no next & no dynamicNext → return this node's stage output (may be undefined)
    return stageOutput;
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
    const scope = this.ScopeFactory(context, node.name, this.readOnlyContext);

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
   * Get the next iteration number for a node and increment the counter.
   * Returns 0 for first visit, 1 for second, etc.
   */
  private getAndIncrementIteration(nodeId: string): number {
    const current = this.iterationCounters.get(nodeId) ?? 0;
    this.iterationCounters.set(nodeId, current + 1);
    return current;
  }

  /**
   * Generate an iterated stage name for context tree.
   * First visit: "askLLM", second: "askLLM.1", third: "askLLM.2"
   */
  private getIteratedStageName(baseName: string, iteration: number): string {
    return iteration === 0 ? baseName : `${baseName}.${iteration}`;
  }

  // ───────────────────────── Introspection helpers ─────────────────────────

  /** Returns the full context tree (global + stage contexts) for observability panels. */
  getContextTree(): ContextTreeType {
    return this.treePipelineContext.getContextTree();
  }

  /** Returns the TreePipelineContext (root holder of StageContexts). */
  getContext(): TreePipelineContext {
    return this.treePipelineContext;
  }

  /** Sets a root object value into the global context (utility). */
  setRootObject(path: string[], key: string, value: unknown) {
    this.treePipelineContext.setRootObject(path, key, value);
  }

  /** Returns pipeline ids inherited under this root (for debugging fan-out). */
  getInheritedPipelines() {
    return this.treePipelineContext.getPipelines();
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
}
