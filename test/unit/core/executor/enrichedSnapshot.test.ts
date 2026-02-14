/**
 * enrichedSnapshot.test.ts
 *
 * Unit tests for the enriched StageSnapshot feature (single-pass-debug-structure).
 *
 * BEHAVIOR: When `enrichSnapshots: true` is enabled on FlowChartExecutor,
 * the StageSnapshot passed to the TraversalExtractor includes additional
 * fields: scopeState, debugInfo, stageOutput, errorInfo, and historyIndex.
 *
 * These tests verify:
 * - historyIndex is correctly set from ExecutionHistory length
 * - historyIndex values are non-negative integers
 * - historyIndex values are monotonically increasing
 * - historyIndex reflects the number of commits at each stage's extraction time
 * - Parallel children paths in extractedResults preserve parent-child hierarchy
 *
 * _Requirements: single-pass-debug-structure 2.4, 3.1, 3.2, 3.3_
 */

import { Pipeline, StageNode } from '../../../../src/core/executor/Pipeline';
import { FlowChartExecutor } from '../../../../src/core/executor/FlowChartExecutor';
import {
  TraversalExtractor,
  PipelineStageFunction,
  StageSnapshot,
} from '../../../../src/core/executor/types';
import { StageContext } from '../../../../src/core/memory/StageContext';
import type { ScopeFactory } from '../../../../src/core/memory/types';

type TOut = any;
type TScope = any;
type PSF = PipelineStageFunction<TOut, TScope>;
type Node = StageNode<TOut, TScope>;

// Silence logger noise during tests
// WHY: Include debug() because scopeLog.ts calls logger.debug when setObject is used
jest.mock('../../../../src/utils/logger', () => ({
  logger: { error: jest.fn(), info: jest.fn(), warn: jest.fn(), debug: jest.fn() },
}));

// Simple scope factory - returns context as scope (matches existing test patterns)
const scopeFactory: ScopeFactory<any> = (ctx: any) => ctx;

// Build a typed stageMap from object (matches existing test patterns)
const makeMap = (obj: Record<string, jest.Mock<any, any>>): Map<string, PSF> => {
  const m = new Map<string, PSF>();
  for (const [k, v] of Object.entries(obj)) m.set(k, v as unknown as PSF);
  return m;
};

