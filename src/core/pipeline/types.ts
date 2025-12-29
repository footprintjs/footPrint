/**
 * StreamCallback
 * ------------------------------------------------------------------
 * A callback function that receives tokens as they are generated during streaming.
 * Used by streaming stages to emit tokens incrementally to clients.
 */
export type StreamCallback = (token: string) => void;

/**
 * StreamTokenHandler
 * ------------------------------------------------------------------
 * A handler function that receives tokens along with their stream identifier.
 * Used by consumers to route tokens from multiple concurrent streams.
 *
 * @param streamId - Unique identifier for the stream (typically the stage name)
 * @param token - The token string emitted by the streaming stage
 */
export type StreamTokenHandler = (streamId: string, token: string) => void;

/**
 * StreamLifecycleHandler
 * ------------------------------------------------------------------
 * A handler function for stream lifecycle events (start/end).
 * Called when a streaming stage begins or completes execution.
 *
 * @param streamId - Unique identifier for the stream
 * @param fullText - (Optional) The accumulated text, provided on stream end
 */
export type StreamLifecycleHandler = (streamId: string, fullText?: string) => void;

/**
 * StreamHandlers
 * ------------------------------------------------------------------
 * Configuration object for stream event handlers.
 * Consumers register these handlers via FlowBuilder's fluent API.
 *
 * @property onToken - Called when a streaming stage emits a token
 * @property onStart - Called when a streaming stage begins execution
 * @property onEnd - Called when a streaming stage completes, with accumulated text
 */
export interface StreamHandlers {
  onToken?: StreamTokenHandler;
  onStart?: StreamLifecycleHandler;
  onEnd?: StreamLifecycleHandler;
}

/**
 * PipelineStageFunction
 * ------------------------------------------------------------------
 * TOut   – return type produced by the stage
 * TScope – the *scope* object passed to the stage
 *
 * The optional third parameter `streamCallback` is automatically injected
 * by TreePipeline for stages marked as streaming. Existing stages with
 * the 2-parameter signature `(scope, breakFn)` remain fully compatible.
 */
export type PipelineStageFunction<TOut, TScope> = (
  scope: TScope,
  breakPipeline: () => void,
  streamCallback?: StreamCallback,
) => Promise<TOut> | TOut;

export type NodeResultType = {
  id: string;
  result: unknown;
  isError?: boolean;
};

export type PipelineResponse = {
  result: string | Error;
  isError: boolean;
};

export type PipelineResponses = { [pipelineId: string]: PipelineResponse };

export type TreeOfFunctionsResponse = PipelineResponses | string | Error;

/**
 * DynamicChildrenResult
 * ------------------------------------------------------------------
 * Result type for dynamic stage handlers.
 * When a stage is marked with `isDynamic: true`, it may return this structure
 * to provide children that should be executed after the stage completes,
 * and/or specify a dynamic next node for looping.
 *
 * @property output - The stage's normal output value
 * @property dynamicChildren - Children to execute (single node or array)
 * @property dynamicNext - Next node to execute (enables loops by pointing to existing node ID)
 *
 * @example
 * ```typescript
 * // Dynamic children:
 * return {
 *   output: { status: 'success' },
 *   dynamicChildren: [childNode1, childNode2],
 * };
 *
 * // Loop back to existing node:
 * return {
 *   output: { formattedResults },
 *   dynamicNext: 'askLLM',  // Loop back to LLM stage
 * };
 * ```
 */
export type DynamicChildrenResult<TOut = any, TScope = any> = {
  /** 
   * When true, indicates this result contains dynamic children or dynamicNext.
   * TreePipeline checks this flag to determine if the return object should be
   * treated as a dynamic result vs a regular stage output.
   */
  isDynamic?: boolean;
  /** The stage's normal output value */
  output?: TOut;
  /** Dynamic children to execute after this stage */
  dynamicChildren?: import('./TreePipeline').StageNode<TOut, TScope> | import('./TreePipeline').StageNode<TOut, TScope>[];
  /** Dynamic next node - enables loops by pointing to existing node ID or providing a node */
  dynamicNext?: string | import('./TreePipeline').StageNode<TOut, TScope>;
};
