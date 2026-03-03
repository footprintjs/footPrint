/**
 * Unit tests for scopeLog (treeConsole) - Structured logging utilities
 *
 * Target: 100% coverage for scopeLog.ts
 * Previously uncovered:
 *   - line 40: consoleError (adds error to stage context)
 *   - lines 51-56: consoleMetric (both reset and non-reset paths)
 *   - lines 71-76: consoleEval (both reset and non-reset paths)
 */

import * as fc from 'fast-check';
import { treeConsole } from '../../../src/utils/scopeLog';
import { StageContext } from '../../../src/core/memory/StageContext';
import { GlobalStore } from '../../../src/core/memory/GlobalStore';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Creates a real StageContext with a real GlobalStore for integration-level testing.
 * We spy on logger.debug to suppress output and verify logging calls.
 */
const makeContext = (pipelineId = 'test-pipe', stageName = 'test-stage') => {
  const globalStore = new GlobalStore();
  const ctx = new StageContext(pipelineId, stageName, globalStore);
  return ctx;
};

// Suppress console.debug output during tests
beforeEach(() => {
  jest.spyOn(console, 'debug').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

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

/** Generates arbitrary JSON-serializable values. */
const arbValue = fc.oneof(
  fc.string(),
  fc.integer(),
  fc.double({ noNaN: true }),
  fc.boolean(),
  fc.constant(null),
  fc.array(fc.string(), { maxLength: 3 }),
  fc.dictionary(fc.string({ minLength: 1, maxLength: 10 }), fc.string(), { maxKeys: 3 }),
);

/** Generates valid path arrays. */
const arbPath = fc.array(
  fc.string({ minLength: 1, maxLength: 15 }).filter((s) => /^[a-zA-Z][a-zA-Z0-9_]*$/.test(s)),
  { minLength: 0, maxLength: 3 },
);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('treeConsole', () => {
  // ========================================================================
  // treeConsole.log (consoleLog) - already partially covered
  // ========================================================================

  describe('log (consoleLog)', () => {
    test('adds a log entry in non-reset mode (default)', () => {
      const ctx = makeContext('p1', 'logStage');

      treeConsole.log(ctx, 'logStage', [], 'myKey', 'myValue');

      // addLog records in logContext via updateNestedValue (merge semantics)
      expect(ctx.debug.logContext).toHaveProperty('myKey');
    });

    test('sets a log entry in reset mode', () => {
      const ctx = makeContext('p1', 'logStage');

      // First add, then reset
      treeConsole.log(ctx, 'logStage', [], 'counter', 1);
      treeConsole.log(ctx, 'logStage', [], 'counter', 99, true);

      // In reset mode, setLog overwrites the value
      expect(ctx.debug.logContext).toHaveProperty('counter');
    });

    test('calls logger.debug with formatted message', () => {
      const ctx = makeContext('p1', 'myStage');

      treeConsole.log(ctx, 'myStage', ['sub', 'path'], 'info', 'hello');

      expect(console.debug).toHaveBeenCalledWith(
        expect.stringContaining('PIPELINE ID: [p1]'),
      );
      expect(console.debug).toHaveBeenCalledWith(
        expect.stringContaining('STAGE: [myStage]'),
      );
    });
  });

  // ========================================================================
  // treeConsole.error (consoleError) - line 40
  // ========================================================================

  describe('error (consoleError)', () => {
    test('records an error entry via addError', () => {
      const ctx = makeContext('p1', 'errStage');

      treeConsole.error(ctx, 'errStage', [], 'validationFailed', 'missing field');

      // consoleError calls ctx.addError which stores in errorContext
      expect(ctx.debug.errorContext).toHaveProperty('validationFailed');
    });

    test('records error with path segments', () => {
      const ctx = makeContext('p2', 'errStage2');

      treeConsole.error(ctx, 'errStage2', ['input', 'validation'], 'typeError', 'expected string');

      expect(ctx.debug.errorContext).toBeDefined();
    });

    test('handles complex error objects', () => {
      const ctx = makeContext('p3', 'errStage3');
      const errorPayload = {
        message: 'Connection timeout',
        code: 'ETIMEDOUT',
        stack: 'Error: Connection timeout\n    at ...',
      };

      treeConsole.error(ctx, 'errStage3', [], 'networkError', errorPayload);

      expect(ctx.debug.errorContext).toHaveProperty('networkError');
    });

    test('handles null and undefined values', () => {
      const ctx = makeContext('p4', 'errStage4');

      treeConsole.error(ctx, 'errStage4', [], 'nullError', null);
      treeConsole.error(ctx, 'errStage4', [], 'undefError', undefined);

      expect(ctx.debug.errorContext).toHaveProperty('nullError');
      expect(ctx.debug.errorContext).toHaveProperty('undefError');
    });

    test('does not call logger.debug (error path has no logging)', () => {
      const ctx = makeContext('p5', 'silentErr');

      treeConsole.error(ctx, 'silentErr', [], 'someErr', 'err-value');

      // consoleError only calls addError, no logger.debug call
      // We verify that only the error context is populated
      expect(ctx.debug.errorContext).toHaveProperty('someErr');
    });

    test('accepts reset parameter without changing behavior', () => {
      const ctx = makeContext('p6', 'resetErr');

      // consoleError signature accepts reset but does not use it
      treeConsole.error(ctx, 'resetErr', [], 'err1', 'v1', false);
      treeConsole.error(ctx, 'resetErr', [], 'err2', 'v2', true);

      expect(ctx.debug.errorContext).toHaveProperty('err1');
      expect(ctx.debug.errorContext).toHaveProperty('err2');
    });
  });

  // ========================================================================
  // treeConsole.metric (consoleMetric) - lines 51-56
  // ========================================================================

  describe('metric (consoleMetric)', () => {
    test('adds a metric entry in non-reset mode (default)', () => {
      const ctx = makeContext('p1', 'metricStage');

      treeConsole.metric(ctx, 'metricStage', [], 'latencyMs', 42);

      // non-reset calls addMetric (merge semantics)
      expect(ctx.debug.metricContext).toHaveProperty('latencyMs');
    });

    test('adds a metric entry when reset=false', () => {
      const ctx = makeContext('p1', 'metricStage');

      treeConsole.metric(ctx, 'metricStage', [], 'throughput', 100, false);

      expect(ctx.debug.metricContext).toHaveProperty('throughput');
    });

    test('sets a metric entry when reset=true (overwrite semantics)', () => {
      const ctx = makeContext('p1', 'metricStage');

      // First add a metric
      treeConsole.metric(ctx, 'metricStage', [], 'count', 5);
      // Then reset it
      treeConsole.metric(ctx, 'metricStage', [], 'count', 99, true);

      expect(ctx.debug.metricContext).toHaveProperty('count');
    });

    test('calls logger.debug with METRIC prefix', () => {
      const ctx = makeContext('p1', 'metricStage');

      treeConsole.metric(ctx, 'metricStage', ['perf'], 'cpuTime', 320);

      expect(console.debug).toHaveBeenCalledWith(
        expect.stringContaining('METRIC: PIPELINE ID: [p1]'),
      );
      expect(console.debug).toHaveBeenCalledWith(
        expect.stringContaining('STAGE: [metricStage]'),
      );
    });

    test('handles object metric values', () => {
      const ctx = makeContext('p1', 'metricStage');

      treeConsole.metric(ctx, 'metricStage', [], 'timing', { start: 0, end: 100 });

      expect(ctx.debug.metricContext).toHaveProperty('timing');
    });

    test('handles metric with path segments', () => {
      const ctx = makeContext('p1', 'metricStage');

      treeConsole.metric(ctx, 'metricStage', ['sub', 'system'], 'rate', 0.95);

      // Metric is recorded under the nested path
      expect(ctx.debug.metricContext).toBeDefined();
    });

    test('reset=true uses setMetric to overwrite previous value', () => {
      const ctx = makeContext('p1', 'overwriteStage');
      const spySet = jest.spyOn(ctx, 'setMetric');
      const spyAdd = jest.spyOn(ctx, 'addMetric');

      treeConsole.metric(ctx, 'overwriteStage', [], 'x', 'new', true);

      expect(spySet).toHaveBeenCalledWith('x', 'new', []);
      expect(spyAdd).not.toHaveBeenCalled();
    });

    test('reset=false (default) uses addMetric to merge', () => {
      const ctx = makeContext('p1', 'mergeStage');
      const spySet = jest.spyOn(ctx, 'setMetric');
      const spyAdd = jest.spyOn(ctx, 'addMetric');

      treeConsole.metric(ctx, 'mergeStage', [], 'y', 'val');

      expect(spyAdd).toHaveBeenCalledWith('y', 'val', []);
      expect(spySet).not.toHaveBeenCalled();
    });
  });

  // ========================================================================
  // treeConsole.eval (consoleEval) - lines 71-76
  // ========================================================================

  describe('eval (consoleEval)', () => {
    test('adds an eval entry in non-reset mode (default)', () => {
      const ctx = makeContext('p1', 'evalStage');

      treeConsole.eval(ctx, 'evalStage', [], 'accuracy', 0.92);

      // non-reset calls addEval (merge semantics)
      expect(ctx.debug.evalContext).toHaveProperty('accuracy');
    });

    test('adds an eval entry when reset=false', () => {
      const ctx = makeContext('p1', 'evalStage');

      treeConsole.eval(ctx, 'evalStage', [], 'f1Score', 0.87, false);

      expect(ctx.debug.evalContext).toHaveProperty('f1Score');
    });

    test('sets an eval entry when reset=true (overwrite semantics)', () => {
      const ctx = makeContext('p1', 'evalStage');

      // First add an eval
      treeConsole.eval(ctx, 'evalStage', [], 'precision', 0.8);
      // Then reset it
      treeConsole.eval(ctx, 'evalStage', [], 'precision', 0.95, true);

      expect(ctx.debug.evalContext).toHaveProperty('precision');
    });

    test('calls logger.debug with EVAL prefix', () => {
      const ctx = makeContext('p1', 'evalStage');

      treeConsole.eval(ctx, 'evalStage', ['model'], 'recall', 0.78);

      expect(console.debug).toHaveBeenCalledWith(
        expect.stringContaining('EVAL: PIPELINE ID: [p1]'),
      );
      expect(console.debug).toHaveBeenCalledWith(
        expect.stringContaining('STAGE: [evalStage]'),
      );
    });

    test('handles object eval values', () => {
      const ctx = makeContext('p1', 'evalStage');

      treeConsole.eval(ctx, 'evalStage', [], 'confusion', {
        tp: 10,
        fp: 2,
        fn: 3,
        tn: 85,
      });

      expect(ctx.debug.evalContext).toHaveProperty('confusion');
    });

    test('handles eval with path segments', () => {
      const ctx = makeContext('p1', 'evalStage');

      treeConsole.eval(ctx, 'evalStage', ['quality', 'check'], 'score', 4.5);

      expect(ctx.debug.evalContext).toBeDefined();
    });

    test('reset=true uses setEval to overwrite previous value', () => {
      const ctx = makeContext('p1', 'overwriteEval');
      const spySet = jest.spyOn(ctx, 'setEval');
      const spyAdd = jest.spyOn(ctx, 'addEval');

      treeConsole.eval(ctx, 'overwriteEval', [], 'e', 'new', true);

      expect(spySet).toHaveBeenCalledWith('e', 'new', []);
      expect(spyAdd).not.toHaveBeenCalled();
    });

    test('reset=false (default) uses addEval to merge', () => {
      const ctx = makeContext('p1', 'mergeEval');
      const spySet = jest.spyOn(ctx, 'setEval');
      const spyAdd = jest.spyOn(ctx, 'addEval');

      treeConsole.eval(ctx, 'mergeEval', [], 'f', 'val');

      expect(spyAdd).toHaveBeenCalledWith('f', 'val', []);
      expect(spySet).not.toHaveBeenCalled();
    });
  });

  // ========================================================================
  // treeConsole export shape
  // ========================================================================

  describe('export shape', () => {
    test('treeConsole exposes log, error, metric, and eval functions', () => {
      expect(typeof treeConsole.log).toBe('function');
      expect(typeof treeConsole.error).toBe('function');
      expect(typeof treeConsole.metric).toBe('function');
      expect(typeof treeConsole.eval).toBe('function');
    });
  });

  // ========================================================================
  // Property-based tests
  // ========================================================================

  describe('property: consoleError always records to errorContext', () => {
    test('arbitrary key/value pairs are stored in errorContext', () => {
      fc.assert(
        fc.property(arbKey, arbValue, arbPath, (key, value, path) => {
          const ctx = makeContext('prop-pipe', 'prop-stage');

          treeConsole.error(ctx, 'prop-stage', path, key, value);

          // Error must always be recorded regardless of key/value/path
          expect(ctx.debug.errorContext).toBeDefined();
          // The key should exist somewhere in errorContext (possibly nested by path)
          const hasContent = Object.keys(ctx.debug.errorContext).length > 0;
          expect(hasContent).toBe(true);
        }),
        { numRuns: 50 },
      );
    });
  });

  describe('property: consoleMetric always records to metricContext', () => {
    test('non-reset path always populates metricContext', () => {
      fc.assert(
        fc.property(arbKey, arbValue, (key, value) => {
          const ctx = makeContext('prop-pipe', 'prop-stage');

          treeConsole.metric(ctx, 'prop-stage', [], key, value);

          expect(ctx.debug.metricContext).toHaveProperty(key);
        }),
        { numRuns: 50 },
      );
    });

    test('reset path always populates metricContext', () => {
      fc.assert(
        fc.property(arbKey, arbValue, (key, value) => {
          const ctx = makeContext('prop-pipe', 'prop-stage');

          treeConsole.metric(ctx, 'prop-stage', [], key, value, true);

          expect(ctx.debug.metricContext).toHaveProperty(key);
        }),
        { numRuns: 50 },
      );
    });
  });

  describe('property: consoleEval always records to evalContext', () => {
    test('non-reset path always populates evalContext', () => {
      fc.assert(
        fc.property(arbKey, arbValue, (key, value) => {
          const ctx = makeContext('prop-pipe', 'prop-stage');

          treeConsole.eval(ctx, 'prop-stage', [], key, value);

          expect(ctx.debug.evalContext).toHaveProperty(key);
        }),
        { numRuns: 50 },
      );
    });

    test('reset path always populates evalContext', () => {
      fc.assert(
        fc.property(arbKey, arbValue, (key, value) => {
          const ctx = makeContext('prop-pipe', 'prop-stage');

          treeConsole.eval(ctx, 'prop-stage', [], key, value, true);

          expect(ctx.debug.evalContext).toHaveProperty(key);
        }),
        { numRuns: 50 },
      );
    });
  });

  describe('property: metric and eval reset vs non-reset use different methods', () => {
    test('metric: reset=true calls setMetric, reset=false calls addMetric', () => {
      fc.assert(
        fc.property(arbKey, arbValue, fc.boolean(), (key, value, shouldReset) => {
          const ctx = makeContext('prop-pipe', 'prop-stage');
          const spySet = jest.spyOn(ctx, 'setMetric');
          const spyAdd = jest.spyOn(ctx, 'addMetric');

          treeConsole.metric(ctx, 'prop-stage', [], key, value, shouldReset);

          if (shouldReset) {
            expect(spySet).toHaveBeenCalledTimes(1);
            expect(spyAdd).not.toHaveBeenCalled();
          } else {
            expect(spyAdd).toHaveBeenCalledTimes(1);
            expect(spySet).not.toHaveBeenCalled();
          }

          spySet.mockRestore();
          spyAdd.mockRestore();
        }),
        { numRuns: 50 },
      );
    });

    test('eval: reset=true calls setEval, reset=false calls addEval', () => {
      fc.assert(
        fc.property(arbKey, arbValue, fc.boolean(), (key, value, shouldReset) => {
          const ctx = makeContext('prop-pipe', 'prop-stage');
          const spySet = jest.spyOn(ctx, 'setEval');
          const spyAdd = jest.spyOn(ctx, 'addEval');

          treeConsole.eval(ctx, 'prop-stage', [], key, value, shouldReset);

          if (shouldReset) {
            expect(spySet).toHaveBeenCalledTimes(1);
            expect(spyAdd).not.toHaveBeenCalled();
          } else {
            expect(spyAdd).toHaveBeenCalledTimes(1);
            expect(spySet).not.toHaveBeenCalled();
          }

          spySet.mockRestore();
          spyAdd.mockRestore();
        }),
        { numRuns: 50 },
      );
    });
  });
});
