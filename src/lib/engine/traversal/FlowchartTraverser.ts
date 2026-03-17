/**
 * FlowchartTraverser — Pre-order DFS traversal of StageNode graph.
 *
 * Unified traversal algorithm for all node shapes:
 *   const pre = await prep();
 *   const [x, y] = await Promise.all([fx(pre), fy(pre)]);
 *   return await next(x, y);
 *
 * For each node, executeNode follows 7 phases:
 *   0. CLASSIFY  — subflow detection, early delegation
 *   1. VALIDATE  — node invariants, role markers
 *   2. EXECUTE   — run stage fn, commit, break check
 *   3. DYNAMIC   — StageNode return detection, subflow auto-registration, structure updates
 *   4. CHILDREN  — fork/selector/decider dispatch
 *   5. CONTINUE  — dynamic next / linear next resolution
 *   6. LEAF      — no continuation, return output
 *
 * Break semantics: If a stage calls breakFn(), commit and STOP.
 * Patch model: Stage writes into local patch; commitPatch() after return or throw.
 */

import type { StageContext } from '../../memory/StageContext.js';
import type { ScopeProtectionMode } from '../../scope/protection/types.js';
import { isStageNodeReturn } from '../graph/StageNode.js';
import { ChildrenExecutor } from '../handlers/ChildrenExecutor.js';
import { ContinuationResolver } from '../handlers/ContinuationResolver.js';
import { DeciderHandler } from '../handlers/DeciderHandler.js';
import { ExtractorRunner } from '../handlers/ExtractorRunner.js';
import { NodeResolver } from '../handlers/NodeResolver.js';
import { RuntimeStructureManager } from '../handlers/RuntimeStructureManager.js';
import { SelectorHandler } from '../handlers/SelectorHandler.js';
import { StageRunner } from '../handlers/StageRunner.js';
import { SubflowExecutor } from '../handlers/SubflowExecutor.js';
import { FlowRecorderDispatcher } from '../narrative/FlowRecorderDispatcher.js';
import { NarrativeFlowRecorder } from '../narrative/NarrativeFlowRecorder.js';
import { NullControlFlowNarrativeGenerator } from '../narrative/NullControlFlowNarrativeGenerator.js';
import type { FlowRecorder, IControlFlowNarrative } from '../narrative/types.js';
import type {
  ExtractorError,
  HandlerDeps,
  IExecutionRuntime,
  ILogger,
  NodeResultType,
  ScopeFactory,
  SerializedPipelineStructure,
  StageFunction,
  StageNode,
  StreamHandlers,
  SubflowResult,
  TraversalExtractor,
  TraversalResult,
} from '../types.js';

export interface TraverserOptions<TOut = any, TScope = any> {
  root: StageNode<TOut, TScope>;
  stageMap: Map<string, StageFunction<TOut, TScope>>;
  scopeFactory: ScopeFactory<TScope>;
  executionRuntime: IExecutionRuntime;
  readOnlyContext?: unknown;
  /** Execution environment — propagates to subflows automatically. */
  executionEnv?: import('../../engine/types').ExecutionEnv;
  throttlingErrorChecker?: (error: unknown) => boolean;
  streamHandlers?: StreamHandlers;
  extractor?: TraversalExtractor;
  scopeProtectionMode?: ScopeProtectionMode;
  subflows?: Record<string, { root: StageNode<TOut, TScope> }>;
  enrichSnapshots?: boolean;
  narrativeEnabled?: boolean;
  buildTimeStructure?: SerializedPipelineStructure;
  logger: ILogger;
  signal?: AbortSignal;
  /** Pre-configured FlowRecorders to attach when narrative is enabled. */
  flowRecorders?: FlowRecorder[];
}

export class FlowchartTraverser<TOut = any, TScope = any> {
  private readonly root: StageNode<TOut, TScope>;
  private stageMap: Map<string, StageFunction<TOut, TScope>>;
  private readonly executionRuntime: IExecutionRuntime;
  private subflows?: Record<string, { root: StageNode<TOut, TScope> }>;
  private readonly logger: ILogger;
  private readonly signal?: AbortSignal;

