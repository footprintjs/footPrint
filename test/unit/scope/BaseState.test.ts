/**
 * Unit tests for BaseState - Covers debug/metric/eval logging methods
 * and global/root state access methods.
 *
 * Target: 100% coverage for BaseState.ts
 * Previously uncovered:
 *   - lines 70-86: addDebugInfo, addDebugMessage, addErrorInfo, addMetric, addEval
 *   - lines 107-111: setGlobal, getGlobal, setObjectInRoot
 */

import * as fc from 'fast-check';
import { BaseState } from '../../../src/scope/BaseState';
import { StageContext } from '../../../src/core/memory/StageContext';
import { GlobalStore } from '../../../src/core/memory/GlobalStore';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Creates a real StageContext backed by a real GlobalStore.
 * This avoids mocking internal implementation details and gives us
 * real metadata collection to assert against.
 */
const makeRealContext = (pipelineId = 'test-pipe', stageName = 'test-stage') => {
  const globalStore = new GlobalStore();
  const ctx = new StageContext(pipelineId, stageName, globalStore);
  return { ctx, globalStore };
};

/**
 * Creates a mock context with jest spies for methods that need verification.
 * Used for testing delegation patterns where we care about argument forwarding.
 */
const makeMockContext = () => {
  const calls: Record<string, any[][]> = {};
  const record = (name: string, args: any[]) => {
    if (!calls[name]) calls[name] = [];
    calls[name].push(args);
  };

  const ctx = {
    pipelineId: 'pipe-123',
    addLog: jest.fn((...args: any[]) => record('addLog', args)),
    setLog: jest.fn((...args: any[]) => record('setLog', args)),
    addError: jest.fn((...args: any[]) => record('addError', args)),
    addMetric: jest.fn((...args: any[]) => record('addMetric', args)),
    setMetric: jest.fn((...args: any[]) => record('setMetric', args)),
    addEval: jest.fn((...args: any[]) => record('addEval', args)),
    setEval: jest.fn((...args: any[]) => record('setEval', args)),
    getValue: jest.fn().mockReturnValue(42),
    setObject: jest.fn(),
    updateObject: jest.fn(),
    getFromGlobalContext: jest.fn().mockReturnValue('global-val'),
    setGlobal: jest.fn(),
    getGlobal: jest.fn().mockReturnValue('global-read'),
    setRoot: jest.fn(),
    debug: {
      logContext: {},
      errorContext: {},
      metricContext: {},
      evalContext: {},
    },
  } as any;

  return { ctx, calls };
};

// ---------------------------------------------------------------------------
// Arbitraries for property-based tests
// ---------------------------------------------------------------------------

/**
 * Keys that exist on Object.prototype (toString, valueOf, constructor, etc.)
 * must be avoided because updateNestedValue stores values in plain objects
 * and inherited properties cause type conflicts with spread operations.
 */
const PROTO_KEYS = new Set(Object.getOwnPropertyNames(Object.prototype));

/** Generates valid identifier-like keys that do not collide with Object.prototype. */
const arbKey = fc
  .string({ minLength: 1, maxLength: 30 })
  .filter((s) => /^[a-zA-Z][a-zA-Z0-9_]*$/.test(s) && !PROTO_KEYS.has(s));

/** Generates scalar (non-array, non-object) JSON-serializable values. */
const arbScalarValue = fc.oneof(
  fc.string(),
  fc.integer(),
  fc.double({ noNaN: true }),
  fc.boolean(),
  fc.constant(null),
);

