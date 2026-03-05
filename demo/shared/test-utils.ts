/**
 * Shared Test Utilities for Demo Tests
 *
 * WHY: Provides consistent test helpers across all demo tests, reducing
 * boilerplate and ensuring uniform testing patterns. These utilities
 * enable verification of execution order, timing, and scope state.
 *
 * KEY UTILITIES:
 * - createTestScopeFactory: Creates scope factories with optional recording
 * - assertExecutionOrder: Verifies stages executed in expected order
 * - createDelayedOperation: Creates async operations with configurable delay
 * - createExecutionTracker: Tracks stage execution for verification
 *
 * DESIGN DECISIONS:
 * - Uses BaseState from footprint for consistency with library
 * - Recording is opt-in to avoid overhead in simple tests
 * - Execution tracker uses closure pattern for thread-safety
 */

import { BaseState, StageContext, GlobalStore, PipelineRuntime } from 'footprint';

// ============================================================================
// Types
// ============================================================================

/**
 * Options for creating a test scope factory.
 *
 * WHY: Allows tests to optionally record scope operations for verification
 * without requiring recording in every test.
 */
export interface TestScopeFactoryOptions {
  /** Whether to record getValue/setValue operations */
  recordOperations?: boolean;
  /** Callback invoked on each scope operation */
  onOperation?: (op: ScopeOperation) => void;
}

/**
 * Represents a single scope operation (read or write).
 *
 * WHY: Enables tests to verify that stages performed expected scope operations.
 */
export interface ScopeOperation {
  type: 'read' | 'write';
  stageName: string;
  path: string[];
  key: string;
  value?: unknown;
  timestamp: number;
}

/**
 * Tracks stage execution order and timing.
 *
 * WHY: Enables verification of execution order and parallel timing.
 */
export interface ExecutionTracker {
  /** Records that a stage started execution */
  recordStart: (stageName: string) => void;
  /** Records that a stage completed execution */
  recordEnd: (stageName: string) => void;
  /** Returns the order in which stages started */
  getStartOrder: () => string[];
  /** Returns the order in which stages completed */
  getEndOrder: () => string[];
  /** Returns timing data for each stage */
  getTimings: () => Map<string, { start: number; end: number; duration: number }>;
  /** Resets all tracking data */
  reset: () => void;
}

// ============================================================================
// Scope Factory Utilities
// ============================================================================

/**
 * Creates a test scope factory with optional operation recording.
 *
 * WHY: Provides consistent scope creation across all demo tests while
 * allowing optional recording for verification of scope operations.
 *
 * DESIGN: Uses BaseState from footprint to ensure tests use the same
 * scope implementation as production code.
 *
 * @param options - Configuration for the scope factory
 * @returns A scope factory function compatible with FlowChartBuilder.execute()
 *
 * @example
 * ```typescript
 * // Simple usage without recording
 * const scopeFactory = createTestScopeFactory();
 * const result = await builder.execute(scopeFactory);
 *
 * // With operation recording
 * const operations: ScopeOperation[] = [];
 * const scopeFactory = createTestScopeFactory({
 *   recordOperations: true,
 *   onOperation: (op) => operations.push(op),
 * });
 * ```
 */
export function createTestScopeFactory(options: TestScopeFactoryOptions = {}) {
  const { recordOperations = false, onOperation } = options;

  return (ctx: StageContext, stageName: string, readOnly?: unknown): BaseState => {
    const scope = new BaseState(ctx, stageName, readOnly);

    if (recordOperations && onOperation) {
      // Wrap getValue to record reads
      const originalGetValue = scope.getValue.bind(scope);
      scope.getValue = (key?: string) => {
        const value = originalGetValue(key);
        onOperation({
          type: 'read',
          stageName,
          path: [],
          key: key ?? '',
          value,
          timestamp: Date.now(),
        });
        return value;
      };

      // Wrap setValue to record writes
      const originalSetValue = scope.setValue.bind(scope);
      scope.setValue = (key: string, value: unknown) => {
        onOperation({
          type: 'write',
          stageName,
          path: [],
          key,
          value,
          timestamp: Date.now(),
        });
        return originalSetValue(key, value);
      };
    }

    return scope;
  };
}