  // Handler modules
  private readonly nodeResolver: NodeResolver<TOut, TScope>;
  private readonly childrenExecutor: ChildrenExecutor<TOut, TScope>;
  private readonly subflowExecutor: SubflowExecutor<TOut, TScope>;
  private readonly stageRunner: StageRunner<TOut, TScope>;
  private readonly continuationResolver: ContinuationResolver<TOut, TScope>;
  private readonly deciderHandler: DeciderHandler<TOut, TScope>;
  private readonly selectorHandler: SelectorHandler<TOut, TScope>;
  private readonly structureManager: RuntimeStructureManager;
  private readonly extractorRunner: ExtractorRunner<TOut, TScope>;
  private readonly narrativeGenerator: IControlFlowNarrative;
  private readonly flowRecorderDispatcher: FlowRecorderDispatcher | undefined;

  // Execution state
  private subflowResults: Map<string, SubflowResult> = new Map();

  constructor(opts: TraverserOptions<TOut, TScope>) {
    this.root = opts.root;
    this.stageMap = opts.stageMap;
    this.executionRuntime = opts.executionRuntime;
    this.subflows = opts.subflows;
    this.logger = opts.logger;
    this.signal = opts.signal;

    // Structure manager (deep-clones build-time structure)
    this.structureManager = new RuntimeStructureManager();
    this.structureManager.init(opts.buildTimeStructure);

    // Extractor runner
    this.extractorRunner = new ExtractorRunner(
      opts.extractor,
      opts.enrichSnapshots ?? false,
      this.executionRuntime,
      this.logger,
    );

    // Narrative generator
    // When narrative is enabled with FlowRecorders, use FlowRecorderDispatcher.
    // When narrative is enabled without FlowRecorders, use legacy ControlFlowNarrativeGenerator.
    // When disabled, use NullControlFlowNarrativeGenerator (zero-cost).
    if (opts.narrativeEnabled) {
      const dispatcher = new FlowRecorderDispatcher();
      this.flowRecorderDispatcher = dispatcher;

      // If custom FlowRecorders are provided, use them; otherwise attach default NarrativeFlowRecorder
      if (opts.flowRecorders && opts.flowRecorders.length > 0) {
        for (const recorder of opts.flowRecorders) {
          dispatcher.attach(recorder);
        }
      } else {
        dispatcher.attach(new NarrativeFlowRecorder());
      }

      this.narrativeGenerator = dispatcher;
    } else {
      this.narrativeGenerator = new NullControlFlowNarrativeGenerator();
    }

    // Build shared deps bag
    const deps = this.createDeps(opts);

    // Initialize handler modules
    this.nodeResolver = new NodeResolver(deps);
    this.childrenExecutor = new ChildrenExecutor(deps, this.executeNode.bind(this));
    this.stageRunner = new StageRunner(deps);
    this.continuationResolver = new ContinuationResolver(deps, this.nodeResolver, (nodeId, count) =>
      this.structureManager.updateIterationCount(nodeId, count),
    );
    this.deciderHandler = new DeciderHandler(deps);
    this.selectorHandler = new SelectorHandler(deps, this.childrenExecutor);
    this.subflowExecutor = new SubflowExecutor(
      deps,
      this.nodeResolver,
      this.executeStage.bind(this),
      this.extractorRunner.callExtractor.bind(this.extractorRunner),
      this.getStageFn.bind(this),
    );
  }