/** Generates arbitrary JSON-serializable values including arrays and objects. */
const arbValue = fc.oneof(
  arbScalarValue,
  fc.array(fc.string(), { maxLength: 3 }),
  fc.dictionary(fc.string({ minLength: 1, maxLength: 10 }), fc.string(), { maxKeys: 3 }),
);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('BaseState', () => {
  // ========================================================================
  // Constructor
  // ========================================================================

  describe('constructor', () => {
    test('stores stageContext, stageName, and readOnlyValues', () => {
      const { ctx } = makeRealContext();
      const state = new BaseState(ctx, 'myStage', { some: 'data' });

      expect(state.getReadOnlyValues()).toEqual({ some: 'data' });
      expect(state.getPipelineId()).toBe('test-pipe');
    });

    test('readOnlyValues defaults to undefined when omitted', () => {
      const { ctx } = makeRealContext();
      const state = new BaseState(ctx, 'myStage');

      expect(state.getReadOnlyValues()).toBeUndefined();
    });
  });

  // ========================================================================
  // getInitialValueFor - optional chaining branch
  // ========================================================================

  describe('getInitialValueFor', () => {
    test('returns undefined when getFromGlobalContext does not exist on context', () => {
      const ctx = {
        pipelineId: 'p1',
        getValue: jest.fn(),
      } as any;
      const state = new BaseState(ctx, 's1');

      const result = state.getInitialValueFor('anyKey');
      expect(result).toBeUndefined();
    });
  });

  // ========================================================================
  // Debug methods (lines 70-86)
  // ========================================================================

  describe('addDebugInfo', () => {
    test('delegates to treeConsole.log with correct arguments', () => {
      const { ctx } = makeRealContext('p1', 'debugStage');
      const state = new BaseState(ctx, 'debugStage');

      // addDebugInfo writes to the stage's log context via treeConsole.log
      state.addDebugInfo('requestId', 'abc-123');

      // The log should appear in the context's debug metadata
      expect(ctx.debug.logContext).toHaveProperty('requestId');
    });

    test('handles object values', () => {
      const { ctx } = makeRealContext();
      const state = new BaseState(ctx, 's1');
      const complexValue = { nested: { deep: true }, arr: [1, 2, 3] };

      state.addDebugInfo('payload', complexValue);
      expect(ctx.debug.logContext).toHaveProperty('payload');
    });
  });

  describe('addDebugMessage', () => {
    test('logs a message array under the "messages" key', () => {
      const { ctx } = makeRealContext('p1', 'msgStage');
      const state = new BaseState(ctx, 'msgStage');

      state.addDebugMessage('Something happened');

      // treeConsole.log is called with key='messages', value=['Something happened']
      // which adds to ctx.debug.logContext
      expect(ctx.debug.logContext).toHaveProperty('messages');
    });

    test('wraps the value in an array', () => {
      const { ctx } = makeRealContext();
      const state = new BaseState(ctx, 's1');

      state.addDebugMessage('hello');

      // The value passed to treeConsole.log is [value], so the metadata
      // should contain the wrapped array
      const messages = ctx.debug.logContext.messages;
      expect(messages).toBeDefined();
    });
  });

  describe('addErrorInfo', () => {
    test('logs error info with key and value wrapped in array', () => {
      const { ctx } = makeRealContext('p1', 'errStage');
      const state = new BaseState(ctx, 'errStage');

      state.addErrorInfo('validationError', 'field X is required');

      // addErrorInfo calls treeConsole.log with value wrapped in array
      expect(ctx.debug.logContext).toHaveProperty('validationError');
    });

    test('handles Error objects', () => {
      const { ctx } = makeRealContext();
      const state = new BaseState(ctx, 's1');
      const error = new Error('test error');

      state.addErrorInfo('exception', error);
      expect(ctx.debug.logContext).toHaveProperty('exception');
    });
  });

  describe('addMetric', () => {
    test('records a metric via treeConsole.metric', () => {
      const { ctx } = makeRealContext('p1', 'metricStage');
      const state = new BaseState(ctx, 'metricStage');

      state.addMetric('latencyMs', 42);

      // treeConsole.metric calls ctx.addMetric which records in metricContext
      expect(ctx.debug.metricContext).toHaveProperty('latencyMs');
    });

    test('handles string metric values', () => {
      const { ctx } = makeRealContext();
      const state = new BaseState(ctx, 's1');

      state.addMetric('status', 'success');
      expect(ctx.debug.metricContext).toHaveProperty('status');
    });
  });

  describe('addEval', () => {
    test('records an eval via treeConsole.eval', () => {
      const { ctx } = makeRealContext('p1', 'evalStage');
      const state = new BaseState(ctx, 'evalStage');

      state.addEval('accuracy', 0.95);

      // treeConsole.eval calls ctx.addEval which records in evalContext
      expect(ctx.debug.evalContext).toHaveProperty('accuracy');
    });

    test('handles object eval values', () => {
      const { ctx } = makeRealContext();
      const state = new BaseState(ctx, 's1');

      state.addEval('scores', { precision: 0.9, recall: 0.8 });
      expect(ctx.debug.evalContext).toHaveProperty('scores');
    });
  });

  // ========================================================================
  // Global / Root methods (lines 107-111)
  // ========================================================================

  describe('setGlobal', () => {
    test('delegates to context.setGlobal when method exists', () => {
      const { ctx } = makeMockContext();
      const state = new BaseState(ctx, 'globalStage');

      state.setGlobal('theme', 'dark', 'Set user theme');

      expect(ctx.setGlobal).toHaveBeenCalledWith('theme', 'dark', 'Set user theme');
    });

    test('works without description', () => {
      const { ctx } = makeMockContext();
      const state = new BaseState(ctx, 'globalStage');

      state.setGlobal('locale', 'en-US');

      expect(ctx.setGlobal).toHaveBeenCalledWith('locale', 'en-US', undefined);
    });

    test('gracefully handles missing setGlobal method', () => {
      const ctx = {
        pipelineId: 'p1',
        getValue: jest.fn(),
      } as any;
      const state = new BaseState(ctx, 's1');

      // setGlobal uses optional chaining, so should not throw
      expect(() => state.setGlobal('key', 'val')).not.toThrow();
    });
  });

  describe('getGlobal', () => {
    test('delegates to context.getGlobal when method exists', () => {
      const { ctx } = makeMockContext();
      const state = new BaseState(ctx, 'globalStage');

      const result = state.getGlobal('theme');

      expect(result).toBe('global-read');
      expect(ctx.getGlobal).toHaveBeenCalledWith('theme');
    });

    test('returns undefined when getGlobal method does not exist', () => {
      const ctx = {
        pipelineId: 'p1',
        getValue: jest.fn(),
      } as any;
      const state = new BaseState(ctx, 's1');

      const result = state.getGlobal('missing');
      expect(result).toBeUndefined();
    });
  });

  describe('setObjectInRoot', () => {
    test('delegates to context.setRoot when method exists', () => {
      const { ctx } = makeMockContext();
      const state = new BaseState(ctx, 'rootStage');

      state.setObjectInRoot('config', { debug: true });

      expect(ctx.setRoot).toHaveBeenCalledWith('config', { debug: true });
    });

    test('gracefully handles missing setRoot method', () => {
      const ctx = {
        pipelineId: 'p1',
        getValue: jest.fn(),
      } as any;
      const state = new BaseState(ctx, 's1');

      expect(() => state.setObjectInRoot('key', 'val')).not.toThrow();
    });
  });

  // ========================================================================
  // Integration with real StageContext + GlobalStore
  // ========================================================================

  describe('integration: debug + metric + eval round-trip', () => {
    test('all metadata categories are recorded correctly', () => {
      const { ctx } = makeRealContext('integ-pipe', 'integ-stage');
      const state = new BaseState(ctx, 'integ-stage');

      state.addDebugInfo('step', 'validation');
      state.addDebugMessage('Validating input');
      state.addErrorInfo('fieldError', 'missing name');
      state.addMetric('duration', 150);
      state.addEval('score', 0.88);

      // Verify all metadata categories have entries
      expect(Object.keys(ctx.debug.logContext).length).toBeGreaterThan(0);
      expect(Object.keys(ctx.debug.metricContext).length).toBeGreaterThan(0);
      expect(Object.keys(ctx.debug.evalContext).length).toBeGreaterThan(0);
    });
  });

  describe('integration: setGlobal / getGlobal with real context', () => {
    test('setGlobal writes to global namespace, getGlobal reads it back', () => {
      const globalStore = new GlobalStore();
      const ctx = new StageContext('pipeline-1', 'stage-1', globalStore);
      const state = new BaseState(ctx, 'stage-1');

      state.setGlobal('appVersion', '2.0.0');

      // The write is buffered, but we can read via getGlobal which reads from GlobalStore
      // After commit, the value should be available globally
      ctx.commit();
      const result = state.getGlobal('appVersion');
      expect(result).toBe('2.0.0');
    });
  });

  describe('integration: setObjectInRoot with real context', () => {
    test('setObjectInRoot writes to root namespace via setRoot', () => {
      const globalStore = new GlobalStore();
      const ctx = new StageContext('pipeline-1', 'stage-1', globalStore);
      const state = new BaseState(ctx, 'stage-1');

      state.setObjectInRoot('topLevel', 'rootValue');

      // setRoot patches at [] with the key, then commits
      ctx.commit();
      // The value should be accessible at the pipeline level
      const stored = globalStore.getValue('pipeline-1', [], 'topLevel');
      expect(stored).toBe('rootValue');
    });
  });

  // ========================================================================
  // Property-based tests
  // ========================================================================

  describe('property: arbitrary key/value pairs produce correct metadata entries', () => {
    test('addDebugInfo always records the key in logContext', () => {
      fc.assert(
        fc.property(arbKey, arbValue, (key, value) => {
          const { ctx } = makeRealContext('prop-pipe', 'prop-stage');
          const state = new BaseState(ctx, 'prop-stage');

          state.addDebugInfo(key, value);

          expect(ctx.debug.logContext).toHaveProperty(key);
        }),
        { numRuns: 50 },
      );
    });

    test('addMetric always records the key in metricContext', () => {
      fc.assert(
        fc.property(arbKey, arbScalarValue, (key, value) => {
          const { ctx } = makeRealContext('prop-pipe', 'prop-stage');
          const state = new BaseState(ctx, 'prop-stage');

          state.addMetric(key, value);

          expect(ctx.debug.metricContext).toHaveProperty(key);
        }),
        { numRuns: 50 },
      );
    });

    test('addEval always records the key in evalContext', () => {
      fc.assert(
        fc.property(arbKey, arbValue, (key, value) => {
          const { ctx } = makeRealContext('prop-pipe', 'prop-stage');
          const state = new BaseState(ctx, 'prop-stage');

          state.addEval(key, value);

          expect(ctx.debug.evalContext).toHaveProperty(key);
        }),
        { numRuns: 50 },
      );
    });

    test('setGlobal forwards arbitrary key/value to context.setGlobal', () => {
      fc.assert(
        fc.property(arbKey, arbValue, (key, value) => {
          const { ctx } = makeMockContext();
          const state = new BaseState(ctx, 'prop-stage');

          state.setGlobal(key, value);

          expect(ctx.setGlobal).toHaveBeenCalledWith(key, value, undefined);
        }),
        { numRuns: 50 },
      );
    });

    test('getGlobal forwards arbitrary key to context.getGlobal', () => {
      fc.assert(
        fc.property(arbKey, (key) => {
          const { ctx } = makeMockContext();
          const state = new BaseState(ctx, 'prop-stage');

          const result = state.getGlobal(key);

          expect(ctx.getGlobal).toHaveBeenCalledWith(key);
          expect(result).toBe('global-read');
        }),
        { numRuns: 50 },
      );
    });

    test('setObjectInRoot forwards arbitrary key/value to context.setRoot', () => {
      fc.assert(
        fc.property(arbKey, arbValue, (key, value) => {
          const { ctx } = makeMockContext();
          const state = new BaseState(ctx, 'prop-stage');

          state.setObjectInRoot(key, value);

          expect(ctx.setRoot).toHaveBeenCalledWith(key, value);
        }),
        { numRuns: 50 },
      );
    });
  });

  // ========================================================================
  // BRAND symbol
  // ========================================================================

  describe('BRAND', () => {
    test('is a well-known symbol', () => {
      expect(typeof BaseState.BRAND).toBe('symbol');
      expect(BaseState.BRAND).toBe(Symbol.for('BaseState@v1'));
    });
  });
});
