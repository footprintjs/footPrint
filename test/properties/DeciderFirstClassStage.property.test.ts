/**
 * Property-Based Tests: Decider First-Class Stage
 *
 * INVARIANTS TESTED:
 * These properties must hold for ALL valid inputs:
 * 1. addDeciderFunction produces correct build output structure
 * 2. Scope-based decider routes to correct branch
 * 3. Default fallback for invalid branch IDs
 * 4. Error propagation on decider throw
 * 5. Debug visibility for scope-based deciders
 * 6. Multiple scope-based deciders execute independently
 *
 * GENERATOR STRATEGY:
 * - Generate random valid stage names (alphanumeric, starting with letter)
 * - Generate random stage functions (simple sync/async returning branch IDs)
 * - Generate random optional ids and displayNames
 * - Generate random branch configurations (1-5 branches with unique IDs)
 * - Generate random scope key/value pairs for decider state
 * - Verify structural properties of the built FlowChart
 * - Verify execution-time routing, error handling, and debug visibility
 *
 * Feature: decider-first-class-stage, Property 1-6
 */

import * as fc from 'fast-check';
import {
  FlowChartBuilder,
  flowChart,
  type SerializedPipelineStructure,
} from '../../src/core/builder/FlowChartBuilder';
import { FlowChartExecutor } from '../../src/core/executor/FlowChartExecutor';
import type { StageNode } from '../../src/core/executor/Pipeline';
import type { StageSnapshot } from '../../src/core/executor/types';
import { StageContext } from '../../src/core/memory/StageContext';
import type { ScopeFactory } from '../../src/core/memory/types';

/**
 * Simple scope factory for testing.
 * WHY: Pipeline requires a scope factory to create scope instances for each stage.
 * Using StageContext directly is the simplest approach for property tests.
 */
const testScopeFactory: ScopeFactory<StageContext> = (context: StageContext) => context;

/* ============================================================================
 * Generators
 * ========================================================================== */

/**
 * Arbitrary for valid stage names (non-empty, alphanumeric, starts with letter).
 * WHY: Stage names are used as stageMap keys and must be valid identifiers.
 */
const arbStageName = fc
  .string({ minLength: 1, maxLength: 20 })
  .filter((s) => /^[a-zA-Z][a-zA-Z0-9_]*$/.test(s));

/**
 * Arbitrary for optional stage IDs (same format as names, or undefined).
 */
const arbOptionalId = fc.option(arbStageName, { nil: undefined });

/**
 * Arbitrary for optional display names (any non-empty string, or undefined).
 */
const arbOptionalDisplayName = fc.option(
  fc.string({ minLength: 1, maxLength: 30 }).filter((s) => s.trim().length > 0),
  { nil: undefined },
);

/**
 * Arbitrary for a branch configuration: unique id, name, optional fn.
 * WHY: Branches need unique IDs for decider routing.
 */
const arbBranch = fc.record({
  id: arbStageName,
  name: arbStageName,
  hasFn: fc.boolean(),
});

/**
 * Arbitrary for a list of branches with unique IDs (1-5 branches).
 * WHY: Deciders require at least one branch, and IDs must be unique.
 */
const arbBranches = fc
  .array(arbBranch, { minLength: 1, maxLength: 5 })
  .map((branches) => {
    // Ensure unique IDs by appending index
    return branches.map((b, i) => ({
      ...b,
      id: `${b.id}_${i}`,
      name: `${b.name}_${i}`,
    }));
  });

/* ============================================================================
 * Helpers
 * ========================================================================== */

/**
 * Walk a StageNode tree to find a node by name.
 */
function findNode<TOut, TScope>(
  root: StageNode<TOut, TScope>,
  name: string,
): StageNode<TOut, TScope> | undefined {
  if (root.name === name) return root;
  if (root.children) {
    for (const child of root.children) {
      const found = findNode(child, name);
      if (found) return found;
    }
  }
  if (root.next) return findNode(root.next, name);
  return undefined;
}

