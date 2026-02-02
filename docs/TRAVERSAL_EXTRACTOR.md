# Extractor API

The Extractor API provides two pluggable mechanisms for extracting data from your flowcharts:

1. **Runtime Extractor** (`addTraversalExtractor`) - Called during pipeline execution after each stage completes
2. **Build-Time Extractor** (`addBuildTimeExtractor`) - Called during `toSpec()` to customize the serialized structure

Both extractors enable applications to transform data into whatever format their frontend or consumers need, without polluting the library with domain-specific concepts.

## Overview

### Runtime Extractor (Traversal)

When building pipelines with `FlowChartBuilder`, you can register a traversal extractor function that will be called after each stage completes. The extractor receives a `StageSnapshot` containing:
- The node being executed
- The execution context (with scope and debug info)
- A step number for time traveler synchronization
- Pre-computed structure metadata (type, subflowId, etc.)

```typescript
import { FlowChartBuilder, TraversalExtractor, StageSnapshot } from 'tree-of-functions';

const myExtractor: TraversalExtractor<MyData> = (snapshot: StageSnapshot) => {
  const { node, context, stepNumber, structureMetadata } = snapshot;
  const scope = context.getScope();
  const debugInfo = context.getDebugInfo();
  
  return {
    stageName: node.name,
    stepNumber, // 1-based execution order for time traveler sync
    type: structureMetadata.type, // Pre-computed: 'stage' | 'decider' | 'fork' | 'streaming'
    subflowId: structureMetadata.subflowId, // Correctly propagated within subflows
    llmResponse: scope?.llmResponse,
    toolCalls: debugInfo?.toolCalls,
  };
};

const builder = new FlowChartBuilder()
  .start('entry', entryFn)
  .addFunction('askLLM', askLLMFn)
  .addTraversalExtractor(myExtractor)
  .build();
```

### Build-Time Extractor

Register a build-time extractor to customize how `toSpec()` serializes the flowchart structure:

```typescript
import { FlowChartBuilder, BuildTimeExtractor, BuildTimeNodeMetadata } from 'tree-of-functions';

// Service layer extractor that adds 'type' field for UI
const myExtractor: BuildTimeExtractor<MyNodeFormat> = (metadata: BuildTimeNodeMetadata) => {
  // Compute node type from metadata
  let type: 'stage' | 'decider' | 'fork' | 'streaming' = 'stage';
  if (metadata.hasDecider || metadata.hasSelector) type = 'decider';
  else if (metadata.children && metadata.children.length > 0) type = 'fork';
  else if (metadata.isStreaming) type = 'streaming';
  
  return {
    id: metadata.id ?? metadata.name,
    name: metadata.name,
    type,
    next: metadata.next,
    children: metadata.children,
  };
};

const builder = new FlowChartBuilder()
  .start('entry', entryFn)
  .addFunction('askLLM', askLLMFn)
  .addBuildTimeExtractor(myExtractor);

// toSpec() now returns the transformed format
const spec = builder.toSpec<MyNodeFormat>();
```

## API Reference

### Runtime Extractor Types

#### `RuntimeStructureMetadata`

Pre-computed structure metadata provided to the traversal extractor. The library computes these values during traversal so consumers don't need to post-process `getRuntimeRoot()` with their own serialization logic.

```typescript
interface RuntimeStructureMetadata {
  /** Computed node type based on node properties */
  type: 'stage' | 'decider' | 'fork' | 'streaming';
  
  /** Subflow ID - propagated from subflow root to all children within the subflow */
  subflowId?: string;
  
  /** True if this node is the root of a subflow */
  isSubflowRoot?: boolean;
  
  /** Display name of the subflow (for subflow roots) */
  subflowName?: string;
  
  /** True if this node is a parallel child of a fork */
  isParallelChild?: boolean;
  
  /** Parent fork's ID (for parallel children) */
  parallelGroupId?: string;
  
  /** Target stage ID if this node loops back to a previous stage */
  loopTarget?: string;
  
  /** True if this node has dynamically-added children (e.g., toolBranch) */
  isDynamic?: boolean;
  
  /** True if this is a loop-back reference node */
  isLoopReference?: boolean;
  
  /** Streaming stage identifier */
  streamId?: string;
}
```

#### `StageSnapshot<TOut, TScope>`

Data passed to the traversal extractor for each stage.

```typescript
interface StageSnapshot<TOut = any, TScope = any> {
  /** The node being executed */
  node: StageNode<TOut, TScope>;
  /** The stage's execution context */
  context: StageContext;
  /** 1-based step number in execution order (for time traveler sync) */
  stepNumber: number;
  /** Pre-computed structure metadata for this node */
  structureMetadata: RuntimeStructureMetadata;
}
```