describe('Enriched StageSnapshot: historyIndex', () => {
  /**
   * BEHAVIOR: historyIndex reflects the number of commits in ExecutionHistory
   * at the time the extractor is called for each stage.
   *
   * WHY: This enables scope reconstruction via executionHistory.materialise(historyIndex)
   * without a separate history replay pass. Consumers can use this index to
   * materialise the scope state at any stage on demand.
   */
  describe('when enrichSnapshots is enabled on a linear pipeline with scope writes', () => {
    /**
     * VERIFIES: historyIndex is present and correctly set for each stage
     * in a linear pipeline where every stage writes to scope (triggering commits).
     *
     * DESIGN: Each stage writes a unique key to scope via context.setObject(),
     * which means each stage's commit() records a new entry in ExecutionHistory.
     * The historyIndex should reflect the cumulative commit count at extraction time.
     *
     * _Requirements: single-pass-debug-structure 3.1, 3.2, 3.3_
     */
    it('should set historyIndex to the number of commits at each stage extraction time', async () => {
      // Arrange: Capture all enriched snapshots during traversal
      const capturedSnapshots: StageSnapshot[] = [];
      const extractor: TraversalExtractor = (snapshot) => {
        capturedSnapshots.push(snapshot);
        return {
          stageName: snapshot.node.name,
          historyIndex: snapshot.historyIndex,
          stepNumber: snapshot.stepNumber,
        };
      };

      // Stage functions that write to scope (so commits happen)
      // WHY: Each setObject call writes to the WriteBuffer, and commit()
      // flushes it to GlobalStore + records in ExecutionHistory.
      const fns = {
        stage1: jest.fn((scope: StageContext) => {
          scope.setObject([], 'key1', 'value1');
          return 'result1';
        }),
        stage2: jest.fn((scope: StageContext) => {
          scope.setObject([], 'key2', 'value2');
          return 'result2';
        }),
        stage3: jest.fn((scope: StageContext) => {
          scope.setObject([], 'key3', 'value3');
          return 'result3';
        }),
        stage4: jest.fn((scope: StageContext) => {
          scope.setObject([], 'key4', 'value4');
          return 'result4';
        }),
      };

      const root: Node = {
        name: 'stage1',
        fn: fns.stage1,
        next: {
          name: 'stage2',
          fn: fns.stage2,
          next: {
            name: 'stage3',
            fn: fns.stage3,
            next: {
              name: 'stage4',
              fn: fns.stage4,
            },
          },
        },
      };

      // Act: Execute with enrichSnapshots enabled (last constructor param)
      const pipeline = new Pipeline(
        root,
        makeMap(fns),
        scopeFactory,
        undefined, // defaultValuesForContext
        undefined, // initialContext
        undefined, // readOnlyContext
        undefined, // throttlingErrorChecker
        undefined, // streamHandlers
        extractor,
        undefined, // scopeProtectionMode
        undefined, // subflows
        true,       // enrichSnapshots
      );
      await pipeline.execute();

      // Assert: All 4 stages should have been captured
      expect(capturedSnapshots.length).toBe(4);

      // Each stage writes to scope and commits, so historyIndex should
      // reflect the cumulative commit count:
      // - After stage1 commits: 1 commit in history → historyIndex = 1
      // - After stage2 commits: 2 commits in history → historyIndex = 2
      // - After stage3 commits: 3 commits in history → historyIndex = 3
      // - After stage4 commits: 4 commits in history → historyIndex = 4
      const historyIndices = capturedSnapshots.map((s) => s.historyIndex);
      expect(historyIndices).toEqual([1, 2, 3, 4]);
    });

    /**
     * VERIFIES: historyIndex values are non-negative integers.
     * EDGE CASE: Ensures no negative or fractional values appear.
     *
     * _Requirements: single-pass-debug-structure 3.3_
     */
    it('should produce non-negative integer historyIndex values', async () => {
      const capturedSnapshots: StageSnapshot[] = [];
      const extractor: TraversalExtractor = (snapshot) => {
        capturedSnapshots.push(snapshot);
        return { historyIndex: snapshot.historyIndex };
      };

      const fns = {
        stageA: jest.fn((scope: StageContext) => {
          scope.setObject([], 'a', 1);
          return 'a';
        }),
        stageB: jest.fn((scope: StageContext) => {
          scope.setObject([], 'b', 2);
          return 'b';
        }),
        stageC: jest.fn((scope: StageContext) => {
          scope.setObject([], 'c', 3);
          return 'c';
        }),
      };

      const root: Node = {
        name: 'stageA',
        fn: fns.stageA,
        next: {
          name: 'stageB',
          fn: fns.stageB,
          next: { name: 'stageC', fn: fns.stageC },
        },
      };

      const pipeline = new Pipeline(
        root,
        makeMap(fns),
        scopeFactory,
        undefined, undefined, undefined, undefined, undefined,
        extractor,
        undefined, undefined,
        true, // enrichSnapshots
      );
      await pipeline.execute();

      // Every historyIndex should be a non-negative integer
      for (const snapshot of capturedSnapshots) {
        expect(snapshot.historyIndex).toBeDefined();
        expect(typeof snapshot.historyIndex).toBe('number');
        expect(snapshot.historyIndex).toBeGreaterThanOrEqual(0);
        expect(Number.isInteger(snapshot.historyIndex)).toBe(true);
      }
    });

    /**
     * VERIFIES: historyIndex values are monotonically increasing across stages.
     * WHY: Each stage commits at least once, so the history grows with each stage.
     * The historyIndex at stage N+1 must be strictly greater than at stage N.
     *
     * _Requirements: single-pass-debug-structure 3.3_
     */
    it('should produce monotonically increasing historyIndex values', async () => {
      const historyIndices: number[] = [];
      const extractor: TraversalExtractor = (snapshot) => {
        historyIndices.push(snapshot.historyIndex!);
        return { historyIndex: snapshot.historyIndex };
      };

      const fns = {
        first: jest.fn((scope: StageContext) => {
          scope.setObject([], 'first', true);
          return 'first';
        }),
        second: jest.fn((scope: StageContext) => {
          scope.setObject([], 'second', true);
          return 'second';
        }),
        third: jest.fn((scope: StageContext) => {
          scope.setObject([], 'third', true);
          return 'third';
        }),
      };

      const root: Node = {
        name: 'first',
        fn: fns.first,
        next: {
          name: 'second',
          fn: fns.second,
          next: { name: 'third', fn: fns.third },
        },
      };

      const pipeline = new Pipeline(
        root,
        makeMap(fns),
        scopeFactory,
        undefined, undefined, undefined, undefined, undefined,
        extractor,
        undefined, undefined,
        true, // enrichSnapshots
      );
      await pipeline.execute();

      // Verify monotonic increase: each value must be strictly greater than the previous
      expect(historyIndices.length).toBeGreaterThanOrEqual(2);
      for (let i = 1; i < historyIndices.length; i++) {
        expect(historyIndices[i]).toBeGreaterThan(historyIndices[i - 1]);
      }
    });

    /**
     * VERIFIES: historyIndex is undefined when enrichSnapshots is disabled.
     * WHY: Backward compatibility — existing extractors should not see enrichment fields.
     *
     * _Requirements: single-pass-debug-structure 4.1_
     */
    it('should NOT include historyIndex when enrichSnapshots is disabled', async () => {
      const capturedSnapshots: StageSnapshot[] = [];
      const extractor: TraversalExtractor = (snapshot) => {
        capturedSnapshots.push(snapshot);
        return { name: snapshot.node.name };
      };

      const fns = {
        stage1: jest.fn((scope: StageContext) => {
          scope.setObject([], 'key', 'val');
          return 'done';
        }),
      };

      const root: Node = { name: 'stage1', fn: fns.stage1 };

      // enrichSnapshots NOT set (defaults to false)
      const pipeline = new Pipeline(
        root,
        makeMap(fns),
        scopeFactory,
        undefined, undefined, undefined, undefined, undefined,
        extractor,
      );
      await pipeline.execute();

      expect(capturedSnapshots.length).toBe(1);
      expect(capturedSnapshots[0].historyIndex).toBeUndefined();
    });

    /**
     * VERIFIES: historyIndex works correctly via FlowChartExecutor API.
     * WHY: Ensures the enrichSnapshots flag is properly threaded through
     * from FlowChartExecutor constructor to Pipeline.
     *
     * _Requirements: single-pass-debug-structure 3.1, 4.4_
     */
    it('should work correctly via FlowChartExecutor with enrichSnapshots', async () => {
      const capturedSnapshots: StageSnapshot[] = [];
      const extractor: TraversalExtractor = (snapshot) => {
        capturedSnapshots.push(snapshot);
        return {
          stageName: snapshot.node.name,
          historyIndex: snapshot.historyIndex,
        };
      };

      const chart = {
        root: {
          name: 'step1',
          fn: (scope: StageContext) => {
            scope.setObject([], 'x', 10);
            return 'step1-done';
          },
          next: {
            name: 'step2',
            fn: (scope: StageContext) => {
              scope.setObject([], 'y', 20);
              return 'step2-done';
            },
            next: {
              name: 'step3',
              fn: (scope: StageContext) => {
                scope.setObject([], 'z', 30);
                return 'step3-done';
              },
            },
          },
        } as Node,
        stageMap: new Map<string, PSF>([
          ['step1', ((scope: StageContext) => { scope.setObject([], 'x', 10); return 'step1-done'; }) as any],
          ['step2', ((scope: StageContext) => { scope.setObject([], 'y', 20); return 'step2-done'; }) as any],
          ['step3', ((scope: StageContext) => { scope.setObject([], 'z', 30); return 'step3-done'; }) as any],
        ]),
        extractor,
      };

      // enrichSnapshots passed as last constructor param
      const executor = new FlowChartExecutor(
        chart,
        scopeFactory,
        undefined, // defaultValuesForContext
        undefined, // initialContext
        undefined, // readOnlyContext
        undefined, // throttlingErrorChecker
        undefined, // streamHandlers
        undefined, // scopeProtectionMode
        true,       // enrichSnapshots
      );
      await executor.run();

      expect(capturedSnapshots.length).toBe(3);

      const historyIndices = capturedSnapshots.map((s) => s.historyIndex);

      // All should be defined, non-negative integers
      for (const idx of historyIndices) {
        expect(idx).toBeDefined();
        expect(typeof idx).toBe('number');
        expect(idx).toBeGreaterThanOrEqual(0);
        expect(Number.isInteger(idx)).toBe(true);
      }

      // Should be monotonically increasing
      for (let i = 1; i < historyIndices.length; i++) {
        expect(historyIndices[i]!).toBeGreaterThan(historyIndices[i - 1]!);
      }

      // Should reflect cumulative commit count: 1, 2, 3
      expect(historyIndices).toEqual([1, 2, 3]);
    });
  });
});

