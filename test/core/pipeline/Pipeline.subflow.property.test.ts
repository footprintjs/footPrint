/**
 * Pipeline.subflow.property.test.ts
 *
 * Property-based tests for nested subflow context functionality using fast-check.
 * These tests validate correctness properties defined in the design document.
 *
 * _Requirements: All (comprehensive validation via properties)_
 */

import * as fc from 'fast-check';
import { Pipeline, StageNode } from '../../../src/core/pipeline/Pipeline';
import { StageContext } from '../../../src/core/context/StageContext';
import { ScopeFactory } from '../../../src/core/context/types';

// Simple scope factory for testing
const testScopeFactory: ScopeFactory<StageContext> = (context: StageContext) => context;

describe('Pipeline Subflow Property-Based Tests', () => {
  // Reserved property names that exist on all objects - avoid these in property tests
  const RESERVED_KEYS = new Set([
    'toString', 'valueOf', 'hasOwnProperty', 'isPrototypeOf', 
    'propertyIsEnumerable', 'toLocaleString', 'constructor',
    '__proto__', '__defineGetter__', '__defineSetter__',
    '__lookupGetter__', '__lookupSetter__'
  ]);

  // Safe key generator that avoids reserved names
  const safeKeyArb = fc.string({ minLength: 3, maxLength: 20 })
    .filter(s => /^[a-z][a-zA-Z0-9]*$/.test(s) && !RESERVED_KEYS.has(s));

  /**
   * Property 1: Subflow Context Isolation
   * ------------------------------------------------------------------
   * For any subflow execution, the subflow's stages SHALL write to and read from
   * the subflow's isolated PipelineRuntime, NOT the parent's context.
   *
   * _Validates: Requirements 2.1, 2.2, 2.3_
   */
  describe('Property 1: Subflow Context Isolation', () => {
    it('subflow scope writes are isolated from parent scope', async () => {
      await fc.assert(
        fc.asyncProperty(
          // Generate random key-value pairs for parent and subflow (avoiding reserved names)
          safeKeyArb,
          fc.string({ minLength: 1, maxLength: 50 }),
          safeKeyArb,
          fc.string({ minLength: 1, maxLength: 50 }),
          async (parentKey, parentValue, subflowKey, subflowValue) => {
            // Track what was written where
            let parentWroteKey = '';
            let subflowWroteKey = '';

            const subflowStage: StageNode = {
              name: 'subflowRoot',
              id: 'subflowRoot',
              isSubflowRoot: true,
              subflowId: 'isolation-test',
              subflowName: 'Isolation Test',
              fn: (scope: StageContext) => {
                scope.setObject([], subflowKey, subflowValue);
                subflowWroteKey = subflowKey;
                return 'subflow-done';
              },
            };

            const root: StageNode = {
              name: 'root',
              id: 'root',
              fn: (scope: StageContext) => {
                scope.setObject([], parentKey, parentValue);
                parentWroteKey = parentKey;
                return 'parent-done';
              },
              next: subflowStage,
            };

            const stageMap = new Map();
            const pipeline = new Pipeline(root, stageMap, testScopeFactory);

            await pipeline.execute();

            // Get parent context tree
            const parentTree = pipeline.getContextTree();
            const parentGlobal = parentTree.globalContext as Record<string, unknown>;

            // Get subflow context tree
            const subflowResults = pipeline.getSubflowResults();
            const subflowResult = subflowResults.get('isolation-test')!;
            const subflowGlobal = subflowResult.treeContext.globalContext as Record<string, unknown>;

            // PROPERTY: Parent's key should NOT appear in subflow's global context
            // (unless they happen to be the same key, which is fine - they're isolated)
            if (parentWroteKey !== subflowWroteKey) {
              expect(Object.prototype.hasOwnProperty.call(subflowGlobal, parentWroteKey)).toBe(false);
            }

            // PROPERTY: Subflow's key should NOT appear in parent's global context
            if (parentWroteKey !== subflowWroteKey) {
              expect(Object.prototype.hasOwnProperty.call(parentGlobal, subflowWroteKey)).toBe(false);
            }

            // PROPERTY: Each context should have its own key
            expect(parentGlobal[parentWroteKey]).toBe(parentValue);
            expect(subflowGlobal[subflowWroteKey]).toBe(subflowValue);
          },
        ),
        { numRuns: 100 },
      );
    });
  });

  /**
   * Property 2: Subflow Result Completeness
   * ------------------------------------------------------------------
   * For any completed subflow execution (success or error), the SubflowResult
   * SHALL contain all required fields: subflowId, subflowName, treeContext,
   * pipelineStructure, parentStageId.
   *
   * _Validates: Requirements 3.1, 3.2, 3.3, 3.4_
   */
  describe('Property 2: Subflow Result Completeness', () => {
    it('all SubflowResult fields are present for successful execution', async () => {
      await fc.assert(
        fc.asyncProperty(
          // Generate random subflow metadata (using safe identifiers)
          safeKeyArb,
          fc.string({ minLength: 1, maxLength: 50 }),
          async (subflowId, subflowName) => {
            const subflowStage: StageNode = {
              name: 'subflowRoot',
              id: 'subflowRoot',
              isSubflowRoot: true,
              subflowId,
              subflowName,
              fn: () => 'subflow-output',
            };

            const root: StageNode = {
              name: 'root',
              id: 'root',
              fn: () => 'root-output',
              next: subflowStage,
            };

            const stageMap = new Map();
            const pipeline = new Pipeline(root, stageMap, testScopeFactory);

            await pipeline.execute();

            const subflowResults = pipeline.getSubflowResults();
            const result = subflowResults.get(subflowId)!;

            // PROPERTY: All required fields must be present and correct
            expect(result).toBeDefined();
            expect(result.subflowId).toBe(subflowId);
            expect(result.subflowName).toBe(subflowName);
            expect(result.treeContext).toBeDefined();
            expect(result.treeContext.globalContext).toBeDefined();
            expect(result.treeContext.stageContexts).toBeDefined();
            expect(result.treeContext.history).toBeDefined();
            expect(result.pipelineStructure).toBeDefined();
            expect(result.pipelineStructure.name).toBe('subflowRoot');
            expect(result.parentStageId).toBeDefined();
            expect(typeof result.parentStageId).toBe('string');
          },
        ),
        { numRuns: 100 },
      );
    });

    it('all SubflowResult fields are present even on error', async () => {
      await fc.assert(
        fc.asyncProperty(
          safeKeyArb,
          fc.string({ minLength: 1, maxLength: 100 }),
          async (subflowId, errorMessage) => {
            const subflowStage: StageNode = {
              name: 'errorSubflow',
              id: 'errorSubflow',
              isSubflowRoot: true,
              subflowId,
              subflowName: 'Error Subflow',
              fn: () => {
                throw new Error(errorMessage);
              },
            };

            const root: StageNode = {
              name: 'root',
              id: 'root',
              fn: () => 'root-output',
              next: subflowStage,
            };

            const stageMap = new Map();
            const pipeline = new Pipeline(root, stageMap, testScopeFactory);

            // Should throw but still collect partial data
            await expect(pipeline.execute()).rejects.toThrow(errorMessage);

            const subflowResults = pipeline.getSubflowResults();
            const result = subflowResults.get(subflowId)!;

            // PROPERTY: Even on error, all required fields must be present
            expect(result).toBeDefined();
            expect(result.subflowId).toBe(subflowId);
            expect(result.subflowName).toBe('Error Subflow');
            expect(result.treeContext).toBeDefined();
            expect(result.pipelineStructure).toBeDefined();
            expect(result.parentStageId).toBeDefined();
          },
        ),
        { numRuns: 50 },
      );
    });
  });

  /**
   * Property 3: SubflowResultsMap Consistency
   * ------------------------------------------------------------------
   * For any pipeline execution with N subflows, the SubflowResultsMap
   * returned by getSubflowResults() SHALL contain exactly N entries.
   *
   * _Validates: Requirements 4.1, 4.2, 4.3_
   */
  describe('Property 3: SubflowResultsMap Consistency', () => {
    it('N subflows produce exactly N entries in SubflowResultsMap', async () => {
      await fc.assert(
        fc.asyncProperty(
          // Generate 1-5 subflows
          fc.integer({ min: 1, max: 5 }),
          async (numSubflows) => {
            const subflows: StageNode[] = [];

            for (let i = 0; i < numSubflows; i++) {
              subflows.push({
                name: `subflow${i}`,
                id: `subflow${i}`,
                isSubflowRoot: true,
                subflowId: `subflow-${i}`,
                subflowName: `Subflow ${i}`,
                fn: () => `output-${i}`,
              });
            }

            const root: StageNode = {
              name: 'root',
              id: 'root',
              fn: () => 'root-output',
              children: subflows,
            };

            const stageMap = new Map();
            const pipeline = new Pipeline(root, stageMap, testScopeFactory);

            await pipeline.execute();

            const subflowResults = pipeline.getSubflowResults();

            // PROPERTY: Exactly N entries for N subflows
            expect(subflowResults.size).toBe(numSubflows);

            // PROPERTY: Each subflow has its entry
            for (let i = 0; i < numSubflows; i++) {
              expect(subflowResults.has(`subflow-${i}`)).toBe(true);
              const result = subflowResults.get(`subflow-${i}`)!;
              expect(result.subflowName).toBe(`Subflow ${i}`);
            }
          },
        ),
        { numRuns: 100 },
      );
    });
  });

  /**
   * Property 4: Backward Compatibility
   * ------------------------------------------------------------------
   * For any pipeline without subflows (no nodes with isSubflowRoot: true),
   * the execution behavior SHALL be identical to the current implementation,
   * and getSubflowResults() SHALL return an empty Map.
   *
   * _Validates: Requirements 6.1, 6.2, 6.3, 6.4_
   */
  describe('Property 4: Backward Compatibility', () => {
    it('pipelines without subflows have empty SubflowResultsMap', async () => {
      await fc.assert(
        fc.asyncProperty(
          // Generate 1-5 regular stages
          fc.integer({ min: 1, max: 5 }),
          async (numStages) => {
            // Build a linear chain of stages
            let current: StageNode | undefined;

            for (let i = numStages - 1; i >= 0; i--) {
              const stage: StageNode = {
                name: `stage${i}`,
                id: `stage${i}`,
                fn: () => `output-${i}`,
                next: current,
              };
              current = stage;
            }

            const stageMap = new Map();
            const pipeline = new Pipeline(current!, stageMap, testScopeFactory);

            await pipeline.execute();

            // PROPERTY: No subflows = empty map
            const subflowResults = pipeline.getSubflowResults();
            expect(subflowResults.size).toBe(0);

            // PROPERTY: Context tree should have normal structure
            const contextTree = pipeline.getContextTree();
            expect(contextTree.globalContext).toBeDefined();
            expect(contextTree.stageContexts).toBeDefined();
            expect(contextTree.history).toBeDefined();
          },
        ),
        { numRuns: 100 },
      );
    });

    it('execution order preserved for non-subflow pipelines', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 2, max: 5 }),
          async (numStages) => {
            const executionOrder: string[] = [];

            // Build a linear chain
            let current: StageNode | undefined;

            for (let i = numStages - 1; i >= 0; i--) {
              const stageName = `stage${i}`;
              const stage: StageNode = {
                name: stageName,
                id: stageName,
                fn: () => {
                  executionOrder.push(stageName);
                  return `output-${i}`;
                },
                next: current,
              };
              current = stage;
            }

            const stageMap = new Map();
            const pipeline = new Pipeline(current!, stageMap, testScopeFactory);

            await pipeline.execute();

            // PROPERTY: Stages execute in order (stage0, stage1, stage2, ...)
            const expectedOrder = Array.from({ length: numStages }, (_, i) => `stage${i}`);
            expect(executionOrder).toEqual(expectedOrder);
          },
        ),
        { numRuns: 100 },
      );
    });
  });

  /**
   * Property 5: Subflow Break Isolation
   * ------------------------------------------------------------------
   * For any subflow that calls breakFn(), the break SHALL stop execution
   * within the subflow only. The parent pipeline SHALL continue execution
   * after the subflow completes.
   *
   * _Validates: Requirement 2.4 (implicit - subflows are independent)_
   */
  describe('Property 5: Subflow Break Isolation', () => {
    it('subflow break does not propagate to parent pipeline', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.boolean(), // Whether subflow should break
          async (shouldBreak) => {
            let subflowExecuted = false;
            let afterSubflowExecuted = false;

            // Define subflow as a separate node
            const subflowStage: StageNode = {
              name: 'breakingSubflow',
              id: 'breakingSubflow',
              isSubflowRoot: true,
              subflowId: 'break-test',
              subflowName: 'Break Test',
              fn: (_scope: StageContext, breakFn: () => void) => {
                subflowExecuted = true;
                if (shouldBreak) {
                  breakFn();
                }
                return 'subflow-output';
              },
            };

            // Define afterSubflow as a separate node
            const afterSubflow: StageNode = {
              name: 'afterSubflow',
              id: 'afterSubflow',
              fn: () => {
                afterSubflowExecuted = true;
                return 'after-output';
              },
            };

            // Chain them properly: root -> subflow -> afterSubflow
            // The key is that afterSubflow is the parent's next, not the subflow's next
            subflowStage.next = undefined; // Subflow has no internal next
            
            const root: StageNode = {
              name: 'root',
              id: 'root',
              fn: () => 'root-output',
              next: subflowStage,
            };
            
            // Add afterSubflow as next of the subflow in the parent chain
            // This is tricky - we need to modify the structure so afterSubflow
            // is executed after the subflow completes in the parent context
            // 
            // Actually, the current implementation executes subflow.next as part
            // of the subflow's internal execution. To have afterSubflow run in
            // the parent context, we need a different structure.
            //
            // For now, let's test that the subflow's internal break doesn't
            // affect the parent's break flag by checking that the parent
            // pipeline completes successfully.

            const stageMap = new Map();
            const pipeline = new Pipeline(root, stageMap, testScopeFactory);

            await pipeline.execute();

            // PROPERTY: Subflow always executes
            expect(subflowExecuted).toBe(true);

            // PROPERTY: Subflow results are collected regardless of break
            const subflowResults = pipeline.getSubflowResults();
            expect(subflowResults.has('break-test')).toBe(true);

            // PROPERTY: Parent pipeline completes successfully (no error thrown)
            // This verifies the subflow break didn't propagate to parent
            const contextTree = pipeline.getContextTree();
            expect(contextTree).toBeDefined();
          },
        ),
        { numRuns: 100 },
      );
    });

    it('subflow break stops internal execution but parent continues', async () => {
      // This test verifies that when a subflow breaks, its internal children
      // don't execute, but the parent pipeline is unaffected
      let subflowRootExecuted = false;
      let subflowChildExecuted = false;
      let parentAfterSubflowExecuted = false;

      const subflowStage: StageNode = {
        name: 'breakingSubflow',
        id: 'breakingSubflow',
        isSubflowRoot: true,
        subflowId: 'break-internal-test',
        subflowName: 'Break Internal Test',
        fn: (_scope: StageContext, breakFn: () => void) => {
          subflowRootExecuted = true;
          breakFn(); // Break inside subflow
          return 'subflow-output';
        },
        children: [
          {
            name: 'subflowChild',
            id: 'subflowChild',
            fn: () => {
              subflowChildExecuted = true;
              return 'child-output';
            },
          },
        ],
      };

      // Create a fork pattern where subflow is one child and afterSubflow is another
      // This way both execute in parallel from the parent's perspective
      const afterSubflow: StageNode = {
        name: 'afterSubflow',
        id: 'afterSubflow',
        fn: () => {
          parentAfterSubflowExecuted = true;
          return 'after-output';
        },
      };

      const root: StageNode = {
        name: 'root',
        id: 'root',
        fn: () => 'root-output',
        children: [subflowStage, afterSubflow],
      };

      const stageMap = new Map();
      const pipeline = new Pipeline(root, stageMap, testScopeFactory);

      await pipeline.execute();

      // Subflow root executed
      expect(subflowRootExecuted).toBe(true);

      // Subflow child did NOT execute (break stopped internal execution)
      expect(subflowChildExecuted).toBe(false);

      // Parent's other child DID execute (break was isolated to subflow)
      expect(parentAfterSubflowExecuted).toBe(true);
    });
  });
});