#### `TraversalExtractor<TResult>`

A user-provided function that extracts data from each stage.

```typescript
type TraversalExtractor<TResult = unknown> = (
  snapshot: StageSnapshot
) => TResult | undefined | null;
```

#### `ExtractorError`

Recorded when an extractor throws an error.

```typescript
interface ExtractorError {
  /** Stage path where the error occurred */
  stagePath: string;
  /** Error message */
  message: string;
  /** Original error object */
  error: unknown;
}
```

### Build-Time Extractor Types

#### `BuildTimeNodeMetadata`

Metadata provided to the build-time extractor for each node.

```typescript
interface BuildTimeNodeMetadata {
  /** Stage name (stageMap key) */
  name: string;
  /** Optional stable ID */
  id?: string;
  /** Human-readable display name for UI */
  displayName?: string;
  /** Recursively extracted children (for fork/decider patterns) */
  children?: BuildTimeNodeMetadata[];
  /** Recursively extracted next node (for linear continuation) */
  next?: BuildTimeNodeMetadata;
  /** True if this node has a decider function */
  hasDecider?: boolean;
  /** True if this node has a selector function */
  hasSelector?: boolean;
  /** Branch IDs for decider/selector nodes */
  branchIds?: string[];
  /** Loop target stage ID */
  loopTarget?: string;
  /** True if this is a streaming stage */
  isStreaming?: boolean;
  /** Stream identifier */
  streamId?: string;
  /** True if this is a parallel child of a fork */
  isParallelChild?: boolean;
  /** Parent fork ID for parallel children */
  parallelGroupId?: string;
  /** True if this is a subflow root */
  isSubflowRoot?: boolean;
  /** Subflow mount ID */
  subflowId?: string;
  /** Subflow display name */
  subflowName?: string;
}
```

#### `BuildTimeExtractor<TResult>`

A user-provided function that transforms node metadata during `toSpec()`.

```typescript
type BuildTimeExtractor<TResult = FlowChartSpec> = (
  metadata: BuildTimeNodeMetadata
) => TResult;
```

### FlowChartBuilder Methods

#### Runtime Extractor Methods

##### `addTraversalExtractor<TResult>(extractor: TraversalExtractor<TResult>): this`

Register a traversal extractor function. Only one extractor per flow is supported - calling this multiple times replaces the previous extractor (last one wins).

#### Build-Time Extractor Methods

##### `addBuildTimeExtractor<TResult>(extractor: BuildTimeExtractor<TResult>): this`

Register a build-time extractor function. The extractor is called for each node during `toSpec()` traversal. Only one extractor per flow is supported - calling this multiple times replaces the previous extractor (last one wins).

##### `getBuildTimeExtractorErrors(): Array<{ message: string; error: unknown }>`

Returns any errors that occurred during build-time extraction. Useful for debugging.

### Pipeline Methods

#### `getExtractedResults<TResult>(): Map<string, TResult>`

Returns the collected extracted results after pipeline execution. Map keys are stage paths.

#### `getExtractorErrors(): ExtractorError[]`

Returns any errors that occurred during extraction. Useful for debugging.

## Usage Examples

### Basic Extraction

```typescript
const extractor: TraversalExtractor = (snapshot) => ({
  stageName: snapshot.node.name,
  displayName: snapshot.node.displayName,
  timestamp: Date.now(),
});

const { root, stageMap, extractor: ext } = new FlowChartBuilder()
  .start('entry', entryFn)
  .addFunction('process', processFn)
  .addTraversalExtractor(extractor)
  .build();

const pipeline = new Pipeline(root, stageMap, scopeFactory, ..., ext);
await pipeline.execute();

const results = pipeline.getExtractedResults();
// Map { "entry" => {...}, "process" => {...} }
```

### Typed Extraction

```typescript
interface LLMStageData {
  stageName: string;
  llmResponse?: string;
  tokenCount?: number;
  toolCalls?: ToolCall[];
}

const extractor: TraversalExtractor<LLMStageData> = (snapshot) => {
  const { node, context } = snapshot;
  const scope = context.getScope();
  const debugInfo = context.getDebugInfo();
  
  return {
    stageName: node.name,
    llmResponse: scope?.llmResponse,
    tokenCount: debugInfo?.tokenCount,
    toolCalls: debugInfo?.toolCalls,
  };
};

// Results are typed
const results = pipeline.getExtractedResults<LLMStageData>();
const entry = results.get('entry');
// entry is LLMStageData | undefined
```

### Selective Extraction

Return `undefined` or `null` to skip adding an entry for a stage:

```typescript
const extractor: TraversalExtractor = (snapshot) => {
  // Only extract data from LLM stages
  if (!snapshot.node.name.includes('LLM')) {
    return undefined; // Skip this stage
  }
  
  return {
    stageName: snapshot.node.name,
    response: snapshot.context.getScope()?.llmResponse,
  };
};
```

### Using with execute() Convenience Method

```typescript
const result = await new FlowChartBuilder()
  .start('entry', entryFn)
  .addFunction('process', processFn)
  .addTraversalExtractor(extractor)
  .execute(scopeFactory);
```

Note: When using `execute()`, you don't have direct access to the Pipeline instance. For full control over extracted results, use `build()` and create the Pipeline manually.

## Execution Model

The extractor is called at a specific point in the stage lifecycle:

```
Stage Execution Timeline
─────────────────────────────────────────────────────────────────────────────

  1. executeNode() called
         │
         ▼
  2. executeStage() runs the stage function
         │
         ▼
  3. commitPatch() applies scope changes
         │
         ▼
  4. ★ EXTRACTOR CALLED HERE ★
     - Stage has completed (success or error)
     - Context contains committed data
     - debugInfo contains execution metadata
         │
         ▼
  5. Continue to children/next/return
```

## Error Handling

### Extractor Errors Don't Crash the Pipeline

If your extractor throws an error, the pipeline continues execution normally:

```typescript
const extractor: TraversalExtractor = (snapshot) => {
  if (snapshot.node.name === 'problematic') {
    throw new Error('Oops!'); // Won't crash the pipeline
  }
  return { name: snapshot.node.name };
};
```

Errors are:
1. Logged to the console
2. Recorded in `getExtractorErrors()`
3. The stage is NOT added to `getExtractedResults()`

### Checking for Errors

```typescript
await pipeline.execute();

const errors = pipeline.getExtractorErrors();
if (errors.length > 0) {
  console.warn('Extractor errors:', errors);
}
```

### Stage Errors

When a stage throws an error:
1. `commitPatch()` is called (partial data committed)
2. Extractor is called (can extract error info from context)
3. Error propagates normally

This allows extractors to capture error state:

```typescript
const extractor: TraversalExtractor = (snapshot) => {
  const errorInfo = snapshot.context.getErrorInfo();
  return {
    stageName: snapshot.node.name,
    error: errorInfo?.stageExecutionError,
    hasError: !!errorInfo,
  };
};
```

## Subflow Support

The extractor automatically works with subflows. When a subflow executes, the extractor is called for each stage in the subflow with paths prefixed by the subflow ID:

```typescript
// Results after executing a flow with a subflow
const results = pipeline.getExtractedResults();
// Map {
//   "entry" => {...},
//   "llm-core.askLLM" => {...},      // Subflow stage
//   "llm-core.processResponse" => {...}, // Subflow stage
//   "aggregate" => {...},
// }
```

## Best Practices

### Keep Extractors Simple

Extractors should be fast and simple. Avoid:
- Heavy computations
- Async operations (extractors are synchronous)
- Side effects

### Extract Only What You Need

Don't extract everything - focus on what your frontend actually needs:

```typescript
// Good: Extract specific data
const extractor: TraversalExtractor = (snapshot) => ({
  name: snapshot.node.name,
  response: snapshot.context.getScope()?.llmResponse,
});

// Avoid: Extracting entire context
const badExtractor: TraversalExtractor = (snapshot) => ({
  ...snapshot.context.getScope(),
  ...snapshot.context.getDebugInfo(),
});
```

### Handle Missing Data Gracefully

Use optional chaining and defaults:

```typescript
const extractor: TraversalExtractor = (snapshot) => ({
  stageName: snapshot.node.name,
  response: snapshot.context.getScope()?.llmResponse ?? null,
  tokenCount: snapshot.context.getDebugInfo()?.tokenCount ?? 0,
});
```

### Use TypeScript for Type Safety

Define interfaces for your extracted data:

```typescript
interface MyExtractedData {
  stageName: string;
  response: string | null;
  tokenCount: number;
}

const extractor: TraversalExtractor<MyExtractedData> = (snapshot) => ({
  stageName: snapshot.node.name,
  response: snapshot.context.getScope()?.llmResponse ?? null,
  tokenCount: snapshot.context.getDebugInfo()?.tokenCount ?? 0,
});
```

## Backward Compatibility

The traversal extractor feature is fully opt-in:

- Pipelines without an extractor behave identically to before
- `getContextTree()` continues to work unchanged
- No changes to Pipeline constructor signature (extractor passed via build output)
- No effect on pipeline execution timing or order