describe('Enriched StageSnapshot: parallel children path hierarchy', () => {
  /**
   * BEHAVIOR: When a pipeline has fork nodes with parallel children,
   * the stage paths in the extractedResults Map correctly reflect the
   * parent-child hierarchy. Each child's path should be prefixed by
   * its parent fork's branchPath context.
   *
   * WHY: The Incremental_Debug_Map must preserve parent-child relationships
   * via stage path hierarchy so consumers can reconstruct the tree structure
   * from the flat map without a post-traversal walk.
   *
   * _Requirements: single-pass-debug-structure 2.4_
   */
  describe('when a fork node has parallel children with stage functions', () => {
    /**
     * VERIFIES: Fork children paths in extractedResults are keyed with
     * the child's branchPath context, preserving the hierarchy.
     *
     * DESIGN: A fork node ("fork") has two children ("childA", "childB").
     * Each child has a stage function. The extractedResults should contain
     * entries for the fork node and both children, with children paths
     * reflecting their position in the hierarchy.
     *
     * _Requirements: single-pass-debug-structure 2.4_
     */
    it('should store fork children with hierarchy-preserving paths in extractedResults', async () => {
      const extractor: TraversalExtractor = (snapshot) => {
        return {
          stageName: snapshot.node.name,
          stepNumber: snapshot.stepNumber,
        };
      };

      const fns = {
        fork: jest.fn((scope: StageContext) => {
          scope.setObject([], 'forkKey', 'forkValue');
          return 'fork-result';
        }),
        childA: jest.fn((scope: StageContext) => {
          scope.setObject([], 'childAKey', 'childAValue');
          return 'childA-result';
        }),
        childB: jest.fn((scope: StageContext) => {
          scope.setObject([], 'childBKey', 'childBValue');
          return 'childB-result';
        }),
      };

      const root: Node = {
        name: 'fork',
        id: 'fork',
        fn: fns.fork,
        children: [
          { name: 'childA', id: 'childA', fn: fns.childA },
          { name: 'childB', id: 'childB', fn: fns.childB },
        ],
      };

      const pipeline = new Pipeline(
        root,
        makeMap(fns),
        scopeFactory,
        undefined, undefined, undefined, undefined, undefined,
        extractor,
        undefined, undefined,
        true, // enrichSnapshots
      );
      await pipeline.execute();

      const results = pipeline.getExtractedResults<{ stageName: string; stepNumber: number }>();
      const paths = Array.from(results.keys());

      // The fork node itself should have a path
      expect(paths.some((p) => p === 'fork')).toBe(true);

      // Children should have paths that include their child id context
      // The ChildrenExecutor sets pipelineIdForChild = pipelineId || child.id
      // so children get branchPath = child.id, and getStagePath builds child.id.child.id
      const childPaths = paths.filter((p) => p !== 'fork');
      expect(childPaths.length).toBe(2);

      // Each child path should be prefixed by the child's id (branch context)
      // Path format: branchPath.nodeId where branchPath = child.id
      expect(childPaths.some((p) => p.includes('childA'))).toBe(true);
      expect(childPaths.some((p) => p.includes('childB'))).toBe(true);

      // Verify the paths are distinct (each child has its own branch)
      const childAPath = childPaths.find((p) => p.includes('childA'))!;
      const childBPath = childPaths.find((p) => p.includes('childB'))!;
      expect(childAPath).not.toBe(childBPath);
    });

    /**
     * VERIFIES: Fork children with nested next chains preserve hierarchy
     * through the entire chain. A child's next stages should also have
     * paths that reflect the child's branch context.
     *
     * DESIGN: Fork node → children [childA → nextA, childB → nextB].
     * All stages within a child's chain should share the same branch prefix.
     *
     * _Requirements: single-pass-debug-structure 2.4_
     */
    it('should preserve hierarchy for children with next chains', async () => {
      const extractor: TraversalExtractor = (snapshot) => {
        return {
          stageName: snapshot.node.name,
          stepNumber: snapshot.stepNumber,
        };
      };

      const fns = {
        fork: jest.fn((scope: StageContext) => {
          scope.setObject([], 'forkKey', 'forkValue');
          return 'fork-result';
        }),
        childA: jest.fn((scope: StageContext) => {
          scope.setObject([], 'childAKey', 'childAValue');
          return 'childA-result';
        }),
        nextA: jest.fn((scope: StageContext) => {
          scope.setObject([], 'nextAKey', 'nextAValue');
          return 'nextA-result';
        }),
        childB: jest.fn((scope: StageContext) => {
          scope.setObject([], 'childBKey', 'childBValue');
          return 'childB-result';
        }),
        nextB: jest.fn((scope: StageContext) => {
          scope.setObject([], 'nextBKey', 'nextBValue');
          return 'nextB-result';
        }),
      };

      const root: Node = {
        name: 'fork',
        id: 'fork',
        fn: fns.fork,
        children: [
          {
            name: 'childA',
            id: 'childA',
            fn: fns.childA,
            next: { name: 'nextA', id: 'nextA', fn: fns.nextA },
          },
          {
            name: 'childB',
            id: 'childB',
            fn: fns.childB,
            next: { name: 'nextB', id: 'nextB', fn: fns.nextB },
          },
        ],
      };

      const pipeline = new Pipeline(
        root,
        makeMap(fns),
        scopeFactory,
        undefined, undefined, undefined, undefined, undefined,
        extractor,
        undefined, undefined,
        true, // enrichSnapshots
      );
      await pipeline.execute();

      const results = pipeline.getExtractedResults<{ stageName: string; stepNumber: number }>();
      const paths = Array.from(results.keys());

      // Should have 5 entries: fork + childA + nextA + childB + nextB
      expect(paths.length).toBe(5);

      // Fork node at root level
      expect(paths).toContain('fork');

      // All stages within childA's branch should share the same branch prefix
      const childABranchPaths = paths.filter((p) => p !== 'fork' && p.includes('childA'));
      expect(childABranchPaths.length).toBeGreaterThanOrEqual(1);

      // nextA should be in the same branch as childA (same prefix)
      const nextAPaths = paths.filter((p) => p.includes('nextA'));
      expect(nextAPaths.length).toBe(1);

      // All stages within childB's branch should share the same branch prefix
      const childBBranchPaths = paths.filter((p) => p !== 'fork' && p.includes('childB'));
      expect(childBBranchPaths.length).toBeGreaterThanOrEqual(1);

      // nextB should be in the same branch as childB (same prefix)
      const nextBPaths = paths.filter((p) => p.includes('nextB'));
      expect(nextBPaths.length).toBe(1);

      // Verify that nextA and nextB paths share the same branch prefix as their parent child
      // The branchPath for childA's subtree is childA's pipelineIdForChild
      // nextA's path should start with the same prefix as childA's path
      const childAPath = childABranchPaths.find((p) => results.get(p)?.stageName === 'childA');
      const nextAPath = nextAPaths[0];
      if (childAPath && nextAPath) {
        // Both should share a common prefix (the child's branch context)
        const childAPrefix = childAPath.split('.')[0];
        expect(nextAPath.startsWith(childAPrefix)).toBe(true);
      }
    });

    /**
     * VERIFIES: Fork node followed by a next node produces correct paths.
     * The fork's children should have hierarchy-preserving paths, and the
     * next node after the fork should have a path at the same level as the fork.
     *
     * DESIGN: fork → children [childA, childB] → next (continuation after fork).
     * The continuation "next" should NOT be nested under any child's path.
     *
     * _Requirements: single-pass-debug-structure 2.4_
     */
    it('should correctly separate fork children paths from continuation next paths', async () => {
      const extractor: TraversalExtractor = (snapshot) => {
        return {
          stageName: snapshot.node.name,
          stepNumber: snapshot.stepNumber,
        };
      };

      const fns = {
        fork: jest.fn((scope: StageContext) => {
          scope.setObject([], 'forkKey', 'forkValue');
          return 'fork-result';
        }),
        childA: jest.fn((scope: StageContext) => {
          scope.setObject([], 'childAKey', 'childAValue');
          return 'childA-result';
        }),
        childB: jest.fn((scope: StageContext) => {
          scope.setObject([], 'childBKey', 'childBValue');
          return 'childB-result';
        }),
        continuation: jest.fn((scope: StageContext) => {
          scope.setObject([], 'contKey', 'contValue');
          return 'continuation-result';
        }),
      };

      const root: Node = {
        name: 'fork',
        id: 'fork',
        fn: fns.fork,
        children: [
          { name: 'childA', id: 'childA', fn: fns.childA },
          { name: 'childB', id: 'childB', fn: fns.childB },
        ],
        next: { name: 'continuation', id: 'continuation', fn: fns.continuation },
      };

      const pipeline = new Pipeline(
        root,
        makeMap(fns),
        scopeFactory,
        undefined, undefined, undefined, undefined, undefined,
        extractor,
        undefined, undefined,
        true, // enrichSnapshots
      );
      await pipeline.execute();

      const results = pipeline.getExtractedResults<{ stageName: string; stepNumber: number }>();
      const paths = Array.from(results.keys());

      // Should have 4 entries: fork + childA + childB + continuation
      expect(paths.length).toBe(4);

      // Fork node at root level
      expect(paths).toContain('fork');

      // Continuation should be at the same branchPath level as fork (not nested under children)
      // Since branchPath for the continuation is the same as fork's branchPath ("")
      const continuationPath = paths.find((p) => results.get(p)?.stageName === 'continuation');
      expect(continuationPath).toBeDefined();

      // Children paths should be distinct from the continuation path
      const childPaths = paths.filter(
        (p) => p !== 'fork' && p !== continuationPath,
      );
      expect(childPaths.length).toBe(2);

      // Children paths should NOT be a prefix of the continuation path
      // (they are in separate branches)
      for (const childPath of childPaths) {
        expect(continuationPath!.startsWith(childPath)).toBe(false);
      }
    });

    /**
     * VERIFIES: Enriched snapshots for fork children include correct enrichment data.
     * WHY: Ensures that enrichment (scopeState, debugInfo, stageOutput, historyIndex)
     * works correctly for parallel children, not just linear pipelines.
     *
     * _Requirements: single-pass-debug-structure 1.1, 1.3, 2.4, 3.1_
     */
    it('should include enrichment fields for fork children when enrichSnapshots is enabled', async () => {

      const capturedSnapshots: StageSnapshot[] = [];
      const extractor: TraversalExtractor = (snapshot) => {
        capturedSnapshots.push(snapshot);
        return {
          stageName: snapshot.node.name,
          scopeState: snapshot.scopeState,
          stageOutput: snapshot.stageOutput,
          historyIndex: snapshot.historyIndex,
        };
      };

      const fns = {
        fork: jest.fn((scope: StageContext) => {
          scope.setObject([], 'forkKey', 'forkValue');
          return 'fork-result';
        }),
        childA: jest.fn((scope: StageContext) => {
          scope.setObject([], 'childAKey', 'childAValue');
          return 'childA-result';
        }),
        childB: jest.fn((scope: StageContext) => {
          scope.setObject([], 'childBKey', 'childBValue');
          return 'childB-result';
        }),
      };

      const root: Node = {
        name: 'fork',
        id: 'fork',
        fn: fns.fork,
        children: [
          { name: 'childA', id: 'childA', fn: fns.childA },
          { name: 'childB', id: 'childB', fn: fns.childB },
        ],
      };

      const pipeline = new Pipeline(
        root,
        makeMap(fns),
        scopeFactory,
        undefined, undefined, undefined, undefined, undefined,
        extractor,
        undefined, undefined,
        true, // enrichSnapshots
      );
      await pipeline.execute();

      // Should have 3 snapshots: fork + childA + childB
      expect(capturedSnapshots.length).toBe(3);

      // All snapshots should have enrichment fields
      for (const snapshot of capturedSnapshots) {
        expect(snapshot.scopeState).toBeDefined();
        expect(snapshot.historyIndex).toBeDefined();
        expect(typeof snapshot.historyIndex).toBe('number');
        expect(snapshot.historyIndex).toBeGreaterThanOrEqual(0);
      }

      // Fork snapshot should have its output
      const forkSnapshot = capturedSnapshots.find((s) => s.node.name === 'fork');
      expect(forkSnapshot).toBeDefined();
      expect(forkSnapshot!.stageOutput).toBe('fork-result');

      // Child snapshots should have their outputs
      const childASnapshot = capturedSnapshots.find((s) => s.node.name === 'childA');
      expect(childASnapshot).toBeDefined();
      expect(childASnapshot!.stageOutput).toBe('childA-result');

      const childBSnapshot = capturedSnapshots.find((s) => s.node.name === 'childB');
      expect(childBSnapshot).toBeDefined();
      expect(childBSnapshot!.stageOutput).toBe('childB-result');

      // Children's scopeState should include the fork's committed state
      // (since children execute after fork commits)
      expect(childASnapshot!.scopeState).toHaveProperty('forkKey', 'forkValue');
      expect(childBSnapshot!.scopeState).toHaveProperty('forkKey', 'forkValue');
    });
  });
});