  private createDeps(opts: TraverserOptions<TOut, TScope>): HandlerDeps<TOut, TScope> {
    return {
      stageMap: this.stageMap,
      root: this.root,
      executionRuntime: this.executionRuntime,
      ScopeFactory: opts.scopeFactory,
      subflows: this.subflows,
      throttlingErrorChecker: opts.throttlingErrorChecker,
      streamHandlers: opts.streamHandlers,
      scopeProtectionMode: opts.scopeProtectionMode ?? 'error',
      readOnlyContext: opts.readOnlyContext,
      executionEnv: opts.executionEnv,
      narrativeGenerator: this.narrativeGenerator,
      logger: this.logger,
      signal: opts.signal,
    };
  }

  // ─────────────────────── Public API ───────────────────────

  async execute(): Promise<TraversalResult> {
    const context = this.executionRuntime.rootStageContext;
    return await this.executeNode(this.root, context, { shouldBreak: false }, '');
  }

  getRuntimeStructure(): SerializedPipelineStructure | undefined {
    return this.structureManager.getStructure();
  }

  getSnapshot() {
    return this.executionRuntime.getSnapshot();
  }

  getRuntime() {
    return this.executionRuntime;
  }

  setRootObject(path: string[], key: string, value: unknown) {
    this.executionRuntime.setRootObject(path, key, value);
  }

  getBranchIds() {
    return this.executionRuntime.getPipelines();
  }

  getRuntimeRoot(): StageNode {
    return this.root;
  }

  getSubflowResults(): Map<string, SubflowResult> {
    return this.subflowResults;
  }

  getExtractedResults<TResult = unknown>(): Map<string, TResult> {
    return this.extractorRunner.getExtractedResults() as Map<string, TResult>;
  }

  getExtractorErrors(): ExtractorError[] {
    return this.extractorRunner.getExtractorErrors();
  }

  getNarrative(): string[] {
    return this.narrativeGenerator.getSentences();
  }

  /** Returns the FlowRecorderDispatcher, or undefined if narrative is disabled. */
  getFlowRecorderDispatcher(): FlowRecorderDispatcher | undefined {
    return this.flowRecorderDispatcher;
  }

  // ─────────────────────── Core Traversal ───────────────────────

  private getStageFn(node: StageNode<TOut, TScope>): StageFunction<TOut, TScope> | undefined {
    if (typeof node.fn === 'function') return node.fn as StageFunction<TOut, TScope>;
    return this.stageMap.get(node.name);
  }

  private async executeStage(
    node: StageNode<TOut, TScope>,
    stageFunc: StageFunction<TOut, TScope>,
    context: StageContext,
    breakFn: () => void,
  ) {
    return this.stageRunner.run(node, stageFunc, context, breakFn);
  }

