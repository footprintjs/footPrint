/**
 * scope-api.test.ts
 *
 * Comprehensive scenario tests and property-based tests for FootPrint's
 * scope and state management public API.
 *
 * These tests exercise the consumer-facing scope extensibility layer:
 *   - BaseState: base class consumers extend for custom scopes
 *   - createProtectedScope: proxy-based scope protection
 *   - Scope Provider System: provider resolution and composition
 *   - WriteBuffer + GlobalStore: buffered writes and commit semantics
 *
 * All tests use the real implementations (no mocks).
 */

import * as fc from 'fast-check';
import {
  BaseState,
  createProtectedScope,
  createErrorMessage,
  GlobalStore,
  StageContext,
  WriteBuffer,
  FlowChartBuilder,
  FlowChartExecutor,
} from '../../src';
import type {
  ScopeFactory,
  ScopeProvider,
  StageContextLike,
  ScopeProtectionMode,
} from '../../src';
import {
  resolveScopeProvider,
  __clearScopeResolversForTests,
  registerScopeResolver,
  makeFactoryProvider,
  makeClassProvider,
} from '../../src/scope/providers';

// ============================================================================
// Shared Arbitraries
// ============================================================================

const RESERVED = new Set([
  'toString', 'valueOf', 'hasOwnProperty', 'isPrototypeOf',
  'propertyIsEnumerable', 'toLocaleString', 'constructor',
  '__proto__', '__defineGetter__', '__defineSetter__',
  '__lookupGetter__', '__lookupSetter__',
]);

/** Valid JS identifier, excluding reserved Object.prototype names */
const arbIdentifier = fc
  .string({ minLength: 1, maxLength: 30 })
  .filter((s) => /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(s))
  .filter((s) => !RESERVED.has(s));

/** Arbitrary stage names */
const arbStageName = fc
  .string({ minLength: 1, maxLength: 30 })
  .filter((s) => /^[a-zA-Z][a-zA-Z0-9_-]*$/.test(s));

/** Arbitrary for JSON-safe primitive values */
const arbPrimitive = fc.oneof(
  fc.string(),
  fc.integer(),
  fc.boolean(),
  fc.constant(null),
);

/** Arbitrary for any assignable value */
const arbValue = fc.oneof(
  fc.string(),
  fc.integer(),
  fc.boolean(),
  fc.constant(null),
  fc.constant(undefined),
  fc.array(fc.integer(), { maxLength: 5 }),
  fc.dictionary(fc.string({ minLength: 1, maxLength: 10 }), fc.integer()),
);

/** Arbitrary for valid numeric metric values */
const arbNumericValue = fc.oneof(
  fc.integer(),
  fc.double({ noNaN: true, noDefaultInfinity: true }),
);

// ============================================================================
// Helpers
// ============================================================================

/**
 * Create a real StageContext backed by a real GlobalStore.
 * No mocking -- these are genuine runtime objects.
 */
function makeRealContext(
  pipelineId = 'test-pipeline',
  stageName = 'testStage',
  defaults?: unknown,
): { ctx: StageContext; store: GlobalStore } {
  const store = new GlobalStore(defaults);
  const ctx = new StageContext(pipelineId, stageName, store);
  return { ctx, store };
}

// ============================================================================
// 1. BaseState Scenario Tests
// ============================================================================

