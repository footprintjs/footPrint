/**
 * TreePipeline.ts
 *
 * Engine for Tree-of-Functions traversal with a **programmer-friendly order**:
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

import { logger } from '../logger';

import { StageContext } from '../context/StageContext';
import { TreePipelineContext, ContextTreeType } from '../context/TreePipelineContext';
import { NodeResultType, PipelineStageFunction, TreeOfFunctionsResponse, StreamHandlers, StreamCallback } from './types';
import { ScopeFactory } from '../context/types';

export type Decider = (nodeArgs: any) => string | Promise<string>;

export type StageNode<TOut = any, TScope = any> = {
    /** Human-readable stage name; also used as the stageMap key */
    name: string;
    /** Optional stable id (required by decider/fork aggregation) */
    id?: string;
    /** Linear continuation */
    next?: StageNode<TOut, TScope>;
    /** Parallel children (fork) */
    children?: StageNode<TOut, TScope>[];
    /** Decider (mutually exclusive with `next`); must select a child `id` */
    nextNodeDecider?: Decider;
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

export class TreePipeline<TOut, TScope> {
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

        // ───────────────────────── 1) Validation ─────────────────────────
        // A node must provide at least one of: stage, children, or decider.
        if (!hasStageFunction && !isDeciderNode && !hasChildren) {
            const errorMessage =
                `Node '${node.name}' must define: embedded fn OR a stageMap entry OR have children/decider`;
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
        // unified order: stage (optional) → commit → (break?) → children (optional) → next (optional)
        let stageOutput: TOut | undefined;

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
        }

        // ───────────────────────── 4) Children (if any) ─────────────────────────
        if (hasChildren) {
            // Breadcrumbs
            context.addDebugInfo('totalChildren', node.children?.length);
            context.addDebugInfo('orderOfExecution', 'ChildrenAfterStage');

            const nodeChildrenResults = await this.executeNodeChildren(node, context, undefined, branchPath);

            // Fork-only: return bundle object
            if (!hasNext) {
                return nodeChildrenResults;
            }
            // Fork + next: continue below
        }

        // ───────────────────────── 5) Linear `next` (if provided) ─────────────────────────
        if (hasNext) {
            const nextNode = node.next!;
            const nextStageContext = context.createNextContext(branchPath as string, nextNode.name);
            return await this.executeNode(nextNode, nextStageContext, breakFlag, branchPath);
        }

        // ───────────────────────── 6) Leaf ─────────────────────────
        // No children & no next → return this node's stage output (may be undefined)
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
}
