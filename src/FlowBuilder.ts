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
  Pipeline,
} from './core/pipeline';

type ScopeConstructor<TScope> = new (context: StageContext, stageName: string, readOnlyContext?: unknown) => TScope;

/**
 * Serialized pipeline node for frontend visualization.
 * This is a JSON-serializable representation of the StageNode tree.
 */
export interface SerializedPipelineNode {
  id: string;
  name: string;
  /** Human-readable display name for UI (e.g., "User Prompt" instead of "useQuestion") */
  displayName?: string;
  type: 'stage' | 'decider' | 'fork' | 'streaming';
  next?: SerializedPipelineNode;
  children?: SerializedPipelineNode[];
  isStreaming?: boolean;
  streamId?: string;
  isDynamic?: boolean;
  /** Target node ID for loop-back edges */
  loopTarget?: string;
  /** True if this is a reference node (prevents infinite recursion) */
  isLoopReference?: boolean;
  /** True if this node is a child of a parallel fork */
  isParallelChild?: boolean;
  /** ID of the parent fork node (for parallel children) */
  parallelGroupId?: string;
}

export type AppResponse = {
  response: TreeOfFunctionsResponse;
  treeContext: ContextTreeType;
  isError?: boolean;
  /** The runtime pipeline root (includes dynamic children and loop targets added at runtime) */
  runtimeRoot?: StageNode;
  /** Serialized pipeline structure for frontend visualization */
  pipelineStructure?: SerializedPipelineNode;
};

// Todo:
// 1. addWorkflow
// 2. addStageHandlers
// 3. addStageScopes(ScopeClass, initialValues, readOnlyValues)
// 4. Execute
// 5. addLogger (to inject loggig system)
export class FlowBuilder<TOut, TScope> {
  private _pipeline?: Pipeline<TOut, TScope>;
  private _readOnlyContext?: Partial<TScope>;
  private _throttlingErrorChecker?: (error: unknown) => boolean;
  private _scopeFactory?: ScopeFactory<TScope>;
  private _stageHandlerMap?: Map<string, PipelineStageFunction<TOut, TScope>>;
  private _workFlow?: StageNode;
  private _originalWorkflow?: StageNode; // Store original for serialization
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
    // Deep clone the original workflow for serialization (before runtime modifications)
    this._originalWorkflow = JSON.parse(JSON.stringify(workFlow, (key, value) => {
      // Skip function properties during clone
      if (typeof value === 'function') return undefined;
      return value;
    }));
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
    this._pipeline = new Pipeline<TOut, TScope>(
      this._workFlow,
      this._stageHandlerMap,
      this._scopeFactory,
      this.defaultValuesForContext,
      this._initialContext,
      this._readOnlyContext ?? this._initialContext, // Use initialContext as readOnlyContext if not explicitly set
      this._throttlingErrorChecker,
      this._streamHandlers,
    );
    return await executeApp(this._pipeline, this._throttlingErrorChecker);
  }
}

async function executeApp<TOut, TScope>(
  pipeline: Pipeline<TOut, TScope>,
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
  const runtimeRoot = pipeline.getRuntimeRoot();
  
  // Serialize the runtime pipeline structure for frontend visualization
  // Dynamic nodes (like toolBranch with runtime children) are marked with isDynamic=true
  // so FE can get their children from treeContext instead (avoiding duplicates)
  const pipelineStructure = serializePipelineStructure(runtimeRoot);
  
  return {
    response,
    treeContext,
    isError,
    runtimeRoot,
    pipelineStructure,
  };
}

/**
 * Checks if a node is a reference (used for loop-back) rather than a real node.
 * A reference node has id/name but no fn and no children/next of its own.
 */
function isReferenceNode(node: StageNode): boolean {
  return (
    !node.fn &&
    !node.children?.length &&
    !node.next &&
    !node.nextNodeDecider &&
    !node.nextNodeSelector
  );
}

/**
 * Serializes a StageNode tree to a JSON-serializable format for frontend visualization.
 * This provides the source of truth for the pipeline structure including runtime modifications.
 * 
 * @param node - The root StageNode to serialize
 * @param visited - Set of visited node IDs to prevent circular references
 * @param parentForkId - ID of the parent fork node (for parallel children)
 * @returns SerializedPipelineNode representing the pipeline structure
 */
export function serializePipelineStructure(
  node: StageNode,
  visited: Set<string> = new Set(),
  parentForkId?: string
): SerializedPipelineNode {
  const nodeId = node.id || node.name;
  
  // Prevent infinite loops from circular references (loops)
  if (visited.has(nodeId)) {
    return {
      id: `${nodeId}_ref`,
      name: node.name,
      type: 'stage',
      isLoopReference: true,
    };
  }
  visited.add(nodeId);
  
  // Check if this node has dynamically-added children (e.g., toolBranch)
  // Dynamic nodes are those that return StageNode with children at runtime
  // We detect this by checking if children exist but the node has no static nextNodeDecider/nextNodeSelector
  // AND the node has a stage function (fn) that could have added children dynamically
  // Static fork children (from addListOfFunction) don't have fn on the parent node
  const hasDynamicChildren = Boolean(
    node.children?.length && 
    !node.nextNodeDecider && 
    !node.nextNodeSelector &&
    node.fn // Only consider dynamic if the node has a function that could add children
  );
  
  // Determine node type
  let type: SerializedPipelineNode['type'] = 'stage';
  if (node.nextNodeDecider || node.nextNodeSelector) {
    type = 'decider';
  } else if (node.children && node.children.length > 0 && !hasDynamicChildren) {
    // Only mark as fork if children are static (not dynamic tools)
    type = 'fork';
  } else if (node.isStreaming) {
    type = 'streaming';
  }
  
  const serialized: SerializedPipelineNode = {
    id: nodeId,
    name: node.name,
    type,
  };
  
  // Add display name if provided
  if (node.displayName) {
    serialized.displayName = node.displayName;
  }
  
  // Add parallel child metadata if this node is a child of a fork
  if (parentForkId) {
    serialized.isParallelChild = true;
    serialized.parallelGroupId = parentForkId;
  }
  
  // Mark dynamic nodes - FE will get their children from runtime context instead
  if (hasDynamicChildren) {
    serialized.isDynamic = true;
  }
  
  // Add streaming properties
  if (node.isStreaming) {
    serialized.isStreaming = true;
    if (node.streamId) {
      serialized.streamId = node.streamId;
    }
  }
  
  // Serialize next node (linear continuation)
  if (node.next) {
    const nextId = node.next.id || node.next.name;
    
    // Check if next is a reference node (loop-back) or already visited
    if (visited.has(nextId) || isReferenceNode(node.next)) {
      // This is a loop-back reference
      serialized.loopTarget = nextId;
    } else {
      // next nodes are not parallel children, so don't pass parentForkId
      serialized.next = serializePipelineStructure(node.next, visited);
    }
  }
  
  // Serialize children (parallel branches or decider options)
  // Skip children for dynamic nodes - FE gets those from runtime context
  if (node.children && node.children.length > 0 && !hasDynamicChildren) {
    // Determine if this is a fork (parallel children without decider/selector)
    const isFork = !node.nextNodeDecider && !node.nextNodeSelector;
    const forkId = isFork ? nodeId : undefined;
    
    serialized.children = node.children.map((child) => 
      serializePipelineStructure(child, new Set(visited), forkId)
    );
  }
  
  return serialized;
}
