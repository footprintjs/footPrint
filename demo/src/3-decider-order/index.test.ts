/**
 * Tests for Demo 3: Decider (Order Processing Domain)
 *
 * BEHAVIOR: Verifies that decider routes to exactly ONE branch based on
 * the decider function's return value, and that execution continues
 * after the selected branch completes.
 *
 * WHY: These tests serve as documentation for the single-choice branching
 * pattern, demonstrating that exactly one branch executes per decision.
 *
 * TEST STRUCTURE:
 * - Uses GIVEN/WHEN/THEN format for clarity
 * - Branch selection tests verify routing logic
 * - Scope tests verify data sharing between stages
 */

import { FlowChartBuilder, BaseState, StageContext } from 'footprint';
import {
  buildOrderProcessingFlow,
  stages,
  fulfillmentDecider,
  sampleOrders,
  setCurrentOrder,
  FulfillmentType,
  OrderData,
} from './index';

// ============================================================================
// Test Utilities
// ============================================================================

/**
 * Creates a scope factory that tracks which stages executed.
 */
function createExecutionTracker() {
  const executedStages: string[] = [];

  const scopeFactory = (ctx: StageContext, stageName: string, readOnly?: unknown) => {
    executedStages.push(stageName);
    return new BaseState(ctx, stageName, readOnly);
  };

  return {
    scopeFactory,
    getExecutedStages: () => executedStages,
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

// ============================================================================
// Test Suite
// ============================================================================

describe('Demo 3: Decider (Order Processing)', () => {
  /**
   * BEHAVIOR: Decider routes to exactly one branch
   * WHY: Single-choice branching must execute exactly one path
   */
  describe('when executing decider with different order types', () => {
    /**
     * GIVEN: A standard order (physical items, standard shipping)
     * WHEN: The pipeline executes
     * THEN: Only StandardFulfillment branch executes
     */
    it('should route to StandardFulfillment for standard orders', async () => {
      // Arrange
      const tracker = createExecutionTracker();
      setCurrentOrder(sampleOrders.standard);

      // Act - pipeline without ConfirmOrder to test branch selection
      const builder = new FlowChartBuilder()
        .start('AnalyzeOrder', stages.analyzeOrder)
        .addDecider(fulfillmentDecider)
          .addFunctionBranch('standard', 'StandardFulfillment', stages.standardFulfillment)
          .addFunctionBranch('express', 'ExpressFulfillment', stages.expressFulfillment)
          .addFunctionBranch('digital', 'DigitalDelivery', stages.digitalDelivery)
          .setDefault('standard')
          .end();

      await builder.execute(tracker.scopeFactory);

      // Assert - only standard branch should execute
      const executed = tracker.getExecutedStages();
      expect(executed).toContain('AnalyzeOrder');
      expect(executed).toContain('StandardFulfillment');
      expect(executed).not.toContain('ExpressFulfillment');
      expect(executed).not.toContain('DigitalDelivery');
    });

    /**
     * GIVEN: An express order (physical items, express shipping)
     * WHEN: The pipeline executes
     * THEN: Only ExpressFulfillment branch executes
     */
    it('should route to ExpressFulfillment for express orders', async () => {
      // Arrange
      const tracker = createExecutionTracker();
      setCurrentOrder(sampleOrders.express);

      // Act - pipeline without ConfirmOrder to test branch selection
      const builder = new FlowChartBuilder()
        .start('AnalyzeOrder', stages.analyzeOrder)
        .addDecider(fulfillmentDecider)
          .addFunctionBranch('standard', 'StandardFulfillment', stages.standardFulfillment)
          .addFunctionBranch('express', 'ExpressFulfillment', stages.expressFulfillment)
          .addFunctionBranch('digital', 'DigitalDelivery', stages.digitalDelivery)
          .setDefault('standard')
          .end();

      await builder.execute(tracker.scopeFactory);

      // Assert - only express branch should execute
      const executed = tracker.getExecutedStages();
      expect(executed).toContain('AnalyzeOrder');
      expect(executed).toContain('ExpressFulfillment');
      expect(executed).not.toContain('StandardFulfillment');
      expect(executed).not.toContain('DigitalDelivery');
    });

    /**
     * GIVEN: A digital order (all digital items)
     * WHEN: The pipeline executes
     * THEN: Only DigitalDelivery branch executes
     */
    it('should route to DigitalDelivery for digital orders', async () => {
      // Arrange
      const tracker = createExecutionTracker();
      setCurrentOrder(sampleOrders.digital);

      // Act - pipeline without ConfirmOrder to test branch selection
      const builder = new FlowChartBuilder()
        .start('AnalyzeOrder', stages.analyzeOrder)
        .addDecider(fulfillmentDecider)
          .addFunctionBranch('standard', 'StandardFulfillment', stages.standardFulfillment)
          .addFunctionBranch('express', 'ExpressFulfillment', stages.expressFulfillment)
          .addFunctionBranch('digital', 'DigitalDelivery', stages.digitalDelivery)
          .setDefault('standard')
          .end();

      await builder.execute(tracker.scopeFactory);

      // Assert - only digital branch should execute
      const executed = tracker.getExecutedStages();
      expect(executed).toContain('AnalyzeOrder');
      expect(executed).toContain('DigitalDelivery');
      expect(executed).not.toContain('StandardFulfillment');
      expect(executed).not.toContain('ExpressFulfillment');
    });
  });

  /**
   * BEHAVIOR: Decider function receives previous stage output
   * WHY: Routing decisions depend on data from previous stages
   */
  describe('when decider function receives input', () => {
    /**
     * GIVEN: A decider function that examines fulfillmentType
     * WHEN: Called with different fulfillment types
     * THEN: Returns the correct branch ID
     */
    it('should return correct branch ID based on fulfillmentType', () => {
      // Assert - decider function returns correct branch IDs
      expect(fulfillmentDecider({ fulfillmentType: 'standard' })).toBe('standard');
      expect(fulfillmentDecider({ fulfillmentType: 'express' })).toBe('express');
      expect(fulfillmentDecider({ fulfillmentType: 'digital' })).toBe('digital');
    });

    /**
     * GIVEN: A decider function with undefined input
     * WHEN: Called with undefined fulfillmentType
     * THEN: Returns default branch ID ('standard')
     */
    it('should return default branch ID when fulfillmentType is undefined', () => {
      // Assert - defaults to 'standard' when undefined
      expect(fulfillmentDecider({ fulfillmentType: undefined as unknown as FulfillmentType })).toBe('standard');
      expect(fulfillmentDecider(undefined as unknown as { fulfillmentType: FulfillmentType })).toBe('standard');
    });
  });

  /**
   * BEHAVIOR: Scope data flows correctly through decider
   * WHY: Data written before decider should be available in branches
   */
  describe('when sharing scope data through decider', () => {
    /**
     * GIVEN: AnalyzeOrder writes order data to scope
     * WHEN: A branch executes
     * THEN: The branch can read the order data and produce correct result
     */
    it('should allow branches to read data written before decider', async () => {
      // Arrange
      const scopeFactory = createSimpleScopeFactory();
      setCurrentOrder(sampleOrders.standard);

      // Act
      const builder = new FlowChartBuilder()
        .start('AnalyzeOrder', stages.analyzeOrder)
        .addDecider(fulfillmentDecider)
          .addFunctionBranch('standard', 'StandardFulfillment', stages.standardFulfillment)
          .addFunctionBranch('express', 'ExpressFulfillment', stages.expressFulfillment)
          .addFunctionBranch('digital', 'DigitalDelivery', stages.digitalDelivery)
          .setDefault('standard')
          .end();

      const result = await builder.execute(scopeFactory) as any;

      // Assert - StandardFulfillment reads order from scope and produces result
      // The result is from the selected branch (StandardFulfillment)
      expect(result).toHaveProperty('orderId', sampleOrders.standard.orderId);
      expect(result).toHaveProperty('method', 'standard');
      expect(result).toHaveProperty('carrier', 'USPS');
    });

    /**
     * GIVEN: A branch writes fulfillment result to scope
     * WHEN: ExpressFulfillment executes
     * THEN: Result contains express-specific data
     */
    it('should produce branch-specific output for express orders', async () => {
      // Arrange
      const scopeFactory = createSimpleScopeFactory();
      setCurrentOrder(sampleOrders.express);

      // Act
      const builder = new FlowChartBuilder()
        .start('AnalyzeOrder', stages.analyzeOrder)
        .addDecider(fulfillmentDecider)
          .addFunctionBranch('standard', 'StandardFulfillment', stages.standardFulfillment)
          .addFunctionBranch('express', 'ExpressFulfillment', stages.expressFulfillment)
          .addFunctionBranch('digital', 'DigitalDelivery', stages.digitalDelivery)
          .setDefault('standard')
          .end();

      const result = await builder.execute(scopeFactory) as any;

      // Assert - ExpressFulfillment produces express-specific result
      expect(result).toHaveProperty('method', 'express');
      expect(result).toHaveProperty('estimatedDays', 2);
      expect(result).toHaveProperty('carrier', 'FedEx');
      expect(result).toHaveProperty('priorityFee', 15.99);
    });
  });

  /**
   * BEHAVIOR: Default branch is used for unknown IDs
   * WHY: Fallback ensures pipeline doesn't fail on unexpected values
   */
  describe('when decider returns unknown branch ID', () => {
    /**
     * GIVEN: A decider that returns an unknown branch ID
     * WHEN: The pipeline executes
     * THEN: The default branch executes
     */
    it('should execute default branch for unknown IDs', async () => {
      // Arrange
      const tracker = createExecutionTracker();
      const unknownDecider = () => 'unknown-branch-id';

      // Act
      const builder = new FlowChartBuilder()
        .start('Entry', async () => ({ started: true }))
        .addDecider(unknownDecider)
          .addFunctionBranch('a', 'BranchA', async () => ({ branch: 'a' }))
          .addFunctionBranch('b', 'BranchB', async () => ({ branch: 'b' }))
          .setDefault('a')
          .end()
        .addFunction('Exit', async () => ({ completed: true }));

      await builder.execute(tracker.scopeFactory);

      // Assert - default branch 'a' should execute
      const executed = tracker.getExecutedStages();
      expect(executed).toContain('BranchA');
      expect(executed).not.toContain('BranchB');
    });
  });

  /**
   * BEHAVIOR: buildOrderProcessingFlow() returns a valid pipeline
   * WHY: Exported builder function should work correctly for testing
   */
  describe('when using buildOrderProcessingFlow()', () => {
    /**
     * GIVEN: The exported buildOrderProcessingFlow function
     * WHEN: Called
     * THEN: Returns a valid built flowchart
     */
    it('should return a built flowchart', () => {
      // Act
      const flow = buildOrderProcessingFlow();

      // Assert
      expect(flow).toBeDefined();
      expect(flow).toHaveProperty('root');
    });
  });

  /**
   * BEHAVIOR: Business logic produces correct fulfillment results
   * WHY: Domain-specific calculations should be accurate
   */
  describe('when calculating fulfillment results', () => {
    /**
     * GIVEN: A standard order
     * WHEN: StandardFulfillment executes
     * THEN: Result has correct carrier and estimated days
     */
    it('should produce correct standard fulfillment result', async () => {
      // Arrange
      const scopeFactory = createSimpleScopeFactory();
      setCurrentOrder(sampleOrders.standard);

      // Act
      const builder = new FlowChartBuilder()
        .start('AnalyzeOrder', stages.analyzeOrder)
        .addDecider(fulfillmentDecider)
          .addFunctionBranch('standard', 'StandardFulfillment', stages.standardFulfillment)
          .addFunctionBranch('express', 'ExpressFulfillment', stages.expressFulfillment)
          .addFunctionBranch('digital', 'DigitalDelivery', stages.digitalDelivery)
          .setDefault('standard')
          .end();

      const result = await builder.execute(scopeFactory) as any;

      // Assert - result is from the selected branch (StandardFulfillment)
      expect(result).toHaveProperty('method', 'standard');
      expect(result).toHaveProperty('estimatedDays', 5);
      expect(result).toHaveProperty('carrier', 'USPS');
    });

    /**
     * GIVEN: A digital order
     * WHEN: DigitalDelivery executes
     * THEN: Result has download links for all items
     */
    it('should produce correct digital delivery result', async () => {
      // Arrange
      const scopeFactory = createSimpleScopeFactory();
      setCurrentOrder(sampleOrders.digital);

      // Act
      const builder = new FlowChartBuilder()
        .start('AnalyzeOrder', stages.analyzeOrder)
        .addDecider(fulfillmentDecider)
          .addFunctionBranch('standard', 'StandardFulfillment', stages.standardFulfillment)
          .addFunctionBranch('express', 'ExpressFulfillment', stages.expressFulfillment)
          .addFunctionBranch('digital', 'DigitalDelivery', stages.digitalDelivery)
          .setDefault('standard')
          .end();

      const result = await builder.execute(scopeFactory) as any;

      // Assert - result is from the selected branch (DigitalDelivery)
      expect(result).toHaveProperty('method', 'digital');
      expect(result).toHaveProperty('estimatedDays', 0);
      expect(result).toHaveProperty('downloadLinks');
      expect(result.downloadLinks).toHaveLength(sampleOrders.digital.items.length);
    });
  });
});