/**
 * Creates a minimal scope factory without recording.
 *
 * WHY: Provides the simplest possible scope factory for tests that
 * don't need operation recording.
 *
 * @returns A basic scope factory function
 *
 * @example
 * ```typescript
 * const scopeFactory = createMinimalScopeFactory();
 * const result = await builder.execute(scopeFactory);
 * ```
 */
export function createMinimalScopeFactory() {
  return (ctx: StageContext, stageName: string, readOnly?: unknown): BaseState => {
    return new BaseState(ctx, stageName, readOnly);
  };
}

// ============================================================================
// Execution Order Utilities
// ============================================================================

/**
 * Asserts that stages executed in the expected order.
 *
 * WHY: Common assertion pattern for verifying linear execution order.
 * Provides clear error messages when order doesn't match.
 *
 * @param actualOrder - Array of stage names in execution order
 * @param expectedOrder - Array of expected stage names in order
 * @throws Error if orders don't match
 *
 * @example
 * ```typescript
 * const tracker = createExecutionTracker();
 * // ... execute pipeline with tracker ...
 * assertExecutionOrder(tracker.getEndOrder(), ['Stage1', 'Stage2', 'Stage3']);
 * ```
 */
export function assertExecutionOrder(actualOrder: string[], expectedOrder: string[]): void {
  if (actualOrder.length !== expectedOrder.length) {
    throw new Error(
      `Execution order length mismatch.\n` +
        `  Expected ${expectedOrder.length} stages: [${expectedOrder.join(', ')}]\n` +
        `  Actual ${actualOrder.length} stages: [${actualOrder.join(', ')}]`,
    );
  }

  for (let i = 0; i < expectedOrder.length; i++) {
    if (actualOrder[i] !== expectedOrder[i]) {
      throw new Error(
        `Execution order mismatch at position ${i}.\n` +
          `  Expected: ${expectedOrder[i]}\n` +
          `  Actual: ${actualOrder[i]}\n` +
          `  Full expected: [${expectedOrder.join(', ')}]\n` +
          `  Full actual: [${actualOrder.join(', ')}]`,
      );
    }
  }
}

/**
 * Asserts that all expected stages executed (order doesn't matter).
 *
 * WHY: For parallel execution, we care that all stages ran but not
 * necessarily in what order they completed.
 *
 * @param actualStages - Array of stage names that executed
 * @param expectedStages - Array of expected stage names
 * @throws Error if sets don't match
 *
 * @example
 * ```typescript
 * // For parallel children, order may vary
 * assertAllStagesExecuted(tracker.getEndOrder(), ['Child1', 'Child2', 'Child3']);
 * ```
 */
export function assertAllStagesExecuted(actualStages: string[], expectedStages: string[]): void {
  const actualSet = new Set(actualStages);
  const expectedSet = new Set(expectedStages);

  const missing = expectedStages.filter((s) => !actualSet.has(s));
  const extra = actualStages.filter((s) => !expectedSet.has(s));

  if (missing.length > 0 || extra.length > 0) {
    throw new Error(
      `Stage execution mismatch.\n` +
        (missing.length > 0 ? `  Missing stages: [${missing.join(', ')}]\n` : '') +
        (extra.length > 0 ? `  Unexpected stages: [${extra.join(', ')}]\n` : '') +
        `  Expected: [${expectedStages.join(', ')}]\n` +
        `  Actual: [${actualStages.join(', ')}]`,
    );
  }
}

// ============================================================================
// Timing Utilities
// ============================================================================

