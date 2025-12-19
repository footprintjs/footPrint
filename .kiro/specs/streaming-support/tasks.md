# Implementation Plan

- [x] 1. Extend StageNode type with streaming metadata
  - [x] 1.1 Add `isStreaming` and `streamId` optional fields to StageNode type
    - Update `src/core/pipeline/TreePipeline.ts` StageNode type definition
    - Add JSDoc comments explaining the fields
    - _Requirements: 1.1, 1.2_
  - [x] 1.2 Write property test for streaming flag propagation
    - **Property 1: Streaming flag propagation**
    - **Validates: Requirements 1.1, 1.2**

- [x] 2. Update PipelineStageFunction signature
  - [x] 2.1 Add optional streamCallback parameter to PipelineStageFunction type
    - Update `src/core/pipeline/types.ts` with new signature
    - Ensure backward compatibility with existing 2-param stages
    - _Requirements: 2.1, 5.1_
  - [x] 2.2 Write property test for backward compatibility
    - **Property 8: Backward compatibility**
    - **Validates: Requirements 5.1, 5.3**

- [x] 3. Add stream handler types
  - [x] 3.1 Create StreamHandlers interface and related types
    - Add `StreamTokenHandler`, `StreamLifecycleHandler`, `StreamHandlers` types
    - Export from `src/core/pipeline/types.ts`
    - _Requirements: 2.3, 6.1, 6.2_

- [x] 4. Extend TreePipeline to support streaming
  - [x] 4.1 Add streamHandlers parameter to TreePipeline constructor
    - Store streamHandlers as private readonly field
    - Update constructor signature
    - _Requirements: 2.1, 2.3_
  - [x] 4.2 Modify executeStage to inject stream callback
    - Check `node.isStreaming` flag
    - Create bound callback with streamId
    - Pass as 3rd parameter to stage function
    - Call onStart lifecycle hook before execution
    - Call onEnd lifecycle hook after execution
    - _Requirements: 2.1, 2.2, 6.1, 6.2_
  - [x] 4.3 Write property test for callback injection
    - **Property 2: Callback injection for streaming stages**
    - **Validates: Requirements 2.1**
  - [x] 4.4 Write property test for no callback on non-streaming stages
    - **Property 3: No callback for non-streaming stages**
    - **Validates: Requirements 2.2, 5.2**

- [x] 5. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 6. Extend FlowBuilder with streaming API
  - [x] 6.1 Add addStreamingFunction method
    - Create node with `isStreaming: true` and streamId
    - Default streamId to stage name if not provided
    - _Requirements: 1.1, 1.2_
  - [x] 6.2 Add onStream, onStreamStart, onStreamEnd methods
    - Store handlers in private _streamHandlers object
    - Return `this` for fluent chaining
    - _Requirements: 1.3, 6.1, 6.2_
  - [x] 6.3 Pass streamHandlers to TreePipeline in execute method
    - Update execute() to pass _streamHandlers to TreePipeline constructor
    - _Requirements: 2.3_
  - [x] 6.4 Write property test for token delivery with streamId
    - **Property 4: Token delivery with correct streamId**
    - **Validates: Requirements 2.3, 3.1**

- [ ] 7. Implement context tree sanitization
  - [ ] 7.1 Create stripFunctions utility
    - Recursively remove function references from objects
    - Skip keys starting with `__` that contain functions
    - Handle arrays and nested objects
    - _Requirements: 4.1, 4.2_
  - [ ] 7.2 Apply stripFunctions in getContextTree
    - Call stripFunctions before returning context tree
    - Ensure JSON.stringify works on result
    - _Requirements: 4.3_
  - [ ] 7.3 Write property test for context tree serialization
    - **Property 7: Context tree serialization**
    - **Validates: Requirements 4.1, 4.2, 4.3**

- [ ] 8. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 9. Handle parallel streaming (fork children)
  - [ ] 9.1 Ensure executeNodeChildren passes streamHandlers to child execution
    - Each child stage should receive its own bound callback
    - Tokens from parallel stages should not interfere
    - _Requirements: 3.2_
  - [ ] 9.2 Write property test for parallel stream integrity
    - **Property 5: Parallel stream integrity**
    - **Validates: Requirements 3.2**

- [ ] 10. Implement graceful degradation
  - [ ] 10.1 Handle missing handlers gracefully
    - streamCallback should be no-op if no handler registered
    - Lifecycle hooks should skip if not registered
    - _Requirements: 1.4, 2.4, 6.3_
  - [ ] 10.2 Write property test for graceful degradation
    - **Property 9: Graceful degradation**
    - **Validates: Requirements 1.4, 2.4, 6.3**

- [ ] 11. Verify pipeline continuation after streaming
  - [ ] 11.1 Ensure streaming stages return values propagate to next stages
    - Stage return value should be passed to next stage
    - Pipeline should continue normally after streaming completes
    - _Requirements: 3.3_
  - [ ] 11.2 Write property test for pipeline continuation
    - **Property 6: Pipeline continuation after streaming**
    - **Validates: Requirements 3.3**

- [ ] 12. Implement lifecycle hooks
  - [ ] 12.1 Track accumulated text during streaming
    - Accumulate tokens as they're emitted
    - Pass accumulated text to onEnd callback
    - _Requirements: 6.2_
  - [ ] 12.2 Write property test for lifecycle hook invocation
    - **Property 10: Lifecycle hook invocation**
    - **Validates: Requirements 6.1, 6.2**

- [ ] 13. Update exports
  - [ ] 13.1 Export new types from index
    - Export StreamTokenHandler, StreamLifecycleHandler, StreamHandlers
    - Ensure all public APIs are accessible
    - _Requirements: All_

- [ ] 14. Final Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.