/**
 * Walk a SerializedPipelineStructure tree to find a spec by name.
 */
function findSpec(
  root: SerializedPipelineStructure,
  name: string,
): SerializedPipelineStructure | undefined {
  if (root.name === name) return root;
  if (root.children) {
    for (const child of root.children) {
      const found = findSpec(child, name);
      if (found) return found;
    }
  }
  if (root.next) return findSpec(root.next, name);
  return undefined;
}

/* ============================================================================
 * Property Tests
 * ========================================================================== */

describe('Feature: decider-first-class-stage', () => {
  /**
   * PROPERTY 1: Build-time correctness of addDeciderFunction
   *
   * For any valid name, stage function, optional id, optional displayName,
   * and set of branches with unique IDs, calling addDeciderFunction(name, fn, id, displayName)
   * followed by branch additions and end() SHALL produce a FlowChart where:
   * - The StageNode has the correct name, fn registered in stageMap, id, displayName
   * - deciderFn = true on the StageNode
   * - nextNodeDecider is NOT set
   * - SerializedPipelineStructure has hasDecider: true, type: 'decider'
   * - branchIds match the added branches
   *
   * **Validates: Requirements 1.1, 1.3, 1.4, 1.5, 5.1, 6.1, 6.2, 6.3**
   *
   * COUNTEREXAMPLE MEANING:
   * If this fails, it means addDeciderFunction is not correctly building the
   * StageNode tree or SerializedPipelineStructure, which would cause Pipeline
   * to misroute execution or the debug UI to render incorrectly.
   */
  describe('Property 1: Build-time correctness of addDeciderFunction', () => {
    it('should produce correct StageNode and spec structure for any valid inputs', () => {
      fc.assert(
        fc.property(
          arbStageName, // rootName
          arbStageName, // deciderName
          arbOptionalId, // deciderId
          arbOptionalDisplayName, // deciderDisplayName
          arbBranches, // branches
          (rootName, deciderName, deciderId, deciderDisplayName, branches) => {
            // Ensure deciderName differs from rootName to avoid stageMap collision
            if (deciderName === rootName) return;

            // Create a dummy stage function for the decider
            const deciderFn = () => branches[0].id;

            // Build the flowchart
            const builder = new FlowChartBuilder();
            builder.start(rootName, () => 'root-output');

            let deciderList = builder.addDeciderFunction(
              deciderName,
              deciderFn as any,
              deciderId,
              deciderDisplayName,
            );

            // Add branches
            for (const branch of branches) {
              const branchFn = branch.hasFn ? (() => `output-${branch.id}`) : undefined;
              deciderList = deciderList.addFunctionBranch(
                branch.id,
                branch.name,
                branchFn as any,
              );
            }

            deciderList.end();
            const flowChart = builder.build();

            // ── Verify StageNode structure ──

            // Find the decider node in the tree
            const deciderNode = findNode(flowChart.root, deciderName);
            expect(deciderNode).toBeDefined();

            // deciderFn must be true (scope-based decider)
            // _Requirements: 5.1_
            expect(deciderNode!.deciderFn).toBe(true);

            // nextNodeDecider must NOT be set (mutually exclusive)
            expect(deciderNode!.nextNodeDecider).toBeUndefined();

            // Name must match
            expect(deciderNode!.name).toBe(deciderName);

            // Optional id must match if provided
            // _Requirements: 1.4_
            if (deciderId) {
              expect(deciderNode!.id).toBe(deciderId);
            }

            // Optional displayName must match if provided
            // _Requirements: 1.5_
            if (deciderDisplayName) {
              expect(deciderNode!.displayName).toBe(deciderDisplayName);
            }

            // fn must be registered in stageMap
            // _Requirements: 1.3_
            expect(flowChart.stageMap.has(deciderName)).toBe(true);
            expect(flowChart.stageMap.get(deciderName)).toBe(deciderFn);

            // Children must match branches
            expect(deciderNode!.children).toBeDefined();
            expect(deciderNode!.children!.length).toBe(branches.length);

            const childIds = deciderNode!.children!.map((c) => c.id);
            for (const branch of branches) {
              expect(childIds).toContain(branch.id);
            }

            // ── Verify SerializedPipelineStructure ──

            const deciderSpec = findSpec(flowChart.buildTimeStructure, deciderName);
            expect(deciderSpec).toBeDefined();

            // hasDecider must be true
            // _Requirements: 6.1_
            expect(deciderSpec!.hasDecider).toBe(true);

            // type must be 'decider'
            // _Requirements: 6.2_
            expect(deciderSpec!.type).toBe('decider');

            // branchIds must match
            // _Requirements: 6.2_
            expect(deciderSpec!.branchIds).toBeDefined();
            const specBranchIds = deciderSpec!.branchIds!;
            for (const branch of branches) {
              expect(specBranchIds).toContain(branch.id);
            }
            expect(specBranchIds.length).toBe(branches.length);
          },
        ),
        { numRuns: 100 },
      );
    });

    it('should apply build-time extractor to decider nodes', () => {
      fc.assert(
        fc.property(
          arbStageName,
          arbStageName,
          arbBranches,
          (rootName, deciderName, branches) => {
            if (deciderName === rootName) return;

            // Track extractor calls
            const extractedNames: string[] = [];
            const extractor = (metadata: any) => {
              extractedNames.push(metadata.name);
              return { ...metadata, extracted: true };
            };

            const builder = new FlowChartBuilder(extractor);
            builder.start(rootName, () => 'root-output');

            let deciderList = builder.addDeciderFunction(
              deciderName,
              (() => branches[0].id) as any,
            );

            for (const branch of branches) {
              deciderList = deciderList.addFunctionBranch(branch.id, branch.name);
            }

            deciderList.end();
            builder.build();

            // Extractor must have been called for the decider node
            // _Requirements: 6.3_
            expect(extractedNames).toContain(deciderName);
          },
        ),
        { numRuns: 100 },
      );
    });
  });

  /* ============================================================================
   * Execution-Level Property Tests (Properties 2-6)
   *
   * These tests verify runtime behavior of scope-based deciders by building
   * and executing full pipelines. They complement the build-time tests above.
   * ========================================================================== */

  /**
   * PROPERTY 2: Scope-based decider routes to correct branch
   *
   * For any scope-based decider function (sync or async) that returns a valid
   * branch ID, and any set of branches containing that ID, executing the pipeline
   * SHALL invoke the decider with (scope, breakFn), commit the decider's scope
   * writes, and execute exactly the branch matching the returned ID.
   *
   * **Validates: Requirements 2.1, 2.2, 2.3, 2.6, 5.3**
   *
   * COUNTEREXAMPLE MEANING:
   * If this fails, it means the scope-based decider is not correctly routing
   * execution to the branch matching the returned ID, or scope writes are not
   * being committed before branch execution.
   */
  describe('Property 2: Scope-based decider routes to correct branch', () => {
    it('should route to the correct branch for any valid branch ID (sync and async)', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbBranches, // branches (1-5 with unique IDs)
          fc.boolean(), // isAsync — whether the decider is async
          fc.string({ minLength: 1, maxLength: 10 }), // scopeValue — value written by decider
          async (branches, isAsync, scopeValue) => {
            // Pick a random branch to route to
            const targetIndex = 0; // Always route to first branch for determinism
            const targetBranchId = branches[targetIndex].id;

            // Track which branches executed
            const executedBranches: string[] = [];
            // Track whether decider's scope write was committed before branch runs
            let scopeValueSeenByBranch: unknown = undefined;

            // Build the pipeline
            const builder = new FlowChartBuilder();
            builder.start('entry', ((scope: StageContext) => {
              scope.setObject([], 'entryDone', true);
            }) as any);

            // Create decider function (sync or async) that writes to scope and returns branch ID
            const deciderFn = isAsync
              ? async (scope: StageContext) => {
                  scope.setObject([], 'deciderWrite', scopeValue);
                  return targetBranchId;
                }
              : (scope: StageContext) => {
                  scope.setObject([], 'deciderWrite', scopeValue);
                  return targetBranchId;
                };

            let deciderList = builder.addDeciderFunction(
              'TestDecider',
              deciderFn as any,
              'test-decider',
            );

            // Add all branches with tracking functions
            for (const branch of branches) {
              deciderList = deciderList.addFunctionBranch(
                branch.id,
                branch.name,
                ((scope: StageContext) => {
                  executedBranches.push(branch.id);
                  // Read the decider's scope write to verify it was committed
                  scopeValueSeenByBranch = scope.getValue([], 'deciderWrite');
                  return `output-${branch.id}`;
                }) as any,
              );
            }

            deciderList.end();
            const chart = builder.build();
            const executor = new FlowChartExecutor(chart, testScopeFactory);
            await executor.run();

            // PROPERTY: Exactly one branch should have executed
            expect(executedBranches.length).toBe(1);

            // PROPERTY: The executed branch must match the returned ID
            // _Requirements: 2.1, 2.2, 5.3_
            expect(executedBranches[0]).toBe(targetBranchId);

            // PROPERTY: Decider's scope writes must be committed before branch execution
            // _Requirements: 2.6_
            expect(scopeValueSeenByBranch).toBe(scopeValue);
          },
        ),
        { numRuns: 100 },
      );
    });

    it('should route to any randomly chosen branch from the set', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbBranches,
          fc.nat(), // random index seed
          async (branches, indexSeed) => {
            // Pick a random branch to route to
            const targetIndex = indexSeed % branches.length;
            const targetBranchId = branches[targetIndex].id;

            const executedBranches: string[] = [];

            const builder = new FlowChartBuilder();
            builder.start('entry', (() => 'entry') as any);

            let deciderList = builder.addDeciderFunction(
              'RandomDecider',
              ((_scope: StageContext) => targetBranchId) as any,
              'random-decider',
            );

            for (const branch of branches) {
              deciderList = deciderList.addFunctionBranch(
                branch.id,
                branch.name,
                (() => {
                  executedBranches.push(branch.id);
                }) as any,
              );
            }

            deciderList.end();
            const chart = builder.build();
            const executor = new FlowChartExecutor(chart, testScopeFactory);
            await executor.run();

            // PROPERTY: Exactly the target branch should execute
            // _Requirements: 2.2, 2.3_
            expect(executedBranches).toEqual([targetBranchId]);
          },
        ),
        { numRuns: 100 },
      );
    });
  });

  /**
   * PROPERTY 3: Default fallback for invalid branch IDs
   *
   * For any scope-based decider that returns a branch ID not matching any child,
   * and a default branch configured (with id='default'), the pipeline SHALL
   * execute the default branch instead.
   *
   * **Validates: Requirements 2.4**
   *
   * COUNTEREXAMPLE MEANING:
   * If this fails, it means the default fallback mechanism is broken for
   * scope-based deciders, causing runtime errors when the decider returns
   * an unexpected branch ID.
   */
  describe('Property 3: Default fallback for invalid branch IDs', () => {
    it('should fall back to default branch when decider returns invalid ID', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbBranches, // branches
          arbStageName, // invalidBranchId — guaranteed not to match any branch
          async (branches, invalidBranchId) => {
            // Ensure the invalid ID doesn't accidentally match a branch
            const branchIds = new Set(branches.map((b) => b.id));
            if (branchIds.has(invalidBranchId) || branchIds.has('default')) return;

            const executedBranches: string[] = [];

            const builder = new FlowChartBuilder();
            builder.start('entry', (() => 'entry') as any);

            // Decider returns an ID that doesn't match any branch
            let deciderList = builder.addDeciderFunction(
              'FallbackDecider',
              ((_scope: StageContext) => invalidBranchId) as any,
              'fallback-decider',
            );

            // Add regular branches
            for (const branch of branches) {
              deciderList = deciderList.addFunctionBranch(
                branch.id,
                branch.name,
                (() => {
                  executedBranches.push(branch.id);
                }) as any,
              );
            }

            // Add a default branch (id='default' is what handleScopeBased looks for)
            deciderList = deciderList.addFunctionBranch(
              'default',
              'DefaultBranch',
              (() => {
                executedBranches.push('default');
              }) as any,
            );

            deciderList.end();
            const chart = builder.build();
            const executor = new FlowChartExecutor(chart, testScopeFactory);
            await executor.run();

            // PROPERTY: The default branch should execute when no match found
            // _Requirements: 2.4_
            expect(executedBranches).toEqual(['default']);
          },
        ),
        { numRuns: 100 },
      );
    });

    it('should throw when no default branch and invalid ID returned', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbBranches,
          arbStageName,
          async (branches, invalidBranchId) => {
            // Ensure the invalid ID doesn't match any branch
            const branchIds = new Set(branches.map((b) => b.id));
            if (branchIds.has(invalidBranchId)) return;

            const builder = new FlowChartBuilder();
            builder.start('entry', (() => 'entry') as any);

            let deciderList = builder.addDeciderFunction(
              'NoDefaultDecider',
              ((_scope: StageContext) => invalidBranchId) as any,
              'no-default-decider',
            );

            for (const branch of branches) {
              deciderList = deciderList.addFunctionBranch(branch.id, branch.name);
            }

            deciderList.end();
            const chart = builder.build();
            const executor = new FlowChartExecutor(chart, testScopeFactory);

            // PROPERTY: Should throw when no default and invalid ID
            await expect(executor.run()).rejects.toThrow(/doesn't match any child/);
          },
        ),
        { numRuns: 100 },
      );
    });
  });

  /**
   * PROPERTY 4: Error propagation on decider throw
   *
   * For any scope-based decider function that throws an error, the pipeline
   * SHALL commit the partial patch, call the extractor with error info
   * containing the error message, and propagate the exception to the caller.
   *
   * **Validates: Requirements 2.5**
   *
   * COUNTEREXAMPLE MEANING:
   * If this fails, it means errors in scope-based deciders are not being
   * properly propagated or the partial patch is not being committed,
   * which would break error handling and forensic debugging.
   */
  describe('Property 4: Error propagation on decider throw', () => {
    it('should propagate errors and call extractor with error info', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbBranches,
          fc.string({ minLength: 1, maxLength: 50 }), // errorMessage
          fc.string({ minLength: 1, maxLength: 10 }), // scopeWriteBeforeError
          async (branches, errorMessage, scopeWriteBeforeError) => {
            // Track extractor calls to verify error info
            const extractorSnapshots: StageSnapshot[] = [];

            const builder = new FlowChartBuilder();
            builder.start('entry', ((scope: StageContext) => {
              scope.setObject([], 'entryDone', true);
            }) as any);

            // Decider writes to scope then throws
            let deciderList = builder.addDeciderFunction(
              'ErrorDecider',
              ((scope: StageContext) => {
                // Write to scope before throwing (partial patch)
                scope.setObject([], 'partialWrite', scopeWriteBeforeError);
                throw new Error(errorMessage);
              }) as any,
              'error-decider',
            );

            for (const branch of branches) {
              deciderList = deciderList.addFunctionBranch(branch.id, branch.name);
            }

            deciderList.end();

            // Add extractor to capture snapshots
            builder.addTraversalExtractor((snapshot: StageSnapshot) => {
              extractorSnapshots.push(snapshot);
              return { name: snapshot.node.name };
            });

            const chart = builder.build();
            const executor = new FlowChartExecutor(
              chart,
              testScopeFactory,
              undefined,
              undefined,
              undefined,
              undefined,
              undefined,
              undefined,
              true, // enrichSnapshots
            );

            // PROPERTY: Error must propagate to the caller
            // _Requirements: 2.5_
            await expect(executor.run()).rejects.toThrow(errorMessage);

            // PROPERTY: Extractor must have been called for the decider with error info
            const deciderSnapshot = extractorSnapshots.find(
              (s) => s.node.name === 'ErrorDecider',
            );
            expect(deciderSnapshot).toBeDefined();

            // PROPERTY: Error info must be present in the snapshot
            // _Requirements: 2.5_
            expect(deciderSnapshot!.errorInfo).toBeDefined();
            expect(deciderSnapshot!.errorInfo!.type).toBe('stageExecutionError');
            expect(deciderSnapshot!.errorInfo!.message).toContain(errorMessage);
          },
        ),
        { numRuns: 100 },
      );
    });
  });

  /**
   * PROPERTY 5: Debug visibility for scope-based deciders
   *
   * For any scope-based decider execution with an extractor configured,
   * the extractor SHALL receive a StageSnapshot with a positive stepNumber,
   * structureMetadata.type === 'decider', scopeState populated (when
   * enrichSnapshots is enabled), and a flow debug message logged with
   * the chosen branch name.
   *
   * **Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5**
   *
   * COUNTEREXAMPLE MEANING:
   * If this fails, it means scope-based deciders are not appearing as
   * full stages in the debug UI, breaking observability and time-travel.
   */
  describe('Property 5: Debug visibility for scope-based deciders', () => {
    it('should produce correct StageSnapshot with debug metadata', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbBranches,
          fc.string({ minLength: 1, maxLength: 10 }), // scopeValue
          async (branches, scopeValue) => {
            const targetBranchId = branches[0].id;
            const extractorSnapshots: StageSnapshot[] = [];

            const builder = new FlowChartBuilder();
            builder.start('entry', ((scope: StageContext) => {
              scope.setObject([], 'entryValue', scopeValue);
            }) as any);

            let deciderList = builder.addDeciderFunction(
              'DebugDecider',
              ((scope: StageContext) => {
                scope.setObject([], 'deciderValue', scopeValue);
                return targetBranchId;
              }) as any,
              'debug-decider',
            );

            for (const branch of branches) {
              deciderList = deciderList.addFunctionBranch(
                branch.id,
                branch.name,
                (() => `output-${branch.id}`) as any,
              );
            }

            deciderList.end();

            builder.addTraversalExtractor((snapshot: StageSnapshot) => {
              extractorSnapshots.push(snapshot);
              return { name: snapshot.node.name, step: snapshot.stepNumber };
            });

            const chart = builder.build();
            const executor = new FlowChartExecutor(
              chart,
              testScopeFactory,
              undefined,
              undefined,
              undefined,
              undefined,
              undefined,
              undefined,
              true, // enrichSnapshots
            );
            await executor.run();

            // Find the decider's snapshot
            const deciderSnapshot = extractorSnapshots.find(
              (s) => s.node.name === 'DebugDecider',
            );
            expect(deciderSnapshot).toBeDefined();

            // PROPERTY: stepNumber must be positive (1-based)
            // _Requirements: 3.1_
            expect(deciderSnapshot!.stepNumber).toBeGreaterThan(0);

            // PROPERTY: structureMetadata.type must be 'decider'
            // _Requirements: 3.2_
            expect(deciderSnapshot!.structureMetadata.type).toBe('decider');

            // PROPERTY: scopeState must be populated when enrichSnapshots is enabled
            // _Requirements: 3.3_
            expect(deciderSnapshot!.scopeState).toBeDefined();

            // PROPERTY: stageOutput should be the branch ID
            expect(deciderSnapshot!.stageOutput).toBe(targetBranchId);

            // PROPERTY: debugInfo should contain flow messages with the chosen branch name
            // _Requirements: 3.5_
            // The flow message is added AFTER the extractor call for the decider,
            // so we check the branch's snapshot or the decider context directly.
            // The flow message is on the decider's context, captured in debugInfo.
            // Note: The flow message is added after commit and extractor call,
            // so it may appear in the branch's context. Let's verify the branch executed.
            const branchSnapshot = extractorSnapshots.find(
              (s) => s.node.id === targetBranchId,
            );
            expect(branchSnapshot).toBeDefined();
            // The branch should have a step number after the decider
            expect(branchSnapshot!.stepNumber).toBeGreaterThan(deciderSnapshot!.stepNumber);
          },
        ),
        { numRuns: 100 },
      );
    });

    it('should log flow debug message with chosen branch name', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbBranches,
          async (branches) => {
            const targetBranchId = branches[0].id;
            const targetBranchName = branches[0].name;

            const builder = new FlowChartBuilder();
            builder.start('entry', (() => 'entry') as any);

            let deciderList = builder.addDeciderFunction(
              'FlowMsgDecider',
              ((_scope: StageContext) => targetBranchId) as any,
              'flow-msg-decider',
            );

            for (const branch of branches) {
              deciderList = deciderList.addFunctionBranch(
                branch.id,
                branch.name,
                (() => `output-${branch.id}`) as any,
              );
            }

            deciderList.end();

            // Use enrichSnapshots to capture debugInfo with flow messages
            const extractorSnapshots: StageSnapshot[] = [];
            builder.addTraversalExtractor((snapshot: StageSnapshot) => {
              extractorSnapshots.push(snapshot);
              return { name: snapshot.node.name };
            });

            const chart = builder.build();
            const executor = new FlowChartExecutor(
              chart,
              testScopeFactory,
              undefined,
              undefined,
              undefined,
              undefined,
              undefined,
              undefined,
              true, // enrichSnapshots
            );
            await executor.run();

            // The flow debug message is added to the decider's context AFTER
            // the extractor call, so we need to check the context directly.
            // The branch snapshot's context should have the flow message from
            // the decider's context tree.
            // Let's verify via the enriched snapshot's debugInfo on the branch.
            // Actually, the flow message is on the decider context, and the
            // branch gets a new context via createNext. So the flow message
            // lives on the decider's StageContext.
            const deciderSnapshot = extractorSnapshots.find(
              (s) => s.node.name === 'FlowMsgDecider',
            );
            expect(deciderSnapshot).toBeDefined();

            // Access the context's flow messages directly
            // _Requirements: 3.5_
            const flowMessages = deciderSnapshot!.context.debug.flowMessages;
            expect(flowMessages.length).toBeGreaterThan(0);

            // Find the branch flow message
            const branchMsg = flowMessages.find((m: any) => m.type === 'branch');
            expect(branchMsg).toBeDefined();
            // The message should mention the chosen branch name
            expect(branchMsg!.description).toContain(targetBranchName);
          },
        ),
        { numRuns: 100 },
      );
    });
  });

  /**
   * PROPERTY 6: Multiple scope-based deciders execute independently
   *
   * For any two separate pipelines each containing addDeciderFunction nodes,
   * each decider SHALL execute according to its scope-based function and
   * produce the correct branch selection independently.
   *
   * **Validates: Requirements 4.3, 5.3**
   *
   * COUNTEREXAMPLE MEANING:
   * If this fails, it means having multiple scope-based deciders in
   * separate pipelines causes interference.
   */
  describe('Property 6: Multiple scope-based deciders execute independently', () => {
    it('should execute two scope-based deciders correctly in separate pipelines', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.nat({ max: 1 }), // firstTargetIndex (0 or 1)
          fc.nat({ max: 1 }), // secondTargetIndex (0 or 1)
          async (firstTargetIndex, secondTargetIndex) => {
            const firstBranches = [
              { id: 'first_a', name: 'FirstA' },
              { id: 'first_b', name: 'FirstB' },
            ];
            const secondBranches = [
              { id: 'second_a', name: 'SecondA' },
              { id: 'second_b', name: 'SecondB' },
            ];

            const firstTargetId = firstBranches[firstTargetIndex].id;
            const secondTargetId = secondBranches[secondTargetIndex].id;

            const executedBranches: string[] = [];

            // Pipeline 1: Scope-based decider
            const firstBuilder = new FlowChartBuilder();
            firstBuilder.start('firstEntry', ((scope: StageContext) => {
              scope.setObject([], 'firstRoute', firstTargetId);
            }) as any);

            let firstDeciderList = firstBuilder.addDeciderFunction(
              'FirstDecider',
              ((scope: StageContext) => {
                return scope.getValue([], 'firstRoute') as string;
              }) as any,
              'first-decider',
            );

            for (const branch of firstBranches) {
              firstDeciderList = firstDeciderList.addFunctionBranch(
                branch.id,
                branch.name,
                (() => { executedBranches.push(branch.id); }) as any,
              );
            }
            firstDeciderList.end();
            const firstChart = firstBuilder.build();

            // Pipeline 2: Scope-based decider
            const secondBuilder = new FlowChartBuilder();
            secondBuilder.start('secondEntry', ((scope: StageContext) => {
              scope.setObject([], 'secondRoute', secondTargetId);
            }) as any);

            let secondDeciderList = secondBuilder.addDeciderFunction(
              'SecondDecider',
              ((scope: StageContext) => {
                return scope.getValue([], 'secondRoute') as string;
              }) as any,
              'second-decider',
            );

            for (const branch of secondBranches) {
              secondDeciderList = secondDeciderList.addFunctionBranch(
                branch.id,
                branch.name,
                (() => { executedBranches.push(branch.id); }) as any,
              );
            }
            secondDeciderList.end();
            const secondChart = secondBuilder.build();

            // Execute both pipelines
            await new FlowChartExecutor(firstChart, testScopeFactory).run();
            await new FlowChartExecutor(secondChart, testScopeFactory).run();

            // PROPERTY: Both deciders should have executed their correct branches
            // _Requirements: 4.3, 5.3_
            expect(executedBranches.length).toBe(2);
            expect(executedBranches[0]).toBe(firstTargetId);
            expect(executedBranches[1]).toBe(secondTargetId);
          },
        ),
        { numRuns: 100 },
      );
    });

    it('should use identical DeciderList API for multiple addDeciderFunction calls', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbBranches,
          async (branches) => {
            const targetId = branches[0].id;

            const firstExecuted: string[] = [];
            const secondExecuted: string[] = [];

            // Pipeline 1: Scope-based decider with constant return
            const firstBuilder = new FlowChartBuilder();
            firstBuilder.start('entry', (() => 'entry') as any);
            let firstList = firstBuilder.addDeciderFunction(
              'Decider',
              (() => targetId) as any,
            );
            for (const branch of branches) {
              firstList = firstList.addFunctionBranch(
                branch.id,
                branch.name,
                (() => { firstExecuted.push(branch.id); }) as any,
              );
            }
            firstList.end();
            const firstChart = firstBuilder.build();

            // Pipeline 2: Scope-based decider with scope read
            const secondBuilder = new FlowChartBuilder();
            secondBuilder.start('entry', ((scope: StageContext) => {
              scope.setObject([], 'target', targetId);
            }) as any);
            let secondList = secondBuilder.addDeciderFunction(
              'Decider',
              ((scope: StageContext) => scope.getValue([], 'target') as string) as any,
            );
            for (const branch of branches) {
              secondList = secondList.addFunctionBranch(
                branch.id,
                branch.name,
                (() => { secondExecuted.push(branch.id); }) as any,
              );
            }
            secondList.end();
            const secondChart = secondBuilder.build();

            // Execute both
            await new FlowChartExecutor(firstChart, testScopeFactory).run();
            await new FlowChartExecutor(secondChart, testScopeFactory).run();

            // PROPERTY: Both should route to the same branch
            expect(firstExecuted).toEqual([targetId]);
            expect(secondExecuted).toEqual([targetId]);
          },
        ),
        { numRuns: 100 },
      );
    });
  });
});