describe('BaseState Scenario Tests', () => {
  describe('Consumer subclass workflow', () => {
    class UserScope extends BaseState {
      get userName(): string {
        return this.getValue('name') as string;
      }
      set userName(value: string) {
        this.setValue('name', value);
      }

      get userAge(): number {
        return this.getValue('age') as number;
      }
      set userAge(value: number) {
        this.setValue('age', value);
      }

      recordLatency(ms: number) {
        this.addMetric('latency', ms);
      }

      recordAccuracy(score: number) {
        this.addEval('accuracy', score);
      }

      logStep(info: string) {
        this.addDebugInfo('step', info);
      }
    }

    it('should allow consumers to create a BaseState subclass with custom methods', () => {
      const { ctx } = makeRealContext();
      const scope = new UserScope(ctx, 'myStage');
      expect(scope).toBeInstanceOf(BaseState);
      expect(scope).toBeInstanceOf(UserScope);
    });

    it('should round-trip values via setValue / getValue', () => {
      const { ctx } = makeRealContext();
      const scope = new UserScope(ctx, 'myStage');

      scope.userName = 'Alice';
      ctx.commit();

      // After commit, value should be readable
      const scope2 = new UserScope(ctx, 'myStage');
      expect(scope2.userName).toBe('Alice');
    });

    it('should make addDebugInfo data visible in getSnapshot()', () => {
      const { ctx } = makeRealContext();
      const scope = new UserScope(ctx, 'myStage');

      scope.logStep('initialized');

      const snapshot = ctx.getSnapshot();
      expect(snapshot.logs).toBeDefined();
      // The debug info should appear somewhere in the logs
      expect(JSON.stringify(snapshot.logs)).toContain('initialized');
    });

    it('should record metrics via addMetric and make them visible in getSnapshot', () => {
      const { ctx } = makeRealContext();
      const scope = new UserScope(ctx, 'myStage');

      scope.recordLatency(150);

      const snapshot = ctx.getSnapshot();
      expect(snapshot.metrics).toBeDefined();
      expect(JSON.stringify(snapshot.metrics)).toContain('150');
    });

    it('should record evals via addEval and make them visible in getSnapshot', () => {
      const { ctx } = makeRealContext();
      const scope = new UserScope(ctx, 'myStage');

      scope.recordAccuracy(0.95);

      const snapshot = ctx.getSnapshot();
      expect(snapshot.evals).toBeDefined();
      expect(JSON.stringify(snapshot.evals)).toContain('0.95');
    });

    it('should support setGlobal / getGlobal for cross-stage shared data', () => {
      const { ctx } = makeRealContext();
      const scope = new UserScope(ctx, 'myStage');

      scope.setGlobal('sessionId', 'abc-123');
      ctx.commit();

      const retrieved = scope.getGlobal('sessionId');
      expect(retrieved).toBe('abc-123');
    });

    it('should persist getReadOnlyValues across construction', () => {
      const { ctx } = makeRealContext();
      const readOnly = { apiKey: 'secret', maxRetries: 3 };
      const scope = new UserScope(ctx, 'myStage', readOnly);

      expect(scope.getReadOnlyValues()).toEqual(readOnly);
    });

    it('should return pipelineId via getPipelineId', () => {
      const { ctx } = makeRealContext('my-pipeline-42');
      const scope = new UserScope(ctx, 'myStage');

      expect(scope.getPipelineId()).toBe('my-pipeline-42');
    });
  });

  describe('BaseState subclass used as scopeFactory in FlowChartExecutor', () => {
    class TrackingScope extends BaseState {
      setData(key: string, value: unknown) {
        this.setValue(key, value);
      }
      getData(key: string) {
        return this.getValue(key);
      }
    }

    it('should persist scope data across stages in a real flowchart execution', async () => {
      const stageOrder: string[] = [];

      const chart = new FlowChartBuilder()
        .start('writer', (scope: TrackingScope) => {
          stageOrder.push('writer');
          scope.setData('message', 'hello from writer');
          return { next: 'reader' };
        })
        .addFunction('reader', (scope: TrackingScope) => {
          stageOrder.push('reader');
          const msg = scope.getData('message');
          scope.setData('readResult', msg);
          return {};
        })
        .build();

      const scopeFactory: ScopeFactory<TrackingScope> = (ctx, stageName, ro) =>
        new TrackingScope(ctx as StageContext, stageName, ro);

      const executor = new FlowChartExecutor(chart, scopeFactory);
      await executor.run();

      expect(stageOrder).toEqual(['writer', 'reader']);

      // Verify scope data persisted across stages through the runtime snapshot
      const snapshot = executor.getContextTree();
      const globalState = snapshot.globalContext;
      // The data should be persisted somewhere in the global state
      expect(JSON.stringify(globalState)).toContain('hello from writer');
    });
  });

  describe('Integration: build flowchart -> custom scope -> execute -> verify', () => {
    class AnalyticsScope extends BaseState {
      recordStep(name: string) {
        this.addDebugInfo('steps', name);
      }
      writeResult(key: string, value: unknown) {
        this.setValue(key, value);
      }
      readResult(key: string) {
        return this.getValue(key);
      }
    }

    it('should execute a multi-stage pipeline with custom scope and verify data', async () => {
      const chart = new FlowChartBuilder()
        .start('analyze', (scope: AnalyticsScope) => {
          scope.recordStep('analyze');
          scope.writeResult('sentiment', 'positive');
          return { next: 'summarize' };
        })
        .addFunction('summarize', (scope: AnalyticsScope) => {
          scope.recordStep('summarize');
          const sentiment = scope.readResult('sentiment');
          scope.writeResult('summary', `Result was ${sentiment}`);
          return {};
        })
        .build();

      const scopeFactory: ScopeFactory<AnalyticsScope> = (ctx, name, ro) =>
        new AnalyticsScope(ctx as StageContext, name, ro);

      const executor = new FlowChartExecutor(chart, scopeFactory);
      await executor.run();

      const snapshot = executor.getContextTree();
      const globalState = snapshot.globalContext;
      expect(JSON.stringify(globalState)).toContain('positive');
    });
  });
});

