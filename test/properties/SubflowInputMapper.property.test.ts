/**
 * SubflowInputMapper.property.test.ts
 *
 * Property-based tests for SubflowInputMapper scope isolation behavior.
 * Uses fast-check to verify universal properties across all inputs.
 *
 * **Property 1: createSubflowPipelineContext Returns Correct Context**
 * **Property 2: Subflow Stages Access InputMapper Values via Scope**
 * **Property 3: Subflow Scope Isolation**
 * **Property 5: Return Value Flows to Parent**
 * **Property 6: Backward Compatibility with Empty InputMapper**
 * **Property 7: Isolated Scope Mode Isolation**
 * **Validates: Requirements 1.2, 1.3, 2.1, 2.2, 2.4, 4.1, 4.2, 5.3, 6.1, 7.3**
 */

import * as fc from 'fast-check';
import {
  getInitialScopeValues,
  seedSubflowGlobalStore,
  createSubflowPipelineContext,
  applyOutputMapping,
} from '../../src/core/executor/handlers/SubflowInputMapper';
import { PipelineRuntime } from '../../src/core/memory/PipelineRuntime';
import type { SubflowMountOptions, PipelineContext } from '../../src/core/executor/types';
import { StageContext } from '../../src/core/memory/StageContext';

/**
 * Reserved JavaScript property names that should not be used as keys.
 * These can cause issues when used as object property names.
 */
const RESERVED_PROPERTY_NAMES = new Set([
  'toString', 'valueOf', 'hasOwnProperty', 'isPrototypeOf',
  'propertyIsEnumerable', 'toLocaleString', 'constructor',
  '__proto__', '__defineGetter__', '__defineSetter__',
  '__lookupGetter__', '__lookupSetter__',
  'caller', 'callee', 'arguments',
]);

/**
 * Arbitrary for safe property keys that won't conflict with JS reserved names.
 */
const safeKeyArbitrary = fc.string({ minLength: 1, maxLength: 20 })
  .filter(s => /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(s))
  .filter(s => !RESERVED_PROPERTY_NAMES.has(s));

// Arbitrary for generating scope objects
const scopeArbitrary = fc.dictionary(
  safeKeyArbitrary,
  fc.oneof(
    fc.string(),
    fc.integer(),
    fc.boolean(),
    fc.constant(null),
    fc.array(fc.integer(), { maxLength: 5 }),
    fc.dictionary(safeKeyArbitrary, fc.string(), { maxKeys: 3 }),
  ),
  { minKeys: 0, maxKeys: 10 }
);

