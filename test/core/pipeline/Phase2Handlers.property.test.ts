/**
 * Phase2Handlers.property.test.ts
 *
 * Property-based tests for the Phase 2 handler modules:
 * - StageRunner
 * - LoopHandler
 * - DeciderHandler
 *
 * These tests verify the correctness properties defined in the design document.
 *
 * **Feature: pipeline-phase2-handlers**
 */

import * as fc from 'fast-check';
import { LoopHandler } from '../../../src/core/pipeline/LoopHandler';
import { StageRunner } from '../../../src/core/pipeline/StageRunner';
import { NodeResolver } from '../../../src/core/pipeline/NodeResolver';
import { PipelineContext, PipelineStageFunction } from '../../../src/core/pipeline/types';
import { StageNode } from '../../../src/core/pipeline/GraphTraverser';
import { PipelineRuntime } from '../../../src/core/context/PipelineRuntime';

// Helper to create a minimal PipelineContext for testing
function createTestContext<TOut = any, TScope = any>(): PipelineContext<TOut, TScope> {
  const pipelineRuntime = new PipelineRuntime('test');
  return {
    stageMap: new Map(),
    root: { name: 'root', id: 'root' },
    pipelineRuntime,
    ScopeFactory: (_context, stageName) => ({ stageName } as unknown as TScope),
    scopeProtectionMode: 'off',
  };
}

// Helper to create a NodeResolver with predefined nodes
function createNodeResolver<TOut = any, TScope = any>(
  nodes: StageNode<TOut, TScope>[],
): NodeResolver<TOut, TScope> {
  const ctx = createTestContext<TOut, TScope>();
  ctx.root = nodes[0] || { name: 'root', id: 'root' };
  
  for (const node of nodes) {
    ctx.stageMap.set(node.name, node);
  }
  
  return new NodeResolver(ctx);
}

