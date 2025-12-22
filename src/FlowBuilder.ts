import { StageContext } from './core/context/StageContext';
import { ContextTreeType } from './core/context/TreePipelineContext';
import { ScopeFactory } from './core/context/types';
import { logger } from './core/logger';
import {
  PipelineStageFunction,
  StageNode,
  StreamHandlers,
  StreamLifecycleHandler,
  StreamTokenHandler,
  TreeOfFunctionsResponse,
  TreePipeline,
} from './core/pipeline';

type ScopeConstructor<TScope> = new (context: StageContext, stageName: string, readOnlyContext?: unknown) => TScope;

export type AppResponse = {
  response: TreeOfFunctionsResponse;
  treeContext: ContextTreeType;
  isError?: boolean;
};

// Todo:
// 1. addWorkflow
// 2. addStageHandlers
// 3. addStageScopes(ScopeClass, initialValues, readOnlyValues)
// 4. Execute
// 5. addLogger (to inject loggig system)
export class FlowBuilder<TOut, TScope> {
  private _treePipeline?: TreePipeline<TOut, TScope>;
  private _readOnlyContext?: Partial<TScope>;
  private _throttlingErrorChecker?: (error: unknown) => boolean;
  private _scopeFactory?: ScopeFactory<TScope>;
  private _stageHandlerMap?: Map<string, PipelineStageFunction<TOut, TScope>>;
  private _workFlow?: StageNode;
  private _initialContext?: Partial<TScope>;

  /**
   * Stream handlers for streaming stages.
   * Contains callbacks for token emission and lifecycle events (start/end).
   */
  private _streamHandlers: StreamHandlers = {};

  // todo: merge with Initial Context
  private defaultValuesForContext = {
    showDisclaimer: true,
  };

  addReadOnlyContext(readOnlyValues: Partial<TScope>) {
    this._readOnlyContext = readOnlyValues;
    return this;
  }

  addThrottlingErrorChecker(checker: (error: unknown) => boolean) {
    this._throttlingErrorChecker = checker;
    return this;
  }

  /**
   * Adds a streaming function to the pipeline.
   * Creates a stage node with `isStreaming: true` and the specified streamId.
   *
   * @param name - The name of the stage
   * @param streamId - Optional unique identifier for the stream. Defaults to the stage name if not provided.
   * @param fn - Optional stage function. If not provided, must be registered in stageHandlerMap.
   * @returns this for fluent chaining
   *
   * _Requirements: 1.1, 1.2_
   */
  addStreamingFunction(name: string, streamId?: string, fn?: PipelineStageFunction<TOut, TScope>): this {
    // Create a streaming stage node
    const streamingNode: StageNode<TOut, TScope> = {
      name,
      isStreaming: true,
      streamId: streamId ?? name, // Default streamId to stage name if not provided
      fn,
    };

    // If no workflow exists, this becomes the root
    if (!this._workFlow) {
      this._workFlow = streamingNode;
    } else {
      // Append to the end of the linear chain
      let current = this._workFlow;
      while (current.next) {
        current = current.next;
      }
      current.next = streamingNode;
    }

    return this;
  }

  /**
   * Registers a handler for stream token events.
   * Called when a streaming stage emits a token.
   *
   * @param handler - Callback function receiving (streamId, token)
   * @returns this for fluent chaining
   *
   * _Requirements: 1.3_
   */
  onStream(handler: StreamTokenHandler): this {
    this._streamHandlers.onToken = handler;
    return this;
  }

  /**
   * Registers a handler for stream start events.
   * Called when a streaming stage begins execution.
   *
   * @param handler - Callback function receiving (streamId)
   * @returns this for fluent chaining
   *
   * _Requirements: 6.1_
   */
  onStreamStart(handler: StreamLifecycleHandler): this {
    this._streamHandlers.onStart = handler;
    return this;
  }

  /**
   * Registers a handler for stream end events.
   * Called when a streaming stage completes, with accumulated text.
   *
   * @param handler - Callback function receiving (streamId, fullText)
   * @returns this for fluent chaining
   *
   * _Requirements: 6.2_
   */
  onStreamEnd(handler: StreamLifecycleHandler): this {
    this._streamHandlers.onEnd = handler;
    return this;
  }

  addPipeline(
    workFlow: StageNode,
    stageHandlerMap: Map<string, PipelineStageFunction<TOut, TScope>>,
    ScopeClass: ScopeConstructor<TScope>,
    initialContext?: Partial<TScope>,
  ) {
    this._workFlow = workFlow;
    this._stageHandlerMap = stageHandlerMap;
    this._scopeFactory = (context: StageContext, stageName: string, readOnlyContext?: unknown) => {
      return new ScopeClass(context, stageName, readOnlyContext);
    };
    this._initialContext = initialContext;
    return this;
  }

  async execute() {
    if (!this._scopeFactory) {
      throw new Error('Conversation Flow Error: addPipeline must be called with ScopeClass before execute');
    }
    if (!this._stageHandlerMap) {
      throw new Error('Conversation Flow Error: addPipeline must be called with Stage and its Handlers before execute');
    }
    if (!this._workFlow) {
      throw new Error('Conversation Flow Error: addPipeline must be called with Workflow before execute');
    }
    this._treePipeline = new TreePipeline<TOut, TScope>(
      this._workFlow,
      this._stageHandlerMap,
      this._scopeFactory,
      this.defaultValuesForContext,
      this._initialContext,
      this._readOnlyContext ?? this._initialContext, // Use initialContext as readOnlyContext if not explicitly set
      this._throttlingErrorChecker,
      this._streamHandlers,
    );
    return await executeApp(this._treePipeline, this._throttlingErrorChecker);
  }
}

async function executeApp<TOut, TScope>(
  pipeline: TreePipeline<TOut, TScope>,
  isThrottlingError?: (error: unknown) => boolean,
): Promise<AppResponse> {
  let response;
  let isError = false;
  try {
    response = await pipeline.execute();
  } catch (error: unknown) {
    // We will only reach here for linear pipeline, or if a tree pipeline breaks before diverging
    logger.error('FLOW BUILDER Error', { error });
    isError = true;
    response = error as Error;
    if (isThrottlingError && isThrottlingError(error)) {
      pipeline.setRootObject(['monitor'], 'isThrottled', true);
    }
  }
  const treeContext = pipeline.getContextTree();
  const pipelines = pipeline.getInheritedPipelines();
  return {
    response,
    treeContext,
    isError,
  };
}