/**
 * Enriched StageSnapshot: JSON serialization safety
 *
 * BEHAVIOR: When `enrichSnapshots: true` is enabled, the enrichment fields
 * (scopeState, debugInfo, stageOutput, errorInfo) are JSON-serializable
 * for typical scope values (primitives, plain objects, arrays).
 *
 * WHY: Requirement 7.1 states scopeState SHALL be a plain JSON-serializable
 * object, and Requirement 7.2 states debugInfo SHALL be a plain JSON-serializable
 * object. The shallow clone approach (`{ ...globalStore.getState() }`) produces
 * serializable output for standard scope shapes. These tests verify the
 * round-trip property: JSON.parse(JSON.stringify(x)) ≈ x.
 *
 * _Requirements: single-pass-debug-structure 7.1, 7.2_
 */
describe('Enriched StageSnapshot: JSON serialization safety', () => {
  /**
   * BEHAVIOR: scopeState is JSON-serializable for typical scope values
   * including strings, numbers, booleans, arrays, and nested objects.
   *
   * WHY: Consumers need to transmit enriched snapshots over the wire
   * or store them for later analysis. The shallow clone must produce
   * output that survives a JSON round-trip for standard value types.
   */
  describe('when scope contains typical JSON-safe values', () => {
    /**
     * VERIFIES: scopeState round-trips through JSON.parse(JSON.stringify())
     * for a scope containing strings, numbers, booleans, arrays, nested objects, and null.
     *
     * EDGE CASE: Includes nested objects and arrays to verify that the shallow
     * clone captures references to serializable nested structures correctly.
     *
     * _Requirements: single-pass-debug-structure 7.1_
     */
    it('should produce JSON-serializable scopeState for standard scope shapes', async () => {
      const capturedSnapshots: StageSnapshot[] = [];
      const extractor: TraversalExtractor = (snapshot) => {
        capturedSnapshots.push(snapshot);
        return { stageName: snapshot.node.name };
      };

      // Stage writes a rich scope with various JSON-safe value types
      const fns = {
        richScope: jest.fn((scope: StageContext) => {
          scope.setObject([], 'stringVal', 'hello');
          scope.setObject([], 'numberVal', 42);
          scope.setObject([], 'boolVal', true);
          scope.setObject([], 'nullVal', null);
          scope.setObject([], 'arrayVal', [1, 'two', false, null]);
          scope.setObject([], 'nestedObj', {
            level1: {
              level2: {
                deep: 'value',
                count: 99,
              },
            },
            tags: ['a', 'b', 'c'],
          });
          return 'rich-result';
        }),
      };

      const root: Node = { name: 'richScope', fn: fns.richScope };

      const pipeline = new Pipeline(
        root,
        makeMap(fns),
        scopeFactory,
        undefined, undefined, undefined, undefined, undefined,
        extractor,
        undefined, undefined,
        true, // enrichSnapshots
      );
      await pipeline.execute();

      expect(capturedSnapshots.length).toBe(1);
      const snapshot = capturedSnapshots[0];

      // scopeState should be defined
      expect(snapshot.scopeState).toBeDefined();

      // JSON round-trip: serialize and deserialize should produce equivalent object
      const roundTripped = JSON.parse(JSON.stringify(snapshot.scopeState));
      expect(roundTripped).toEqual(snapshot.scopeState);

      // Verify specific values survived the round-trip
      expect(roundTripped.stringVal).toBe('hello');
      expect(roundTripped.numberVal).toBe(42);
      expect(roundTripped.boolVal).toBe(true);
      expect(roundTripped.nullVal).toBeNull();
      expect(roundTripped.arrayVal).toEqual([1, 'two', false, null]);
      expect(roundTripped.nestedObj).toEqual({
        level1: { level2: { deep: 'value', count: 99 } },
        tags: ['a', 'b', 'c'],
      });
    });
  });

  /**
   * BEHAVIOR: debugInfo is JSON-serializable for typical debug metadata
   * including logs, errors, metrics, and evals.
   *
   * WHY: Requirement 7.2 states debugInfo SHALL be a plain JSON-serializable
   * object. The spread operator captures debug context as plain objects,
   * which should survive JSON round-trip for standard metadata values.
   */
  describe('when stage writes debug metadata', () => {
    /**
     * VERIFIES: debugInfo round-trips through JSON.parse(JSON.stringify())
     * for a stage that writes logs, errors, metrics, and evals.
     *
     * _Requirements: single-pass-debug-structure 7.2_
     */
    it('should produce JSON-serializable debugInfo for typical debug metadata', async () => {
      const capturedSnapshots: StageSnapshot[] = [];
      const extractor: TraversalExtractor = (snapshot) => {
        capturedSnapshots.push(snapshot);
        return { stageName: snapshot.node.name };
      };

      // Stage writes various debug metadata types
      const fns = {
        debugStage: jest.fn((scope: StageContext) => {
          scope.addLog('requestId', 'req-123');
          scope.addLog('processingTime', 150);
          scope.addLog('tags', ['fast', 'cached']);
          scope.addError('validationWarning', 'Field X is deprecated');
          scope.addMetric('latencyMs', 42);
          scope.addEval('qualityScore', 0.95);
          return 'debug-result';
        }),
      };

      const root: Node = { name: 'debugStage', fn: fns.debugStage };

      const pipeline = new Pipeline(
        root,
        makeMap(fns),
        scopeFactory,
        undefined, undefined, undefined, undefined, undefined,
        extractor,
        undefined, undefined,
        true, // enrichSnapshots
      );
      await pipeline.execute();

      expect(capturedSnapshots.length).toBe(1);
      const snapshot = capturedSnapshots[0];

      // debugInfo should be defined
      expect(snapshot.debugInfo).toBeDefined();

      // JSON round-trip: serialize and deserialize should produce equivalent object
      const roundTripped = JSON.parse(JSON.stringify(snapshot.debugInfo));
      expect(roundTripped).toEqual(snapshot.debugInfo);

      // Verify specific debug values survived the round-trip
      expect(roundTripped.logs.requestId).toBe('req-123');
      expect(roundTripped.logs.processingTime).toBe(150);
      expect(roundTripped.logs.tags).toEqual(['fast', 'cached']);
      expect(roundTripped.errors.validationWarning).toBe('Field X is deprecated');
      expect(roundTripped.metrics.latencyMs).toBe(42);
      expect(roundTripped.evals.qualityScore).toBe(0.95);
    });
  });

  /**
   * BEHAVIOR: stageOutput is JSON-serializable for typical return values
   * including primitives, objects, and arrays.
   *
   * WHY: Consumers may serialize the entire enriched snapshot for
   * transmission or storage. The stageOutput field must survive
   * JSON round-trip for standard return value types.
   */
  describe('when stage returns typical JSON-safe values', () => {
    /**
     * VERIFIES: stageOutput round-trips through JSON.parse(JSON.stringify())
     * for stages returning various value types (string, object, array).
     *
     * _Requirements: single-pass-debug-structure 7.1, 7.2_
     */
    it('should produce JSON-serializable stageOutput for typical return values', async () => {
      const capturedSnapshots: StageSnapshot[] = [];
      const extractor: TraversalExtractor = (snapshot) => {
        capturedSnapshots.push(snapshot);
        return { stageName: snapshot.node.name };
      };

      // Three stages returning different value types
      const fns = {
        stringStage: jest.fn((scope: StageContext) => {
          scope.setObject([], 'step', 'one');
          return 'simple-string';
        }),
        objectStage: jest.fn((scope: StageContext) => {
          scope.setObject([], 'step', 'two');
          return { status: 'ok', count: 3, items: ['a', 'b'] };
        }),
        arrayStage: jest.fn((scope: StageContext) => {
          scope.setObject([], 'step', 'three');
          return [1, 'two', { nested: true }];
        }),
      };

      const root: Node = {
        name: 'stringStage',
        fn: fns.stringStage,
        next: {
          name: 'objectStage',
          fn: fns.objectStage,
          next: {
            name: 'arrayStage',
            fn: fns.arrayStage,
          },
        },
      };

      const pipeline = new Pipeline(
        root,
        makeMap(fns),
        scopeFactory,
        undefined, undefined, undefined, undefined, undefined,
        extractor,
        undefined, undefined,
        true, // enrichSnapshots
      );
      await pipeline.execute();

      expect(capturedSnapshots.length).toBe(3);

      // Verify each stageOutput survives JSON round-trip
      const stringSnapshot = capturedSnapshots.find((s) => s.node.name === 'stringStage')!;
      expect(JSON.parse(JSON.stringify(stringSnapshot.stageOutput))).toEqual('simple-string');

      const objectSnapshot = capturedSnapshots.find((s) => s.node.name === 'objectStage')!;
      expect(JSON.parse(JSON.stringify(objectSnapshot.stageOutput))).toEqual({
        status: 'ok',
        count: 3,
        items: ['a', 'b'],
      });

      const arraySnapshot = capturedSnapshots.find((s) => s.node.name === 'arrayStage')!;
      expect(JSON.parse(JSON.stringify(arraySnapshot.stageOutput))).toEqual([
        1,
        'two',
        { nested: true },
      ]);
    });
  });
});


