/**
 * SubflowExecutor — Isolated recursive execution with I/O mapping.
 *
 * Responsibilities:
 * - Execute subflows with isolated ExecutionRuntime contexts
 * - Apply input/output mapping via SubflowInputMapper
 * - Handle nested subflow detection and delegation
 * - Track subflow results for debugging/visualization
 *
 * Each subflow gets its own GlobalStore for isolation.
 * The subflow's `next` chain after children is NOT executed inside —
 * the parent's executeNode continues with node.next after return.
 */

import type { StageContext } from '../../memory/StageContext';
import type { Selector, StageNode } from '../graph/StageNode';
import { isStageNodeReturn } from '../graph/StageNode';
import type { HandlerDeps, IExecutionRuntime, NodeResultType, StageFunction, SubflowResult } from '../types';
import type { NodeResolver } from './NodeResolver';
import { StageRunner } from './StageRunner';
import {
  applyOutputMapping,
  createSubflowHandlerDeps,
  getInitialScopeValues,
  seedSubflowGlobalStore,
} from './SubflowInputMapper';

/** Callback for running a stage function. Avoids circular dep with traverser. */
export type ExecuteStageFn<TOut = any, TScope = any> = (
  node: StageNode<TOut, TScope>,
  stageFunc: StageFunction<TOut, TScope>,
  context: StageContext,
  breakFn: () => void,
) => Promise<TOut>;

/** Callback for calling the traversal extractor. */
export type CallExtractorFn<TOut = any, TScope = any> = (
  node: StageNode<TOut, TScope>,
  context: StageContext,
  stagePath: string,
  stageOutput?: unknown,
  errorInfo?: { type: string; message: string },
) => void;

/** Callback for getting a stage function from the stage map. */
export type GetStageFnFn<TOut = any, TScope = any> = (
  node: StageNode<TOut, TScope>,
) => StageFunction<TOut, TScope> | undefined;

export class SubflowExecutor<TOut = any, TScope = any> {
  private currentSubflowDeps?: HandlerDeps<TOut, TScope>;
  private currentSubflowRoot?: StageNode<TOut, TScope>;
  private subflowResultsMap?: Map<string, SubflowResult>;

  constructor(
    private deps: HandlerDeps<TOut, TScope>,
    private nodeResolver: NodeResolver<TOut, TScope>,
    private executeStage: ExecuteStageFn<TOut, TScope>,
    private callExtractor: CallExtractorFn<TOut, TScope>,
    private getStageFn: GetStageFnFn<TOut, TScope>,
  ) {}

