/**
 * SubflowExecutor — Isolation boundary for subflow execution.
 *
 * Responsibilities:
 * - Create isolated ExecutionRuntime for each subflow
 * - Apply input/output mapping via SubflowInputMapper
 * - Delegate traversal to a factory-created FlowchartTraverser
 * - Track subflow results for debugging/visualization
 *
 * Each subflow gets its own GlobalStore for isolation.
 * Traversal uses the SAME 7-phase algorithm as the top-level traverser
 * (via SubflowTraverserFactory), so deciders, selectors, loops, lazy subflows,
 * and abort signals all work inside subflows automatically.
 */

import type { StageContext } from '../../memory/StageContext.js';
import { isPauseSignal } from '../../pause/types.js';
import type { StageNode } from '../graph/StageNode.js';
import type { TraversalContext } from '../narrative/types.js';
import type {
  HandlerDeps,
  IExecutionRuntime,
  SubflowResult,
  SubflowTraverserFactory,
  SubflowTraverserHandle,
} from '../types.js';
import { applyOutputMapping, getInitialScopeValues, seedSubflowGlobalStore } from './SubflowInputMapper.js';

export class SubflowExecutor<TOut = any, TScope = any> {
  constructor(
    private deps: HandlerDeps<TOut, TScope>,
    private traverserFactory: SubflowTraverserFactory<TOut, TScope>,
  ) {}