## Step Number Tracking

The `stepNumber` field in `StageSnapshot` provides a 1-based counter that increments for each stage execution. This is useful for:

- **Time Traveler Sync**: Frontend debug UIs can use `stepNumber` to synchronize flowchart highlighting with execution history
- **Execution Order**: Track the exact order stages were executed, including loop iterations
- **Debugging**: Identify which iteration of a loop a particular execution belongs to

### Step Number Behavior

```typescript
// Step numbers increment monotonically
const extractor: TraversalExtractor = (snapshot) => ({
  stageName: snapshot.node.name,
  stepNumber: snapshot.stepNumber, // 1, 2, 3, 4, ...
});

// In a loop, each iteration gets unique step numbers:
// prepareHistory (step 1) → askLLM (step 2) → toolBranch (step 3)
// prepareHistory (step 4) → askLLM (step 5) → toolBranch (step 6)
// prepareHistory (step 7) → askLLM (step 8) → finalResponse (step 9)
```

### Using Step Numbers for Time Traveler

```typescript
interface StageMetadata {
  name: string;
  stepNumber: number;
  // ... other fields
}

const extractor: TraversalExtractor<StageMetadata> = (snapshot) => ({
  name: snapshot.node.name,
  stepNumber: snapshot.stepNumber,
  scope: snapshot.context.getScope(),
  debugInfo: snapshot.context.getDebugInfo(),
});

// Frontend can then:
// 1. Build a timeline from stepNumber ordering
// 2. Highlight the current step in the flowchart
// 3. Allow stepping forward/backward through execution
```

## Build-Time Extractor Usage

The build-time extractor transforms the flowchart structure during `toSpec()`. This is useful for:

- **Adding computed properties**: Derive `type` from node properties
- **Format transformation**: Convert to a different schema for your frontend
- **Removing unused fields**: Strip properties your consumer doesn't need

**Note**: Build-time extractors operate on the static flowchart definition. For runtime structure serialization (including dynamic children, loops, and subflows), use the Runtime Structure Metadata feature instead.

## Runtime Structure Metadata (Recommended)

The `structureMetadata` field in `StageSnapshot` provides pre-computed structure information for each node as it executes. This eliminates the need for service-layer post-processing of `getRuntimeRoot()`.

### Why Use Runtime Structure Metadata?

Previously, service layers had to:
1. Get raw `StageNode` from `getRuntimeRoot()` after execution
2. Write their own `serializePipelineStructure()` function to convert to their format
3. Handle complex logic like `subflowId` propagation and node type computation

With `structureMetadata`, the library handles all of this during traversal:
- **Node type computation**: `type` is pre-computed as 'stage', 'decider', 'fork', or 'streaming'
- **SubflowId propagation**: `subflowId` is correctly propagated to all children within a subflow
- **Parallel child tracking**: `isParallelChild` and `parallelGroupId` are set for fork children
- **Dynamic node detection**: `isDynamic` is set for nodes with dynamically-added children

### Service Layer Migration Example

Replace your `serializePipelineStructure()` function with a TraversalExtractor:

```typescript
import { TraversalExtractor, StageSnapshot, RuntimeStructureMetadata } from 'tree-of-functions';

// Your service's desired output format
interface PipelineNode {
  id: string;
  name: string;
  type: 'stage' | 'decider' | 'fork' | 'streaming';
  subflowId?: string;
  isSubflowRoot?: boolean;
  subflowName?: string;
  isParallelChild?: boolean;
  parallelGroupId?: string;
  loopTarget?: string;
  isDynamic?: boolean;
  isStreaming?: boolean;
  streamId?: string;
}

// Accumulated structure during pipeline execution
const pipelineStructure: Map<string, PipelineNode> = new Map();
const executionOrder: string[] = [];

// The extractor transforms each node as it executes
const structureExtractor: TraversalExtractor = (snapshot: StageSnapshot) => {
  const { node, stepNumber, structureMetadata } = snapshot;
  const nodeId = node.id || node.name;
  
  // Transform library's structureMetadata to service's PipelineNode format
  // No more manual type computation or subflowId propagation!
  const pipelineNode: PipelineNode = {
    id: nodeId,
    name: node.name,
    type: structureMetadata.type,
    subflowId: structureMetadata.subflowId,
    isSubflowRoot: structureMetadata.isSubflowRoot,
    subflowName: structureMetadata.subflowName,
    isParallelChild: structureMetadata.isParallelChild,
    parallelGroupId: structureMetadata.parallelGroupId,
    loopTarget: structureMetadata.loopTarget,
    isDynamic: structureMetadata.isDynamic,
    isStreaming: structureMetadata.type === 'streaming',
    streamId: structureMetadata.streamId,
  };
  
  pipelineStructure.set(nodeId, pipelineNode);
  executionOrder.push(nodeId);
  
  // Return step number for time traveler sync
  return { stepNumber };
};

// Usage
const chart = flowChart('start', startStage)
  .addFunction('process', processStage)
  .addTraversalExtractor(structureExtractor)
  .build();

// After execution, pipelineStructure contains the serialized structure
// No need for serializePipelineStructure(getRuntimeRoot())!
```