  /**
   * Execute a subflow with isolated context.
   *
   * 1. Creates a fresh ExecutionRuntime for the subflow
   * 2. Applies input mapping to seed the subflow's GlobalStore
   * 3. Executes the subflow's internal structure
   * 4. Applies output mapping to write results back to parent scope
   * 5. Stores execution data for debugging/visualization
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

    parentContext.addFlowDebugMessage('subflow', `Entering ${subflowName} subflow`, {
      targetStage: subflowId,
    });
    this.deps.narrativeGenerator.onSubflowEntry(subflowName, subflowId, node.description);

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

    // Create isolated runtime via dynamic construction (avoids circular import)
    const ExecutionRuntimeClass = this.deps.executionRuntime.constructor as new (name: string) => IExecutionRuntime;
    const nestedRuntime = new ExecutionRuntimeClass(node.name);
    let nestedRootContext = nestedRuntime.rootStageContext;

    // Seed GlobalStore with input
    if (Object.keys(mappedInput).length > 0) {
      seedSubflowGlobalStore(nestedRuntime, mappedInput);
      // Refresh rootStageContext so WriteBuffer sees committed data
      const StageContextClass = nestedRootContext.constructor as new (...args: any[]) => StageContext;
      nestedRootContext = new StageContextClass(
        '',
        nestedRootContext.stageName,
        nestedRuntime.globalStore,
        '',
        nestedRuntime.executionHistory,
      );
      nestedRuntime.rootStageContext = nestedRootContext;
    }

    // Create subflow HandlerDeps
    const subflowDeps = createSubflowHandlerDeps(this.deps, nestedRuntime, mappedInput);

    const subflowBreakFlag = { shouldBreak: false };

    const hasChildren = Boolean(node.children && node.children.length > 0);
    const subflowNode: StageNode<TOut, TScope> = {
      ...node,
      isSubflowRoot: false,
      next: hasChildren ? undefined : node.next,
    };

    let subflowOutput: any;
    let subflowError: Error | undefined;

    try {
      this.subflowResultsMap = subflowResultsMap;
      this.currentSubflowRoot = subflowNode;
      this.currentSubflowDeps = subflowDeps;

      subflowOutput = await this.executeSubflowInternal(subflowNode, nestedRootContext, subflowBreakFlag, subflowId);
    } catch (error: any) {
      subflowError = error;
      parentContext.addError('subflowError', error.toString());
      this.deps.logger.error(`Error in subflow (${subflowId}):`, { error });
    } finally {
      this.currentSubflowRoot = undefined;
      this.currentSubflowDeps = undefined;
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
        const mappedOutput = applyOutputMapping(subflowOutput, parentScope, outputContext, mountOptions);

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
    this.deps.narrativeGenerator.onSubflowExit(subflowName, subflowId);

    parentContext.commit();

    if (subflowError) {
      throw subflowError;
    }

    return subflowOutput;
  }

  /**
   * Internal execution within subflow context.
   * Mirrors the traverser's executeNode but within the subflow's isolated runtime.
   */
  private async executeSubflowInternal(
    node: StageNode<TOut, TScope>,
    context: StageContext,
    breakFlag: { shouldBreak: boolean },
    branchPath: string,
  ): Promise<any> {
    // Detect nested subflows
    if (node.isSubflowRoot && node.subflowId) {
      const resolvedNode = this.nodeResolver.resolveSubflowReference(node);
      return await this.executeSubflow(resolvedNode, context, breakFlag, branchPath, this.subflowResultsMap!);
    }

    const stageFunc = this.getStageFn(node);
    const breakFn = () => (breakFlag.shouldBreak = true);

    let stageOutput: TOut | undefined;
    if (stageFunc) {
      try {
        if (this.currentSubflowDeps) {
          const subflowStageRunner = new StageRunner<TOut, TScope>(this.currentSubflowDeps);
          stageOutput = await subflowStageRunner.run(node, stageFunc, context, breakFn);
        } else {
          stageOutput = await this.executeStage(node, stageFunc, context, breakFn);
        }
      } catch (error: any) {
        context.commit();
        this.callExtractor(node, context, this.getStagePath(node, branchPath, context.stageName), undefined, {
          type: 'stageExecutionError',
          message: error.toString(),
        });
        context.addError('stageExecutionError', error.toString());
        this.deps.narrativeGenerator.onError(node.name, error.toString(), error);
        throw error;
      }
      context.commit();
      this.callExtractor(node, context, this.getStagePath(node, branchPath, context.stageName), stageOutput);
      this.deps.narrativeGenerator.onStageExecuted(node.name, node.description);

      if (breakFlag.shouldBreak) {
        this.deps.narrativeGenerator.onBreak(node.name);
        return stageOutput;
      }

      // Handle dynamic StageNode return
      if (stageOutput && typeof stageOutput === 'object' && isStageNodeReturn(stageOutput)) {
        const dynamicNode = stageOutput as StageNode<TOut, TScope>;
        context.addLog('isDynamic', true);
        context.addLog('dynamicPattern', 'StageNodeReturn');

        if (dynamicNode.children && dynamicNode.children.length > 0) {
          node.children = dynamicNode.children;
          context.addLog('dynamicChildCount', dynamicNode.children.length);
          context.addLog(
            'dynamicChildIds',
            dynamicNode.children.map((c) => c.id),
          );

          if (typeof dynamicNode.nextNodeSelector === 'function') {
            node.nextNodeSelector = dynamicNode.nextNodeSelector;
            context.addLog('hasSelector', true);
          }
        }

        if (dynamicNode.next) {
          node.next = dynamicNode.next;
          context.addLog('hasDynamicNext', true);
          const loopTargetId = dynamicNode.next.id;
          if (loopTargetId) {
            context.addLog('loopTarget', loopTargetId);
          }
        }

        stageOutput = undefined;
      }
    }

    // ─── Children dispatch ───
    const hasChildrenAfterStage = Boolean(node.children?.length);
    const hasNextAfterStage = Boolean(node.next);

    if (hasChildrenAfterStage) {
      if (node.nextNodeSelector) {
        const results = await this.executeSelectedChildrenInternal(
          node.nextNodeSelector,
          node.children!,
          stageOutput,
          context,
          branchPath,
          breakFlag,
        );
        if (!hasNextAfterStage) return results;
      } else {
        const results = await this.executeNodeChildrenInternal(node, context, branchPath, breakFlag);
        if (!hasNextAfterStage) return results;
      }
    }

    // ─── Linear next ───
    if (hasNextAfterStage) {
      let nextNode = node.next!;

      // Resolve reference nodes (has id but no fn)
      if (nextNode.id && !nextNode.fn) {
        let resolvedNode: StageNode<TOut, TScope> | undefined;
        if (this.currentSubflowRoot) {
          resolvedNode = this.nodeResolver.findNodeById(nextNode.id, this.currentSubflowRoot);
          if (resolvedNode) context.addLog('dynamicNextResolvedFrom', 'subflow');
        }
        if (!resolvedNode) {
          resolvedNode = this.nodeResolver.findNodeById(nextNode.id);
          if (resolvedNode) context.addLog('dynamicNextResolvedFrom', 'mainPipeline');
        }
        if (resolvedNode) {
          nextNode = resolvedNode;
          context.addLog('dynamicNextResolved', true);
          context.addLog('dynamicNextTarget', nextNode.id);
        } else {
          this.deps.logger.info(`Dynamic next node '${nextNode.id}' not found in subflow or main pipeline`);
          context.addLog('dynamicNextResolved', false);
          context.addLog('dynamicNextNotFound', nextNode.id);
        }
      }

      this.deps.narrativeGenerator.onNext(node.name, nextNode.name, nextNode.description);
      const nextCtx = context.createNext('', nextNode.name);
      return await this.executeSubflowInternal(nextNode, nextCtx, breakFlag, branchPath);
    }

    return stageOutput;
  }