  /**
   * Execute a subflow with isolated context.
   *
   * 1. Creates a fresh ExecutionRuntime for the subflow
   * 2. Applies input mapping to seed the subflow's GlobalStore
   * 3. Delegates traversal to a factory-created FlowchartTraverser
   * 4. Applies output mapping to write results back to parent scope
   * 5. Stores execution data for debugging/visualization
   */
  async executeSubflow(
    node: StageNode<TOut, TScope>,
    parentContext: StageContext,
    breakFlag: { shouldBreak: boolean },
    branchPath: string | undefined,
    subflowResultsMap: Map<string, SubflowResult>,
    parentTraversalContext?: TraversalContext,
  ): Promise<any> {
    const subflowId = node.subflowId!;
    const subflowName = node.subflowName ?? node.name;

    parentContext.addFlowDebugMessage('subflow', `Entering ${subflowName} subflow`, {
      targetStage: subflowId,
    });

    // ─── Input Mapping ───
    const mountOptions = node.subflowMountOptions;
    let mappedInput: Record<string, unknown> = {};

    if (mountOptions) {
      try {
        const parentScope = parentContext.getScope();
        mappedInput = getInitialScopeValues(parentScope, mountOptions);
        if (Object.keys(mappedInput).length > 0) {
          // mappedInput is captured in SubflowResult.treeContext for debugging
        }
      } catch (error: any) {
        parentContext.addError('inputMapperError', error.toString());
        this.deps.logger.error(`Error in inputMapper for subflow (${subflowId}):`, { error });
        throw error;
      }
    }

    // Narrative entry fires AFTER input mapping so it can include mapped values
    this.deps.narrativeGenerator.onSubflowEntry(
      subflowName,
      subflowId,
      node.description,
      parentTraversalContext,
      mappedInput,
    );

    // Create isolated runtime via dynamic construction (avoids circular import)
    const ExecutionRuntimeClass = this.deps.executionRuntime.constructor as new (
      name: string,
      id: string,
    ) => IExecutionRuntime;
    const nestedRuntime = new ExecutionRuntimeClass(node.name, node.id);
    let nestedRootContext = nestedRuntime.rootStageContext;

    // Seed GlobalStore with input
    if (Object.keys(mappedInput).length > 0) {
      seedSubflowGlobalStore(nestedRuntime, mappedInput);
      // Refresh rootStageContext so WriteBuffer sees committed data
      const StageContextClass = nestedRootContext.constructor as new (...args: any[]) => StageContext;
      nestedRootContext = new StageContextClass(
        '',
        nestedRootContext.stageName,
        nestedRootContext.stageId,
        nestedRuntime.globalStore,
        '',
        nestedRuntime.executionHistory,
      );
      nestedRuntime.rootStageContext = nestedRootContext;
    }

    // Prepare subflow root node — strip isSubflowRoot to prevent re-delegation
    const hasChildren = Boolean(node.children && node.children.length > 0);
    const subflowNode: StageNode<TOut, TScope> = {
      ...node,
      isSubflowRoot: false,
      next: hasChildren ? undefined : node.next,
    };

    // ─── Execute via factory traverser ───
    // The factory creates a full FlowchartTraverser with the same 7-phase algorithm,
    // sharing the parent's stageMap, subflows dict, and narrative generator.
    let subflowOutput: any;
    let subflowError: Error | undefined;
    let traverserHandle: SubflowTraverserHandle<TOut, TScope> | undefined;

    try {
      traverserHandle = this.traverserFactory({
        root: subflowNode,
        executionRuntime: nestedRuntime,
        readOnlyContext: mappedInput,
        subflowId,
      });

      subflowOutput = await traverserHandle.execute();
    } catch (error: any) {
      // PauseSignal is not an error — prepend subflow ID and re-throw immediately.
      // No error logging, no subflowResult recording — the pause is control flow.
      if (isPauseSignal(error)) {
        error.prependSubflow(subflowId);
        throw error;
      }
      subflowError = error;
      parentContext.addError('subflowError', error.toString());
      this.deps.logger.error(`Error in subflow (${subflowId}):`, { error });
    }

    // Always merge nested subflow results (even on error — partial results aid debugging)
    if (traverserHandle) {
      for (const [key, value] of traverserHandle.getSubflowResults()) {
        subflowResultsMap.set(key, value);
      }
    }

    const subflowTreeContext = nestedRuntime.getSnapshot();

    // ─── Output Mapping ───
    if (!subflowError && mountOptions?.outputMapper) {
      try {
        let outputContext = parentContext;
        if (parentContext.branchId && parentContext.branchId !== '' && parentContext.parent) {
          outputContext = parentContext.parent;
        }

        const parentScope = outputContext.getScope();
        // For TypedScope subflows, stage functions return void — fall back to a shallow clone
        // of the subflow's shared state so outputMapper can access all scope values written
        // during the subflow. We shallow-clone to avoid aliasing the live SharedMemory context.
        // NOTE: the full scope is passed (not just declared outputs) — outputMapper must
        // explicitly select what to propagate to the parent.
        // Redaction: the subflow shares the parent's _redactedKeys Set (via the same ScopeFactory),
        // so any key marked redacted in the subflow is already visible in the parent's scope.
        // ScopeFacade.setValue checks _redactedKeys.has(key), so writes via outputMapper
        // automatically inherit the subflow's dynamic redaction state.
        const effectiveOutput = subflowOutput ?? { ...subflowTreeContext.sharedState };
        const mappedOutput = applyOutputMapping(effectiveOutput, parentScope, outputContext, mountOptions);

        outputContext.commit();
      } catch (error: any) {
        parentContext.addError('outputMapperError', error.toString());
        this.deps.logger.error(`Error in outputMapper for subflow (${subflowId}):`, { error });
      }
    }

    const subflowResult: SubflowResult = {
      subflowId,
      subflowName,
      treeContext: {
        globalContext: subflowTreeContext.sharedState,
        stageContexts: subflowTreeContext.executionTree as unknown as Record<string, unknown>,
        history: subflowTreeContext.commitLog,
      },
      parentStageId: parentContext.getStageId(),
    };

    const subflowDef = this.deps.subflows?.[subflowId];
    if (subflowDef && (subflowDef as any).buildTimeStructure) {
      subflowResult.pipelineStructure = (subflowDef as any).buildTimeStructure;
    }

    subflowResultsMap.set(subflowId, subflowResult);

    parentContext.addFlowDebugMessage('subflow', `Exiting ${subflowName} subflow`, {
      targetStage: subflowId,
    });
    this.deps.narrativeGenerator.onSubflowExit(
      subflowName,
      subflowId,
      parentTraversalContext,
      subflowResult.treeContext?.globalContext,
    );

    parentContext.commit();

    if (subflowError) {
      throw subflowError;
    }

    return subflowOutput;
  }
}
