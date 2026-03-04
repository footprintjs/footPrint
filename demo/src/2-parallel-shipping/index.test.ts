/**
 * Tests for Demo 2: Parallel Children (Shipping Domain)
 *
 * BEHAVIOR: Verifies that parallel children execute concurrently and
 * that total execution time is approximately max(child times), not sum.
 *
 * WHY: These tests serve as documentation for the fork-join pattern,
 * demonstrating expected behavior and timing characteristics.
 *
 * TEST STRUCTURE:
 * - Uses GIVEN/WHEN/THEN format for clarity
 * - Timing tests verify parallel execution
 * - Scope tests verify data sharing between stages
 */

import { FlowChartBuilder, BaseState, StageContext } from 'footprint';
import { buildParallelShippingFlow, stages, shipmentData, TIMING } from './index';

// ============================================================================
// Test Utilities
// ============================================================================

/**
 * Creates a scope factory that tracks execution timing.
 */
function createTimingTracker() {
  const timings: Map<string, { start: number; end: number }> = new Map();
  const executionOrder: string[] = [];

  const scopeFactory = (ctx: StageContext, stageName: string, readOnly?: unknown) => {
    executionOrder.push(stageName);
    timings.set(stageName, { start: Date.now(), end: 0 });
    return new BaseState(ctx, stageName, readOnly);
  };

  const recordEnd = (stageName: string) => {
    const timing = timings.get(stageName);
    if (timing) {
      timing.end = Date.now();
    }
  };

  return {
    scopeFactory,
    recordEnd,
    getTimings: () => timings,
    getExecutionOrder: () => executionOrder,
  };
}

/**
 * Creates a simple scope factory for basic tests.
 */
function createSimpleScopeFactory() {
  return (ctx: StageContext, stageName: string, readOnly?: unknown) => {
    return new BaseState(ctx, stageName, readOnly);
  };
}

/**
 * Helper to create a delayed stage function for timing tests.
 */
function createDelayedStage(name: string, delayMs: number, tracker: ReturnType<typeof createTimingTracker>) {
  return async (scope: BaseState) => {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    tracker.recordEnd(name);
    return { stage: name, delay: delayMs };
  };
}

// ============================================================================
// Test Suite
// ============================================================================