/**
 * Creates a delayed async operation for testing parallel execution.
 *
 * WHY: Enables testing of parallel execution timing by creating
 * operations with known delays. If parallel execution works correctly,
 * total time should be max(delays) not sum(delays).
 *
 * @param delayMs - Delay in milliseconds before resolving
 * @param result - Value to return after delay
 * @returns Promise that resolves to result after delay
 *
 * @example
 * ```typescript
 * // Create three parallel operations
 * const op1 = createDelayedOperation(100, { id: 1 });
 * const op2 = createDelayedOperation(150, { id: 2 });
 * const op3 = createDelayedOperation(80, { id: 3 });
 *
 * // If parallel, total time ~150ms, not 330ms
 * const start = Date.now();
 * await Promise.all([op1, op2, op3]);
 * const elapsed = Date.now() - start;
 * expect(elapsed).toBeLessThan(200); // Some overhead allowed
 * ```
 */
export function createDelayedOperation<T>(delayMs: number, result: T): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(result), delayMs));
}

/**
 * Creates an execution tracker for monitoring stage execution.
 *
 * WHY: Enables verification of execution order and timing without
 * modifying the pipeline code. Uses closure pattern for thread-safety.
 *
 * DESIGN: Tracks both start and end times to enable verification of
 * parallel execution (overlapping start/end times).
 *
 * @returns ExecutionTracker instance
 *
 * @example
 * ```typescript
 * const tracker = createExecutionTracker();
 *
 * const stage1 = async (scope: BaseState) => {
 *   tracker.recordStart('Stage1');
 *   await someWork();
 *   tracker.recordEnd('Stage1');
 *   return result;
 * };
 *
 * // After execution
 * assertExecutionOrder(tracker.getEndOrder(), ['Stage1', 'Stage2']);
 * ```
 */
export function createExecutionTracker(): ExecutionTracker {
  const startOrder: string[] = [];
  const endOrder: string[] = [];
  const timings = new Map<string, { start: number; end: number; duration: number }>();

  return {
    recordStart: (stageName: string) => {
      startOrder.push(stageName);
      timings.set(stageName, { start: Date.now(), end: 0, duration: 0 });
    },

    recordEnd: (stageName: string) => {
      endOrder.push(stageName);
      const timing = timings.get(stageName);
      if (timing) {
        timing.end = Date.now();
        timing.duration = timing.end - timing.start;
      }
    },

    getStartOrder: () => [...startOrder],
    getEndOrder: () => [...endOrder],
    getTimings: () => new Map(timings),

    reset: () => {
      startOrder.length = 0;
      endOrder.length = 0;
      timings.clear();
    },
  };
}

/**
 * Asserts that parallel execution occurred (total time < sum of individual times).
 *
 * WHY: Verifies that parallel children actually executed in parallel,
 * not sequentially. Allows for some overhead tolerance.
 *
 * @param timings - Map of stage timings from ExecutionTracker
 * @param parallelStages - Names of stages that should have run in parallel
 * @param overheadToleranceMs - Allowed overhead beyond max duration (default: 50ms)
 * @throws Error if execution appears sequential
 *
 * @example
 * ```typescript
 * const tracker = createExecutionTracker();
 * // ... execute pipeline with parallel children ...
 * assertParallelExecution(
 *   tracker.getTimings(),
 *   ['Child1', 'Child2', 'Child3'],
 *   100 // Allow 100ms overhead
 * );
 * ```
 */