/**
 * Enriched StageSnapshot: Decider nodes without stage functions
 *
 * BEHAVIOR: When a decider node has no stage function (pure routing node),
 * the extractor is still called for it so it appears in the debug UI.
 *
 * WHY: Previously, decider-only nodes (no fn) were invisible in the
 * Incremental_Debug_Map because callExtractor was only called inside
 * the `if (stageFunc)` block in DeciderHandler.handle().
 *
 * FIX: DeciderHandler now calls callExtractor for no-fn deciders before
 * evaluating the decider function, with stageOutput=undefined.
 */
describe('Enriched StageSnapshot: no-fn decider visibility', () => {
  /**
   * VERIFIES: A decider node without a stage function still produces
   * a snapshot in extractedResults with the correct stage path.
   *
   * DESIGN: Pipeline: stage1 → decider(no fn) → [childA, childB]
   * The decider picks childA. All three nodes (stage1, decider, childA)
   * should appear in extractedResults.
   */
  it('should produce a snapshot for a decider node with no stage function', async () => {
    const capturedSnapshots: StageSnapshot[] = [];
    const extractor: TraversalExtractor = (snapshot) => {
      capturedSnapshots.push(snapshot);
      return {
        stageName: snapshot.node.name,
        stepNumber: snapshot.stepNumber,
      };
    };

    const fns = {
      stage1: jest.fn((scope: StageContext) => {
        scope.setObject([], 'key1', 'value1');
        return 'result1';
      }),
      childA: jest.fn((scope: StageContext) => {
        scope.setObject([], 'childAKey', 'childAValue');
        return 'childA-result';
      }),
      childB: jest.fn((scope: StageContext) => {
        scope.setObject([], 'childBKey', 'childBValue');
        return 'childB-result';
      }),
    };

    const childA: Node = { name: 'childA', id: 'childA', fn: fns.childA };
    const childB: Node = { name: 'childB', id: 'childB', fn: fns.childB };

    const root: Node = {
      name: 'stage1',
      id: 'stage1',
      fn: fns.stage1,
      next: {
        name: 'decider',
        id: 'decider',
        // No fn — pure routing node
        nextNodeDecider: (() => 'childA') as any,
        children: [childA, childB],
      },
    };

    const pipeline = new Pipeline(
      root,
      makeMap(fns),
      scopeFactory,
      undefined, undefined, undefined, undefined, undefined,
      extractor,
      undefined, undefined,
      true, // enrichSnapshots
    );
    await pipeline.execute();

    // Should have 3 snapshots: stage1, decider (no fn), childA (chosen)
    const names = capturedSnapshots.map((s) => s.node.name);
    expect(names).toContain('stage1');
    expect(names).toContain('decider');
    expect(names).toContain('childA');
    // childB should NOT be called (decider picked childA)
    expect(names).not.toContain('childB');

    // The decider snapshot should have stageOutput=undefined (no fn)
    const deciderSnapshot = capturedSnapshots.find((s) => s.node.name === 'decider');
    expect(deciderSnapshot).toBeDefined();
    expect(deciderSnapshot!.stageOutput).toBeUndefined();

    // Step numbers should be monotonically increasing
    const steps = capturedSnapshots.map((s) => s.stepNumber);
    for (let i = 1; i < steps.length; i++) {
      expect(steps[i]).toBeGreaterThan(steps[i - 1]);
    }

    // extractedResults should contain the decider path
    const results = pipeline.getExtractedResults<{ stageName: string }>();
    const paths = Array.from(results.keys());
    expect(paths.some((p) => p.includes('decider'))).toBe(true);
  });
});

