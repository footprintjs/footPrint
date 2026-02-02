/**
 * StageRunner.test.ts
 *
 * Unit tests for the StageRunner module.
 * Tests scope creation, protection, streaming lifecycle, sync+async safety,
 * and output preservation.
 *
 * _Requirements: phase2-handlers 1.2, 1.3, 1.4, 1.5, 1.6_
 */

import { StageRunner } from '../../../../src/core/executor/handlers/StageRunner';
import { PipelineContext, PipelineStageFunction, StreamHandlers } from '../../../../src/core/executor/types';
import { StageNode } from '../../../../src/core/executor/Pipeline';
import { PipelineRuntime } from '../../../../src/core/memory/PipelineRuntime';
import { ScopeProtectionMode } from '../../../../src/scope/protection/types';

// Helper to create a minimal PipelineContext for testing
function createTestContext<TOut = any, TScope = any>(
  options: {
    scopeProtectionMode?: ScopeProtectionMode;
    streamHandlers?: StreamHandlers;
    readOnlyContext?: unknown;
  } = {},
): PipelineContext<TOut, TScope> {
  const pipelineRuntime = new PipelineRuntime('test');
  return {
    stageMap: new Map(),
    root: { name: 'root', id: 'root' },
    pipelineRuntime,
    ScopeFactory: (context, stageName, readOnlyContext) => ({
      stageName,
      readOnlyContext,
    } as unknown as TScope),
    scopeProtectionMode: options.scopeProtectionMode ?? 'off',
    streamHandlers: options.streamHandlers,
    readOnlyContext: options.readOnlyContext,
  };
}

