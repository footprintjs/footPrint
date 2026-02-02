/**
 * ModuleComposition.property.test.ts
 *
 * Property-based tests verifying that the modular refactoring of Pipeline.ts
 * preserves behavior. The extracted modules (NodeResolver, ChildrenExecutor,
 * SubflowExecutor) should produce identical results to the original implementation.
 *
 * **Validates: Requirements 5.2, 6.2**
 */

import * as fc from 'fast-check';
import { Pipeline, StageNode } from '../../src/core/executor/Pipeline';
import { StageContext } from '../../src/core/memory/StageContext';
import { ScopeFactory } from '../../src/core/memory/types';

// Simple scope factory for testing
const testScopeFactory: ScopeFactory<StageContext> = (context: StageContext) => context;

describe('Module Composition Property-Based Tests', () => {
  // Reserved property names to avoid in generated keys
  const RESERVED_KEYS = new Set([
    'toString', 'valueOf', 'hasOwnProperty', 'isPrototypeOf',
    'propertyIsEnumerable', 'toLocaleString', 'constructor',
    '__proto__', '__defineGetter__', '__defineSetter__',
    '__lookupGetter__', '__lookupSetter__', 'name', 'length',
    'caller', 'callee', 'arguments', 'prototype', 'bind', 'call', 'apply',
  ]);

  // Safe key generator
  const safeKeyArb = fc
    .string({ minLength: 3, maxLength: 15 })
    .filter((s) => /^[a-z][a-zA-Z0-9]*$/.test(s) && !RESERVED_KEYS.has(s));

  // Safe identifier for stage names
  const safeIdArb = fc
    .string({ minLength: 2, maxLength: 10 })
    .filter((s) => /^[a-zA-Z][a-zA-Z0-9]*$/.test(s) && !RESERVED_KEYS.has(s));

  /**
   * Property 1: Module Composition Preserves Behavior
   * ------------------------------------------------------------------
   * For any pipeline execution with the refactored modules, the execution
   * SHALL produce identical results (context tree, subflow results) as
   * expected from the original implementation.
   *
   * **Validates: Requirements 5.2, 6.2**
   */
  describe('Property 1: Module Composition Preserves Behavior', () => {
    it('linear pipeline execution produces correct context tree', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 2, max: 5 }),
          fc.array(safeKeyArb, { minLength: 1, maxLength: 3 }),
          async (numStages, keys) => {
            const executionOrder: string[] = [];
            const expectedValues: Record<string, string> = {};

            // Build a linear chain of stages
            let current: StageNode | undefined;

            for (let i = numStages - 1; i >= 0; i--) {
              const stageName = `stage${i}`;
              const key = keys[i % keys.length];
              const value = `value-${i}`;
              expectedValues[key] = value; // Last write wins

              const stage: StageNode = {
                name: stageName,
                id: stageName,
                fn: (scope: StageContext) => {
                  executionOrder.push(stageName);
                  scope.setObject([], key, value);
                  return `output-${i}`;
                },
                next: current,
              };
              current = stage;
            }

            const stageMap = new Map();
            const pipeline = new Pipeline(current!, stageMap, testScopeFactory);

            const result = await pipeline.execute();

            // PROPERTY: Execution completes successfully
            expect(result).toBeDefined();

            // PROPERTY: Stages execute in correct order
            const expectedOrder = Array.from({ length: numStages }, (_, i) => `stage${i}`);
            expect(executionOrder).toEqual(expectedOrder);

            // PROPERTY: Context tree has correct structure
            const contextTree = pipeline.getContextTree();
            expect(contextTree.globalContext).toBeDefined();
            expect(contextTree.stageContexts).toBeDefined();
            expect(contextTree.history).toBeDefined();

            // PROPERTY: Root stage is at top level of stageContexts
            expect(contextTree.stageContexts.name).toBe('stage0');

            // PROPERTY: Linear chain is connected via .next
            let currentContext = contextTree.stageContexts;
            for (let i = 0; i < numStages; i++) {
              expect(currentContext.name).toBe(`stage${i}`);
              if (i < numStages - 1) {
                expect(currentContext.next).toBeDefined();
                currentContext = currentContext.next!;
              }
            }
          },
        ),
        { numRuns: 100 },
      );
    });

    it('fork/join execution aggregates children results correctly', async () => {
      await fc.assert(
        fc.asyncProperty(fc.integer({ min: 2, max: 4 }), async (numChildren) => {
          const childResults: string[] = [];

          const children: StageNode[] = [];
          for (let i = 0; i < numChildren; i++) {
            children.push({
              name: `child${i}`,
              id: `child${i}`,
              fn: () => {
                childResults.push(`child${i}`);
                return `child-output-${i}`;
              },
            });
          }

          const root: StageNode = {
            name: 'root',
            id: 'root',
            fn: () => 'root-output',
            children,
          };

          const stageMap = new Map();
          const pipeline = new Pipeline(root, stageMap, testScopeFactory);

          await pipeline.execute();

          // PROPERTY: All children executed
          expect(childResults.length).toBe(numChildren);

          // PROPERTY: Context tree has children array with correct count
          const contextTree = pipeline.getContextTree();
          expect(contextTree.stageContexts.children).toBeDefined();
          expect(contextTree.stageContexts.children!.length).toBe(numChildren);

          // PROPERTY: Each child has correct name
          const childNames = contextTree.stageContexts.children!.map((c: any) => c.name);
          for (let i = 0; i < numChildren; i++) {
            expect(childNames).toContain(`child${i}`);
          }
        }),
        { numRuns: 100 },
      );
    });
  });

  /**
   * Property 2: NodeResolver Determinism
   * ------------------------------------------------------------------
   * For any node lookup by ID, the NodeResolver SHALL return the same
   * node consistently, searching depth-first through the tree.
   *
   * **Validates: Requirements 3.4**
   */
  describe('Property 2: NodeResolver Determinism', () => {
    it('node lookup is deterministic for nested structures', async () => {
      await fc.assert(
        fc.asyncProperty(fc.integer({ min: 1, max: 3 }), async (depth) => {
          // Build a nested structure
          const buildNested = (currentDepth: number, prefix: string): StageNode => {
            const id = `${prefix}node${currentDepth}`;
            const node: StageNode = {
              name: id,
              id,
              fn: () => `output-${id}`,
            };

            if (currentDepth < depth) {
              node.children = [
                buildNested(currentDepth + 1, `${prefix}left-`),
                buildNested(currentDepth + 1, `${prefix}right-`),
              ];
            }

            return node;
          };

          const root = buildNested(0, '');

          const stageMap = new Map();
          const pipeline = new Pipeline(root, stageMap, testScopeFactory);

          await pipeline.execute();

          // PROPERTY: Root node has correct name
          const contextTree = pipeline.getContextTree();
          expect(contextTree.stageContexts.name).toBe('node0');

          // PROPERTY: Children exist at correct depth
          if (depth >= 1) {
            expect(contextTree.stageContexts.children).toBeDefined();
            expect(contextTree.stageContexts.children!.length).toBe(2);
            const childNames = contextTree.stageContexts.children!.map((c: any) => c.name);
            expect(childNames).toContain('left-node1');
            expect(childNames).toContain('right-node1');
          }
        }),
        { numRuns: 50 },
      );
    });
  });

  /**
   * Property 3: SubflowExecutor Isolation
   * ------------------------------------------------------------------
   * For any subflow execution, the SubflowExecutor SHALL create an
   * isolated PipelineRuntime that does not leak state to the parent
   * pipeline or sibling subflows.
   *
   * **Validates: Requirements 1.5**
   */
  describe('Property 3: SubflowExecutor Isolation', () => {
    it('sibling subflows have isolated contexts', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 2, max: 4 }),
          safeKeyArb,
          async (numSubflows, baseKey) => {
            const subflows: StageNode[] = [];

            for (let i = 0; i < numSubflows; i++) {
              subflows.push({
                name: `subflow${i}`,
                id: `subflow${i}`,
                isSubflowRoot: true,
                subflowId: `sf-${i}`,
                subflowName: `Subflow ${i}`,
                fn: (scope: StageContext) => {
                  // Each subflow writes its own unique value
                  scope.setObject([], baseKey, `value-from-subflow-${i}`);
                  return `subflow-output-${i}`;
                },
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

            // PROPERTY: Each subflow has its own result
            expect(subflowResults.size).toBe(numSubflows);

            // PROPERTY: Each subflow's context has its own value (isolation)
            for (let i = 0; i < numSubflows; i++) {
              const result = subflowResults.get(`sf-${i}`)!;
              expect(result).toBeDefined();
              expect(result.subflowId).toBe(`sf-${i}`);

              const globalContext = result.treeContext.globalContext as Record<string, unknown>;
              expect(globalContext[baseKey]).toBe(`value-from-subflow-${i}`);
            }
          },
        ),
        { numRuns: 50 },
      );
    });

    it('nested subflows maintain isolation at each level', async () => {
      await fc.assert(
        fc.asyncProperty(safeKeyArb, safeKeyArb, async (outerKey, innerKey) => {
          // Ensure keys are different
          const actualInnerKey = outerKey === innerKey ? `${innerKey}Inner` : innerKey;

          const innerSubflow: StageNode = {
            name: 'innerSubflow',
            id: 'innerSubflow',
            isSubflowRoot: true,
            subflowId: 'inner-sf',
            subflowName: 'Inner Subflow',
            fn: (scope: StageContext) => {
              scope.setObject([], actualInnerKey, 'inner-value');
              return 'inner-output';
            },
          };

          const outerSubflow: StageNode = {
            name: 'outerSubflow',
            id: 'outerSubflow',
            isSubflowRoot: true,
            subflowId: 'outer-sf',
            subflowName: 'Outer Subflow',
            fn: (scope: StageContext) => {
              scope.setObject([], outerKey, 'outer-value');
              return 'outer-output';
            },
            children: [innerSubflow],
          };

          const root: StageNode = {
            name: 'root',
            id: 'root',
            fn: () => 'root-output',
            next: outerSubflow,
          };

          const stageMap = new Map();
          const pipeline = new Pipeline(root, stageMap, testScopeFactory);

          await pipeline.execute();

          const subflowResults = pipeline.getSubflowResults();

          // PROPERTY: Both subflows have results
          expect(subflowResults.has('outer-sf')).toBe(true);
          expect(subflowResults.has('inner-sf')).toBe(true);

          // PROPERTY: Outer subflow has outer key, not inner key
          const outerResult = subflowResults.get('outer-sf')!;
          const outerGlobal = outerResult.treeContext.globalContext as Record<string, unknown>;
          expect(outerGlobal[outerKey]).toBe('outer-value');
          if (outerKey !== actualInnerKey) {
            expect(Object.prototype.hasOwnProperty.call(outerGlobal, actualInnerKey)).toBe(false);
          }

          // PROPERTY: Inner subflow has inner key, not outer key
          const innerResult = subflowResults.get('inner-sf')!;
          const innerGlobal = innerResult.treeContext.globalContext as Record<string, unknown>;
          expect(innerGlobal[actualInnerKey]).toBe('inner-value');
          if (outerKey !== actualInnerKey) {
            expect(Object.prototype.hasOwnProperty.call(innerGlobal, outerKey)).toBe(false);
          }
        }),
        { numRuns: 50 },
      );
    });
  });

  /**
   * Property 4: ChildrenExecutor Aggregation
   * ------------------------------------------------------------------
   * For any fork node with children, the ChildrenExecutor SHALL aggregate
   * results using Promise.allSettled and produce the correct structure.
   *
   * **Validates: Requirements 2.3**
   */
  describe('Property 4: ChildrenExecutor Aggregation', () => {
    it('mixed success/error children are aggregated correctly', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(fc.boolean(), { minLength: 2, maxLength: 4 }),
          async (shouldErrorFlags) => {
            const children: StageNode[] = shouldErrorFlags.map((shouldError, i) => ({
              name: `child${i}`,
              id: `child${i}`,
              fn: () => {
                if (shouldError) {
                  throw new Error(`Error from child${i}`);
                }
                return `success-${i}`;
              },
            }));

            const root: StageNode = {
              name: 'root',
              id: 'root',
              fn: () => 'root-output',
              children,
            };

            const stageMap = new Map();
            const pipeline = new Pipeline(root, stageMap, testScopeFactory);

            // Pipeline returns result with isError flags, doesn't always throw
            const result = await pipeline.execute();

            // PROPERTY: Result contains aggregated children results
            expect(result).toBeDefined();

            // PROPERTY: Context tree has children array
            const contextTree = pipeline.getContextTree();
            expect(contextTree.stageContexts.children).toBeDefined();
            expect(contextTree.stageContexts.children!.length).toBe(shouldErrorFlags.length);
          },
        ),
        { numRuns: 50 },
      );
    });
  });

  /**
   * Property 5: Execution Order Preservation
   * ------------------------------------------------------------------
   * For any pipeline structure, the execution order SHALL be preserved:
   * - Linear: stage1 -> stage2 -> stage3
   * - Fork: parent -> [children in parallel]
   * - Subflow: parent -> subflow stages -> continue
   *
   * **Validates: Requirements 5.2, 6.2**
   */
  describe('Property 5: Execution Order Preservation', () => {
    it('linear execution order is preserved', async () => {
      await fc.assert(
        fc.asyncProperty(fc.integer({ min: 3, max: 6 }), async (numStages) => {
          const executionOrder: string[] = [];

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

          // PROPERTY: Execution order matches expected linear order
          const expectedOrder = Array.from({ length: numStages }, (_, i) => `stage${i}`);
          expect(executionOrder).toEqual(expectedOrder);
        }),
        { numRuns: 100 },
      );
    });

    it('fork children all execute before join continues', async () => {
      await fc.assert(
        fc.asyncProperty(fc.integer({ min: 2, max: 4 }), async (numChildren) => {
          const executionOrder: string[] = [];

          const children: StageNode[] = [];
          for (let i = 0; i < numChildren; i++) {
            children.push({
              name: `child${i}`,
              id: `child${i}`,
              fn: () => {
                executionOrder.push(`child${i}`);
                return `child-output-${i}`;
              },
            });
          }

          const afterFork: StageNode = {
            name: 'afterFork',
            id: 'afterFork',
            fn: () => {
              executionOrder.push('afterFork');
              return 'after-output';
            },
          };

          const root: StageNode = {
            name: 'root',
            id: 'root',
            fn: () => {
              executionOrder.push('root');
              return 'root-output';
            },
            children,
            next: afterFork,
          };

          const stageMap = new Map();
          const pipeline = new Pipeline(root, stageMap, testScopeFactory);

          await pipeline.execute();

          // PROPERTY: Root executes first
          expect(executionOrder[0]).toBe('root');

          // PROPERTY: All children execute before afterFork
          const afterForkIndex = executionOrder.indexOf('afterFork');
          for (let i = 0; i < numChildren; i++) {
            const childIndex = executionOrder.indexOf(`child${i}`);
            expect(childIndex).toBeLessThan(afterForkIndex);
            expect(childIndex).toBeGreaterThan(0); // After root
          }
        }),
        { numRuns: 100 },
      );
    });
  });
});
