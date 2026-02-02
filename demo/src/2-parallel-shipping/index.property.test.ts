/**
 * Property-Based Tests for Demo 2: Parallel Children (Shipping Domain)
 *
 * PROPERTY: Parallel Execution Timing
 * For any pipeline with parallel children where each child has a known
 * execution time T_i, the total execution time SHALL be less than or equal
 * to max(T_i) plus constant overhead (not sum(T_i)).
 *
 * **Validates: Requirements 2.2**
 *
 * WHY: This property ensures the fundamental benefit of parallel execution:
 * concurrent operations complete faster than sequential execution.
 * If this property fails, parallel execution is not working correctly.
 *
 * COUNTEREXAMPLE MEANING: If this test fails, it means parallel children
 * are executing sequentially instead of concurrently, negating the
 * performance benefit of the fork-join pattern.
 */

import * as fc from 'fast-check';
import { FlowChartBuilder, BaseState, StageContext } from 'footprint';

// ============================================================================
// Test Utilities
// ============================================================================

/**
 * Creates a scope factory for property testing.
 */
function createPropertyTestScopeFactory() {
  return (ctx: StageContext, stageName: string, readOnly?: unknown) => {
    return new BaseState(ctx, stageName, readOnly);
  };
}

/**
 * Creates a stage function with a specific delay.
 */
function createDelayedStage(delayMs: number) {
  return async () => {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    return { delay: delayMs, completedAt: Date.now() };
  };
}

/**
 * Generates valid delay values for parallel children.
 * Delays are between 10ms and 100ms to keep tests fast but measurable.
 */
const delayArb = fc.integer({ min: 10, max: 100 });

/**
 * Generates a list of 2-5 delays for parallel children.
 */
const delayListArb = fc.array(delayArb, { minLength: 2, maxLength: 5 });

// ============================================================================
// Property Tests
// ============================================================================