describe('Phase 2 Handlers Property-Based Tests', () => {
  /**
   * Property 6: Iteration Counter Monotonicity
   * ------------------------------------------------------------------
   * For any node ID, successive calls to getAndIncrementIteration SHALL
   * return monotonically increasing values starting from 0 (0, 1, 2, ...).
   *
   * **Validates: Requirements 3.2**
   */
  describe('Property 6: Iteration Counter Monotonicity', () => {
    it('iteration counter returns monotonically increasing values for any node ID', async () => {
      await fc.assert(
        fc.asyncProperty(
          // Generate a valid node ID (alphanumeric, starting with letter)
          fc.string({ minLength: 1, maxLength: 20 }).filter((s) => /^[a-zA-Z][a-zA-Z0-9]*$/.test(s)),
          // Generate number of iterations to test
          fc.integer({ min: 1, max: 100 }),
          async (nodeId, numIterations) => {
            const ctx = createTestContext();
            const nodeResolver = createNodeResolver([{ name: 'root', id: 'root' }]);
            const handler = new LoopHandler(ctx, nodeResolver);

            const results: number[] = [];
            for (let i = 0; i < numIterations; i++) {
              results.push(handler.getAndIncrementIteration(nodeId));
            }

            // PROPERTY: First value is 0
            expect(results[0]).toBe(0);

            // PROPERTY: Each subsequent value is exactly 1 more than previous
            for (let i = 1; i < results.length; i++) {
              expect(results[i]).toBe(results[i - 1] + 1);
            }

            // PROPERTY: Final value is numIterations - 1
            expect(results[results.length - 1]).toBe(numIterations - 1);
          },
        ),
        { numRuns: 100 },
      );
    });

    it('iteration counters are independent for different node IDs', async () => {
      await fc.assert(
        fc.asyncProperty(
          // Generate two different node IDs
          fc.tuple(
            fc.string({ minLength: 1, maxLength: 10 }).filter((s) => /^[a-zA-Z][a-zA-Z0-9]*$/.test(s)),
            fc.string({ minLength: 1, maxLength: 10 }).filter((s) => /^[a-zA-Z][a-zA-Z0-9]*$/.test(s)),
          ).filter(([a, b]) => a !== b),
          // Generate number of iterations for each
          fc.tuple(
            fc.integer({ min: 1, max: 20 }),
            fc.integer({ min: 1, max: 20 }),
          ),
          async ([nodeIdA, nodeIdB], [iterationsA, iterationsB]) => {
            const ctx = createTestContext();
            const nodeResolver = createNodeResolver([{ name: 'root', id: 'root' }]);
            const handler = new LoopHandler(ctx, nodeResolver);

            // Interleave calls to both node IDs
            const resultsA: number[] = [];
            const resultsB: number[] = [];
            
            for (let i = 0; i < Math.max(iterationsA, iterationsB); i++) {
              if (i < iterationsA) {
                resultsA.push(handler.getAndIncrementIteration(nodeIdA));
              }
              if (i < iterationsB) {
                resultsB.push(handler.getAndIncrementIteration(nodeIdB));
              }
            }

            // PROPERTY: Each node ID has its own independent counter starting at 0
            expect(resultsA[0]).toBe(0);
            expect(resultsB[0]).toBe(0);

            // PROPERTY: Each counter is monotonically increasing independently
            for (let i = 1; i < resultsA.length; i++) {
              expect(resultsA[i]).toBe(i);
            }
            for (let i = 1; i < resultsB.length; i++) {
              expect(resultsB[i]).toBe(i);
            }
          },
        ),
        { numRuns: 100 },
      );
    });
  });

  /**
   * Property 7: Iterated Stage Name Format
   * ------------------------------------------------------------------
   * For any base name and iteration number, getIteratedStageName SHALL
   * return: the base name for iteration 0, or "{baseName}.{iteration}"
   * for iteration > 0.
   *
   * **Validates: Requirements 3.3**
   */
  describe('Property 7: Iterated Stage Name Format', () => {
    it('iterated stage name follows correct format for any base name and iteration', async () => {
      await fc.assert(
        fc.asyncProperty(
          // Generate a valid base name (alphanumeric, starting with letter)
          fc.string({ minLength: 1, maxLength: 30 }).filter((s) => /^[a-zA-Z][a-zA-Z0-9]*$/.test(s)),
          // Generate iteration number
          fc.integer({ min: 0, max: 1000 }),
          async (baseName, iteration) => {
            const ctx = createTestContext();
            const nodeResolver = createNodeResolver([{ name: 'root', id: 'root' }]);
            const handler = new LoopHandler(ctx, nodeResolver);

            const result = handler.getIteratedStageName(baseName, iteration);

            if (iteration === 0) {
              // PROPERTY: For iteration 0, return base name unchanged
              expect(result).toBe(baseName);
            } else {
              // PROPERTY: For iteration > 0, return "{baseName}.{iteration}"
              expect(result).toBe(`${baseName}.${iteration}`);
            }
          },
        ),
        { numRuns: 100 },
      );
    });

    it('iterated stage name is deterministic', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.string({ minLength: 1, maxLength: 20 }).filter((s) => /^[a-zA-Z][a-zA-Z0-9]*$/.test(s)),
          fc.integer({ min: 0, max: 100 }),
          async (baseName, iteration) => {
            const ctx = createTestContext();
            const nodeResolver = createNodeResolver([{ name: 'root', id: 'root' }]);
            const handler = new LoopHandler(ctx, nodeResolver);

            // Call multiple times with same inputs
            const result1 = handler.getIteratedStageName(baseName, iteration);
            const result2 = handler.getIteratedStageName(baseName, iteration);
            const result3 = handler.getIteratedStageName(baseName, iteration);

            // PROPERTY: Same inputs always produce same output
            expect(result1).toBe(result2);
            expect(result2).toBe(result3);
          },
        ),
        { numRuns: 100 },
      );
    });
  });

  /**
   * Property 3: Stage Output Preservation
   * ------------------------------------------------------------------
   * For any stage function that returns a value, the StageRunner SHALL
   * return that exact value without modification (identity preservation).
   *
   * **Validates: Requirements 1.6**
   */
  describe('Property 3: Stage Output Preservation', () => {
    it('primitive values are preserved exactly', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.oneof(
            fc.string(),
            fc.integer(),
            fc.double({ noNaN: true }),
            fc.boolean(),
            fc.constant(null),
            fc.constant(undefined),
          ),
          async (primitiveValue) => {
            const ctx = createTestContext();
            const runner = new StageRunner(ctx);
            
            const node: StageNode = { name: 'testStage', id: 'test' };
            const stageFunc: PipelineStageFunction<typeof primitiveValue, any> = () => primitiveValue;

            const stageContext = ctx.pipelineRuntime.rootStageContext;
            const result = await runner.run(node, stageFunc, stageContext, () => {});

            // PROPERTY: Output is exactly the same value
            expect(result).toBe(primitiveValue);
          },
        ),
        { numRuns: 100 },
      );
    });

    it('object references are preserved (same reference)', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.record({
            stringProp: fc.string(),
            numberProp: fc.integer(),
            boolProp: fc.boolean(),
          }),
          async (objectValue) => {
            const ctx = createTestContext();
            const runner = new StageRunner(ctx);
            
            const node: StageNode = { name: 'testStage', id: 'test' };
            const stageFunc: PipelineStageFunction<typeof objectValue, any> = () => objectValue;

            const stageContext = ctx.pipelineRuntime.rootStageContext;
            const result = await runner.run(node, stageFunc, stageContext, () => {});

            // PROPERTY: Output is the exact same object reference
            expect(result).toBe(objectValue);
            
            // PROPERTY: Object contents are unchanged
            expect(result).toEqual(objectValue);
          },
        ),
        { numRuns: 100 },
      );
    });

    it('array references are preserved (same reference)', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(fc.oneof(fc.string(), fc.integer(), fc.boolean()), { minLength: 0, maxLength: 10 }),
          async (arrayValue) => {
            const ctx = createTestContext();
            const runner = new StageRunner(ctx);
            
            const node: StageNode = { name: 'testStage', id: 'test' };
            const stageFunc: PipelineStageFunction<typeof arrayValue, any> = () => arrayValue;

            const stageContext = ctx.pipelineRuntime.rootStageContext;
            const result = await runner.run(node, stageFunc, stageContext, () => {});

            // PROPERTY: Output is the exact same array reference
            expect(result).toBe(arrayValue);
            
            // PROPERTY: Array contents are unchanged
            expect(result).toEqual(arrayValue);
          },
        ),
        { numRuns: 100 },
      );
    });

    it('async stage output is preserved', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.oneof(
            fc.string(),
            fc.integer(),
            fc.record({ value: fc.string() }),
          ),
          async (asyncValue) => {
            const ctx = createTestContext();
            const runner = new StageRunner(ctx);
            
            const node: StageNode = { name: 'asyncStage', id: 'async' };
            const stageFunc: PipelineStageFunction<typeof asyncValue, any> = async () => {
              await new Promise((resolve) => setTimeout(resolve, 1));
              return asyncValue;
            };

            const stageContext = ctx.pipelineRuntime.rootStageContext;
            const result = await runner.run(node, stageFunc, stageContext, () => {});

            // PROPERTY: Async output is preserved
            expect(result).toEqual(asyncValue);
          },
        ),
        { numRuns: 50 }, // Fewer runs due to async overhead
      );
    });

    it('function return values are preserved', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.string(),
          async (returnValue) => {
            const ctx = createTestContext();
            const runner = new StageRunner(ctx);
            
            // Create a function that returns a specific value
            const innerFn = () => returnValue;
            
            const node: StageNode = { name: 'fnStage', id: 'fn' };
            const stageFunc: PipelineStageFunction<typeof innerFn, any> = () => innerFn;

            const stageContext = ctx.pipelineRuntime.rootStageContext;
            const result = await runner.run(node, stageFunc, stageContext, () => {});

            // PROPERTY: Function reference is preserved
            expect(result).toBe(innerFn);
            
            // PROPERTY: Function still works correctly
            expect(result()).toBe(returnValue);
          },
        ),
        { numRuns: 100 },
      );
    });
  });
});
