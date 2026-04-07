/**
 * ExtractorRunner — Per-stage snapshot extraction.
 *
 * Coordinates traversal extractor invocations: step counting,
 * snapshot enrichment, error collection, and result storage.
 */
import type { StageContext } from '../../memory/StageContext.js';
import type { StageNode } from '../graph/StageNode.js';
import type { ExtractorError, IExecutionRuntime, ILogger, TraversalExtractor } from '../types.js';
export declare class ExtractorRunner<TOut = any, TScope = any> {
    private readonly extractor?;
    private readonly enrichSnapshots;
    private readonly executionRuntime;
    private readonly logger;
    private extractedResults;
    private extractorErrors;
    private stepCounter;
    /** Current subflow context for metadata propagation. Set/cleared during subflow execution. */
    currentSubflowId?: string;
    /** Current fork context for metadata propagation. Set/cleared during parallel children execution. */
    currentForkId?: string;
    constructor(extractor: TraversalExtractor | undefined, enrichSnapshots: boolean, executionRuntime: IExecutionRuntime, logger: ILogger);
    /**
     * Call the extractor for a stage and store the result.
     * Increments stepCounter (1-based) before creating snapshot.
     */
    callExtractor(node: StageNode, context: StageContext, stagePath: string, stageOutput?: unknown, errorInfo?: {
        type: string;
        message: string;
    }): void;
    /**
     * Generate the stage path for extractor results.
     * Uses node.id combined with branchPath.
     */
    getStagePath(node: StageNode, branchPath?: string, contextStageName?: string): string;
    private buildStructureMetadata;
    /** Returns extracted results collected during execution. */
    getExtractedResults<TResult = unknown>(): Map<string, TResult>;
    /** Returns errors encountered during extraction. */
    getExtractorErrors(): ExtractorError[];
}
