# Design Document: Streaming Support for TreeOfFunctions

## Overview

This feature adds streaming support to TreeOfFunctions, enabling pipeline stages to emit tokens incrementally to clients. The design follows the principle of "library absorbs complexity" - consumers use a simple fluent API (`addStreamingFunction`, `onStream`), and stage developers receive an automatically-injected callback parameter.

Key design decisions:
1. **Automatic callback injection**: TreePipeline detects streaming stages and injects the callback as a 3rd parameter
2. **Fluent API**: Consumers chain `.onStream()` instead of manually configuring readOnly context
3. **Pure JSON context tree**: Function callbacks are stripped before serialization
4. **Backward compatible**: Existing stages with `(scope, breakFn)` signature continue to work

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│  Consumer Code                                                       │
│  flow.addStreamingFunction('askLLM', 'response')                    │
│      .onStream((streamId, token) => sendToClient(token))            │
└─────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────┐
│  FlowBuilder                                                         │
│  - Stores isStreaming flag and streamId on StageNode                │
│  - Stores stream handler callbacks internally                        │
│  - Passes handler to TreePipeline on execute()                      │
└─────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────┐
│  TreePipeline                                                        │
│  - Receives streamHandler from FlowBuilder                          │
│  - In executeStage(): checks node.isStreaming                       │
│  - Creates bound callback: (token) => streamHandler(streamId, token)│
│  - Passes callback as 3rd param to stage function                   │
└─────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────┐
│  Stage Function                                                      │
│  async function askLLM(scope, breakFn, streamCallback?) {           │
│    for await (const token of llmStream) {                           │
│      streamCallback?.(token);  // Automatic!                        │
│    }                                                                │
│  }                                                                  │
└─────────────────────────────────────────────────────────────────────┘
```

## Components and Interfaces

### StageNode Extension

```typescript
export type StageNode<TOut = any, TScope = any> = {
  name: string;
  id?: string;
  next?: StageNode<TOut, TScope>;
  children?: StageNode<TOut, TScope>[];
  nextNodeDecider?: Decider;
  fn?: PipelineStageFunction<TOut, TScope>;
  
  // NEW: Streaming metadata
  isStreaming?: boolean;
  streamId?: string;
};
```

### Updated Stage Function Signature

```typescript
export type PipelineStageFunction<TOut, TScope> = (
  scope: TScope,
  breakPipeline: () => void,
  streamCallback?: (token: string) => void  // NEW: Optional 3rd parameter
) => Promise<TOut> | TOut;
```

### Stream Handler Types

```typescript
export type StreamTokenHandler = (streamId: string, token: string) => void;
export type StreamLifecycleHandler = (streamId: string, fullText?: string) => void;

export interface StreamHandlers {
  onToken?: StreamTokenHandler;
  onStart?: StreamLifecycleHandler;
  onEnd?: StreamLifecycleHandler;
}
```

### FlowBuilder Extensions

```typescript
class FlowBuilder<TOut, TScope> {
  private _streamHandlers: StreamHandlers = {};
  
  addStreamingFunction(
    name: string,
    streamId?: string,
    fn?: PipelineStageFunction<TOut, TScope>
  ): this;
  
  onStream(handler: StreamTokenHandler): this;
  onStreamStart(handler: StreamLifecycleHandler): this;
  onStreamEnd(handler: StreamLifecycleHandler): this;
}
```

### TreePipeline Extensions

```typescript
class TreePipeline<TOut, TScope> {
  private readonly streamHandlers?: StreamHandlers;
  
  constructor(
    root: StageNode,
    stageMap: Map<string, PipelineStageFunction<TOut, TScope>>,
    scopeFactory: ScopeFactory<TScope>,
    defaultValuesForContext?: unknown,
    initialContext?: unknown,
    readOnlyContext?: unknown,
    throttlingErrorChecker?: (error: unknown) => boolean,
    streamHandlers?: StreamHandlers  // NEW parameter
  );
}
```

## Data Models

### Stream Event Flow

```
Stage emits token
       │
       ▼
streamCallback(token)
       │
       ▼
TreePipeline wraps with streamId
       │
       ▼
streamHandlers.onToken(streamId, token)
       │
       ▼
