/**
 * ExtractorRunner - Coordinates traversal extractor invocations
 *
 * WHY: The extractor is called after each stage completes to extract
 * per-stage data for consumers (debug UIs, API responses, etc.). This
 * module encapsulates the step counting, snapshot enrichment, error
 * handling, and result collection that was previously inline in Pipeline.
 *
 * RELATED:
 * - {@link Pipeline} - Delegates extractor calls here
 * - {@link RuntimeStructureManager} - Provides computeNodeType for metadata
 */

import type { StageContext } from '../../memory/StageContext';
import type { PipelineRuntime } from '../../memory/PipelineRuntime';
import type {
  TraversalExtractor,
  ExtractorError,
  StageSnapshot,
  RuntimeStructureMetadata,
} from '../types';
import type { StageNode } from '../Pipeline';
import { computeNodeType } from './RuntimeStructureManager';
import { logger } from '../../../utils/logger';

export class ExtractorRunner<TOut = any, TScope = any> {
  private readonly extractor?: TraversalExtractor;
  private readonly enrichSnapshots: boolean;
  private readonly pipelineRuntime: PipelineRuntime;

  private extractedResults: Map<string, unknown> = new Map();
  private extractorErrors: ExtractorError[] = [];
  private stepCounter: number = 0;

  /**
   * Current subflow context for metadata propagation.
   * Set/cleared by Pipeline during subflow execution.
   */
  currentSubflowId?: string;

  /**
   * Current fork context for metadata propagation.
   * Set/cleared by Pipeline during parallel children execution.
   */
  currentForkId?: string;

  constructor(
    extractor: TraversalExtractor | undefined,
    enrichSnapshots: boolean,
    pipelineRuntime: PipelineRuntime,
  ) {
    this.extractor = extractor;
    this.enrichSnapshots = enrichSnapshots;
    this.pipelineRuntime = pipelineRuntime;
  }

  /**
   * Call the extractor for a stage and store the result.
   *
   * Increments stepCounter before creating snapshot (1-based).
   * Enriches snapshot with scope state, debug info, stage output,
   * and history index when enrichSnapshots is enabled.
   */
  callExtractor(
    node: StageNode,
    context: StageContext,
    stagePath: string,
    stageOutput?: unknown,
    errorInfo?: { type: string; message: string },
  ): void {
    if (!this.extractor) return;

    this.stepCounter++;

    try {
      const snapshot: StageSnapshot = {
        node,
        context,
        stepNumber: this.stepCounter,
        structureMetadata: this.buildStructureMetadata(node),
      };

      if (this.enrichSnapshots) {
        try {
          snapshot.scopeState = { ...this.pipelineRuntime.globalStore.getState() };

          snapshot.debugInfo = {
            logs: { ...context.debug.logContext },
            errors: { ...context.debug.errorContext },
            metrics: { ...context.debug.metricContext },
            evals: { ...context.debug.evalContext },
          };
          if (context.debug.flowMessages.length > 0) {
            snapshot.debugInfo.flowMessages = [...context.debug.flowMessages];
          }

          snapshot.stageOutput = stageOutput;

          if (errorInfo) {
            snapshot.errorInfo = errorInfo;
          }

          snapshot.historyIndex = this.pipelineRuntime.executionHistory.list().length;
        } catch (enrichError: any) {
          logger.warn(`Enrichment error at stage '${stagePath}':`, { error: enrichError });
        }
      }

      const result = this.extractor(snapshot);

      if (result !== undefined && result !== null) {
        this.extractedResults.set(stagePath, result);
      }
    } catch (error: any) {
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
  getStagePath(node: StageNode, branchPath?: string, contextStageName?: string): string {
    const baseName = node.id ?? node.name;
    const nodeId = (contextStageName && contextStageName !== node.name) ? contextStageName : baseName;
    if (!branchPath) return nodeId;
    return `${branchPath}.${nodeId}`;
  }

  /**
   * Build the RuntimeStructureMetadata for a node.
   * Includes subflow/fork context from Pipeline's current traversal state.
   */
  private buildStructureMetadata(node: StageNode): RuntimeStructureMetadata {
    const metadata: RuntimeStructureMetadata = {
      type: computeNodeType(node),
    };

    if (node.isSubflowRoot) {
      metadata.isSubflowRoot = true;
      metadata.subflowId = node.subflowId;
      metadata.subflowName = node.subflowName;
    } else if (this.currentSubflowId) {
      metadata.subflowId = this.currentSubflowId;
    }

    if (this.currentForkId) {
      metadata.isParallelChild = true;
      metadata.parallelGroupId = this.currentForkId;
    }

    if (node.isStreaming) {
      metadata.streamId = node.streamId;
    }

    const hasDynamicChildren = Boolean(
      node.children?.length &&
      !node.nextNodeDecider &&
      !node.nextNodeSelector &&
      node.fn
    );
    if (hasDynamicChildren) {
      metadata.isDynamic = true;
    }

    return metadata;
  }

  /** Returns extracted results collected during execution. */
  getExtractedResults<TResult = unknown>(): Map<string, TResult> {
    return this.extractedResults as Map<string, TResult>;
  }

  /** Returns errors encountered during extraction. */
  getExtractorErrors(): ExtractorError[] {
    return this.extractorErrors;
  }
}