// ============================================================================
// 2. createProtectedScope Scenario Tests
// ============================================================================

describe('createProtectedScope Scenario Tests', () => {
  describe("mode='error': direct property assignment throws", () => {
    it('should throw Error on direct property assignment', () => {
      const scope = { data: 'original' };
      const ps = createProtectedScope(scope, { mode: 'error', stageName: 'test' });

      expect(() => {
        (ps as any).foo = 'bar';
      }).toThrow(Error);
    });

    it('should not modify the underlying object when error is thrown', () => {
      const scope: Record<string, any> = { data: 'original' };
      const ps = createProtectedScope(scope, { mode: 'error', stageName: 'test' });

      try {
        (ps as any).newProp = 'value';
      } catch {
        // expected
      }

      expect(scope.newProp).toBeUndefined();
      expect(scope.data).toBe('original');
    });
  });

  describe("mode='warn': direct property assignment logs warning but doesn't throw", () => {
    it('should allow assignment and log a warning', () => {
      const warnings: string[] = [];
      const scope: Record<string, any> = {};
      const ps = createProtectedScope(scope, {
        mode: 'warn',
        stageName: 'warnStage',
        logger: (msg) => warnings.push(msg),
      });

      // Should not throw
      (ps as any).myProp = 42;

      expect(scope.myProp).toBe(42);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('myProp');
      expect(warnings[0]).toContain('warnStage');
    });
  });

  describe("mode='off': direct property assignment works normally", () => {
    it('should allow assignment with no interception', () => {
      const warnings: string[] = [];
      const scope: Record<string, any> = {};
      const ps = createProtectedScope(scope, {
        mode: 'off',
        stageName: 'offStage',
        logger: (msg) => warnings.push(msg),
      });

      (ps as any).myProp = 'hello';

      expect(scope.myProp).toBe('hello');
      expect(warnings).toHaveLength(0);
    });

    it('should return the original scope object (no proxy)', () => {
      const scope = { x: 1 };
      const ps = createProtectedScope(scope, { mode: 'off' });
      expect(ps).toBe(scope);
    });
  });

  describe('Protected scope still allows method calls', () => {
    it('should allow calling methods like setValue, getValue on a scope object', () => {
      const store: Record<string, any> = {};
      const scope = {
        setValue: (key: string, val: any) => { store[key] = val; },
        getValue: (key: string) => store[key],
        addDebugInfo: (k: string, v: any) => { store[`debug_${k}`] = v; },
      };

      const ps = createProtectedScope(scope, { mode: 'error', stageName: 'test' });

      // Method calls should work fine
      ps.setValue('name', 'Alice');
      expect(ps.getValue('name')).toBe('Alice');
      ps.addDebugInfo('step', 'done');
      expect(store['debug_step']).toBe('done');
    });
  });

  describe('Error message includes property name and suggested method', () => {
    it('should include the property name in the error message', () => {
      const ps = createProtectedScope({}, { mode: 'error', stageName: 'myStage' });

      try {
        (ps as any).fooBar = 'value';
        fail('Expected error to be thrown');
      } catch (e: any) {
        expect(e.message).toContain('fooBar');
        expect(e.message).toContain('setValue');
        expect(e.message).toContain('myStage');
      }
    });

    it('should produce messages consistent with createErrorMessage helper', () => {
      const expected = createErrorMessage('testProp', 'testStage');
      const ps = createProtectedScope({}, { mode: 'error', stageName: 'testStage' });

      try {
        (ps as any).testProp = 'value';
        fail('Expected error to be thrown');
      } catch (e: any) {
        expect(e.message).toBe(expected);
      }
    });
  });

  describe('Nested object property assignment on the proxy target', () => {
    it('should protect direct assignment even when assigning objects', () => {
      const scope: Record<string, any> = {};
      const ps = createProtectedScope(scope, { mode: 'error', stageName: 'test' });

      expect(() => {
        (ps as any).nested = { a: 1, b: 2 };
      }).toThrow();
    });

    it('should allow mutating already-existing nested objects (proxy only traps top-level set)', () => {
      // NOTE: the protection is on the Proxy set trap, which only catches
      // direct property assignment on the proxy itself. Mutations on nested
      // objects already stored in the scope are NOT trapped.
      const scope: Record<string, any> = { config: { timeout: 5000 } };
      const ps = createProtectedScope(scope, { mode: 'error', stageName: 'test' });

      // This is a read (get 'config') then a mutation on the returned object.
      // The proxy's set trap is not triggered for nested mutations.
      ps.config.timeout = 9000;
      expect(scope.config.timeout).toBe(9000);
    });
  });

  describe('Symbol properties are handled', () => {
    it('should intercept symbol property assignments unless they are in allowedInternalProperties', () => {
      const sym = Symbol('mySym');
      const scope: Record<string | symbol, any> = {};
      const ps = createProtectedScope(scope, {
        mode: 'error',
        stageName: 'test',
        allowedInternalProperties: [],
      });

      // Symbol assignment should also be intercepted (stringified as "Symbol(mySym)")
      expect(() => {
        (ps as any)[sym] = 'value';
      }).toThrow();
    });

    it('should allow symbol assignments when the symbol is in allowedInternalProperties', () => {
      const sym = Symbol('allowed');
      const scope: Record<string | symbol, any> = {};
      const ps = createProtectedScope(scope, {
        mode: 'error',
        stageName: 'test',
        allowedInternalProperties: [sym],
      });

      // This should NOT throw because the symbol is explicitly allowed
      (ps as any)[sym] = 'allowed-value';
      expect(scope[sym]).toBe('allowed-value');
    });
  });
});