Consumer callback receives (streamId, token)
```

### Context Tree (Pure JSON)

The context tree excludes all function references:

```typescript
// Internal storage may have functions
{
  readOnly: {
    __streamHandlers: { onToken: fn, onStart: fn }  // Functions
  }
}

// getContextTree() returns pure JSON
{
  globalContext: { ... },
  stageContexts: { ... },
  history: [ ... ]
  // No __streamHandlers - stripped out
}
```

## Correctness Properties

*A property is a characteristic or behavior that should hold true across all valid executions of a system-essentially, a formal statement about what the system should do. Properties serve as the bridge between human-readable specifications and machine-verifiable correctness guarantees.*

### Property 1: Streaming flag propagation
*For any* stage name and streamId, when `addStreamingFunction(name, streamId)` is called, the resulting StageNode SHALL have `isStreaming: true` and `streamId` equal to the provided value (or name if not provided).
**Validates: Requirements 1.1, 1.2**

### Property 2: Callback injection for streaming stages
*For any* stage marked with `isStreaming: true`, when TreePipeline executes that stage, the stage function SHALL receive a defined function as its third parameter.
**Validates: Requirements 2.1**

### Property 3: No callback for non-streaming stages
*For any* stage without `isStreaming: true`, when TreePipeline executes that stage, the stage function SHALL receive undefined as its third parameter.
**Validates: Requirements 2.2, 5.2**

### Property 4: Token delivery with correct streamId
*For any* token emitted via streamCallback, the consumer's onStream handler SHALL receive that exact token paired with the correct streamId for that stage.
**Validates: Requirements 2.3, 3.1**

### Property 5: Parallel stream integrity
*For any* set of parallel streaming stages (fork children), all tokens emitted by all stages SHALL be delivered to the consumer without loss, each with its correct streamId.
**Validates: Requirements 3.2**

### Property 6: Pipeline continuation after streaming
*For any* streaming stage that returns a value, subsequent stages SHALL receive that return value, and pipeline execution SHALL continue normally.
**Validates: Requirements 3.3**

### Property 7: Context tree serialization
*For any* pipeline execution with streaming enabled, `getContextTree()` SHALL return an object that can be serialized with `JSON.stringify()` without errors.
**Validates: Requirements 4.1, 4.2, 4.3**

### Property 8: Backward compatibility
*For any* existing stage function with signature `(scope, breakFn)`, execution SHALL complete without errors regardless of streaming configuration.
**Validates: Requirements 5.1, 5.3**

### Property 9: Graceful degradation
*For any* streaming stage executed without registered handlers (onStream, onStreamStart, onStreamEnd), execution SHALL complete without errors.
**Validates: Requirements 1.4, 2.4, 6.3**

### Property 10: Lifecycle hook invocation
*For any* streaming stage with registered lifecycle handlers, onStreamStart SHALL be called before the first token, and onStreamEnd SHALL be called after stage completion with the accumulated text.
**Validates: Requirements 6.1, 6.2**

## Error Handling

| Scenario | Behavior |
|----------|----------|
| streamCallback called without handler | Silently ignored (no-op) |
| Stage throws during streaming | Error propagates normally, partial tokens already delivered |
| Invalid streamId (empty string) | Use stage name as fallback |
| Concurrent token emission (parallel) | All tokens delivered, order within stream preserved |

## Testing Strategy

### Unit Testing

Unit tests will cover:
- FlowBuilder correctly sets streaming flags on nodes
- TreePipeline injects callbacks only for streaming stages
- Context tree serialization excludes functions
- Lifecycle hooks called at correct times

### Property-Based Testing

Using fast-check for property-based tests:

1. **Streaming flag property**: Generate random names/streamIds, verify node properties
2. **Token delivery property**: Generate random token sequences, verify all delivered with correct streamId
3. **Parallel integrity property**: Generate parallel stages with random tokens, verify no loss
4. **Serialization property**: Generate various pipeline configurations, verify JSON.stringify succeeds
5. **Backward compatibility property**: Generate old-style stages, verify execution succeeds

Test annotations will follow the format:
`**Feature: streaming-support, Property {number}: {property_text}**`

Minimum 100 iterations per property test using fast-check.