describe('SubflowInputMapper — Property Tests', () => {
  /**
   * **Property 2: Subflow Stages Access InputMapper Values via Scope**
   * 
   * *For any* subflow with an inputMapper, when a stage executes within the subflow,
   * the stage's scope SHALL contain all key-value pairs returned by the inputMapper.
   * 
   * **Validates: Requirements 1.3**
   */
  describe('Property 2: Subflow Stages Access InputMapper Values via Scope', () => {
    it('subflow context readOnlyContext equals mappedInput', () => {
      fc.assert(
        fc.property(
          scopeArbitrary,
          scopeArbitrary,
          (parentReadOnlyContext, mappedInput) => {
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
              readOnlyContext: parentReadOnlyContext,
            };

            // Create subflow context with mappedInput
            const subflowRuntime = new PipelineRuntime('subflow');
            const subflowCtx = createSubflowPipelineContext(parentCtx, subflowRuntime, mappedInput);

            // Verify: subflow's readOnlyContext equals mappedInput
            expect(subflowCtx.readOnlyContext).toEqual(mappedInput);

            // Verify: subflow's readOnlyContext is NOT parent's readOnlyContext
            if (Object.keys(parentReadOnlyContext).length > 0 || Object.keys(mappedInput).length > 0) {
              // Only check if at least one has content
              if (JSON.stringify(parentReadOnlyContext) !== JSON.stringify(mappedInput)) {
                expect(subflowCtx.readOnlyContext).not.toEqual(parentReadOnlyContext);
              }
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    it('ScopeFactory receives mappedInput as readOnlyContext', () => {
      fc.assert(
        fc.property(
          scopeArbitrary.filter(s => Object.keys(s).length > 0),
          (mappedInput) => {
            // Track what readOnlyContext was passed to ScopeFactory
            let capturedReadOnlyContext: unknown;

            const parentRuntime = new PipelineRuntime('parent');
            const parentCtx: PipelineContext = {
              stageMap: new Map(),
              root: { name: 'root' },
              pipelineRuntime: parentRuntime,
              ScopeFactory: (core, stageName, readOnlyContext) => {
                capturedReadOnlyContext = readOnlyContext;
                const ctx = readOnlyContext as Record<string, unknown> | undefined;
                return { ...ctx } as any;
              },
              scopeProtectionMode: 'warn',
              readOnlyContext: { parentValue: 'should-not-appear' },
            };

            // Create subflow context
            const subflowRuntime = new PipelineRuntime('subflow');
            const subflowCtx = createSubflowPipelineContext(parentCtx, subflowRuntime, mappedInput);

            // Simulate StageRunner calling ScopeFactory
            const mockContext = {} as StageContext;
            subflowCtx.ScopeFactory(mockContext, 'testStage', subflowCtx.readOnlyContext);

            // Verify: ScopeFactory received mappedInput
            expect(capturedReadOnlyContext).toEqual(mappedInput);
          }
        ),
        { numRuns: 50 }
      );
    });

    it('stage scope contains all inputMapper values', () => {
      fc.assert(
        fc.property(
          scopeArbitrary.filter(s => Object.keys(s).length > 0),
          (mappedInput) => {
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
              readOnlyContext: {},
            };

            // Create subflow context
            const subflowRuntime = new PipelineRuntime('subflow');
            const subflowCtx = createSubflowPipelineContext(parentCtx, subflowRuntime, mappedInput);

            // Create scope via ScopeFactory (simulating StageRunner)
            const mockContext = {} as StageContext;
            const scope = subflowCtx.ScopeFactory(mockContext, 'testStage', subflowCtx.readOnlyContext);

            // Verify: scope contains all mappedInput values
            for (const [key, value] of Object.entries(mappedInput)) {
              expect(scope[key]).toEqual(value);
            }
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  /**
   * **Property 7: Isolated Scope Mode Isolation**
   * 
   * *For any* parent scope and inputMapper:
   * - The result SHALL contain ONLY keys returned by inputMapper
   * - The result SHALL NOT contain any keys from parent scope that weren't mapped
   * 
   * **Validates: Requirements 6.1, 7.3**
   */
  describe('Property 7: Isolated Scope Mode Isolation', () => {
    it('isolated mode only contains inputMapper keys', () => {
      fc.assert(
        fc.property(
          scopeArbitrary,
          scopeArbitrary,
          (parentScope, mappedValues) => {
            const options: SubflowMountOptions = {
              inputMapper: () => mappedValues,
            };

            const result = getInitialScopeValues(parentScope, options);

            // Result should exactly match mappedValues
            expect(result).toEqual(mappedValues);

            // Result should NOT contain any parent keys that aren't in mappedValues
            const parentOnlyKeys = Object.keys(parentScope).filter(
              k => !(k in mappedValues)
            );
            for (const key of parentOnlyKeys) {
              expect(result).not.toHaveProperty(key);
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    it('no inputMapper returns empty object (function with no args)', () => {
      fc.assert(
        fc.property(
          scopeArbitrary,
          (parentScope) => {
            const options: SubflowMountOptions = {
              // No inputMapper - like a function with no arguments
            };

            const result = getInitialScopeValues(parentScope, options);

            // Result should be empty
            expect(result).toEqual({});
            expect(Object.keys(result)).toHaveLength(0);
          }
        ),
        { numRuns: 50 }
      );
    });

    it('no options returns empty object', () => {
      fc.assert(
        fc.property(
          scopeArbitrary,
          (parentScope) => {
            const result = getInitialScopeValues(parentScope);

            // Result should be empty
            expect(result).toEqual({});
          }
        ),
        { numRuns: 50 }
      );
    });
  });

  /**
   * **Property: Seeding Preserves Values**
   * 
   * *For any* initial values, after seeding to GlobalStore:
   * - All seeded values SHALL be retrievable via getGlobal
   * - Values SHALL be exactly equal to what was seeded
   */
  describe('Property: Seeding Preserves Values', () => {
    it('seeded values are retrievable via scope accessors', () => {
      fc.assert(
        fc.property(
          scopeArbitrary.filter(s => Object.keys(s).length > 0),
          (initialValues) => {
            const runtime = new PipelineRuntime('test');
            
            seedSubflowGlobalStore(runtime, initialValues);

            const rootContext = runtime.rootStageContext;
            for (const [key, value] of Object.entries(initialValues)) {
              if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
                // Nested objects are written via setObject (pipeline-namespaced)
                // Read back each nested key via getValue
                for (const [nestedKey, nestedValue] of Object.entries(value as Record<string, unknown>)) {
                  expect(rootContext.getValue([key], nestedKey)).toEqual(nestedValue);
                }
              } else {
                // Scalars are written via setGlobal (root-level)
                expect(rootContext.getGlobal(key)).toEqual(value);
              }
            }
          }
        ),
        { numRuns: 50 }
      );
    });
  });

  /**
   * **Property 1: createSubflowPipelineContext Returns Correct Context**
   * 
   * *For any* parent PipelineContext and mapped input values, calling
   * `createSubflowPipelineContext` SHALL return a new PipelineContext where
   * `readOnlyContext` equals the mapped input values.
   * 
   * **Validates: Requirements 1.2, 5.3**
   */
  describe('Property 1: createSubflowPipelineContext Returns Correct Context', () => {
    it('returned context has readOnlyContext equal to mappedInput', () => {
      fc.assert(
        fc.property(
          scopeArbitrary,
          (mappedInput) => {
            const parentRuntime = new PipelineRuntime('parent');
            const parentCtx: PipelineContext = {
              stageMap: new Map(),
              root: { name: 'root' },
              pipelineRuntime: parentRuntime,
              ScopeFactory: (core, stageName, readOnlyContext) => ({} as any),
              scopeProtectionMode: 'warn',
              readOnlyContext: { differentValue: 'parent' },
            };

            const subflowRuntime = new PipelineRuntime('subflow');
            const result = createSubflowPipelineContext(parentCtx, subflowRuntime, mappedInput);

            expect(result.readOnlyContext).toEqual(mappedInput);
          }
        ),
        { numRuns: 100 }
      );
    });

    it('returned context uses subflow runtime', () => {
      fc.assert(
        fc.property(
          scopeArbitrary,
          (mappedInput) => {
            const parentRuntime = new PipelineRuntime('parent');
            const subflowRuntime = new PipelineRuntime('subflow');
            
            const parentCtx: PipelineContext = {
              stageMap: new Map(),
              root: { name: 'root' },
              pipelineRuntime: parentRuntime,
              ScopeFactory: (core, stageName, readOnlyContext) => ({} as any),
              scopeProtectionMode: 'warn',
            };

            const result = createSubflowPipelineContext(parentCtx, subflowRuntime, mappedInput);

            expect(result.pipelineRuntime).toBe(subflowRuntime);
            expect(result.pipelineRuntime).not.toBe(parentRuntime);
          }
        ),
        { numRuns: 50 }
      );
    });

    it('returned context copies other fields from parent', () => {
      fc.assert(
        fc.property(
          scopeArbitrary,
          (mappedInput) => {
            const parentRuntime = new PipelineRuntime('parent');
            const subflowRuntime = new PipelineRuntime('subflow');
            const mockThrottlingChecker = () => false;

            const parentCtx: PipelineContext = {
              stageMap: new Map([['stage1', async () => 'result']]),
              root: { name: 'root', id: 'root-id' },
              pipelineRuntime: parentRuntime,
              ScopeFactory: (core, stageName, readOnlyContext) => ({} as any),
              scopeProtectionMode: 'error',
              subflows: { 'sub1': { root: { name: 'sub1' } } },
              throttlingErrorChecker: mockThrottlingChecker,
            };

            const result = createSubflowPipelineContext(parentCtx, subflowRuntime, mappedInput);

            // These should be copied from parent
            expect(result.stageMap).toBe(parentCtx.stageMap);
            expect(result.root).toBe(parentCtx.root);
            expect(result.ScopeFactory).toBe(parentCtx.ScopeFactory);
            expect(result.scopeProtectionMode).toBe(parentCtx.scopeProtectionMode);
            expect(result.subflows).toBe(parentCtx.subflows);
            expect(result.throttlingErrorChecker).toBe(parentCtx.throttlingErrorChecker);
          }
        ),
        { numRuns: 50 }
      );
    });
  });

  /**
   * **Property 3: Subflow Scope Isolation**
   * 
   * *For any* subflow execution, writes to the subflow's scope SHALL NOT affect
   * the parent's GlobalStore, regardless of whether an outputMapper is present.
   * 
   * **Validates: Requirements 2.1, 2.2, 7.3**
   */
  describe('Property 3: Subflow Scope Isolation', () => {
    it('subflow GlobalStore writes do not affect parent GlobalStore', () => {
      fc.assert(
        fc.property(
          scopeArbitrary.filter(s => Object.keys(s).length > 0),
          scopeArbitrary.filter(s => Object.keys(s).length > 0),
          fc.dictionary(
            fc.string({ minLength: 1, maxLength: 10 }).filter(s => /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(s)),
            fc.oneof(fc.string(), fc.integer()),
            { minKeys: 1, maxKeys: 5 }
          ),
          (parentInitialValues, mappedInput, subflowWrites) => {
            // Setup parent runtime with initial values
            const parentRuntime = new PipelineRuntime('parent');
            const parentRootContext = parentRuntime.rootStageContext;
            
            // Seed parent with initial values
            for (const [key, value] of Object.entries(parentInitialValues)) {
              parentRootContext.setGlobal(key, value);
            }
            parentRootContext.commit();
            
            // Capture parent state before subflow
            const parentStateBefore: Record<string, unknown> = {};
            for (const key of Object.keys(parentInitialValues)) {
              parentStateBefore[key] = parentRootContext.getGlobal(key);
            }

            // Create subflow runtime (isolated)
            const subflowRuntime = new PipelineRuntime('subflow');
            seedSubflowGlobalStore(subflowRuntime, mappedInput);
            
            // Simulate subflow writes to its own GlobalStore
            const subflowRootContext = subflowRuntime.rootStageContext;
            for (const [key, value] of Object.entries(subflowWrites)) {
              subflowRootContext.setGlobal(key, value);
            }
            subflowRootContext.commit();

            // Verify: parent GlobalStore unchanged
            for (const [key, expectedValue] of Object.entries(parentStateBefore)) {
              expect(parentRootContext.getGlobal(key)).toEqual(expectedValue);
            }

            // Verify: subflow writes did NOT leak to parent
            // Only check keys that are valid identifiers and not in parent
            for (const key of Object.keys(subflowWrites)) {
              if (!(key in parentInitialValues)) {
                // Key was only written in subflow, should not exist in parent
                // Use getScope() to check actual state, not prototype chain
                const parentScope = parentRootContext.getScope();
                expect(Object.prototype.hasOwnProperty.call(parentScope, key)).toBe(false);
              }
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    it('subflow and parent have independent GlobalStores', () => {
      // Reserved JavaScript property names that shouldn't be used as keys
      const reservedKeys = ['__proto__', 'constructor', 'prototype', 'hasOwnProperty', 'toString', 'valueOf'];
      
      fc.assert(
        fc.property(
          fc.string({ minLength: 1, maxLength: 20 }).filter(s => 
            /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(s) && !reservedKeys.includes(s)
          ),
          fc.string(),
          fc.string(),
          (key, parentValue, subflowValue) => {
            // Ensure different values to test isolation
            fc.pre(parentValue !== subflowValue);

            const parentRuntime = new PipelineRuntime('parent');
            const subflowRuntime = new PipelineRuntime('subflow');

            // Write same key with different values to each
            parentRuntime.rootStageContext.setGlobal(key, parentValue);
            parentRuntime.rootStageContext.commit();

            subflowRuntime.rootStageContext.setGlobal(key, subflowValue);
            subflowRuntime.rootStageContext.commit();

            // Verify: each runtime has its own value
            expect(parentRuntime.rootStageContext.getGlobal(key)).toEqual(parentValue);
            expect(subflowRuntime.rootStageContext.getGlobal(key)).toEqual(subflowValue);
          }
        ),
        { numRuns: 50 }
      );
    });
  });

  /**
   * **Property 5: Return Value Flows to Parent**
   * 
   * *For any* subflow execution, the subflow's return value (last stage output)
   * SHALL be returned to the parent and available to the parent's next stage.
   * 
   * **Validates: Requirements 2.4**
   */
  describe('Property 5: Return Value Flows to Parent', () => {
    it('subflow return value is preserved through debugInfo', () => {
      fc.assert(
        fc.property(
          fc.oneof(
            fc.string(),
            fc.integer(),
            fc.boolean(),
            fc.array(fc.integer(), { maxLength: 5 }),
            fc.dictionary(fc.string({ minLength: 1, maxLength: 10 }), fc.string(), { maxKeys: 3 }),
            fc.constant(null),
          ),
          (returnValue) => {
            // Simulate subflow execution that returns a value
            const subflowRuntime = new PipelineRuntime('subflow');
            const subflowRootContext = subflowRuntime.rootStageContext;

            // Store return value in subflow context (simulating stage output)
            subflowRootContext.addLog('stageOutput', returnValue);
            subflowRootContext.commit();

            // Verify: return value is retrievable via debug.logContext
            const logContext = subflowRootContext.debug.logContext;
            expect(logContext.stageOutput).toEqual(returnValue);
          }
        ),
        { numRuns: 100 }
      );
    });

    it('outputMapper receives subflow return value', () => {
      fc.assert(
        fc.property(
          fc.oneof(
            fc.string(),
            fc.integer(),
            fc.record({ result: fc.string(), count: fc.integer() }),
          ),
          scopeArbitrary,
          (subflowOutput, parentScope) => {
            // Track what outputMapper receives
            let receivedOutput: unknown;
            let receivedParentScope: unknown;

            const options: SubflowMountOptions = {
              outputMapper: (output, scope) => {
                receivedOutput = output;
                receivedParentScope = scope;
                return { mappedResult: output };
              },
            };

            // Create mock parent context for applyOutputMapping
            const parentRuntime = new PipelineRuntime('parent');
            const parentContext = parentRuntime.rootStageContext;

            // Apply output mapping
            applyOutputMapping(subflowOutput, parentScope, parentContext, options);

            // Verify: outputMapper received correct values
            expect(receivedOutput).toEqual(subflowOutput);
            expect(receivedParentScope).toEqual(parentScope);
          }
        ),
        { numRuns: 50 }
      );
    });

    it('outputMapper result is written to parent scope', () => {
      // Exclude prototype pollution keys that pass the regex but have special JS behavior
      const RESERVED_KEYS = ['__proto__', 'constructor', 'prototype'];
      
      fc.assert(
        fc.property(
          fc.dictionary(
            fc.string({ minLength: 1, maxLength: 10 }).filter(s => 
              /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(s) && !RESERVED_KEYS.includes(s)
            ),
            fc.oneof(fc.string(), fc.integer()),
            { minKeys: 1, maxKeys: 5 }
          ),
          (outputValues) => {
            const options: SubflowMountOptions = {
              outputMapper: () => outputValues,
            };

            const parentRuntime = new PipelineRuntime('parent');
            const parentContext = parentRuntime.rootStageContext;

            // Apply output mapping
            applyOutputMapping('subflowResult', {}, parentContext, options);
            
            // Commit the patch to apply writes to GlobalStore
            parentContext.commit();

            // Verify: outputMapper values are written to parent context
            for (const [key, value] of Object.entries(outputValues)) {
              expect(parentContext.getGlobal(key)).toEqual(value);
            }
          }
        ),
        { numRuns: 50 }
      );
    });
  });

  /**
   * **Property 6: Backward Compatibility with Empty InputMapper**
   * 
   * *For any* subflow mounted without inputMapper, the subflow SHALL execute
   * with empty `readOnlyContext`, and the subflow result SHALL be stored in
   * the parent stage's debugInfo under `subflowResult`.
   * 
   * **Validates: Requirements 4.1, 4.2**
   */
  describe('Property 6: Backward Compatibility with Empty InputMapper', () => {
    it('no inputMapper results in empty readOnlyContext', () => {
      fc.assert(
        fc.property(
          scopeArbitrary,
          (parentScope) => {
            // Options without inputMapper
            const options: SubflowMountOptions = {
              // No inputMapper - backward compatible mode
            };

            const mappedInput = getInitialScopeValues(parentScope, options);

            // Verify: empty readOnlyContext
            expect(mappedInput).toEqual({});
            expect(Object.keys(mappedInput)).toHaveLength(0);
          }
        ),
        { numRuns: 50 }
      );
    });

    it('subflow context has empty readOnlyContext when no inputMapper', () => {
      fc.assert(
        fc.property(
          scopeArbitrary,
          (parentReadOnlyContext) => {
            const parentRuntime = new PipelineRuntime('parent');
            const parentCtx: PipelineContext = {
              stageMap: new Map(),
              root: { name: 'root' },
              pipelineRuntime: parentRuntime,
              ScopeFactory: (core, stageName, readOnlyContext) => ({} as any),
              scopeProtectionMode: 'warn',
              readOnlyContext: parentReadOnlyContext,
            };

            // Create subflow context with empty mappedInput (no inputMapper)
            const subflowRuntime = new PipelineRuntime('subflow');
            const emptyMappedInput = {};
            const subflowCtx = createSubflowPipelineContext(parentCtx, subflowRuntime, emptyMappedInput);

            // Verify: subflow has empty readOnlyContext
            expect(subflowCtx.readOnlyContext).toEqual({});
          }
        ),
        { numRuns: 50 }
      );
    });

    it('subflow result can be stored in debugInfo', () => {
      fc.assert(
        fc.property(
          fc.string({ minLength: 1, maxLength: 20 }).filter(s => /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(s)),
          fc.string({ minLength: 1, maxLength: 20 }).filter(s => /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(s)),
          fc.oneof(fc.string(), fc.integer(), fc.record({ data: fc.string() })),
          (subflowId, subflowName, subflowOutput) => {
            const parentRuntime = new PipelineRuntime('parent');
            const parentContext = parentRuntime.rootStageContext;

            // Simulate storing subflow result in parent's debugInfo
            const subflowResult = {
              subflowId,
              subflowName,
              treeContext: {
                globalContext: {},
                stageContexts: {},
                history: [],
              },
              parentStageId: 'parent-stage',
            };

            parentContext.addLog('subflowResult', subflowResult);
            parentContext.addLog('hasSubflowData', true);
            parentContext.commit();

            // Verify: subflowResult is stored in debug.logContext
            const logContext = parentContext.debug.logContext;
            expect(logContext.subflowResult).toEqual(subflowResult);
            expect(logContext.hasSubflowData).toBe(true);
          }
        ),
        { numRuns: 50 }
      );
    });

    it('undefined options results in empty readOnlyContext', () => {
      fc.assert(
        fc.property(
          scopeArbitrary,
          (parentScope) => {
            // No options at all
            const mappedInput = getInitialScopeValues(parentScope, undefined);

            // Verify: empty readOnlyContext
            expect(mappedInput).toEqual({});
          }
        ),
        { numRuns: 50 }
      );
    });
  });
});