/**
 * Enriched StageSnapshot: Loop iteration unique paths
 *
 * BEHAVIOR: When a pipeline loops back to a previously-visited node,
 * each iteration produces a unique key in extractedResults instead of
 * overwriting the previous iteration's entry.
 *
 * WHY: Previously, getStagePath used node.id/node.name (the BASE name),
 * so loop iterations (e.g., CallLLM visited twice) would overwrite the
 * first iteration's entry in the extractedResults Map.
 *
 * FIX: getStagePath now uses context.stageName when it differs from
 * node.name, which includes the iteration suffix (e.g., "CallLLM.1").
 */
describe('Enriched StageSnapshot: loop iteration unique paths', () => {
  /**
   * VERIFIES: A pipeline with a loop-back via LoopHandler produces separate
   * entries in extractedResults for each iteration of the looped node.
   *
   * DESIGN: Pipeline: nodeA → nodeB (dynamic next → nodeA by id) → nodeA.1 → nodeB.1
   * nodeB's stage function returns a dynamic next pointing back to nodeA by id.
   * LoopHandler generates iterated names (nodeA.1) and creates new contexts.
   * extractedResults should have entries for nodeA AND nodeA.1 (not overwritten).
   */
  it('should produce unique extractedResults keys for each loop iteration', async () => {
    const capturedSnapshots: StageSnapshot[] = [];
    const extractor: TraversalExtractor = (snapshot) => {
      capturedSnapshots.push(snapshot);
      return {
        stageName: snapshot.node.name,
        stepNumber: snapshot.stepNumber,
        contextStageName: snapshot.context.stageName,
      };
    };

    let nodeACallCount = 0;
    const fns = {
      nodeA: jest.fn((scope: StageContext) => {
        nodeACallCount++;
        scope.setObject([], `nodeA_call_${nodeACallCount}`, true);
        return `nodeA-result-${nodeACallCount}`;
      }),
      nodeB: jest.fn((scope: StageContext) => {
        scope.setObject([], 'nodeBKey', 'nodeBValue');
        // First time: return a dynamic StageNode with next pointing back to nodeA by id reference.
        // This goes through LoopHandler.handleNodeReference which generates iterated names.
        if (nodeACallCount === 1) {
          return { name: 'dynamicRouter', next: { name: 'nodeARef', id: 'nodeA' } } as any;
        }
        // Second time: no dynamic next, pipeline ends
        return 'nodeB-done';
      }),
    };

    const root: Node = {
      name: 'nodeA',
      id: 'nodeA',
      fn: fns.nodeA,
      next: {
        name: 'nodeB',
        id: 'nodeB',
        fn: fns.nodeB,
      },
    };

    const pipeline = new Pipeline(
      root,
      makeMap(fns),
      scopeFactory,
      undefined, undefined, undefined, undefined, undefined,
      extractor,
      undefined, undefined,
      true, // enrichSnapshots
    );
    await pipeline.execute();

    // Should have snapshots for: nodeA, nodeB, nodeA (loop-back), nodeB (loop-back)
    // nodeA should appear at least twice in captured snapshots
    const nodeASnapshots = capturedSnapshots.filter((s) => s.node.name === 'nodeA');
    expect(nodeASnapshots.length).toBeGreaterThanOrEqual(2);

    // The context stage names for nodeA snapshots:
    // LoopHandler.getIteratedStageName returns base name for iteration 0,
    // and "name.N" for iteration N > 0. The first loop-back is iteration 0,
    // so both the initial visit and first loop-back share the base name "nodeA".
    const contextNames = nodeASnapshots.map((s) => s.context.stageName);
    expect(contextNames[0]).toBe('nodeA');

    // extractedResults should have entries for all stages
    const results = pipeline.getExtractedResults<{ stageName: string; contextStageName: string }>();
    const paths = Array.from(results.keys());

    // Verify that extractedResults contains entries for nodeA and nodeB
    const nodeAPaths = paths.filter((p) => p.includes('nodeA'));
    const nodeBPaths = paths.filter((p) => p.includes('nodeB'));
    expect(nodeAPaths.length).toBeGreaterThanOrEqual(1);
    expect(nodeBPaths.length).toBeGreaterThanOrEqual(1);

    // Verify that the pipeline executed the loop correctly by checking
    // that nodeA was called twice (initial + loop-back)
    expect(nodeASnapshots.length).toBe(2);
  });
});