describe('Property 2: Parallel Execution Timing', () => {
  /**
   * PROPERTY: Total time is closer to max than to sum
   *
   * For any set of parallel children with delays [d1, d2, ..., dn],
   * the total execution time should be approximately max(d1, d2, ..., dn),
   * not sum(d1, d2, ..., dn).
   *
   * **Validates: Requirements 2.2**
   */
  it('should complete in approximately max(child times), not sum', async () => {
    await fc.assert(
      fc.asyncProperty(delayListArb, async (delays) => {
        // Arrange
        const scopeFactory = createPropertyTestScopeFactory();
        const children = delays.map((delay, i) => ({
          id: `child${i}`,
          name: `Child${i}`,
          fn: createDelayedStage(delay),
        }));

        const builder = new FlowChartBuilder()
          .start('Entry', async () => ({ started: true }))
          .addListOfFunction(children);

        // Act
        const startTime = Date.now();
        await builder.execute(scopeFactory);
        const totalTime = Date.now() - startTime;

        // Assert
        const maxDelay = Math.max(...delays);
        const sumDelay = delays.reduce((a, b) => a + b, 0);

        // Allow 50ms overhead for test execution
        const overhead = 50;

        // Property: total time should be closer to max than to sum
        // We check that total < (max + sum) / 2, which means it's closer to max
        const midpoint = (maxDelay + sumDelay) / 2;

        // If truly parallel, total should be much closer to max than to sum
        // We use a generous threshold to account for test environment variability
        return totalTime < midpoint + overhead;
      }),
      { numRuns: 20 }, // Fewer runs due to timing-based tests
    );
  });

  /**
   * PROPERTY: Total time is bounded by max delay plus overhead
   *
   * For any set of parallel children, the total execution time
   * should not exceed max(delays) + reasonable overhead.
   *
   * **Validates: Requirements 2.2**
   */
  it('should complete within max(child times) plus overhead', async () => {
    await fc.assert(
      fc.asyncProperty(delayListArb, async (delays) => {
        // Arrange
        const scopeFactory = createPropertyTestScopeFactory();
        const children = delays.map((delay, i) => ({
          id: `child${i}`,
          name: `Child${i}`,
          fn: createDelayedStage(delay),
        }));

        const builder = new FlowChartBuilder()
          .start('Entry', async () => ({ started: true }))
          .addListOfFunction(children);

        // Act
        const startTime = Date.now();
        await builder.execute(scopeFactory);
        const totalTime = Date.now() - startTime;

        // Assert
        const maxDelay = Math.max(...delays);

        // Allow generous overhead (100ms) for test environment variability
        // In production, overhead would be much smaller
        const maxAllowedTime = maxDelay + 100;

        return totalTime <= maxAllowedTime;
      }),
      { numRuns: 20 },
    );
  });

  /**
   * PROPERTY: All children execute regardless of delays
   *
   * For any set of parallel children with varying delays,
   * all children should execute (not just the fastest).
   *
   * **Validates: Requirements 2.2**
   */
  it('should execute all children regardless of individual delays', async () => {
    await fc.assert(
      fc.asyncProperty(delayListArb, async (delays) => {
        // Arrange
        const scopeFactory = createPropertyTestScopeFactory();
        const executedChildren: string[] = [];

        const children = delays.map((delay, i) => ({
          id: `child${i}`,
          name: `Child${i}`,
          fn: async () => {
            await new Promise((resolve) => setTimeout(resolve, delay));
            executedChildren.push(`child${i}`);
            return { childId: i };
          },
        }));

        const builder = new FlowChartBuilder()
          .start('Entry', async () => ({ started: true }))
          .addListOfFunction(children);

        // Act
        await builder.execute(scopeFactory);

        // Assert - all children should have executed
        return executedChildren.length === delays.length;
      }),
      { numRuns: 20 },
    );
  });

  /**
   * PROPERTY: Children can read parent scope data
   *
   * For any value written by the parent stage, all parallel children
   * should be able to read that value.
   *
   * **Validates: Requirements 2.2**
   */
  it('should allow all children to read parent scope data', async () => {
    // Generate a random value to write to scope
    const valueArb = fc.oneof(fc.string(), fc.integer(), fc.boolean());

    await fc.assert(
      fc.asyncProperty(valueArb, fc.integer({ min: 2, max: 5 }), async (parentValue, numChildren) => {
        // Arrange
        const scopeFactory = createPropertyTestScopeFactory();
        const readValues: unknown[] = [];

        const parentStage = async (scope: BaseState) => {
          scope.setObject(['pipeline'], 'parentData', parentValue);
          return { written: true };
        };

        const children = Array.from({ length: numChildren }, (_, i) => ({
          id: `child${i}`,
          name: `Child${i}`,
          fn: async (scope: BaseState) => {
            const value = scope.getValue(['pipeline'], 'parentData');
            readValues.push(value);
            return { childId: i };
          },
        }));

        const builder = new FlowChartBuilder()
          .start('Parent', parentStage)
          .addListOfFunction(children);

        // Act
        await builder.execute(scopeFactory);

        // Assert - all children should have read the same parent value
        return readValues.every((v) => JSON.stringify(v) === JSON.stringify(parentValue));
      }),
      { numRuns: 50 },
    );
  });

  /**
   * PROPERTY: Children scope writes are isolated
   *
   * For any values written by parallel children, those values should
   * NOT be visible to sibling children or subsequent stages via scope.
   *
   * **Validates: Requirements 2.2**
   */
  it('should isolate children scope writes from each other', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 2, max: 4 }), async (numChildren) => {
        // Arrange
        const scopeFactory = createPropertyTestScopeFactory();
        const siblingReads: Array<{ childId: number; siblingValues: unknown[] }> = [];

        const children = Array.from({ length: numChildren }, (_, i) => ({
          id: `child${i}`,
          name: `Child${i}`,
          fn: async (scope: BaseState) => {
            // Write our own value
            scope.setObject(['pipeline'], `child${i}Data`, i * 100);

            // Small delay to let other children write
            await new Promise((resolve) => setTimeout(resolve, 10));

            // Try to read sibling values (should be undefined due to isolation)
            const siblingValues: unknown[] = [];
            for (let j = 0; j < numChildren; j++) {
              if (j !== i) {
                siblingValues.push(scope.getValue(['pipeline'], `child${j}Data`));
              }
            }

            siblingReads.push({ childId: i, siblingValues });
            return { childId: i };
          },
        }));

        const builder = new FlowChartBuilder()
          .start('Entry', async () => ({ started: true }))
          .addListOfFunction(children);

        // Act
        await builder.execute(scopeFactory);

        // Assert - all sibling reads should be undefined (isolated scopes)
        return siblingReads.every((read) => read.siblingValues.every((v) => v === undefined));
      }),
      { numRuns: 20 },
    );
  });
});
