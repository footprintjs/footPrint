/**
 * Tests for Demo 1: Linear Flow (Payment Domain)
 *
 * BEHAVIOR: Verifies that a linear pipeline executes all stages in sequence
 * and correctly shares state between stages via scope operations.
 *
 * WHY: These tests serve as documentation for the linear flow pattern,
 * demonstrating expected behavior and edge cases.
 *
 * TEST STRUCTURE:
 * - Uses GIVEN/WHEN/THEN format for clarity
 * - Each test verifies a specific aspect of linear flow behavior
 * - Tests are independent and can run in any order
 */

import { FlowChartBuilder, BaseState, StageContext, GlobalStore, PipelineRuntime } from 'footprint';
import { buildPaymentFlow, stages, cartItems } from './index';

// ============================================================================
// Test Utilities
// ============================================================================

/**
 * Creates a test scope factory that tracks execution order.
 *
 * WHY: Enables verification of stage execution order without modifying
 * the production code.
 */
function createTrackingScopeFactory(executionOrder: string[]) {
  return (ctx: StageContext, stageName: string, readOnly?: unknown) => {
    executionOrder.push(stageName);
    return new BaseState(ctx, stageName, readOnly);
  };
}

/**
 * Creates a scope factory with a fresh GlobalStore for isolated testing.
 */
function createIsolatedScopeFactory() {
  return (ctx: StageContext, stageName: string, readOnly?: unknown) => {
    return new BaseState(ctx, stageName, readOnly);
  };
}

// ============================================================================
// Test Suite
// ============================================================================