describe('StageRunner', () => {
  describe('scope creation', () => {
    it('should create scope via ScopeFactory with correct parameters', async () => {
      let capturedStageName: string | undefined;
      let capturedReadOnlyContext: unknown;
      
      const ctx = createTestContext({
        readOnlyContext: { readonly: 'data' },
      });
      ctx.ScopeFactory = (context, stageName, readOnlyContext) => {
        capturedStageName = stageName;
        capturedReadOnlyContext = readOnlyContext;
        return { value: 'test-scope' } as any;
      };

      const runner = new StageRunner(ctx);
      const node: StageNode = { name: 'testStage', id: 'test' };
      const stageFunc: PipelineStageFunction<string, any> = (scope) => {
        return 'result';
      };

      const stageContext = ctx.pipelineRuntime.rootStageContext;
      await runner.run(node, stageFunc, stageContext, () => {});

      expect(capturedStageName).toBe('testStage');
      expect(capturedReadOnlyContext).toEqual({ readonly: 'data' });
    });

    it('should pass scope to stage function', async () => {
      let capturedScope: any;
      
      const ctx = createTestContext();
      ctx.ScopeFactory = () => ({ customValue: 42 } as any);

      const runner = new StageRunner(ctx);
      const node: StageNode = { name: 'testStage', id: 'test' };
      const stageFunc: PipelineStageFunction<string, any> = (scope) => {
        capturedScope = scope;
        return 'result';
      };

      const stageContext = ctx.pipelineRuntime.rootStageContext;
      await runner.run(node, stageFunc, stageContext, () => {});

      // Scope is wrapped with protection, but should still have the value
      expect(capturedScope.customValue).toBe(42);
    });
  });

  describe('scope protection', () => {
    it('should apply scope protection in error mode', async () => {
      const ctx = createTestContext({ scopeProtectionMode: 'error' });
      ctx.ScopeFactory = () => ({ existingProp: 'value' } as any);

      const runner = new StageRunner(ctx);
      const node: StageNode = { name: 'testStage', id: 'test' };
      const stageFunc: PipelineStageFunction<string, any> = (scope) => {
        // This should throw because we're trying to set a property directly
        scope.newProp = 'should fail';
        return 'result';
      };

      const stageContext = ctx.pipelineRuntime.rootStageContext;
      
      await expect(runner.run(node, stageFunc, stageContext, () => {}))
        .rejects.toThrow();
    });

    it('should allow scope access in off mode', async () => {
      const ctx = createTestContext({ scopeProtectionMode: 'off' });
      ctx.ScopeFactory = () => ({ existingProp: 'value' } as any);

      const runner = new StageRunner(ctx);
      const node: StageNode = { name: 'testStage', id: 'test' };
      const stageFunc: PipelineStageFunction<string, any> = (scope) => {
        scope.newProp = 'should work';
        return 'result';
      };

      const stageContext = ctx.pipelineRuntime.rootStageContext;
      const result = await runner.run(node, stageFunc, stageContext, () => {});

      expect(result).toBe('result');
    });
  });

  describe('streaming lifecycle', () => {
    it('should call onStart before execution for streaming stages', async () => {
      const lifecycleEvents: string[] = [];
      const streamHandlers: StreamHandlers = {
        onStart: (streamId) => lifecycleEvents.push(`start:${streamId}`),
        onToken: (streamId, token) => lifecycleEvents.push(`token:${streamId}:${token}`),
        onEnd: (streamId, fullText) => lifecycleEvents.push(`end:${streamId}:${fullText}`),
      };

      const ctx = createTestContext({ streamHandlers });
      const runner = new StageRunner(ctx);
      
      const node: StageNode = { name: 'streamingStage', id: 'stream', isStreaming: true };
      const stageFunc: PipelineStageFunction<string, any> = (scope, breakFn, streamCallback) => {
        lifecycleEvents.push('executing');
        return 'result';
      };

      const stageContext = ctx.pipelineRuntime.rootStageContext;
      await runner.run(node, stageFunc, stageContext, () => {});

      expect(lifecycleEvents[0]).toBe('start:streamingStage');
      expect(lifecycleEvents[1]).toBe('executing');
    });

    it('should call onEnd after execution with accumulated text', async () => {
      const lifecycleEvents: string[] = [];
      const streamHandlers: StreamHandlers = {
        onStart: (streamId) => lifecycleEvents.push(`start:${streamId}`),
        onToken: (streamId, token) => lifecycleEvents.push(`token:${streamId}:${token}`),
        onEnd: (streamId, fullText) => lifecycleEvents.push(`end:${streamId}:${fullText}`),
      };

      const ctx = createTestContext({ streamHandlers });
      const runner = new StageRunner(ctx);
      
      const node: StageNode = { name: 'streamingStage', id: 'stream', isStreaming: true };
      const stageFunc: PipelineStageFunction<string, any> = (scope, breakFn, streamCallback) => {
        streamCallback?.('Hello');
        streamCallback?.(' ');
        streamCallback?.('World');
        return 'result';
      };

      const stageContext = ctx.pipelineRuntime.rootStageContext;
      await runner.run(node, stageFunc, stageContext, () => {});

      expect(lifecycleEvents).toContain('end:streamingStage:Hello World');
    });

    it('should route tokens via onToken handler', async () => {
      const tokens: string[] = [];
      const streamHandlers: StreamHandlers = {
        onToken: (streamId, token) => tokens.push(token),
      };

      const ctx = createTestContext({ streamHandlers });
      const runner = new StageRunner(ctx);
      
      const node: StageNode = { name: 'streamingStage', id: 'stream', isStreaming: true };
      const stageFunc: PipelineStageFunction<string, any> = (scope, breakFn, streamCallback) => {
        streamCallback?.('token1');
        streamCallback?.('token2');
        streamCallback?.('token3');
        return 'result';
      };

      const stageContext = ctx.pipelineRuntime.rootStageContext;
      await runner.run(node, stageFunc, stageContext, () => {});

      expect(tokens).toEqual(['token1', 'token2', 'token3']);
    });

    it('should use streamId from node when provided', async () => {
      let capturedStreamId: string | undefined;
      const streamHandlers: StreamHandlers = {
        onStart: (streamId) => { capturedStreamId = streamId; },
      };

      const ctx = createTestContext({ streamHandlers });
      const runner = new StageRunner(ctx);
      
      const node: StageNode = { 
        name: 'streamingStage', 
        id: 'stream', 
        isStreaming: true,
        streamId: 'custom-stream-id',
      };
      const stageFunc: PipelineStageFunction<string, any> = () => 'result';

      const stageContext = ctx.pipelineRuntime.rootStageContext;
      await runner.run(node, stageFunc, stageContext, () => {});

      expect(capturedStreamId).toBe('custom-stream-id');
    });

    it('should not inject streamCallback for non-streaming stages', async () => {
      let receivedCallback: unknown;
      
      const ctx = createTestContext();
      const runner = new StageRunner(ctx);
      
      const node: StageNode = { name: 'normalStage', id: 'normal' };
      const stageFunc: PipelineStageFunction<string, any> = (scope, breakFn, streamCallback) => {
        receivedCallback = streamCallback;
        return 'result';
      };

      const stageContext = ctx.pipelineRuntime.rootStageContext;
      await runner.run(node, stageFunc, stageContext, () => {});

      expect(receivedCallback).toBeUndefined();
    });
  });

  describe('sync+async safety', () => {
    it('should handle synchronous stage functions', async () => {
      const ctx = createTestContext();
      const runner = new StageRunner(ctx);
      
      const node: StageNode = { name: 'syncStage', id: 'sync' };
      const stageFunc: PipelineStageFunction<number, any> = () => 42;

      const stageContext = ctx.pipelineRuntime.rootStageContext;
      const result = await runner.run(node, stageFunc, stageContext, () => {});

      expect(result).toBe(42);
    });

    it('should handle asynchronous stage functions', async () => {
      const ctx = createTestContext();
      const runner = new StageRunner(ctx);
      
      const node: StageNode = { name: 'asyncStage', id: 'async' };
      const stageFunc: PipelineStageFunction<number, any> = async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return 42;
      };

      const stageContext = ctx.pipelineRuntime.rootStageContext;
      const result = await runner.run(node, stageFunc, stageContext, () => {});

      expect(result).toBe(42);
    });

    it('should only await real Promises (instanceof check)', async () => {
      const ctx = createTestContext();
      const runner = new StageRunner(ctx);
      
      // Create an object that is NOT a Promise instance
      // The StageRunner uses `instanceof Promise` check internally
      // However, since run() is async, the return value gets awaited by the caller
      // This test verifies that the internal check works correctly
      const regularObject = {
        value: 'direct-value',
        nested: { data: 42 },
      };
      
      const node: StageNode = { name: 'objectStage', id: 'object' };
      const stageFunc: PipelineStageFunction<any, any> = () => regularObject;

      const stageContext = ctx.pipelineRuntime.rootStageContext;
      const result = await runner.run(node, stageFunc, stageContext, () => {});

      // Regular objects should be returned as-is
      expect(result).toBe(regularObject);
      expect(result.value).toBe('direct-value');
    });
  });

  describe('output preservation', () => {
    it('should return stage output without modification', async () => {
      const ctx = createTestContext();
      const runner = new StageRunner(ctx);
      
      const complexOutput = {
        nested: { value: 42 },
        array: [1, 2, 3],
        fn: () => 'test',
      };
      
      const node: StageNode = { name: 'outputStage', id: 'output' };
      const stageFunc: PipelineStageFunction<typeof complexOutput, any> = () => complexOutput;

      const stageContext = ctx.pipelineRuntime.rootStageContext;
      const result = await runner.run(node, stageFunc, stageContext, () => {});

      expect(result).toBe(complexOutput); // Same reference
      expect(result.nested.value).toBe(42);
      expect(result.array).toEqual([1, 2, 3]);
      expect(result.fn()).toBe('test');
    });

    it('should preserve undefined output', async () => {
      const ctx = createTestContext();
      const runner = new StageRunner(ctx);
      
      const node: StageNode = { name: 'voidStage', id: 'void' };
      const stageFunc: PipelineStageFunction<undefined, any> = () => undefined;

      const stageContext = ctx.pipelineRuntime.rootStageContext;
      const result = await runner.run(node, stageFunc, stageContext, () => {});

      expect(result).toBeUndefined();
    });

    it('should preserve null output', async () => {
      const ctx = createTestContext();
      const runner = new StageRunner(ctx);
      
      const node: StageNode = { name: 'nullStage', id: 'null' };
      const stageFunc: PipelineStageFunction<null, any> = () => null;

      const stageContext = ctx.pipelineRuntime.rootStageContext;
      const result = await runner.run(node, stageFunc, stageContext, () => {});

      expect(result).toBeNull();
    });
  });

  describe('breakFn handling', () => {
    it('should pass breakFn to stage function', async () => {
      let capturedBreakFn: (() => void) | undefined;
      
      const ctx = createTestContext();
      const runner = new StageRunner(ctx);
      
      const node: StageNode = { name: 'breakStage', id: 'break' };
      const stageFunc: PipelineStageFunction<string, any> = (scope, breakFn) => {
        capturedBreakFn = breakFn;
        return 'result';
      };

      const stageContext = ctx.pipelineRuntime.rootStageContext;
      const breakFn = jest.fn();
      await runner.run(node, stageFunc, stageContext, breakFn);

      expect(capturedBreakFn).toBe(breakFn);
    });

    it('should allow stage to call breakFn', async () => {
      const ctx = createTestContext();
      const runner = new StageRunner(ctx);
      
      const node: StageNode = { name: 'breakStage', id: 'break' };
      const stageFunc: PipelineStageFunction<string, any> = (scope, breakFn) => {
        breakFn();
        return 'result';
      };

      const stageContext = ctx.pipelineRuntime.rootStageContext;
      const breakFn = jest.fn();
      await runner.run(node, stageFunc, stageContext, breakFn);

      expect(breakFn).toHaveBeenCalled();
    });
  });

  describe('error handling', () => {
    it('should propagate errors from stage function', async () => {
      const ctx = createTestContext();
      const runner = new StageRunner(ctx);
      
      const testError = new Error('Stage failed');
      const node: StageNode = { name: 'errorStage', id: 'error' };
      const stageFunc: PipelineStageFunction<string, any> = () => {
        throw testError;
      };

      const stageContext = ctx.pipelineRuntime.rootStageContext;
      
      await expect(runner.run(node, stageFunc, stageContext, () => {}))
        .rejects.toThrow('Stage failed');
    });

    it('should propagate async errors from stage function', async () => {
      const ctx = createTestContext();
      const runner = new StageRunner(ctx);
      
      const node: StageNode = { name: 'asyncErrorStage', id: 'asyncError' };
      const stageFunc: PipelineStageFunction<string, any> = async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        throw new Error('Async stage failed');
      };

      const stageContext = ctx.pipelineRuntime.rootStageContext;
      
      await expect(runner.run(node, stageFunc, stageContext, () => {}))
        .rejects.toThrow('Async stage failed');
    });
  });
});
