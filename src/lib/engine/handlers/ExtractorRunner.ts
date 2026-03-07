/**
 * ExtractorRunner — Per-stage snapshot extraction.
 *
 * Coordinates traversal extractor invocations: step counting,
 * snapshot enrichment, error collection, and result storage.
 */

import type { StageContext } from '../../memory/StageContext';
import type { StageNode } from '../graph/StageNode';
import type {
  ExtractorError,
  IExecutionRuntime,
  ILogger,
  RuntimeStructureMetadata,
  StageSnapshot,
  TraversalExtractor,
} from '../types';
import { computeNodeType } from './RuntimeStructureManager';

export class ExtractorRunner<TOut = any, TScope = any> {
  private readonly extractor?: TraversalExtractor;
  private readonly enrichSnapshots: boolean;
  private readonly executionRuntime: IExecutionRuntime;
  private readonly logger: ILogger;

  private extractedResults: Map<string, unknown> = new Map();
  private extractorErrors: ExtractorError[] = [];
  private stepCounter = 0;

  /** Current subflow context for metadata propagation. Set/cleared during subflow execution. */
  currentSubflowId?: string;

  /** Current fork context for metadata propagation. Set/cleared during parallel children execution. */
  currentForkId?: string;

  constructor(
    extractor: TraversalExtractor | undefined,
    enrichSnapshots: boolean,
    executionRuntime: IExecutionRuntime,
    logger: ILogger,
  ) {
    this.extractor = extractor;
    this.enrichSnapshots = enrichSnapshots;
    this.executionRuntime = executionRuntime;
    this.logger = logger;
  }

  /**
   * Call the extractor for a stage and store the result.
   * Increments stepCounter (1-based) before creating snapshot.
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
          snapshot.scopeState = { ...this.executionRuntime.globalStore.getState() };

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

          snapshot.historyIndex = this.executionRuntime.executionHistory.list().length;
        } catch (enrichError: any) {
          this.logger.warn(`Enrichment error at stage '${stagePath}':`, { error: enrichError });
        }
      }

      const result = this.extractor(snapshot);

      if (result !== undefined && result !== null) {
        this.extractedResults.set(stagePath, result);
      }
    } catch (error: any) {
      this.logger.error(`Extractor error at stage '${stagePath}':`, { error });
      this.extractorErrors.push({
        stagePath,
        message: error?.message ?? String(error),
        error,
      });
    }
  }

  /**
   * Generate the stage path for extractor results.
   * Uses node.id (preferred) or node.name, combined with branchPath.
   */
  getStagePath(node: StageNode, branchPath?: string, contextStageName?: string): string {
    const baseName = node.id ?? node.name;
    const nodeId = contextStageName && contextStageName !== node.name ? contextStageName : baseName;
    if (!branchPath) return nodeId;
    return `${branchPath}.${nodeId}`;
  }

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

    const hasDynamicChildren = Boolean(node.children?.length && !node.nextNodeSelector && node.fn);
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