// ============================================================================
// 3. Scope Provider System Tests
// ============================================================================

describe('Scope Provider System Tests', () => {
  afterEach(() => {
    __clearScopeResolversForTests();
  });

  const ctx: StageContextLike = {
    getValue: () => undefined,
    setObject: () => {},
    updateObject: () => {},
    addLog: () => {},
    addError: () => {},
    getFromGlobalContext: () => undefined,
    setRoot: () => {},
    pipelineId: 'provider-test',
  };

  describe('Single provider attached to scope', () => {
    it('should resolve a factory function into a factory provider', () => {
      const factory = (c: StageContextLike, stage: string) => ({ stage, kind: 'factory' });
      const provider = resolveScopeProvider(factory);

      expect(provider.kind).toBe('factory');
      const scope = provider.create(ctx, 'StageA') as any;
      expect(scope.stage).toBe('StageA');
      expect(scope.kind).toBe('factory');
    });

    it('should resolve a BaseState subclass into a class provider', () => {
      class MyScope extends BaseState {
        greeting() { return 'hello'; }
      }

      const provider = resolveScopeProvider(MyScope);
      expect(provider.kind).toBe('class');

      const scope = provider.create(ctx as any, 'StageB') as MyScope;
      expect(scope).toBeInstanceOf(BaseState);
      expect(scope).toBeInstanceOf(MyScope);
      expect(scope.greeting()).toBe('hello');
    });
  });

  describe('Multiple providers composed together', () => {
    it('should support registering multiple custom resolvers', () => {
      const TOKEN_A = Symbol('tokenA');
      const TOKEN_B = Symbol('tokenB');

      registerScopeResolver({
        name: 'resolverA',
        canHandle: (input) => input === TOKEN_A,
        makeProvider: () => ({
          kind: 'A',
          create: (_c, stage) => ({ from: 'A', stage }),
        }),
      });

      registerScopeResolver({
        name: 'resolverB',
        canHandle: (input) => input === TOKEN_B,
        makeProvider: () => ({
          kind: 'B',
          create: (_c, stage) => ({ from: 'B', stage }),
        }),
      });

      const providerA = resolveScopeProvider(TOKEN_A);
      const providerB = resolveScopeProvider(TOKEN_B);

      expect(providerA.kind).toBe('A');
      expect(providerB.kind).toBe('B');

      expect((providerA.create(ctx, 'S1') as any).from).toBe('A');
      expect((providerB.create(ctx, 'S2') as any).from).toBe('B');
    });
  });

  describe('Provider dependency resolution order', () => {
    it('should use first matching custom resolver (registration order)', () => {
      const SHARED_TOKEN = Symbol('shared');
      const order: string[] = [];

      registerScopeResolver({
        name: 'first',
        canHandle: (input) => {
          order.push('first-check');
          return input === SHARED_TOKEN;
        },
        makeProvider: () => ({
          kind: 'first',
          create: (_c, stage) => ({ from: 'first', stage }),
        }),
      });

      registerScopeResolver({
        name: 'second',
        canHandle: (input) => {
          order.push('second-check');
          return input === SHARED_TOKEN;
        },
        makeProvider: () => ({
          kind: 'second',
          create: (_c, stage) => ({ from: 'second', stage }),
        }),
      });

      const provider = resolveScopeProvider(SHARED_TOKEN);
      expect(provider.kind).toBe('first');
      // The first resolver was checked before the second
      expect(order[0]).toBe('first-check');
    });

    it('should fall back to builtin resolver when custom resolvers do not match', () => {
      registerScopeResolver({
        name: 'custom-only',
        canHandle: () => false, // never matches
        makeProvider: () => ({
          kind: 'never',
          create: () => ({}),
        }),
      });

      const factory = (c: StageContextLike, s: string) => ({ s });
      const provider = resolveScopeProvider(factory);
      expect(provider.kind).toBe('factory');
    });
  });

  describe('makeFactoryProvider and makeClassProvider', () => {
    it('should create a factory provider from a function', () => {
      const fn = (c: StageContextLike, stage: string) => ({ stage });
      const p = makeFactoryProvider(fn);

      expect(p.kind).toBe('factory');
      const scope = p.create(ctx, 'S') as any;
      expect(scope.stage).toBe('S');
    });

    it('should create a class provider from a BaseState subclass', () => {
      class X extends BaseState {}
      const p = makeClassProvider(X);

      expect(p.kind).toBe('class');
      const scope = p.create(ctx as any, 'S');
      expect(scope).toBeInstanceOf(X);
    });
  });
});