  /**
   * Pre-order DFS traversal — the core algorithm.
   * Each call processes one node through all 7 phases.
   */
  private async executeNode(
    node: StageNode<TOut, TScope>,
    context: StageContext,
    breakFlag: { shouldBreak: boolean },
    branchPath?: string,
  ): Promise<any> {
    // Attach builder metadata to context for snapshot enrichment
    if (node.description) context.description = node.description;
    if (node.isSubflowRoot && node.subflowId) context.subflowId = node.subflowId;

    // ─── Phase 0: CLASSIFY — subflow detection ───
    if (node.isSubflowRoot && node.subflowId) {
      const resolvedNode = this.nodeResolver.resolveSubflowReference(node);
      const previousSubflowId = this.extractorRunner.currentSubflowId;
      this.extractorRunner.currentSubflowId = node.subflowId;

      let subflowOutput: any;
      try {
        subflowOutput = await this.subflowExecutor.executeSubflow(
          resolvedNode,
          context,
          breakFlag,
          branchPath,
          this.subflowResults,
        );
      } finally {
        this.extractorRunner.currentSubflowId = previousSubflowId;
      }

      const isReferenceBasedSubflow = resolvedNode !== node;
      const hasChildren = Boolean(node.children && node.children.length > 0);
      const shouldExecuteContinuation = isReferenceBasedSubflow || hasChildren;

      if (node.next && shouldExecuteContinuation) {
        const nextCtx = context.createNext(branchPath as string, node.next.name, node.next.id);
        return await this.executeNode(node.next, nextCtx, breakFlag, branchPath);
      }

      return subflowOutput;
    }

    const stageFunc = this.getStageFn(node);
    const hasStageFunction = Boolean(stageFunc);
    const isScopeBasedDecider = Boolean(node.deciderFn);
    const isScopeBasedSelector = Boolean(node.selectorFn);
    const isDeciderNode = isScopeBasedDecider;
    const hasChildren = Boolean(node.children?.length);
    const hasNext = Boolean(node.next);
    const originalNext = node.next;

    // ─── Phase 1: VALIDATE — node invariants ───
    if (!hasStageFunction && !isDeciderNode && !isScopeBasedSelector && !hasChildren) {
      const errorMessage = `Node '${node.name}' must define: embedded fn OR a stageMap entry OR have children/decider`;
      this.logger.error(`Error in pipeline (${branchPath}) stage [${node.name}]:`, { error: errorMessage });
      throw new Error(errorMessage);
    }
    if (isDeciderNode && !hasChildren) {
      const errorMessage = 'Decider node needs to have children to execute';
      this.logger.error(`Error in pipeline (${branchPath}) stage [${node.name}]:`, { error: errorMessage });
      throw new Error(errorMessage);
    }
    if (isScopeBasedSelector && !hasChildren) {
      const errorMessage = 'Selector node needs to have children to execute';
      this.logger.error(`Error in pipeline (${branchPath}) stage [${node.name}]:`, { error: errorMessage });
      throw new Error(errorMessage);
    }

    // Role markers for debug panels
    if (!hasStageFunction) {
      if (isDeciderNode) context.setAsDecider();
      else if (hasChildren) context.setAsFork();
    }

    const breakFn = () => (breakFlag.shouldBreak = true);

    // ─── Phase 2a: SELECTOR — scope-based multi-choice ───
    if (isScopeBasedSelector) {
      const previousForkId = this.extractorRunner.currentForkId;
      this.extractorRunner.currentForkId = node.id;

      try {
        const selectorResult = await this.selectorHandler.handleScopeBased(
          node,
          stageFunc!,
          context,
          breakFlag,
          branchPath,
          this.executeStage.bind(this),
          this.executeNode.bind(this),
          this.extractorRunner.callExtractor.bind(this.extractorRunner),
          this.extractorRunner.getStagePath.bind(this.extractorRunner),
        );

        if (hasNext) {
          const nextCtx = context.createNext(branchPath as string, node.next!.name, node.next!.id);
          return await this.executeNode(node.next!, nextCtx, breakFlag, branchPath);
        }
        return selectorResult;
      } finally {
        this.extractorRunner.currentForkId = previousForkId;
      }
    }

    // ─── Phase 2b: DECIDER — scope-based single-choice conditional branch ───
    if (isDeciderNode) {
      const deciderResult = await this.deciderHandler.handleScopeBased(
        node,
        stageFunc!,
        context,
        breakFlag,
        branchPath,
        this.executeStage.bind(this),
        this.executeNode.bind(this),
        this.extractorRunner.callExtractor.bind(this.extractorRunner),
        this.extractorRunner.getStagePath.bind(this.extractorRunner),
      );

      // After branch execution, follow decider's own next (e.g., loopTo target)
      if (hasNext && !breakFlag.shouldBreak) {
        const nextNode = originalNext!;
        const isLoopRef =
          !this.getStageFn(nextNode) &&
          !nextNode.children?.length &&
          !nextNode.deciderFn &&
          !nextNode.selectorFn &&
          !nextNode.isSubflowRoot;

        if (isLoopRef) {
          return this.continuationResolver.resolve(
            nextNode,
            node,
            context,
            breakFlag,
            branchPath,
            this.executeNode.bind(this),
          );
        }

        this.narrativeGenerator.onNext(node.name, nextNode.name, nextNode.description);
        const nextCtx = context.createNext(branchPath as string, nextNode.name, nextNode.id);
        return await this.executeNode(nextNode, nextCtx, breakFlag, branchPath);
      }

      return deciderResult;
    }

    // ─── Abort check — cooperative cancellation ───
    if (this.signal?.aborted) {
      const reason =
        this.signal.reason instanceof Error ? this.signal.reason : new Error(this.signal.reason ?? 'Aborted');
      throw reason;
    }

    // ─── Phase 3: EXECUTE — run stage function ───
    let stageOutput: TOut | undefined;
    let dynamicNext: StageNode<TOut, TScope> | undefined;

    if (stageFunc) {
      try {
        stageOutput = await this.executeStage(node, stageFunc, context, breakFn);
      } catch (error: any) {
        context.commit();
        this.extractorRunner.callExtractor(
          node,
          context,
          this.extractorRunner.getStagePath(node, branchPath, context.stageName),
          undefined,
          { type: 'stageExecutionError', message: error.toString() },
        );
        this.narrativeGenerator.onError(node.name, error.toString(), error);
        this.logger.error(`Error in pipeline (${branchPath}) stage [${node.name}]:`, { error });
        context.addError('stageExecutionError', error.toString());
        throw error;
      }
      context.commit();
      this.extractorRunner.callExtractor(
        node,
        context,
        this.extractorRunner.getStagePath(node, branchPath, context.stageName),
        stageOutput,
      );
      this.narrativeGenerator.onStageExecuted(node.name, node.description);

      if (breakFlag.shouldBreak) {
        this.narrativeGenerator.onBreak(node.name);
        this.logger.info(`Execution stopped in pipeline (${branchPath}) after ${node.name} due to break condition.`);
        return stageOutput;
      }

      // ─── Phase 4: DYNAMIC — StageNode return detection ───
      if (stageOutput && typeof stageOutput === 'object' && isStageNodeReturn(stageOutput)) {
        const dynamicNode = stageOutput as StageNode<TOut, TScope>;
        context.addLog('isDynamic', true);
        context.addLog('dynamicPattern', 'StageNodeReturn');

        // Dynamic subflow auto-registration
        if (dynamicNode.isSubflowRoot && dynamicNode.subflowDef && dynamicNode.subflowId) {
          context.addLog('dynamicPattern', 'dynamicSubflow');
          context.addLog('dynamicSubflowId', dynamicNode.subflowId);

          // Structural-only subflow: has buildTimeStructure but no executable root.
          // Used for pre-executed subflows (e.g., inner flows that already ran).
          // Annotates the node for visualization without re-executing.
          if (!dynamicNode.subflowDef.root) {
            context.addLog('dynamicPattern', 'structuralSubflow');
            node.isSubflowRoot = true;
            node.subflowId = dynamicNode.subflowId;
            node.subflowName = dynamicNode.subflowName;
            node.description = dynamicNode.description ?? node.description;

            this.structureManager.updateDynamicSubflow(
              node.id,
              dynamicNode.subflowId!,
              dynamicNode.subflowName,
              dynamicNode.subflowDef.buildTimeStructure,
            );

            // Fall through to Phase 5 (continuation) — no subflow execution needed
          } else {
            // Full dynamic subflow: register + execute
            this.autoRegisterSubflowDef(dynamicNode.subflowId, dynamicNode.subflowDef, node.id);

            node.isSubflowRoot = true;
            node.subflowId = dynamicNode.subflowId;
            node.subflowName = dynamicNode.subflowName;
            node.subflowMountOptions = dynamicNode.subflowMountOptions;

            this.structureManager.updateDynamicSubflow(
              node.id,
              dynamicNode.subflowId!,
              dynamicNode.subflowName,
              dynamicNode.subflowDef?.buildTimeStructure,
            );

            return await this.executeNode(node, context, breakFlag, branchPath);
          }
        }

        // Check children for subflowDef
        if (dynamicNode.children) {
          for (const child of dynamicNode.children) {
            if (child.isSubflowRoot && child.subflowDef && child.subflowId) {
              this.autoRegisterSubflowDef(child.subflowId, child.subflowDef, child.id);
              this.structureManager.updateDynamicSubflow(
                child.id,
                child.subflowId!,
                child.subflowName,
                child.subflowDef?.buildTimeStructure,
              );
            }
          }
        }

        // Dynamic children (fork pattern)
        if (dynamicNode.children && dynamicNode.children.length > 0) {
          node.children = dynamicNode.children;
          context.addLog('dynamicChildCount', dynamicNode.children.length);
          context.addLog(
            'dynamicChildIds',
            dynamicNode.children.map((c) => c.id),
          );

          this.structureManager.updateDynamicChildren(
            node.id,
            dynamicNode.children,
            Boolean(dynamicNode.nextNodeSelector),
            Boolean(dynamicNode.deciderFn),
          );

          if (typeof dynamicNode.nextNodeSelector === 'function') {
            node.nextNodeSelector = dynamicNode.nextNodeSelector;
            context.addLog('hasSelector', true);
          }
        }

        // Dynamic next (linear continuation)
        if (dynamicNode.next) {
          dynamicNext = dynamicNode.next;
          this.structureManager.updateDynamicNext(node.id, dynamicNode.next);
          node.next = dynamicNode.next;
          context.addLog('hasDynamicNext', true);
        }

        stageOutput = undefined;
      }

      // Restore original next to avoid stale reference on loop revisit
      if (dynamicNext) {
        node.next = originalNext;
      }
    }

    // ─── Phase 5: CHILDREN — fork dispatch ───
    const hasChildrenAfterStage = Boolean(node.children?.length);

    if (hasChildrenAfterStage) {
      context.addLog('totalChildren', node.children?.length);
      context.addLog('orderOfExecution', 'ChildrenAfterStage');

      let nodeChildrenResults: Record<string, NodeResultType>;

      if (node.nextNodeSelector) {
        const previousForkId = this.extractorRunner.currentForkId;
        this.extractorRunner.currentForkId = node.id;
        try {
          nodeChildrenResults = await this.childrenExecutor.executeSelectedChildren(
            node.nextNodeSelector,
            node.children!,
            stageOutput,
            context,
            branchPath as string,
          );
        } finally {
          this.extractorRunner.currentForkId = previousForkId;
        }
      } else {
        const childCount = node.children?.length ?? 0;
        const childNames = node.children?.map((c) => c.name).join(', ');
        context.addFlowDebugMessage('children', `Executing all ${childCount} children in parallel: ${childNames}`, {
          count: childCount,
          targetStage: node.children?.map((c) => c.name),
        });

        const previousForkId = this.extractorRunner.currentForkId;
        this.extractorRunner.currentForkId = node.id;
        try {
          nodeChildrenResults = await this.childrenExecutor.executeNodeChildren(node, context, undefined, branchPath);
        } finally {
          this.extractorRunner.currentForkId = previousForkId;
        }
      }

      // Fork-only: return bundle
      if (!hasNext && !dynamicNext) {
        return nodeChildrenResults!;
      }

      // Capture dynamic children as synthetic subflow result for UI
      const isDynamic = context.debug?.logContext?.isDynamic;
      if (isDynamic && node.children && node.children.length > 0) {
        this.captureDynamicChildrenResult(node, context);
      }
    }

    // ─── Phase 6: CONTINUE — dynamic next / linear next ───
    if (dynamicNext) {
      return this.continuationResolver.resolve(
        dynamicNext,
        node,
        context,
        breakFlag,
        branchPath,
        this.executeNode.bind(this),
      );
    }

    if (hasNext) {
      const nextNode = originalNext!;

      // Detect loop reference nodes created by loopTo() — marked with isLoopRef flag.
      // Route through ContinuationResolver for proper ID resolution, iteration
      // tracking, and narrative generation.
      const isLoopReference = nextNode.isLoopRef;

      if (isLoopReference) {
        return this.continuationResolver.resolve(
          nextNode,
          node,
          context,
          breakFlag,
          branchPath,
          this.executeNode.bind(this),
        );
      }

      this.narrativeGenerator.onNext(node.name, nextNode.name, nextNode.description);
      context.addFlowDebugMessage('next', `Moving to ${nextNode.name} stage`, {
        targetStage: nextNode.name,
      });
      const nextCtx = context.createNext(branchPath as string, nextNode.name, nextNode.id);
      return await this.executeNode(nextNode, nextCtx, breakFlag, branchPath);
    }

    // ─── Phase 7: LEAF — no continuation ───
    return stageOutput;
  }

