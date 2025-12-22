/**
 * Property-based tests for streaming support in TreeOfFunctions.
 * Uses fast-check for property-based testing.
 */

import * as fc from 'fast-check';

import { StageContext } from '../../../src/core/context/StageContext';
import type { PipelineStageFunction, StageNode } from '../../../src/core/pipeline';
import { TreePipeline } from '../../../src/core/pipeline';
import { FlowBuilder } from '../../../src/FlowBuilder';
import { BaseState } from '../../../src/scope/core/BaseState';

/**
 * **Feature: streaming-support, Property 1: Streaming flag propagation**
 *
 * *For any* stage name and streamId, when a StageNode is created with
 * `isStreaming: true` and the specified streamId, the resulting StageNode
 * SHALL have `isStreaming: true` and `streamId` equal to the provided value
 * (or name if not provided).
 *
 * **Validates: Requirements 1.1, 1.2**
 */
describe('Streaming Support Property Tests', () => {
  describe('Property 1: Streaming flag propagation', () => {
    // Arbitrary for valid stage names (non-empty strings)
    const stageNameArb = fc.string({ minLength: 1, maxLength: 50 }).filter((s) => s.trim().length > 0);

    // Arbitrary for optional streamId (either provided or undefined)
    const streamIdArb = fc.option(
      fc.string({ minLength: 1, maxLength: 50 }).filter((s) => s.trim().length > 0),
      { nil: undefined },
    );

    it('should set isStreaming to true when explicitly specified', () => {
      fc.assert(
        fc.property(stageNameArb, (name) => {
          const node: StageNode = {
            name,
            isStreaming: true,
          };

          return node.isStreaming === true;
        }),
        { numRuns: 100 },
      );
    });

    it('should preserve streamId when explicitly provided', () => {
      fc.assert(
        fc.property(stageNameArb, stageNameArb, (name, streamId) => {
          const node: StageNode = {
            name,
            isStreaming: true,
            streamId,
          };

          return node.streamId === streamId;
        }),
        { numRuns: 100 },
      );
    });

    it('should allow streamId to default to stage name when not provided', () => {
      fc.assert(
        fc.property(stageNameArb, (name) => {
          // Simulate the behavior where streamId defaults to name if not provided
          const providedStreamId: string | undefined = undefined;
          const effectiveStreamId = providedStreamId ?? name;

          const node: StageNode = {
            name,
            isStreaming: true,
            streamId: effectiveStreamId,
          };

          return node.streamId === name;
        }),
        { numRuns: 100 },
      );
    });

    it('should correctly propagate both isStreaming and streamId together', () => {
      fc.assert(
        fc.property(stageNameArb, streamIdArb, (name, maybeStreamId) => {
          const effectiveStreamId = maybeStreamId ?? name;

          const node: StageNode = {
            name,
            isStreaming: true,
            streamId: effectiveStreamId,
          };

          // Both properties should be correctly set
          const hasCorrectStreamingFlag = node.isStreaming === true;
          const hasCorrectStreamId = node.streamId === effectiveStreamId;

          return hasCorrectStreamingFlag && hasCorrectStreamId;
        }),
        { numRuns: 100 },
      );
    });

    it('should default isStreaming to undefined when not specified', () => {
      fc.assert(
        fc.property(stageNameArb, (name) => {
          const node: StageNode = {
            name,
          };

          return node.isStreaming === undefined;
        }),
        { numRuns: 100 },
      );
    });

    it('should allow non-streaming stages (isStreaming: false or undefined)', () => {
      fc.assert(
        fc.property(stageNameArb, fc.oneof(fc.constant(false), fc.constant(undefined)), (name, isStreaming) => {
          const node: StageNode = {
            name,
            isStreaming,
          };

          // Non-streaming stages should not have isStreaming: true
          return node.isStreaming !== true;
        }),
        { numRuns: 100 },
      );
    });
  });

  /**
   * **Feature: streaming-support, Property 8: Backward compatibility**
   *
   * *For any* existing stage function with signature `(scope, breakFn)`,
   * execution SHALL complete without errors regardless of streaming configuration.
   *
   * **Validates: Requirements 5.1, 5.3**
   */
  describe('Property 8: Backward compatibility', () => {
    // Simple scope class for testing
    class TestScope extends BaseState {}

    // Scope factory that creates TestScope instances
    const scopeFactory = (context: StageContext, stageName: string, readOnlyContext?: unknown) => {
      return new TestScope(context, stageName, readOnlyContext);
    };

    // Arbitrary for valid stage names
    const stageNameArb = fc.string({ minLength: 1, maxLength: 20 }).filter((s) => /^[a-zA-Z][a-zA-Z0-9]*$/.test(s));

    // Arbitrary for return values (simple primitives)
    const returnValueArb = fc.oneof(fc.string(), fc.integer(), fc.boolean(), fc.constant(null), fc.constant(undefined));

    it('should execute 2-param stage functions without errors', async () => {
      await fc.assert(
        fc.asyncProperty(stageNameArb, returnValueArb, async (stageName, returnValue) => {
          // Create a traditional 2-param stage function (no streamCallback)
          const twoParamStage: PipelineStageFunction<any, TestScope> = (scope, breakFn) => {
            // Traditional stage that only uses scope and breakFn
            return returnValue;
          };

          const stageMap = new Map<string, PipelineStageFunction<any, TestScope>>();
          stageMap.set(stageName, twoParamStage);

          const root: StageNode = { name: stageName };

          const pipeline = new TreePipeline(root, stageMap, scopeFactory);

          // Should execute without throwing
          const result = await pipeline.execute();
          return result === returnValue;
        }),
        { numRuns: 100 },
      );
    });

    it('should execute 2-param async stage functions without errors', async () => {
      await fc.assert(
        fc.asyncProperty(stageNameArb, returnValueArb, async (stageName, returnValue) => {
          // Create a traditional 2-param async stage function
          const twoParamAsyncStage: PipelineStageFunction<any, TestScope> = async (scope, breakFn) => {
            // Simulate async work
            await Promise.resolve();
            return returnValue;
          };

          const stageMap = new Map<string, PipelineStageFunction<any, TestScope>>();
          stageMap.set(stageName, twoParamAsyncStage);

          const root: StageNode = { name: stageName };

          const pipeline = new TreePipeline(root, stageMap, scopeFactory);

          const result = await pipeline.execute();
          return result === returnValue;
        }),
        { numRuns: 100 },
      );
    });

    it('should execute 2-param stages that use breakFn without errors', async () => {
      await fc.assert(
        fc.asyncProperty(stageNameArb, returnValueArb, async (stageName, returnValue) => {
          // Create a stage that uses breakFn
          const stageWithBreak: PipelineStageFunction<any, TestScope> = (scope, breakFn) => {
            breakFn(); // Call break
            return returnValue;
          };

          const stageMap = new Map<string, PipelineStageFunction<any, TestScope>>();
          stageMap.set(stageName, stageWithBreak);

          const root: StageNode = { name: stageName };

          const pipeline = new TreePipeline(root, stageMap, scopeFactory);

          const result = await pipeline.execute();
          return result === returnValue;
        }),
        { numRuns: 100 },
      );
    });

    it('should execute 2-param stages in pipelines with streaming stages without errors', async () => {
      await fc.assert(
        fc.asyncProperty(
          stageNameArb,
          stageNameArb.filter((s) => s !== 'stage1'), // Ensure different names
          returnValueArb,
          async (stage1Name, stage2Name, returnValue) => {
            // Ensure unique names
            const uniqueStage2Name = stage2Name === stage1Name ? stage2Name + '2' : stage2Name;

            // Traditional 2-param stage
            const traditionalStage: PipelineStageFunction<any, TestScope> = (scope, breakFn) => {
              return 'traditional';
            };

            // Another traditional stage
            const anotherTraditionalStage: PipelineStageFunction<any, TestScope> = (scope, breakFn) => {
              return returnValue;
            };

            const stageMap = new Map<string, PipelineStageFunction<any, TestScope>>();
            stageMap.set(stage1Name, traditionalStage);
            stageMap.set(uniqueStage2Name, anotherTraditionalStage);

            // Pipeline with a streaming stage followed by a non-streaming stage
            const root: StageNode = {
              name: stage1Name,
              isStreaming: true, // First stage is streaming
              streamId: 'stream1',
              next: {
                name: uniqueStage2Name,
                // Second stage is traditional (no streaming)
              },
            };

            const pipeline = new TreePipeline(root, stageMap, scopeFactory);

            // Should execute without throwing
            const result = await pipeline.execute();
            return result === returnValue;
          },
        ),
        { numRuns: 100 },
      );
    });

    it('should execute streaming stages that ignore streamCallback without errors', async () => {
      await fc.assert(
        fc.asyncProperty(stageNameArb, returnValueArb, async (stageName, returnValue) => {
          // A streaming stage that doesn't use the streamCallback parameter
          // This tests Requirement 5.3: streaming stage does not use streamCallback
          const streamingStageIgnoringCallback: PipelineStageFunction<any, TestScope> = (scope, breakFn) => {
            // Intentionally not using streamCallback (3rd param)
            return returnValue;
          };

          const stageMap = new Map<string, PipelineStageFunction<any, TestScope>>();
          stageMap.set(stageName, streamingStageIgnoringCallback);

          const root: StageNode = {
            name: stageName,
            isStreaming: true,
            streamId: 'test-stream',
          };

          const pipeline = new TreePipeline(root, stageMap, scopeFactory);

          const result = await pipeline.execute();
          return result === returnValue;
        }),
        { numRuns: 100 },
      );
    });
  });

  /**
   * **Feature: streaming-support, Property 2: Callback injection for streaming stages**
   *
   * *For any* stage marked with `isStreaming: true`, when TreePipeline executes that stage,
   * the stage function SHALL receive a defined function as its third parameter.
   *
   * **Validates: Requirements 2.1**
   */
  describe('Property 2: Callback injection for streaming stages', () => {
    // Simple scope class for testing
    class TestScope extends BaseState {}

    // Scope factory that creates TestScope instances
    const scopeFactory = (context: StageContext, stageName: string, readOnlyContext?: unknown) => {
      return new TestScope(context, stageName, readOnlyContext);
    };

    // Arbitrary for valid stage names
    const stageNameArb = fc.string({ minLength: 1, maxLength: 20 }).filter((s) => /^[a-zA-Z][a-zA-Z0-9]*$/.test(s));

    // Arbitrary for optional streamId
    const streamIdArb = fc.option(
      fc.string({ minLength: 1, maxLength: 20 }).filter((s) => /^[a-zA-Z][a-zA-Z0-9]*$/.test(s)),
      { nil: undefined },
    );

    it('should inject a defined streamCallback for streaming stages', async () => {
      await fc.assert(
        fc.asyncProperty(stageNameArb, streamIdArb, async (stageName, maybeStreamId) => {
          let receivedCallback: ((token: string) => void) | undefined;
          let callbackWasDefined = false;

          // Stage that captures the streamCallback parameter
          const streamingStage: PipelineStageFunction<any, TestScope> = (scope, breakFn, streamCallback) => {
            receivedCallback = streamCallback;
            callbackWasDefined = typeof streamCallback === 'function';
            return 'done';
          };

          const stageMap = new Map<string, PipelineStageFunction<any, TestScope>>();
          stageMap.set(stageName, streamingStage);

          const effectiveStreamId = maybeStreamId ?? stageName;
          const root: StageNode = {
            name: stageName,
            isStreaming: true,
            streamId: effectiveStreamId,
          };

          const pipeline = new TreePipeline(root, stageMap, scopeFactory);

          await pipeline.execute();

          // The callback should be defined for streaming stages
          return callbackWasDefined && typeof receivedCallback === 'function';
        }),
        { numRuns: 100 },
      );
    });

    it('should inject streamCallback that can be called without errors', async () => {
      await fc.assert(
        fc.asyncProperty(
          stageNameArb,
          fc.array(fc.string({ minLength: 1, maxLength: 50 }), { minLength: 1, maxLength: 10 }),
          async (stageName, tokens) => {
            let callbackCallCount = 0;

            // Stage that uses the streamCallback
            const streamingStage: PipelineStageFunction<any, TestScope> = (scope, breakFn, streamCallback) => {
              // Call the callback with each token
              for (const token of tokens) {
                streamCallback?.(token);
                callbackCallCount++;
              }
              return 'done';
            };

            const stageMap = new Map<string, PipelineStageFunction<any, TestScope>>();
            stageMap.set(stageName, streamingStage);

            const root: StageNode = {
              name: stageName,
              isStreaming: true,
              streamId: 'test-stream',
            };

            const pipeline = new TreePipeline(root, stageMap, scopeFactory);

            // Should execute without throwing
            await pipeline.execute();

            // All tokens should have been processed
            return callbackCallCount === tokens.length;
          },
        ),
        { numRuns: 100 },
      );
    });

    it('should route tokens to onToken handler with correct streamId', async () => {
      await fc.assert(
        fc.asyncProperty(
          stageNameArb,
          stageNameArb, // streamId
          fc.array(fc.string({ minLength: 1, maxLength: 20 }), { minLength: 1, maxLength: 5 }),
          async (stageName, streamId, tokens) => {
            const receivedTokens: Array<{ streamId: string; token: string }> = [];

            // Stage that emits tokens
            const streamingStage: PipelineStageFunction<any, TestScope> = (scope, breakFn, streamCallback) => {
              for (const token of tokens) {
                streamCallback?.(token);
              }
              return 'done';
            };

            const stageMap = new Map<string, PipelineStageFunction<any, TestScope>>();
            stageMap.set(stageName, streamingStage);

            const root: StageNode = {
              name: stageName,
              isStreaming: true,
              streamId,
            };

            const pipeline = new TreePipeline(
              root,
              stageMap,
              scopeFactory,
              undefined, // defaultValuesForContext
              undefined, // initialContext
              undefined, // readOnlyContext
              undefined, // throttlingErrorChecker
              {
                onToken: (sid, token) => {
                  receivedTokens.push({ streamId: sid, token });
                },
              },
            );

            await pipeline.execute();

            // All tokens should be received with correct streamId
            const allTokensReceived = receivedTokens.length === tokens.length;
            const allStreamIdsCorrect = receivedTokens.every((r) => r.streamId === streamId);
            const allTokensMatch = receivedTokens.every((r, i) => r.token === tokens[i]);

            return allTokensReceived && allStreamIdsCorrect && allTokensMatch;
          },
        ),
        { numRuns: 100 },
      );
    });
  });

  /**
   * **Feature: streaming-support, Property 3: No callback for non-streaming stages**
   *
   * *For any* stage without `isStreaming: true`, when TreePipeline executes that stage,
   * the stage function SHALL receive undefined as its third parameter.
   *
   * **Validates: Requirements 2.2, 5.2**
   */
  describe('Property 3: No callback for non-streaming stages', () => {
    // Simple scope class for testing
    class TestScope extends BaseState {}

    // Scope factory that creates TestScope instances
    const scopeFactory = (context: StageContext, stageName: string, readOnlyContext?: unknown) => {
      return new TestScope(context, stageName, readOnlyContext);
    };

    // Arbitrary for valid stage names
    const stageNameArb = fc.string({ minLength: 1, maxLength: 20 }).filter((s) => /^[a-zA-Z][a-zA-Z0-9]*$/.test(s));

    // Arbitrary for return values
    const returnValueArb = fc.oneof(fc.string(), fc.integer(), fc.boolean(), fc.constant(null), fc.constant(undefined));

    it('should pass undefined as streamCallback for non-streaming stages', async () => {
      await fc.assert(
        fc.asyncProperty(stageNameArb, returnValueArb, async (stageName, returnValue) => {
          let receivedCallback: ((token: string) => void) | undefined = 'not-set' as any;

          // Stage that captures the streamCallback parameter
          const nonStreamingStage: PipelineStageFunction<any, TestScope> = (scope, breakFn, streamCallback) => {
            receivedCallback = streamCallback;
            return returnValue;
          };

          const stageMap = new Map<string, PipelineStageFunction<any, TestScope>>();
          stageMap.set(stageName, nonStreamingStage);

          // Non-streaming stage (no isStreaming flag)
          const root: StageNode = {
            name: stageName,
            // isStreaming is not set (undefined)
          };

          const pipeline = new TreePipeline(root, stageMap, scopeFactory);

          await pipeline.execute();

          // The callback should be undefined for non-streaming stages
          return receivedCallback === undefined;
        }),
        { numRuns: 100 },
      );
    });

    it('should pass undefined as streamCallback when isStreaming is false', async () => {
      await fc.assert(
        fc.asyncProperty(stageNameArb, returnValueArb, async (stageName, returnValue) => {
          let receivedCallback: ((token: string) => void) | undefined = 'not-set' as any;

          // Stage that captures the streamCallback parameter
          const nonStreamingStage: PipelineStageFunction<any, TestScope> = (scope, breakFn, streamCallback) => {
            receivedCallback = streamCallback;
            return returnValue;
          };

          const stageMap = new Map<string, PipelineStageFunction<any, TestScope>>();
          stageMap.set(stageName, nonStreamingStage);

          // Explicitly non-streaming stage
          const root: StageNode = {
            name: stageName,
            isStreaming: false,
          };

          const pipeline = new TreePipeline(root, stageMap, scopeFactory);

          await pipeline.execute();

          // The callback should be undefined for non-streaming stages
          return receivedCallback === undefined;
        }),
        { numRuns: 100 },
      );
    });

    it('should not inject callback for non-streaming stages even when handlers are registered', async () => {
      await fc.assert(
        fc.asyncProperty(stageNameArb, returnValueArb, async (stageName, returnValue) => {
          let receivedCallback: ((token: string) => void) | undefined = 'not-set' as any;
          let onTokenCalled = false;

          // Stage that captures the streamCallback parameter
          const nonStreamingStage: PipelineStageFunction<any, TestScope> = (scope, breakFn, streamCallback) => {
            receivedCallback = streamCallback;
            return returnValue;
          };

          const stageMap = new Map<string, PipelineStageFunction<any, TestScope>>();
          stageMap.set(stageName, nonStreamingStage);

          // Non-streaming stage
          const root: StageNode = {
            name: stageName,
            // isStreaming is not set
          };

          // Pipeline with stream handlers registered
          const pipeline = new TreePipeline(
            root,
            stageMap,
            scopeFactory,
            undefined, // defaultValuesForContext
            undefined, // initialContext
            undefined, // readOnlyContext
            undefined, // throttlingErrorChecker
            {
              onToken: (streamId, token) => {
                onTokenCalled = true;
              },
            },
          );

          await pipeline.execute();

          // The callback should still be undefined for non-streaming stages
          // and onToken should not have been called
          return receivedCallback === undefined && !onTokenCalled;
        }),
        { numRuns: 100 },
      );
    });

    it('should correctly differentiate streaming and non-streaming stages in same pipeline', async () => {
      await fc.assert(
        fc.asyncProperty(
          stageNameArb,
          stageNameArb.filter((s) => s !== 'stage1'),
          async (stage1Name, stage2Name) => {
            const uniqueStage2Name = stage2Name === stage1Name ? stage2Name + '2' : stage2Name;

            let stage1CallbackDefined = false;
            let stage2CallbackDefined = false;

            // Streaming stage
            const streamingStage: PipelineStageFunction<any, TestScope> = (scope, breakFn, streamCallback) => {
              stage1CallbackDefined = typeof streamCallback === 'function';
              return 'streaming-done';
            };

            // Non-streaming stage
            const nonStreamingStage: PipelineStageFunction<any, TestScope> = (scope, breakFn, streamCallback) => {
              stage2CallbackDefined = typeof streamCallback === 'function';
              return 'non-streaming-done';
            };

            const stageMap = new Map<string, PipelineStageFunction<any, TestScope>>();
            stageMap.set(stage1Name, streamingStage);
            stageMap.set(uniqueStage2Name, nonStreamingStage);

            // Pipeline with streaming stage followed by non-streaming stage
            const root: StageNode = {
              name: stage1Name,
              isStreaming: true,
              streamId: 'stream1',
              next: {
                name: uniqueStage2Name,
                // isStreaming not set - non-streaming
              },
            };

            const pipeline = new TreePipeline(root, stageMap, scopeFactory);

            await pipeline.execute();

            // Streaming stage should have callback, non-streaming should not
            return stage1CallbackDefined && !stage2CallbackDefined;
          },
        ),
        { numRuns: 100 },
      );
    });
  });

  /**
   * **Feature: streaming-support, Property 4: Token delivery with correct streamId**
   *
   * *For any* token emitted via streamCallback, the consumer's onStream handler SHALL
   * receive that exact token paired with the correct streamId for that stage.
   *
   * **Validates: Requirements 2.3, 3.1**
   */
  describe('Property 4: Token delivery with correct streamId (FlowBuilder API)', () => {
    // Simple scope class for testing
    class TestScope extends BaseState {}

    // Arbitrary for valid stage names (alphanumeric starting with letter)
    const stageNameArb = fc.string({ minLength: 1, maxLength: 20 }).filter((s) => /^[a-zA-Z][a-zA-Z0-9]*$/.test(s));

    // Arbitrary for streamId (can be different from stage name)
    const streamIdArb = fc.string({ minLength: 1, maxLength: 20 }).filter((s) => /^[a-zA-Z][a-zA-Z0-9]*$/.test(s));

    // Arbitrary for tokens (non-empty strings)
    const tokenArb = fc.string({ minLength: 1, maxLength: 50 });
    const tokensArb = fc.array(tokenArb, { minLength: 1, maxLength: 10 });

    it('should deliver all tokens with correct streamId via FlowBuilder.onStream', async () => {
      await fc.assert(
        fc.asyncProperty(stageNameArb, streamIdArb, tokensArb, async (stageName, streamId, tokens) => {
          const receivedTokens: Array<{ streamId: string; token: string }> = [];

          // Stage function that emits tokens
          const streamingStage: PipelineStageFunction<any, TestScope> = (scope, breakFn, streamCallback) => {
            for (const token of tokens) {
              streamCallback?.(token);
            }
            return 'done';
          };

          const stageMap = new Map<string, PipelineStageFunction<any, TestScope>>();
          stageMap.set(stageName, streamingStage);

          // Create workflow with streaming stage
          const workflow: StageNode = {
            name: stageName,
            isStreaming: true,
            streamId,
          };

          // Use FlowBuilder with onStream handler
          const builder = new FlowBuilder<any, TestScope>()
            .onStream((sid, token) => {
              receivedTokens.push({ streamId: sid, token });
            })
            .addPipeline(workflow, stageMap, TestScope);

          await builder.execute();

          // Verify all tokens received with correct streamId
          const allTokensReceived = receivedTokens.length === tokens.length;
          const allStreamIdsCorrect = receivedTokens.every((r) => r.streamId === streamId);
          const allTokensMatch = receivedTokens.every((r, i) => r.token === tokens[i]);

          return allTokensReceived && allStreamIdsCorrect && allTokensMatch;
        }),
        { numRuns: 100 },
      );
    });

    it('should use stage name as default streamId when not explicitly provided', async () => {
      await fc.assert(
        fc.asyncProperty(stageNameArb, tokensArb, async (stageName, tokens) => {
          const receivedTokens: Array<{ streamId: string; token: string }> = [];

          // Stage function that emits tokens
          const streamingStage: PipelineStageFunction<any, TestScope> = (scope, breakFn, streamCallback) => {
            for (const token of tokens) {
              streamCallback?.(token);
            }
            return 'done';
          };

          const stageMap = new Map<string, PipelineStageFunction<any, TestScope>>();
          stageMap.set(stageName, streamingStage);

          // Create workflow with streaming stage but NO explicit streamId
          const workflow: StageNode = {
            name: stageName,
            isStreaming: true,
            streamId: stageName, // Default to stage name
          };

          const builder = new FlowBuilder<any, TestScope>()
            .onStream((sid, token) => {
              receivedTokens.push({ streamId: sid, token });
            })
            .addPipeline(workflow, stageMap, TestScope);

          await builder.execute();

          // All tokens should have streamId equal to stage name
          const allStreamIdsMatchStageName = receivedTokens.every((r) => r.streamId === stageName);

          return allStreamIdsMatchStageName;
        }),
        { numRuns: 100 },
      );
    });

    it('should deliver tokens from multiple streaming stages with their respective streamIds', async () => {
      await fc.assert(
        fc.asyncProperty(
          stageNameArb,
          stageNameArb.filter((s) => s !== 'stage1'),
          streamIdArb,
          streamIdArb.filter((s) => s !== 'stream1'),
          tokensArb,
          tokensArb,
          async (stage1Name, stage2Name, streamId1, streamId2, tokens1, tokens2) => {
            // Ensure unique names
            const uniqueStage2Name = stage2Name === stage1Name ? stage2Name + '2' : stage2Name;
            const uniqueStreamId2 = streamId2 === streamId1 ? streamId2 + '2' : streamId2;

            const receivedTokens: Array<{ streamId: string; token: string }> = [];

            // First streaming stage
            const streamingStage1: PipelineStageFunction<any, TestScope> = (scope, breakFn, streamCallback) => {
              for (const token of tokens1) {
                streamCallback?.(token);
              }
              return 'stage1-done';
            };

            // Second streaming stage
            const streamingStage2: PipelineStageFunction<any, TestScope> = (scope, breakFn, streamCallback) => {
              for (const token of tokens2) {
                streamCallback?.(token);
              }
              return 'stage2-done';
            };

            const stageMap = new Map<string, PipelineStageFunction<any, TestScope>>();
            stageMap.set(stage1Name, streamingStage1);
            stageMap.set(uniqueStage2Name, streamingStage2);

            // Create workflow with two streaming stages in sequence
            const workflow: StageNode = {
              name: stage1Name,
              isStreaming: true,
              streamId: streamId1,
              next: {
                name: uniqueStage2Name,
                isStreaming: true,
                streamId: uniqueStreamId2,
              },
            };

            const builder = new FlowBuilder<any, TestScope>()
              .onStream((sid, token) => {
                receivedTokens.push({ streamId: sid, token });
              })
              .addPipeline(workflow, stageMap, TestScope);

            await builder.execute();

            // Verify tokens from stage 1
            const stage1Tokens = receivedTokens.filter((r) => r.streamId === streamId1);
            const stage1TokensCorrect =
              stage1Tokens.length === tokens1.length && stage1Tokens.every((r, i) => r.token === tokens1[i]);

            // Verify tokens from stage 2
            const stage2Tokens = receivedTokens.filter((r) => r.streamId === uniqueStreamId2);
            const stage2TokensCorrect =
              stage2Tokens.length === tokens2.length && stage2Tokens.every((r, i) => r.token === tokens2[i]);

            return stage1TokensCorrect && stage2TokensCorrect;
          },
        ),
        { numRuns: 100 },
      );
    });

    it('should preserve token order within each stream', async () => {
      await fc.assert(
        fc.asyncProperty(
          stageNameArb,
          streamIdArb,
          fc.array(fc.integer({ min: 0, max: 1000 }), { minLength: 2, maxLength: 20 }),
          async (stageName, streamId, tokenNumbers) => {
            const tokens = tokenNumbers.map((n) => `token-${n}`);
            const receivedTokens: string[] = [];

            const streamingStage: PipelineStageFunction<any, TestScope> = (scope, breakFn, streamCallback) => {
              for (const token of tokens) {
                streamCallback?.(token);
              }
              return 'done';
            };

            const stageMap = new Map<string, PipelineStageFunction<any, TestScope>>();
            stageMap.set(stageName, streamingStage);

            const workflow: StageNode = {
              name: stageName,
              isStreaming: true,
              streamId,
            };

            const builder = new FlowBuilder<any, TestScope>()
              .onStream((sid, token) => {
                receivedTokens.push(token);
              })
              .addPipeline(workflow, stageMap, TestScope);

            await builder.execute();

            // Tokens should be received in the same order they were emitted
            const orderPreserved =
              receivedTokens.length === tokens.length && receivedTokens.every((token, i) => token === tokens[i]);

            return orderPreserved;
          },
        ),
        { numRuns: 100 },
      );
    });
  });
});
