# Requirements Document

## Introduction

This feature adds streaming support to TreeOfFunctions, enabling pipeline stages to emit tokens incrementally to clients. This is essential for chatbot applications where LLM responses should appear word-by-word rather than waiting for the complete response. The design prioritizes ease of adoption - consumers use a simple fluent API, and stage developers receive an automatically-injected callback.

## Glossary

- **TreeOfFunctions**: A pipeline orchestration framework that models computation as a tree of stages
- **Streaming Stage**: A pipeline stage that emits tokens incrementally rather than returning a complete result
- **Stream Callback**: A function that receives tokens as they are generated
- **Stream ID**: A unique identifier for a stream, allowing clients to route tokens from multiple concurrent streams
- **FlowBuilder**: The fluent API for constructing TreeOfFunctions pipelines
- **TreePipeline**: The execution engine that traverses the stage tree
- **Stage Function**: A function that executes within a pipeline stage, receiving scope and breakFn parameters

## Requirements

### Requirement 1

**User Story:** As a library consumer, I want to mark stages as streaming using a fluent API, so that I can easily enable streaming without understanding internal implementation details.

#### Acceptance Criteria

1. WHEN a consumer calls `addStreamingFunction(name, streamId)` on FlowBuilder THEN the system SHALL create a stage node with `isStreaming: true` and the specified streamId
2. WHEN a consumer calls `addStreamingFunction(name)` without a streamId THEN the system SHALL use the stage name as the default streamId
3. WHEN a consumer calls `onStream(callback)` on FlowBuilder THEN the system SHALL store the callback for injection during execution
4. WHEN `onStream` is not called THEN the system SHALL execute streaming stages normally without injecting a callback

### Requirement 2

**User Story:** As a stage developer, I want to receive a stream callback as a function parameter, so that I can emit tokens without manually wiring callbacks through scope or readOnly context.

#### Acceptance Criteria

1. WHEN TreePipeline executes a stage marked as streaming THEN the system SHALL pass a streamCallback as the third parameter to the stage function
2. WHEN TreePipeline executes a non-streaming stage THEN the system SHALL pass undefined as the third parameter
3. WHEN a stage function calls streamCallback with a token THEN the system SHALL invoke the consumer's onStream handler with the streamId and token
4. WHEN streamCallback is called but no onStream handler was registered THEN the system SHALL silently ignore the call without throwing errors

### Requirement 3

**User Story:** As a library consumer, I want to receive tokens from multiple streaming stages with their stream IDs, so that I can route tokens to the correct UI components.

#### Acceptance Criteria

1. WHEN multiple streaming stages emit tokens THEN the system SHALL include the correct streamId with each token in the callback
2. WHEN parallel streaming stages (fork children) emit tokens concurrently THEN the system SHALL deliver all tokens with their respective streamIds without data loss
3. WHEN a streaming stage completes THEN the system SHALL continue pipeline execution normally, passing the stage's return value to subsequent stages

### Requirement 4

**User Story:** As a library consumer, I want the context tree to remain pure JSON, so that I can serialize it for logging and debugging without errors.

#### Acceptance Criteria

1. WHEN getContextTree is called THEN the system SHALL return a JSON-serializable object without function references
2. WHEN stream callbacks are stored internally THEN the system SHALL exclude them from the context tree output
3. WHEN JSON.stringify is called on the context tree THEN the system SHALL not throw circular reference or function serialization errors

### Requirement 5

**User Story:** As a stage developer, I want streaming to be optional and backward compatible, so that existing stages continue to work without modification.

#### Acceptance Criteria

1. WHEN an existing stage function with signature `(scope, breakFn)` is used THEN the system SHALL execute it normally without errors
2. WHEN a stage is added with `addFunction` instead of `addStreamingFunction` THEN the system SHALL not inject a stream callback
3. WHEN a streaming stage does not use the streamCallback parameter THEN the system SHALL complete execution normally

### Requirement 6

**User Story:** As a library consumer, I want lifecycle hooks for stream start and end events, so that I can update UI state appropriately.

#### Acceptance Criteria

1. WHEN a consumer calls `onStreamStart(callback)` THEN the system SHALL invoke the callback with streamId when a streaming stage begins execution
2. WHEN a consumer calls `onStreamEnd(callback)` THEN the system SHALL invoke the callback with streamId and accumulated text when a streaming stage completes
3. WHEN lifecycle callbacks are not registered THEN the system SHALL skip lifecycle notifications without errors