describe('Demo 2: Parallel Children (Shipping)', () => {
  /**
   * BEHAVIOR: All parallel children execute
   * WHY: Fork-join pattern must execute all children before continuing
   */
  describe('when executing parallel children', () => {
    /**
     * GIVEN: A pipeline with 3 parallel children
     * WHEN: The pipeline executes
     * THEN: All 3 children execute
     */
    it('should execute all parallel children', async () => {
      // Arrange
      const executedStages: string[] = [];
      const scopeFactory = (ctx: StageContext, stageName: string, readOnly?: unknown) => {
        executedStages.push(stageName);
        return new BaseState(ctx, stageName, readOnly);
      };

      // Act
      const builder = new FlowChartBuilder()
        .start('PrepareShipment', stages.prepareShipment)
        .addListOfFunction([
          { id: 'rate', name: 'CalculateRate', fn: stages.calculateRate },
          { id: 'inventory', name: 'CheckInventory', fn: stages.checkInventory },
          { id: 'address', name: 'ValidateAddress', fn: stages.validateAddress },
        ])
        .addFunction('CreateLabel', stages.createLabel);

      await builder.execute(scopeFactory);

      // Assert - all stages should have executed
      expect(executedStages).toContain('PrepareShipment');
      expect(executedStages).toContain('CalculateRate');
      expect(executedStages).toContain('CheckInventory');
      expect(executedStages).toContain('ValidateAddress');
      expect(executedStages).toContain('CreateLabel');
    });

    /**
     * GIVEN: A pipeline with parallel children
     * WHEN: The pipeline completes
     * THEN: The result is the output of the last stage (after children)
     */
    it('should return the output of the final stage', async () => {
      // Arrange
      const scopeFactory = createSimpleScopeFactory();

      // Act
      const builder = new FlowChartBuilder()
        .start('PrepareShipment', stages.prepareShipment)
        .addListOfFunction([
          { id: 'rate', name: 'CalculateRate', fn: stages.calculateRate },
          { id: 'inventory', name: 'CheckInventory', fn: stages.checkInventory },
          { id: 'address', name: 'ValidateAddress', fn: stages.validateAddress },
        ])
        .addFunction('CreateLabel', stages.createLabel);

      const result = await builder.execute(scopeFactory);

      // Assert - CreateLabel returns these fields (from parent scope, not children)
      expect(result).toHaveProperty('trackingNumber');
      expect(result).toHaveProperty('orderId', shipmentData.orderId);
      expect(result).toHaveProperty('totalWeight');
      expect(result).toHaveProperty('destination');
    });
  });

  /**
   * BEHAVIOR: Parallel execution is faster than sequential
   * WHY: The main benefit of parallel execution is reduced total time
   */
  describe('when measuring parallel execution timing', () => {
    /**
     * GIVEN: 3 parallel children with known delays (150ms, 100ms, 80ms)
     * WHEN: The pipeline executes
     * THEN: Total time is closer to max(150ms) than sum(330ms)
     */
    it('should complete faster than sequential execution would', async () => {
      // Arrange
      const scopeFactory = createSimpleScopeFactory();

      const builder = new FlowChartBuilder()
        .start('PrepareShipment', stages.prepareShipment)
        .addListOfFunction([
          { id: 'rate', name: 'CalculateRate', fn: stages.calculateRate },
          { id: 'inventory', name: 'CheckInventory', fn: stages.checkInventory },
          { id: 'address', name: 'ValidateAddress', fn: stages.validateAddress },
        ])
        .addFunction('CreateLabel', stages.createLabel);

      // Act
      const startTime = Date.now();
      await builder.execute(scopeFactory);
      const totalTime = Date.now() - startTime;

      // Assert
      // If parallel: ~150ms + overhead (let's say < 250ms)
      // If sequential: ~330ms + overhead
      // We check that total time is significantly less than sequential would be
      const maxAllowedTime = TIMING.SEQUENTIAL_SUM_MS * 0.9; // 90% of sequential time
      expect(totalTime).toBeLessThan(maxAllowedTime);
    });

    /**
     * GIVEN: Custom parallel children with specific delays
     * WHEN: The pipeline executes
     * THEN: Total time is approximately max(delays) + overhead
     */
    it('should have total time approximately equal to max child time', async () => {
      // Arrange
      const tracker = createTimingTracker();
      const delays = { child1: 100, child2: 150, child3: 80 };

      const builder = new FlowChartBuilder()
        .start('Entry', async () => ({ started: true }))
        .addListOfFunction([
          { id: 'c1', name: 'Child1', fn: createDelayedStage('Child1', delays.child1, tracker) },
          { id: 'c2', name: 'Child2', fn: createDelayedStage('Child2', delays.child2, tracker) },
          { id: 'c3', name: 'Child3', fn: createDelayedStage('Child3', delays.child3, tracker) },
        ])
        .addFunction('Exit', async () => ({ completed: true }));

      // Act
      const startTime = Date.now();
      await builder.execute(tracker.scopeFactory);
      const totalTime = Date.now() - startTime;

      // Assert
      const maxDelay = Math.max(delays.child1, delays.child2, delays.child3);
      const sumDelay = delays.child1 + delays.child2 + delays.child3;

      // Total should be closer to max than to sum
      // Allow 100ms overhead for test execution
      expect(totalTime).toBeLessThan(maxDelay + 100);
      expect(totalTime).toBeLessThan(sumDelay);
    });
  });

  /**
   * BEHAVIOR: Scope data is shared correctly between stages
   * WHY: Parallel children need to read parent data and write results
   */
  describe('when sharing scope data', () => {
    /**
     * GIVEN: Parent stage writes data to scope
     * WHEN: Parallel children execute
     * THEN: All children can read the parent's data
     */
    it('should allow parallel children to read parent scope data', async () => {
      // Arrange
      const scopeFactory = createSimpleScopeFactory();
      const readValues: Record<string, unknown> = {};

      const parentStage = async (scope: BaseState) => {
        scope.setObject('parentData', { value: 42 });
        return { written: true };
      };

      const childStage = (id: string) => async (scope: BaseState) => {
        readValues[id] = scope.getValue('parentData');
        return { childId: id };
      };

      const builder = new FlowChartBuilder()
        .start('Parent', parentStage)
        .addListOfFunction([
          { id: 'c1', name: 'Child1', fn: childStage('c1') },
          { id: 'c2', name: 'Child2', fn: childStage('c2') },
          { id: 'c3', name: 'Child3', fn: childStage('c3') },
        ]);

      // Act
      await builder.execute(scopeFactory);

      // Assert - all children should have read the same parent data
      expect(readValues['c1']).toEqual({ value: 42 });
      expect(readValues['c2']).toEqual({ value: 42 });
      expect(readValues['c3']).toEqual({ value: 42 });
    });

    /**
     * GIVEN: Parallel children write to scope
     * WHEN: The next stage executes
     * THEN: Children's scope writes are isolated (not visible to parent)
     *
     * NOTE: This is expected behavior - parallel children have isolated scopes.
     * To share data from children to parent, use the stage return value
     * which is aggregated in the children results.
     */
    it('should isolate parallel children scope writes from parent', async () => {
      // Arrange
      const scopeFactory = createSimpleScopeFactory();
      let aggregatedData: Record<string, unknown> = {};

      const childStage = (id: string, value: number) => async (scope: BaseState) => {
        scope.setObject(`child${id}`, value);
        // Return value IS aggregated (unlike scope writes)
        return { childId: id, value };
      };

      const aggregateStage = async (scope: BaseState) => {
        // These will be undefined because children have isolated scopes
        aggregatedData = {
          child1: scope.getValue('child1'),
          child2: scope.getValue('child2'),
          child3: scope.getValue('child3'),
        };
        return { aggregated: true };
      };

      const builder = new FlowChartBuilder()
        .start('Entry', async () => ({ started: true }))
        .addListOfFunction([
          { id: 'c1', name: 'Child1', fn: childStage('1', 100) },
          { id: 'c2', name: 'Child2', fn: childStage('2', 200) },
          { id: 'c3', name: 'Child3', fn: childStage('3', 300) },
        ])
        .addFunction('Aggregate', aggregateStage);

      // Act
      await builder.execute(scopeFactory);

      // Assert - children's scope writes are NOT visible to parent
      // This is expected behavior for scope isolation
      expect(aggregatedData.child1).toBeUndefined();
      expect(aggregatedData.child2).toBeUndefined();
      expect(aggregatedData.child3).toBeUndefined();
    });
  });

  /**
   * BEHAVIOR: buildParallelShippingFlow() returns a valid pipeline
   * WHY: Exported builder function should work correctly for testing
   */
  describe('when using buildParallelShippingFlow()', () => {
    /**
     * GIVEN: The exported buildParallelShippingFlow function
     * WHEN: Called
     * THEN: Returns a valid built flowchart
     */
    it('should return a built flowchart', () => {
      // Act
      const flow = buildParallelShippingFlow();

      // Assert
      expect(flow).toBeDefined();
      expect(flow).toHaveProperty('root');
    });
  });

  /**
   * BEHAVIOR: Business logic produces correct results
   * WHY: Domain-specific calculations should be accurate
   */
  describe('when calculating shipping data', () => {
    /**
     * GIVEN: Shipment items with weights
     * WHEN: PrepareShipment executes
     * THEN: Total weight is calculated correctly
     */
    it('should calculate correct total weight', async () => {
      // Arrange
      const scopeFactory = createSimpleScopeFactory();
      let capturedWeight: number | undefined;

      const captureWeight = async (scope: BaseState) => {
        capturedWeight = scope.getValue('totalWeight') as number;
        return {};
      };

      const builder = new FlowChartBuilder()
        .start('PrepareShipment', stages.prepareShipment)
        .addFunction('CaptureWeight', captureWeight);

      // Act
      await builder.execute(scopeFactory);

      // Assert
      // shipmentData.items: [0.5*2, 1.2*1] = 1.0 + 1.2 = 2.2
      const expectedWeight = shipmentData.items.reduce(
        (sum, item) => sum + item.weight * item.quantity,
        0,
      );
      expect(capturedWeight).toBeCloseTo(expectedWeight, 2);
    });
  });
});