// ============================================================================
// 4. Property-Based Tests
// ============================================================================

describe('Property-Based Tests', () => {
  // --------------------------------------------------------------------------
  // 4.1 BaseState properties (fast-check)
  // --------------------------------------------------------------------------
  describe('BaseState properties', () => {
    it('any key/value written with setValue can be read back with getValue', () => {
      fc.assert(
        fc.property(arbIdentifier, arbValue, (key, value) => {
          // Skip undefined values since they cannot be distinguished from "not found"
          if (value === undefined) return true;

          const { ctx } = makeRealContext();
          const state = new BaseState(ctx, 'test');

          state.setValue(key, value);
          ctx.commit();

          const readBack = state.getValue(key);
          // Use JSON comparison to handle deep equality for objects/arrays
          return JSON.stringify(readBack) === JSON.stringify(value);
        }),
        { numRuns: 100 },
      );
    });

    it('addDebugInfo accumulates (never loses previous entries when using distinct keys)', () => {
      fc.assert(
        fc.property(
          fc.array(fc.string({ minLength: 1, maxLength: 20 }), { minLength: 1, maxLength: 10 }),
          (values) => {
            const { ctx } = makeRealContext();
            const state = new BaseState(ctx, 'test');

            // Use unique keys to avoid merge semantics replacing earlier values
            for (let i = 0; i < values.length; i++) {
              state.addDebugInfo(`key_${i}`, values[i]);
            }

            const snapshot = ctx.getSnapshot();
            const logsStr = JSON.stringify(snapshot.logs);

            // Every value added under a unique key should appear in logs
            for (let i = 0; i < values.length; i++) {
              if (!logsStr.includes(`key_${i}`)) {
                return false;
              }
            }
            return true;
          },
        ),
        { numRuns: 50 },
      );
    });

    it('setGlobal/getGlobal round-trip for arbitrary keys and values', () => {
      fc.assert(
        fc.property(arbIdentifier, arbPrimitive, (key, value) => {
          if (value === null) return true; // null serialization edge case
          const { ctx } = makeRealContext();
          const state = new BaseState(ctx, 'test');

          state.setGlobal(key, value);
          ctx.commit();

          const readBack = state.getGlobal(key);
          return JSON.stringify(readBack) === JSON.stringify(value);
        }),
        { numRuns: 100 },
      );
    });

    it('multiple stages writing to same global key -- last writer wins', () => {
      fc.assert(
        fc.property(
          arbIdentifier,
          fc.array(arbPrimitive, { minLength: 2, maxLength: 5 }),
          (key, values) => {
            const store = new GlobalStore();
            const lastValue = values[values.length - 1];

            for (let i = 0; i < values.length; i++) {
              const ctx = new StageContext('pipe', `stage${i}`, store);
              const state = new BaseState(ctx, `stage${i}`);
              state.setGlobal(key, values[i]);
              ctx.commit();
            }

            // Read from a fresh context
            const readCtx = new StageContext('pipe', 'reader', store);
            const readState = new BaseState(readCtx, 'reader');
            const result = readState.getGlobal(key);
            return JSON.stringify(result) === JSON.stringify(lastValue);
          },
        ),
        { numRuns: 50 },
      );
    });

    it('addMetric never throws for valid numeric values', () => {
      fc.assert(
        fc.property(arbIdentifier, arbNumericValue, (name, value) => {
          const { ctx } = makeRealContext();
          const state = new BaseState(ctx, 'test');

          // Should never throw
          try {
            state.addMetric(name, value);
            return true;
          } catch {
            return false;
          }
        }),
        { numRuns: 100 },
      );
    });
  });

  // --------------------------------------------------------------------------
  // 4.2 Scope protection properties (fast-check)
  // --------------------------------------------------------------------------
  describe('Scope protection properties', () => {
    it("protected scope in 'error' mode always throws on direct assignment for any property name", () => {
      fc.assert(
        fc.property(arbIdentifier, arbValue, arbStageName, (prop, value, stage) => {
          const ps = createProtectedScope({}, {
            mode: 'error',
            stageName: stage,
            allowedInternalProperties: [],
          });

          try {
            (ps as any)[prop] = value;
            return false; // should have thrown
          } catch {
            return true;
          }
        }),
        { numRuns: 100 },
      );
    });

    it("protected scope in 'warn' mode never throws for any property name", () => {
      fc.assert(
        fc.property(arbIdentifier, arbValue, arbStageName, (prop, value, stage) => {
          const ps = createProtectedScope({} as Record<string, any>, {
            mode: 'warn',
            stageName: stage,
            logger: () => {},
          });

          try {
            (ps as any)[prop] = value;
            return true;
          } catch {
            return false;
          }
        }),
        { numRuns: 100 },
      );
    });

    it('protected scope preserves all method calls regardless of mode', () => {
      const modes: ScopeProtectionMode[] = ['error', 'warn', 'off'];

      fc.assert(
        fc.property(
          fc.integer(),
          fc.integer(),
          fc.constantFrom(...modes),
          (a, b, mode) => {
            const scope = {
              add: (x: number, y: number) => x + y,
              mul: (x: number, y: number) => x * y,
            };
            const ps = createProtectedScope(scope, {
              mode,
              stageName: 'test',
              logger: () => {},
            });

            return ps.add(a, b) === a + b && ps.mul(a, b) === a * b;
          },
        ),
        { numRuns: 100 },
      );
    });

    it('property names that are valid JS identifiers are all protected equally', () => {
      fc.assert(
        fc.property(
          arbIdentifier,
          arbIdentifier,
          arbValue,
          arbValue,
          (prop1, prop2, val1, val2) => {
            const scope1 = createProtectedScope({}, {
              mode: 'error',
              stageName: 'test',
              allowedInternalProperties: [],
            });
            const scope2 = createProtectedScope({}, {
              mode: 'error',
              stageName: 'test',
              allowedInternalProperties: [],
            });

            let threw1 = false;
            let threw2 = false;

            try { (scope1 as any)[prop1] = val1; } catch { threw1 = true; }
            try { (scope2 as any)[prop2] = val2; } catch { threw2 = true; }

            // Both should throw equally
            return threw1 === threw2 && threw1 === true;
          },
        ),
        { numRuns: 100 },
      );
    });
  });

  // --------------------------------------------------------------------------
  // 4.3 WriteBuffer properties (fast-check)
  // --------------------------------------------------------------------------
  describe('WriteBuffer properties', () => {
    it('set() followed by commit() makes value visible in GlobalStore', () => {
      fc.assert(
        fc.property(arbIdentifier, arbPrimitive, (key, value) => {
          if (value === null) return true; // null handling edge case
          const store = new GlobalStore();
          const ctx = new StageContext('pipe', 'stage', store);

          // Use StageContext's set method which uses WriteBuffer internally
          ctx.setObject([], key, value);
          ctx.commit();

          const result = store.getValue('pipe', [], key);
          return JSON.stringify(result) === JSON.stringify(value);
        }),
        { numRuns: 100 },
      );
    });

    it('multiple set() calls to same path -- last wins', () => {
      fc.assert(
        fc.property(
          arbIdentifier,
          fc.array(arbPrimitive.filter(v => v !== null), { minLength: 2, maxLength: 5 }),
          (key, values) => {
            const base: Record<string, any> = {};
            const buffer = new WriteBuffer(base);

            for (const v of values) {
              buffer.set([key], v);
            }
            const { overwrite } = buffer.commit();

            const lastValue = values[values.length - 1];
            return JSON.stringify(overwrite[key]) === JSON.stringify(lastValue);
          },
        ),
        { numRuns: 100 },
      );
    });

    it('merge() combines objects, set() overwrites', () => {
      fc.assert(
        fc.property(arbIdentifier, arbIdentifier, fc.integer(), fc.integer(), (key1, key2, val1, val2) => {
          // Ensure distinct keys for clear test
          if (key1 === key2) return true;

          const base: Record<string, any> = {};
          const buffer = new WriteBuffer(base);

          // Merge adds key1
          buffer.merge(['data'], { [key1]: val1 });
          // Merge adds key2 (should keep key1)
          buffer.merge(['data'], { [key2]: val2 });

          const mergedResult = buffer.get(['data']);
          const hasKey1 = mergedResult && mergedResult[key1] === val1;
          const hasKey2 = mergedResult && mergedResult[key2] === val2;

          return hasKey1 && hasKey2;
        }),
        { numRuns: 100 },
      );
    });

    it('set() after merge() overwrites the merged value', () => {
      fc.assert(
        fc.property(arbIdentifier, fc.integer(), fc.integer(), (key, mergeVal, setVal) => {
          const base: Record<string, any> = {};
          const buffer = new WriteBuffer(base);

          buffer.merge(['data'], { [key]: mergeVal });
          buffer.set(['data'], { [key]: setVal });

          const result = buffer.get(['data']);
          return result && result[key] === setVal;
        }),
        { numRuns: 100 },
      );
    });

    it('commit() returns all paths that were written', () => {
      fc.assert(
        fc.property(
          fc.array(arbIdentifier, { minLength: 1, maxLength: 5 }),
          fc.array(arbPrimitive, { minLength: 1, maxLength: 5 }),
          (keys, values) => {
            const base: Record<string, any> = {};
            const buffer = new WriteBuffer(base);

            // Write at least some paths
            const count = Math.min(keys.length, values.length);
            const writtenPaths = new Set<string>();
            for (let i = 0; i < count; i++) {
              buffer.set([keys[i]], values[i]);
              writtenPaths.add(keys[i]);
            }

            const result = buffer.commit();

            // Every path written should appear in the trace
            const tracePaths = new Set(result.trace.map(t => t.path));
            for (const wp of writtenPaths) {
              if (!tracePaths.has(wp)) {
                return false;
              }
            }
            return true;
          },
        ),
        { numRuns: 50 },
      );
    });

    it('commit() resets the buffer for subsequent commits', () => {
      fc.assert(
        fc.property(arbIdentifier, fc.integer(), (key, value) => {
          const base: Record<string, any> = {};
          const buffer = new WriteBuffer(base);

          buffer.set([key], value);
          const first = buffer.commit();

          // Second commit should be empty
          const second = buffer.commit();

          return first.trace.length > 0 && second.trace.length === 0;
        }),
        { numRuns: 100 },
      );
    });

    it('read-after-write consistency: get() returns written value before commit()', () => {
      fc.assert(
        fc.property(arbIdentifier, fc.integer(), (key, value) => {
          const base: Record<string, any> = {};
          const buffer = new WriteBuffer(base);

          buffer.set([key], value);
          const readBack = buffer.get([key]);

          return readBack === value;
        }),
        { numRuns: 100 },
      );
    });
  });
});
