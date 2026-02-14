/**
 * Tests for Demo 3: Decider (Order Processing Domain)
 *
 * BEHAVIOR: Verifies that the scope-based decider (addDeciderFunction) routes
 * to exactly ONE branch based on the decider function's return value.
 *
 * WHY: Documents the single-choice branching pattern using addDeciderFunction.
 * The decider reads fulfillmentType from scope instead of stage output.
 */
import { FlowChartBuilder, BaseState, StageContext } from 'footprint';
import { buildOrderProcessingFlow, stages, fulfillmentDecider, sampleOrders, setCurrentOrder, FulfillmentType } from './index';

function createExecutionTracker() {
  const executedStages: string[] = [];
  const scopeFactory = (ctx: StageContext, stageName: string, readOnly?: unknown) => {
    executedStages.push(stageName);
    return new BaseState(ctx, stageName, readOnly);
  };
  return { scopeFactory, getExecutedStages: () => executedStages };
}

function createSimpleScopeFactory() {
  return (ctx: StageContext, stageName: string, readOnly?: unknown) => new BaseState(ctx, stageName, readOnly);
}

function createMockScope(ft: FulfillmentType | undefined): BaseState {
  return { getValue: (path: string[], key?: string) => { if (path[0] === 'pipeline' && key === 'fulfillmentType') return ft; return undefined; } } as unknown as BaseState;
}

describe('Demo 3: Decider (Order Processing)', () => {
  describe('when executing decider with different order types', () => {
    it('should route to StandardFulfillment for standard orders', async () => {
      const tracker = createExecutionTracker();
      setCurrentOrder(sampleOrders.standard);
      const builder = new FlowChartBuilder()
        .start('AnalyzeOrder', stages.analyzeOrder)
        .addDeciderFunction('FD', fulfillmentDecider as any, 'fd')
        .addFunctionBranch('standard', 'StandardFulfillment', stages.standardFulfillment)
        .addFunctionBranch('express', 'ExpressFulfillment', stages.expressFulfillment)
        .addFunctionBranch('digital', 'DigitalDelivery', stages.digitalDelivery)
        .end();
      await builder.execute(tracker.scopeFactory);
      const executed = tracker.getExecutedStages();
      expect(executed).toContain('AnalyzeOrder');
      expect(executed).toContain('StandardFulfillment');
      expect(executed).not.toContain('ExpressFulfillment');
      expect(executed).not.toContain('DigitalDelivery');
    });
  });
});