### Key Benefits

1. **Eliminates serializePipelineStructure()**: Structure is built incrementally during execution
2. **Correct subflowId propagation**: Library tracks subflow context and propagates correctly
3. **Single source of truth**: Node type computation happens in the library
4. **Incremental structure building**: Structure is available as stages execute
5. **Cleaner separation of concerns**: Library handles traversal; service handles format transformation

### SubflowId Propagation

The library correctly handles subflow boundaries:

```typescript
// When entering a subflow:
// - subflow root: isSubflowRoot=true, subflowId='smart-context-finder'
// - subflow children: subflowId='smart-context-finder' (propagated)

// When exiting a subflow (continuation):
// - continuation stages: subflowId=undefined (NOT propagated)

// This fixes the bug where service-layer serialization incorrectly
// propagated subflowId to continuation stages
```

### Build-Time Extractor Usage

The build-time extractor transforms the flowchart structure during `toSpec()`. This is useful for:

- **Adding computed properties**: Derive `type` from node properties
- **Format transformation**: Convert to a different schema for your frontend
- **Removing unused fields**: Strip properties your consumer doesn't need

### Service Layer Migration Example

If you previously had a `convertToTreeContextResponse()` function that computed node types, you can now use a build-time extractor:

```typescript
import { 
  FlowChartBuilder, 
  BuildTimeExtractor, 
  BuildTimeNodeMetadata,
  FlowChartSpec 
} from 'tree-of-functions';

// Define your service layer's node format
interface ServicePipelineNode {
  id: string;
  name: string;
  type: 'stage' | 'decider' | 'fork' | 'streaming';
  next?: ServicePipelineNode;
  children?: ServicePipelineNode[];
  isStreaming?: boolean;
  streamId?: string;
  loopTarget?: string;
  isSubflowRoot?: boolean;
  subflowId?: string;
  subflowName?: string;
}

// Create extractor that computes 'type' from metadata
const servicePipelineExtractor: BuildTimeExtractor<ServicePipelineNode> = (
  metadata: BuildTimeNodeMetadata
): ServicePipelineNode => {
  // Compute node type from properties
  let type: 'stage' | 'decider' | 'fork' | 'streaming' = 'stage';
  if (metadata.hasDecider || metadata.hasSelector) {
    type = 'decider';
  } else if (metadata.children && metadata.children.length > 0) {
    type = 'fork';
  } else if (metadata.isStreaming) {
    type = 'streaming';
  }

  return {
    id: metadata.id ?? metadata.name,
    name: metadata.name,
    type,
    next: metadata.next as ServicePipelineNode | undefined,
    children: metadata.children as ServicePipelineNode[] | undefined,
    isStreaming: metadata.isStreaming,
    streamId: metadata.streamId,
    loopTarget: metadata.loopTarget,
    isSubflowRoot: metadata.isSubflowRoot,
    subflowId: metadata.subflowId,
    subflowName: metadata.subflowName,
  };
};

// Usage in your service layer
const builder = new FlowChartBuilder()
  .start('entry', entryFn)
  .addFunction('askLLM', askLLMFn)
  .addBuildTimeExtractor(servicePipelineExtractor);

// toSpec() returns ServicePipelineNode format
const pipelineStructure = builder.toSpec<ServicePipelineNode>();

// No more need for convertToTreeContextResponse() for pipeline structure!
```

### Error Handling in Build-Time Extractor

If the build-time extractor throws an error:
1. The error is logged to console
2. The error is recorded in `getBuildTimeExtractorErrors()`
3. `toSpec()` falls back to the default `FlowChartSpec` format

```typescript
const builder = new FlowChartBuilder()
  .start('entry', entryFn)
  .addBuildTimeExtractor((metadata) => {
    if (someCondition) {
      throw new Error('Extractor failed');
    }
    return transformedMetadata;
  });

const spec = builder.toSpec(); // Falls back to FlowChartSpec on error

// Check for errors
const errors = builder.getBuildTimeExtractorErrors();
if (errors.length > 0) {
  console.warn('Build-time extractor errors:', errors);
}
```