  // ─────────────────────── Private Helpers ───────────────────────

  private captureDynamicChildrenResult(node: StageNode<TOut, TScope>, context: StageContext): void {
    const parentStageId = context.getStageId();

    const childStructure: any = {
      id: `${node.id}-children`,
      name: 'Dynamic Children',
      type: 'fork',
      children: node.children!.map((c) => ({
        id: c.id,
        name: c.name,
        type: 'stage',
      })),
    };

    const childStages: Record<string, unknown> = {};
    if (context.children) {
      for (const childCtx of context.children) {
        const snapshot = childCtx.getSnapshot();
        childStages[snapshot.name || snapshot.id] = {
          name: snapshot.name,
          output: snapshot.logs,
          errors: snapshot.errors,
          metrics: snapshot.metrics,
          status: snapshot.errors && Object.keys(snapshot.errors).length > 0 ? 'error' : 'success',
        };
      }
    }

    this.subflowResults.set(node.id, {
      subflowId: node.id,
      subflowName: node.name,
      treeContext: {
        globalContext: {},
        stageContexts: childStages as unknown as Record<string, unknown>,
        history: [],
      },
      parentStageId,
      pipelineStructure: childStructure,
    });
  }

  private autoRegisterSubflowDef(
    subflowId: string,
    subflowDef: NonNullable<StageNode['subflowDef']>,
    mountNodeId?: string,
  ): void {
    let subflowsDict = this.subflows;
    if (!subflowsDict) {
      subflowsDict = {};
      this.subflows = subflowsDict;
    }

    // First-write-wins
    const isNewRegistration = !subflowsDict[subflowId];
    if (isNewRegistration && subflowDef.root) {
      subflowsDict[subflowId] = {
        root: subflowDef.root as StageNode<TOut, TScope>,
        ...(subflowDef.buildTimeStructure ? { buildTimeStructure: subflowDef.buildTimeStructure } : {}),
      } as any;
    }

    // Merge stageMap entries (parent entries preserved)
    if (subflowDef.stageMap) {
      for (const [key, fn] of Array.from(subflowDef.stageMap.entries())) {
        if (!this.stageMap.has(key)) {
          this.stageMap.set(key, fn as StageFunction<TOut, TScope>);
        }
      }
    }

    // Merge nested subflows
    if (subflowDef.subflows) {
      for (const [key, def] of Object.entries(subflowDef.subflows)) {
        if (!subflowsDict[key]) {
          subflowsDict[key] = def as { root: StageNode<TOut, TScope> };
        }
      }
    }

    if (mountNodeId) {
      this.structureManager.updateDynamicSubflow(
        mountNodeId,
        subflowId,
        subflowDef.root?.subflowName || subflowDef.root?.name,
        subflowDef.buildTimeStructure,
      );
    }

    // Notify FlowRecorders only on first registration (matches first-write-wins)
    if (isNewRegistration) {
      const subflowName = subflowDef.root?.subflowName || subflowDef.root?.name || subflowId;
      this.narrativeGenerator.onSubflowRegistered(
        subflowId,
        subflowName,
        subflowDef.root?.description,
        subflowDef.buildTimeStructure,
      );
    }
  }
}