  private getStagePath(node: StageNode<TOut, TScope>, branchPath?: string, contextStageName?: string): string {
    const baseName = node.id;
    const nodeId = contextStageName && contextStageName !== node.name ? contextStageName : baseName;
    if (!branchPath) return nodeId;
    return `${branchPath}.${nodeId}`;
  }

  private async executeNodeChildrenInternal(
    node: StageNode<TOut, TScope>,
    context: StageContext,
    branchPath: string,
    breakFlag: { shouldBreak: boolean },
  ): Promise<Record<string, NodeResultType>> {
    const childPromises: Promise<NodeResultType>[] = (node.children ?? []).map((child) => {
      const childContext = context.createChild('', child.id as string, child.name);
      const childBreakFlag = { shouldBreak: false };

      return this.executeSubflowInternal(child, childContext, childBreakFlag, branchPath)
        .then((result) => {
          childContext.commit();
          return { id: child.id!, result, isError: false };
        })
        .catch((error) => {
          childContext.commit();
          this.deps.logger.info(`TREE PIPELINE: executeNodeChildrenInternal - Error for id: ${child?.id}`, { error });
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
        this.deps.logger.error(`Execution failed: ${s.reason}`);
      }
    });
    return childrenResults;
  }

  private async executeSelectedChildrenInternal(
    selector: Selector,
    children: StageNode<TOut, TScope>[],
    input: any,
    context: StageContext,
    branchPath: string,
    breakFlag: { shouldBreak: boolean },
  ): Promise<Record<string, NodeResultType>> {
    const selectorResult = await selector(input);
    const selectedIds = Array.isArray(selectorResult) ? selectorResult : [selectorResult];

    context.addLog('selectedChildIds', selectedIds);
    context.addLog('selectorPattern', 'multi-choice');

    if (selectedIds.length === 0) {
      context.addLog('skippedAllChildren', true);
      return {};
    }

    const selectedChildren = children.filter((c) => selectedIds.includes(c.id!));
    if (selectedChildren.length !== selectedIds.length) {
      const childIds = children.map((c) => c.id);
      const missing = selectedIds.filter((id) => !childIds.includes(id));
      const errorMessage = `Selector returned unknown child IDs: ${missing.join(', ')}. Available: ${childIds.join(
        ', ',
      )}`;
      this.deps.logger.error(`Error in subflow (${branchPath}):`, { error: errorMessage });
      context.addError('selectorError', errorMessage);
      throw new Error(errorMessage);
    }

    const skippedIds = children.filter((c) => !selectedIds.includes(c.id!)).map((c) => c.id);
    if (skippedIds.length > 0) {
      context.addLog('skippedChildIds', skippedIds);
    }

    const tempNode: StageNode<TOut, TScope> = {
      name: 'selector-temp',
      id: 'selector-temp',
      children: selectedChildren,
    };
    return await this.executeNodeChildrenInternal(tempNode, context, branchPath, breakFlag);
  }
}
