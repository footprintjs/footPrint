# Traversal Extractor

The Traversal Extractor feature provides a pluggable API for extracting data from each stage during pipeline execution. This enables applications to transform stage execution data into whatever format their frontend or consumers need, without polluting the library with domain-specific concepts.

## Overview

When building pipelines with `FlowChartBuilder`, you can register a traversal extractor function that will be called after each stage completes. The extractor receives a `StageSnapshot` containing the node and its execution context, and returns whatever data your application needs.

```typescript
import { FlowChartBuilder, TraversalExtractor, StageSnapshot } from 'tree-of-functions';

const myExtractor: TraversalExtractor<MyData> = (snapshot: StageSnapshot) => {
  const { node, context } = snapshot;
  const scope = context.getScope();
  const debugInfo = context.getDebugInfo();
  
  return {
    stageName: node.name,
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

## API Reference

### Types

#### `StageSnapshot<TOut, TScope>`

Data passed to the traversal extractor for each stage.

```typescript
interface StageSnapshot<TOut = any, TScope = any> {
  /** The node being executed */
  node: StageNode<TOut, TScope>;
  /** The stage's execution context */
  context: StageContext;
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

### FlowChartBuilder Methods

#### `addTraversalExtractor<TResult>(extractor: TraversalExtractor<TResult>): this`

Register a traversal extractor function. Only one extractor per flow is supported - calling this multiple times replaces the previous extractor (last one wins).

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