export function assertParallelExecution(
  timings: Map<string, { start: number; end: number; duration: number }>,
  parallelStages: string[],
  overheadToleranceMs: number = 50,
): void {
  const stageDurations = parallelStages.map((name) => {
    const timing = timings.get(name);
    if (!timing) {
      throw new Error(`No timing data for stage: ${name}`);
    }
    return timing.duration;
  });

  const sumOfDurations = stageDurations.reduce((a, b) => a + b, 0);
  const maxDuration = Math.max(...stageDurations);

  // Find actual total time (from first start to last end)
  const starts = parallelStages.map((name) => timings.get(name)!.start);
  const ends = parallelStages.map((name) => timings.get(name)!.end);
  const actualTotal = Math.max(...ends) - Math.min(...starts);

  // If parallel, actual total should be close to max duration, not sum
  const expectedMaxTotal = maxDuration + overheadToleranceMs;

  if (actualTotal > expectedMaxTotal && actualTotal > sumOfDurations * 0.8) {
    throw new Error(
      `Execution appears sequential, not parallel.\n` +
        `  Sum of individual durations: ${sumOfDurations}ms\n` +
        `  Max individual duration: ${maxDuration}ms\n` +
        `  Actual total time: ${actualTotal}ms\n` +
        `  Expected max (parallel): ~${expectedMaxTotal}ms\n` +
        `  Stages: [${parallelStages.join(', ')}]`,
    );
  }
}

// ============================================================================
// Pipeline Execution Utilities
// ============================================================================

/**
 * Creates a GlobalStore with a unique pipelineId for isolated testing.
 *
 * WHY: Each test should have isolated state to prevent cross-test
 * interference. Using unique pipelineIds ensures GlobalStore isolation.
 *
 * @param pipelineId - Optional custom pipelineId (defaults to unique ID)
 * @returns GlobalStore instance with isolated namespace
 *
 * @example
 * ```typescript
 * const store = createIsolatedGlobalStore();
 * // Store is isolated from other tests
 * ```
 */
export function createIsolatedGlobalStore(pipelineId?: string): GlobalStore {
  const id = pipelineId ?? `test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return new GlobalStore(id);
}

/**
 * Creates a PipelineRuntime for testing with isolated GlobalStore.
 *
 * WHY: Provides a complete runtime environment for testing pipelines
 * with proper isolation.
 *
 * @param pipelineId - Optional custom pipelineId
 * @returns PipelineRuntime instance
 *
 * @example
 * ```typescript
 * const runtime = createTestRuntime();
 * const ctx = runtime.createStageContext('TestStage');
 * ```
 */
export function createTestRuntime(pipelineId?: string): PipelineRuntime {
  const store = createIsolatedGlobalStore(pipelineId);
  return new PipelineRuntime(store);
}

// ============================================================================
// Assertion Helpers
// ============================================================================

/**
 * Asserts that a scope value equals expected value.
 *
 * WHY: Provides clear error messages for scope value assertions.
 *
 * @param scope - BaseState instance to check
 * @param path - Path array for getValue
 * @param key - Key for getValue
 * @param expected - Expected value
 * @throws Error if values don't match
 */
export function assertScopeValue(
  scope: BaseState,
  path: string[],
  key: string,
  expected: unknown,
): void {
  const actual = scope.getValue(key);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Scope value mismatch at path [${path.join('.')}].${key}\n` +
        `  Expected: ${JSON.stringify(expected)}\n` +
        `  Actual: ${JSON.stringify(actual)}`,
    );
  }
}

/**
 * Asserts that exactly one branch was executed (for decider tests).
 *
 * WHY: Deciders should execute exactly one branch. This helper
 * verifies that constraint.
 *
 * @param executedBranches - Array of branch names that executed
 * @param expectedBranch - The single branch that should have executed
 * @throws Error if not exactly one branch executed
 */
export function assertSingleBranchExecuted(
  executedBranches: string[],
  expectedBranch: string,
): void {
  if (executedBranches.length !== 1) {
    throw new Error(
      `Expected exactly 1 branch to execute, but ${executedBranches.length} executed.\n` +
        `  Executed: [${executedBranches.join(', ')}]\n` +
        `  Expected: ${expectedBranch}`,
    );
  }

  if (executedBranches[0] !== expectedBranch) {
    throw new Error(
      `Wrong branch executed.\n` +
        `  Expected: ${expectedBranch}\n` +
        `  Actual: ${executedBranches[0]}`,
    );
  }
}