describe('Demo 1: Linear Flow (Payment)', () => {
  /**
   * BEHAVIOR: Pipeline executes all stages in the defined order
   * WHY: Linear flows must guarantee sequential execution
   */
  describe('when executing a linear pipeline', () => {
    /**
     * GIVEN: A linear pipeline with 4 stages
     * WHEN: The pipeline executes
     * THEN: All 4 stages execute in the order they were added
     */
    it('should execute all stages in order', async () => {
      // Arrange
      const executionOrder: string[] = [];
      const scopeFactory = createTrackingScopeFactory(executionOrder);

      const builder = new FlowChartBuilder()
        .start('ValidateCart', stages.validateCart)
        .addFunction('ProcessPayment', stages.processPayment)
        .addFunction('UpdateInventory', stages.updateInventory)
        .addFunction('SendReceipt', stages.sendReceipt);

      // Act
      await builder.execute(scopeFactory);

      // Assert
      expect(executionOrder).toEqual([
        'ValidateCart',
        'ProcessPayment',
        'UpdateInventory',
        'SendReceipt',
      ]);
    });

    /**
     * GIVEN: A linear pipeline
     * WHEN: The pipeline completes
     * THEN: The result is the output of the last stage
     */
    it('should return the output of the last stage', async () => {
      // Arrange
      const scopeFactory = createIsolatedScopeFactory();
      const builder = new FlowChartBuilder()
        .start('ValidateCart', stages.validateCart)
        .addFunction('ProcessPayment', stages.processPayment)
        .addFunction('UpdateInventory', stages.updateInventory)
        .addFunction('SendReceipt', stages.sendReceipt);

      // Act
      const result = await builder.execute(scopeFactory);

      // Assert - SendReceipt returns these fields
      expect(result).toHaveProperty('sent', true);
      expect(result).toHaveProperty('receiptId');
      expect(result).toHaveProperty('transactionId');
      expect(result).toHaveProperty('total');
      expect(result).toHaveProperty('itemCount');
    });
  });

  /**
   * BEHAVIOR: Scope state is correctly shared between stages
   * WHY: Stage-to-stage communication is the core value of pipelines
   */
  describe('when sharing state between stages', () => {
    /**
     * GIVEN: ValidateCart writes cartTotal to scope
     * WHEN: ProcessPayment executes
     * THEN: ProcessPayment can read the cartTotal value
     */
    it('should allow later stages to read values from earlier stages', async () => {
      // Arrange
      const scopeFactory = createIsolatedScopeFactory();
      let capturedTotal: number | undefined;

      // Create a custom ProcessPayment that captures the read value
      const capturePayment = async (scope: BaseState) => {
        capturedTotal = scope.getValue('cartTotal') as number;
        scope.setObject('transactionId', 'TEST-TXN');
        return { success: true };
      };

      const builder = new FlowChartBuilder()
        .start('ValidateCart', stages.validateCart)
        .addFunction('ProcessPayment', capturePayment);

      // Act
      await builder.execute(scopeFactory);

      // Assert - cartTotal should be sum of cart items
      const expectedTotal = cartItems.reduce((sum, item) => sum + item.price * item.quantity, 0);
      expect(capturedTotal).toBe(expectedTotal);
    });

    /**
     * GIVEN: Multiple stages write to scope
     * WHEN: The final stage executes
     * THEN: It can read values from all previous stages
     */
    it('should accumulate scope values across all stages', async () => {
      // Arrange
      const scopeFactory = createIsolatedScopeFactory();
      let capturedValues: Record<string, unknown> = {};

      // Create a custom final stage that captures all scope values
      const captureReceipt = async (scope: BaseState) => {
        capturedValues = {
          cartTotal: scope.getValue('cartTotal'),
          itemCount: scope.getValue('itemCount'),
          transactionId: scope.getValue('transactionId'),
          paymentStatus: scope.getValue('paymentStatus'),
        };
        return { captured: true };
      };

      const builder = new FlowChartBuilder()
        .start('ValidateCart', stages.validateCart)
        .addFunction('ProcessPayment', stages.processPayment)
        .addFunction('UpdateInventory', stages.updateInventory)
        .addFunction('CaptureReceipt', captureReceipt);

      // Act
      await builder.execute(scopeFactory);

      // Assert
      expect(capturedValues.cartTotal).toBeDefined();
      expect(capturedValues.itemCount).toBeDefined();
      expect(capturedValues.transactionId).toBeDefined();
      expect(capturedValues.paymentStatus).toBe('completed');
    });
  });

  /**
   * BEHAVIOR: Each stage receives correct scope instance
   * WHY: Scope isolation ensures stages don't interfere with each other
   */
  describe('when providing scope to stages', () => {
    /**
     * GIVEN: A pipeline with multiple stages
     * WHEN: Each stage executes
     * THEN: Each stage receives a scope with the correct stageName
     */
    it('should provide scope with correct stageName to each stage', async () => {
      // Arrange
      const stageNames: string[] = [];

      const captureStage = (expectedName: string) => async (scope: BaseState) => {
        // BaseState stores stageName internally
        stageNames.push(expectedName);
        return { stage: expectedName };
      };

      const scopeFactory = (ctx: StageContext, stageName: string, readOnly?: unknown) => {
        stageNames.push(`factory:${stageName}`);
        return new BaseState(ctx, stageName, readOnly);
      };

      const builder = new FlowChartBuilder()
        .start('Stage1', captureStage('Stage1'))
        .addFunction('Stage2', captureStage('Stage2'))
        .addFunction('Stage3', captureStage('Stage3'));

      // Act
      await builder.execute(scopeFactory);

      // Assert - factory is called with correct stage names
      expect(stageNames).toContain('factory:Stage1');
      expect(stageNames).toContain('factory:Stage2');
      expect(stageNames).toContain('factory:Stage3');
    });
  });

  /**
   * BEHAVIOR: buildPaymentFlow() returns a valid pipeline
   * WHY: Exported builder function should work correctly for testing
   */
  describe('when using buildPaymentFlow()', () => {
    /**
     * GIVEN: The exported buildPaymentFlow function
     * WHEN: Called
     * THEN: Returns a valid built flowchart
     */
    it('should return a built flowchart', () => {
      // Act
      const flow = buildPaymentFlow();

      // Assert
      expect(flow).toBeDefined();
      expect(flow).toHaveProperty('root');
    });
  });

  /**
   * BEHAVIOR: Cart total calculation is correct
   * WHY: Business logic should produce correct results
   */
  describe('when calculating cart total', () => {
    /**
     * GIVEN: Cart items with prices and quantities
     * WHEN: ValidateCart executes
     * THEN: Total is sum of (price * quantity) for all items
     */
    it('should calculate correct cart total', async () => {
      // Arrange
      const scopeFactory = createIsolatedScopeFactory();
      let capturedTotal: number | undefined;

      const captureTotal = async (scope: BaseState) => {
        capturedTotal = scope.getValue('cartTotal') as number;
        return {};
      };

      const builder = new FlowChartBuilder()
        .start('ValidateCart', stages.validateCart)
        .addFunction('CaptureTotal', captureTotal);

      // Act
      await builder.execute(scopeFactory);

      // Assert
      // cartItems: [29.99*1, 49.99*2, 79.99*1] = 29.99 + 99.98 + 79.99 = 209.96
      const expectedTotal = 29.99 + 49.99 * 2 + 79.99;
      expect(capturedTotal).toBeCloseTo(expectedTotal, 2);
    });

    /**
     * GIVEN: Cart items with quantities
     * WHEN: ValidateCart executes
     * THEN: Item count is sum of all quantities
     */
    it('should calculate correct item count', async () => {
      // Arrange
      const scopeFactory = createIsolatedScopeFactory();
      let capturedCount: number | undefined;

      const captureCount = async (scope: BaseState) => {
        capturedCount = scope.getValue('itemCount') as number;
        return {};
      };

      const builder = new FlowChartBuilder()
        .start('ValidateCart', stages.validateCart)
        .addFunction('CaptureCount', captureCount);

      // Act
      await builder.execute(scopeFactory);

      // Assert
      // cartItems: [qty:1, qty:2, qty:1] = 4 items
      expect(capturedCount).toBe(4);
    });
  });
});
