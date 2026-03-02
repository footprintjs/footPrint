/**
 * SubflowInputMapper.test.ts
 *
 * Unit tests for the SubflowInputMapper module.
 * Tests input/output mapping helpers for subflow execution.
 *
 * **Property 11: Helper Function Round-Trip**
 * **Validates: Requirements 8.1, 8.2, 8.3**
 */

import {
  extractParentScopeValues,
  getInitialScopeValues,
  seedSubflowGlobalStore,
  applyOutputMapping,
  createSubflowPipelineContext,
} from '../../../../src/core/executor/handlers/SubflowInputMapper';
import { SubflowMountOptions, PipelineContext } from '../../../../src/core/executor/types';
import { PipelineRuntime } from '../../../../src/core/memory/PipelineRuntime';
import { StageContext } from '../../../../src/core/memory/StageContext';

describe('SubflowInputMapper', () => {
  describe('extractParentScopeValues', () => {
    it('should return empty object when no options provided', () => {
      const parentScope = { foo: 'bar', count: 42 };
      const result = extractParentScopeValues(parentScope);
      expect(result).toEqual({});
    });

    it('should return empty object when no inputMapper provided', () => {
      const parentScope = { foo: 'bar', count: 42 };
      const options: SubflowMountOptions = {};
      const result = extractParentScopeValues(parentScope, options);
      expect(result).toEqual({});
    });

    it('should call inputMapper with parent scope and return result', () => {
      const parentScope = { userQuestion: 'Hello', sessionId: 'abc123' };
      const options: SubflowMountOptions = {
        inputMapper: (scope) => ({
          question: scope.userQuestion,
          id: scope.sessionId,
        }),
      };
      const result = extractParentScopeValues(parentScope, options);
      expect(result).toEqual({ question: 'Hello', id: 'abc123' });
    });

    it('should handle inputMapper returning null', () => {
      const parentScope = { foo: 'bar' };
      const options: SubflowMountOptions = {
        inputMapper: () => null as any,
      };
      const result = extractParentScopeValues(parentScope, options);
      expect(result).toEqual({});
    });

    it('should handle inputMapper returning undefined', () => {
      const parentScope = { foo: 'bar' };
      const options: SubflowMountOptions = {
        inputMapper: () => undefined as any,
      };
      const result = extractParentScopeValues(parentScope, options);
      expect(result).toEqual({});
    });

    it('should pass through complex nested objects', () => {
      const parentScope = {
        contexts: [{ id: 1, data: 'a' }, { id: 2, data: 'b' }],
        config: { nested: { deep: true } },
      };
      const options: SubflowMountOptions = {
        inputMapper: (scope) => ({
          allContexts: scope.contexts,
          settings: scope.config,
        }),
      };
      const result = extractParentScopeValues(parentScope, options);
      expect(result).toEqual({
        allContexts: [{ id: 1, data: 'a' }, { id: 2, data: 'b' }],
        settings: { nested: { deep: true } },
      });
    });
  });

  describe('getInitialScopeValues', () => {
    describe('isolated mode (always)', () => {
      it('should return only inputMapper values', () => {
        const parentScope = { foo: 'bar', baz: 'qux', extra: 'ignored' };
        const options: SubflowMountOptions = {
          inputMapper: (scope) => ({ foo: scope.foo }),
        };
        const result = getInitialScopeValues(parentScope, options);
        expect(result).toEqual({ foo: 'bar' });
        expect(result).not.toHaveProperty('baz');
        expect(result).not.toHaveProperty('extra');
      });

      it('should return empty object when no inputMapper provided', () => {
        const parentScope = { foo: 'bar', baz: 'qux' };
        const options: SubflowMountOptions = {};
        const result = getInitialScopeValues(parentScope, options);
        expect(result).toEqual({});
      });

      it('should return empty object when no options provided', () => {
        const parentScope = { foo: 'bar' };
        const result = getInitialScopeValues(parentScope);
        expect(result).toEqual({});
      });

      it('should handle complex inputMapper transformations', () => {
        const parentScope = { 
          userQuestion: 'Hello', 
          sessionContexts: [{ id: 1 }],
          ignoredField: 'not passed'
        };
        const options: SubflowMountOptions = {
          inputMapper: (scope) => ({
            question: scope.userQuestion,
            contexts: scope.sessionContexts,
          }),
        };
        const result = getInitialScopeValues(parentScope, options);
        expect(result).toEqual({
          question: 'Hello',
          contexts: [{ id: 1 }],
        });
        expect(result).not.toHaveProperty('ignoredField');
      });
    });
  });

  describe('seedSubflowGlobalStore', () => {
    it('should seed values to GlobalStore via root context', () => {
      const runtime = new PipelineRuntime('test-subflow');
      const initialValues = { userQuestion: 'Hello', sessionId: 'abc123' };

      seedSubflowGlobalStore(runtime, initialValues);

      // Verify values are accessible via root context's getGlobal
      const rootContext = runtime.rootStageContext;
      expect(rootContext.getGlobal('userQuestion')).toBe('Hello');
      expect(rootContext.getGlobal('sessionId')).toBe('abc123');
    });

    it('should handle empty initial values', () => {
      const runtime = new PipelineRuntime('test-subflow');
      const initialValues = {};

      // Should not throw
      expect(() => seedSubflowGlobalStore(runtime, initialValues)).not.toThrow();
    });

    it('should handle complex nested values', () => {
      const runtime = new PipelineRuntime('test-subflow');
      const initialValues = {
        contexts: [{ id: 1 }, { id: 2 }],
        config: { nested: { deep: true } },
      };

      seedSubflowGlobalStore(runtime, initialValues);

      const rootContext = runtime.rootStageContext;
      expect(rootContext.getGlobal('contexts')).toEqual([{ id: 1 }, { id: 2 }]);
      expect(rootContext.getGlobal('config')).toEqual({ nested: { deep: true } });
    });

    it('should make values visible immediately (committed)', () => {
      const runtime = new PipelineRuntime('test-subflow');
      const initialValues = { key: 'value' };

      seedSubflowGlobalStore(runtime, initialValues);

      // Create a child context and verify it can see the value
      const childContext = runtime.rootStageContext.createNext('', 'child');
      expect(childContext.getGlobal('key')).toBe('value');
    });
  });

  describe('applyOutputMapping', () => {
    let parentRuntime: PipelineRuntime;
    let parentContext: StageContext;

    beforeEach(() => {
      parentRuntime = new PipelineRuntime('parent');
      parentContext = parentRuntime.rootStageContext;
    });

    it('should return undefined when no options provided', () => {
      const result = applyOutputMapping('output', { foo: 'bar' }, parentContext);
      expect(result).toBeUndefined();
    });

    it('should return undefined when no outputMapper provided', () => {
      const options: SubflowMountOptions = {};
      const result = applyOutputMapping('output', { foo: 'bar' }, parentContext, options);
      expect(result).toBeUndefined();
    });

    it('should call outputMapper and write values to parent context', () => {
      const subflowOutput = { result: 'success', data: [1, 2, 3] };
      const parentScope = { existingKey: 'value' };
      const options: SubflowMountOptions = {
        outputMapper: (output, scope) => ({
          subflowResult: output.result,
          subflowData: output.data,
        }),
      };

      const result = applyOutputMapping(subflowOutput, parentScope, parentContext, options);

      expect(result).toEqual({
        subflowResult: 'success',
        subflowData: [1, 2, 3],
      });
      
      // Commit to make values visible
      parentContext.commit();
      
      expect(parentContext.getGlobal('subflowResult')).toBe('success');
      expect(parentContext.getGlobal('subflowData')).toEqual([1, 2, 3]);
    });

    it('should pass parent scope to outputMapper for context', () => {
      const subflowOutput = { count: 5 };
      const parentScope = { multiplier: 10 };
      const options: SubflowMountOptions = {
        outputMapper: (output, scope) => ({
          total: output.count * scope.multiplier,
        }),
      };

      const result = applyOutputMapping(subflowOutput, parentScope, parentContext, options);

      expect(result).toEqual({ total: 50 });
      
      // Commit to make values visible
      parentContext.commit();
      
      expect(parentContext.getGlobal('total')).toBe(50);
    });

    it('should handle outputMapper returning null', () => {
      const options: SubflowMountOptions = {
        outputMapper: () => null as any,
      };

      const result = applyOutputMapping('output', {}, parentContext, options);
      expect(result).toBeUndefined();
    });

    it('should handle outputMapper returning undefined', () => {
      const options: SubflowMountOptions = {
        outputMapper: () => undefined as any,
      };

      const result = applyOutputMapping('output', {}, parentContext, options);
      expect(result).toBeUndefined();
    });
  });

  describe('createSubflowPipelineContext', () => {
    let parentRuntime: PipelineRuntime;
    let parentCtx: PipelineContext;

    beforeEach(() => {
      parentRuntime = new PipelineRuntime('parent');
      parentCtx = {
        stageMap: new Map([['stage1', async () => 'result']]),
        root: { name: 'root' },
        pipelineRuntime: parentRuntime,
        ScopeFactory: (core, stageName, readOnlyContext) => {
          const ctx = readOnlyContext as Record<string, unknown> | undefined;
          return { ...ctx } as any;
        },
        subflows: { 'subflow1': { root: { name: 'subflow1-root' } } },
        throttlingErrorChecker: (err) => false,
        streamHandlers: { onToken: () => {} },
        scopeProtectionMode: 'warn',
        readOnlyContext: { parentValue: 'original' },
      };
    });

    it('should return context with readOnlyContext set to mappedInput', () => {
      const subflowRuntime = new PipelineRuntime('subflow');
      const mappedInput = { question: 'Hello', sessionId: 'abc123' };

      const result = createSubflowPipelineContext(parentCtx, subflowRuntime, mappedInput);

      expect(result.readOnlyContext).toEqual(mappedInput);
      expect(result.readOnlyContext).not.toBe(parentCtx.readOnlyContext);
    });

    it('should use subflow runtime instead of parent runtime', () => {
      const subflowRuntime = new PipelineRuntime('subflow');
      const mappedInput = { key: 'value' };

      const result = createSubflowPipelineContext(parentCtx, subflowRuntime, mappedInput);

      expect(result.pipelineRuntime).toBe(subflowRuntime);
      expect(result.pipelineRuntime).not.toBe(parentCtx.pipelineRuntime);
    });

    it('should copy stageMap from parent context', () => {
      const subflowRuntime = new PipelineRuntime('subflow');
      const mappedInput = {};

      const result = createSubflowPipelineContext(parentCtx, subflowRuntime, mappedInput);

      expect(result.stageMap).toBe(parentCtx.stageMap);
    });

    it('should copy root from parent context', () => {
      const subflowRuntime = new PipelineRuntime('subflow');
      const mappedInput = {};

      const result = createSubflowPipelineContext(parentCtx, subflowRuntime, mappedInput);

      expect(result.root).toBe(parentCtx.root);
    });

    it('should copy ScopeFactory from parent context', () => {
      const subflowRuntime = new PipelineRuntime('subflow');
      const mappedInput = {};

      const result = createSubflowPipelineContext(parentCtx, subflowRuntime, mappedInput);

      expect(result.ScopeFactory).toBe(parentCtx.ScopeFactory);
    });

    it('should copy subflows from parent context', () => {
      const subflowRuntime = new PipelineRuntime('subflow');
      const mappedInput = {};

      const result = createSubflowPipelineContext(parentCtx, subflowRuntime, mappedInput);

      expect(result.subflows).toBe(parentCtx.subflows);
    });

    it('should copy throttlingErrorChecker from parent context', () => {
      const subflowRuntime = new PipelineRuntime('subflow');
      const mappedInput = {};

      const result = createSubflowPipelineContext(parentCtx, subflowRuntime, mappedInput);

      expect(result.throttlingErrorChecker).toBe(parentCtx.throttlingErrorChecker);
    });

    it('should copy streamHandlers from parent context', () => {
      const subflowRuntime = new PipelineRuntime('subflow');
      const mappedInput = {};

      const result = createSubflowPipelineContext(parentCtx, subflowRuntime, mappedInput);

      expect(result.streamHandlers).toBe(parentCtx.streamHandlers);
    });

    it('should copy scopeProtectionMode from parent context', () => {
      const subflowRuntime = new PipelineRuntime('subflow');
      const mappedInput = {};

      const result = createSubflowPipelineContext(parentCtx, subflowRuntime, mappedInput);

      expect(result.scopeProtectionMode).toBe(parentCtx.scopeProtectionMode);
    });

    it('should handle empty mappedInput', () => {
      const subflowRuntime = new PipelineRuntime('subflow');
      const mappedInput = {};

      const result = createSubflowPipelineContext(parentCtx, subflowRuntime, mappedInput);

      expect(result.readOnlyContext).toEqual({});
    });

    it('should handle complex nested mappedInput', () => {
      const subflowRuntime = new PipelineRuntime('subflow');
      const mappedInput = {
        contexts: [{ id: 1, data: 'a' }, { id: 2, data: 'b' }],
        config: { nested: { deep: true } },
        primitives: { str: 'hello', num: 42, bool: true },
      };

      const result = createSubflowPipelineContext(parentCtx, subflowRuntime, mappedInput);

      expect(result.readOnlyContext).toEqual(mappedInput);
    });

    it('should work with ScopeFactory to create scope with mappedInput values', () => {
      const subflowRuntime = new PipelineRuntime('subflow');
      const mappedInput = { question: 'Hello', sessionId: 'abc123' };

      const result = createSubflowPipelineContext(parentCtx, subflowRuntime, mappedInput);

      // Simulate what StageRunner does: call ScopeFactory with readOnlyContext
      const mockContext = {} as StageContext;
      const scope = result.ScopeFactory(mockContext, 'testStage', result.readOnlyContext);
      
      expect(scope.question).toBe('Hello');
      expect(scope.sessionId).toBe('abc123');
    });
  });

  describe('Property 11: Helper Function Round-Trip', () => {
    it('should preserve all inputMapper values through getInitialScopeValues + seedSubflowGlobalStore', () => {
      // Setup parent scope and inputMapper
      const parentScope = {
        userQuestion: 'What is the weather?',
        sessionContexts: [{ id: 1, text: 'context1' }],
        pinnedContext: { important: true },
        ignoredField: 'should not appear',
      };
      const options: SubflowMountOptions = {
        inputMapper: (scope) => ({
          question: scope.userQuestion,
          contexts: scope.sessionContexts,
          pinned: scope.pinnedContext,
        }),
      };

      // Step 1: Get initial values
      const initialValues = getInitialScopeValues(parentScope, options);

      // Step 2: Seed to subflow GlobalStore
      const subflowRuntime = new PipelineRuntime('subflow');
      seedSubflowGlobalStore(subflowRuntime, initialValues);

      // Verify: All keys from inputMapper output are accessible with original values
      const rootContext = subflowRuntime.rootStageContext;
      expect(rootContext.getGlobal('question')).toBe('What is the weather?');
      expect(rootContext.getGlobal('contexts')).toEqual([{ id: 1, text: 'context1' }]);
      expect(rootContext.getGlobal('pinned')).toEqual({ important: true });

      // Verify: Ignored field is NOT present
      expect(rootContext.getGlobal('ignoredField')).toBeUndefined();
    });

    it('should preserve inputMapper values through createSubflowPipelineContext', () => {
      // Setup parent context
      const parentRuntime = new PipelineRuntime('parent');
      const parentCtx: PipelineContext = {
        stageMap: new Map(),
        root: { name: 'root' },
        pipelineRuntime: parentRuntime,
        ScopeFactory: (core, stageName, readOnlyContext) => {
          const ctx = readOnlyContext as Record<string, unknown> | undefined;
          return { ...ctx } as any;
        },
        scopeProtectionMode: 'warn',
        readOnlyContext: { parentValue: 'original' },
      };

      // Setup parent scope and inputMapper
      const parentScope = {
        userQuestion: 'What is the weather?',
        sessionContexts: [{ id: 1, text: 'context1' }],
      };
      const options: SubflowMountOptions = {
        inputMapper: (scope) => ({
          question: scope.userQuestion,
          contexts: scope.sessionContexts,
        }),
      };

      // Step 1: Get initial values (mappedInput)
      const mappedInput = getInitialScopeValues(parentScope, options);

      // Step 2: Create subflow context
      const subflowRuntime = new PipelineRuntime('subflow');
      const subflowCtx = createSubflowPipelineContext(parentCtx, subflowRuntime, mappedInput);

      // Step 3: Simulate StageRunner creating scope via ScopeFactory
      const mockContext = {} as StageContext;
      const scope = subflowCtx.ScopeFactory(mockContext, 'testStage', subflowCtx.readOnlyContext);

      // Verify: Scope contains inputMapper values
      expect(scope.question).toBe('What is the weather?');
      expect(scope.contexts).toEqual([{ id: 1, text: 'context1' }]);

      // Verify: Parent's readOnlyContext is NOT in scope
      expect(scope.parentValue).toBeUndefined();
    });
  });
});
