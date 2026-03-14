/**
 * Scenario test: loopTo runtime execution.
 *
 * Verifies that flowcharts built with the builder's loopTo() method
 * actually execute the loop at runtime — not just build the structure.
 *
 * Prior to the fix, loopTo created a bare reference node { name, id }
 * with no fn. The engine tried to execute it directly and threw:
 *   "Node 'X' must define: embedded fn OR a stageMap entry OR have children/decider"
 */
import type { ScopeFacade } from '../../../../src';
import { flowChart, FlowChartExecutor } from '../../../../src';

describe('Scenario: loopTo runtime execution', () => {
  it('basic loop: a → b → loopTo(a), breaks after N iterations', async () => {
    const order: string[] = [];

    const chart = flowChart(
      'StepA',
      (scope: ScopeFacade) => {
        const count = (scope.getValue('count') as number) ?? 0;
        scope.setValue('count', count + 1);
        order.push(`a-${count}`);
      },
      'step-a',
    )
      .addFunction(
        'StepB',
        (scope: ScopeFacade, breakPipeline: () => void) => {
          const count = scope.getValue('count') as number;
          order.push(`b-${count}`);
          if (count >= 3) {
            scope.setValue('result', 'done');
            breakPipeline();
          }
        },
        'step-b',
      )
      .loopTo('step-a')
      .setEnableNarrative()
      .build();

    const executor = new FlowChartExecutor(chart);
    await executor.run({ input: {} });

    expect(order).toEqual(['a-0', 'b-1', 'a-1', 'b-2', 'a-2', 'b-3']);
    const snapshot = executor.getSnapshot();
    expect(snapshot?.sharedState?.result).toBe('done');
    expect(snapshot?.sharedState?.count).toBe(3);
  });

  it('loopTo mid-chain: a → b → c → loopTo(b)', async () => {
    const order: string[] = [];

    const chart = flowChart(
      'Init',
      (scope: ScopeFacade) => {
        scope.setValue('count', 0);
        order.push('init');
      },
      'init',
    )
      .addFunction(
        'Process',
        (scope: ScopeFacade) => {
          const count = (scope.getValue('count') as number) ?? 0;
          scope.setValue('count', count + 1);
          order.push(`process-${count}`);
        },
        'process',
      )
      .addFunction(
        'Check',
        (scope: ScopeFacade, breakPipeline: () => void) => {
          const count = scope.getValue('count') as number;
          order.push(`check-${count}`);
          if (count >= 2) {
            breakPipeline();
          }
        },
        'check',
      )
      .loopTo('process')
      .build();

    const executor = new FlowChartExecutor(chart);
    await executor.run({ input: {} });

    // Init runs once, then Process/Check loop
    expect(order).toEqual(['init', 'process-0', 'check-1', 'process-1', 'check-2']);
  });

  it('loopTo generates loop narrative entries', async () => {
    const chart = flowChart(
      'Counter',
      (scope: ScopeFacade) => {
        const n = (scope.getValue('n') as number) ?? 0;
        scope.setValue('n', n + 1);
      },
      'counter',
    )
      .addFunction(
        'Gate',
        (scope: ScopeFacade, breakPipeline: () => void) => {
          if ((scope.getValue('n') as number) >= 2) breakPipeline();
        },
        'gate',
      )
      .loopTo('counter')
      .setEnableNarrative()
      .build();

    const executor = new FlowChartExecutor(chart);
    await executor.run({ input: {} });

    const narrative = executor.getNarrative();
    expect(narrative.length).toBeGreaterThan(0);
    // Should mention Counter stage multiple times
    const counterMentions = narrative.filter((s) => s.includes('Counter'));
    expect(counterMentions.length).toBeGreaterThanOrEqual(2);
  });

  it('loopTo with decider: decider → branch → loopTo(earlier)', async () => {
    const order: string[] = [];

    const chart = flowChart(
      'Fetch',
      (scope: ScopeFacade) => {
        const attempt = (scope.getValue('attempt') as number) ?? 0;
        scope.setValue('attempt', attempt + 1);
        order.push(`fetch-${attempt}`);
      },
      'fetch',
    )
      .addDeciderFunction(
        'Decide',
        (scope: ScopeFacade) => {
          const attempt = scope.getValue('attempt') as number;
          return attempt >= 3 ? 'done' : 'retry';
        },
        'decide',
      )
      .addFunctionBranch('retry', 'Retry', () => {
        order.push('retry');
      })
      .addFunctionBranch('done', 'Done', (scope: ScopeFacade, breakPipeline: () => void) => {
        scope.setValue('result', 'finished');
        order.push('done');
        breakPipeline(); // Stop the loop when done
      })
      .setDefault('done')
      .end()
      .loopTo('fetch')
      .build();

    const executor = new FlowChartExecutor(chart);
    await executor.run({ input: {} });

    // Fetch(0) → Decide(retry) → Retry → loop → Fetch(1) → Decide(retry) → Retry → loop → Fetch(2) → Decide(done) → Done(break)
    expect(order).toContain('retry');
    expect(order).toContain('done');
    expect(order[order.length - 1]).toBe('done');
    const snapshot = executor.getSnapshot();
    expect(snapshot?.sharedState?.result).toBe('finished');
  });

  it('loopTo with breakPipeline stops the loop immediately', async () => {
    let iterations = 0;

    const chart = flowChart(
      'Work',
      (scope: ScopeFacade, breakPipeline: () => void) => {
        iterations++;
        if (iterations >= 5) {
          breakPipeline();
        }
      },
      'work',
    )
      .loopTo('work')
      .build();

    const executor = new FlowChartExecutor(chart);
    await executor.run({ input: {} });

    expect(iterations).toBe(5);
  });

  it('snapshot state persists across loop iterations', async () => {
    const chart = flowChart(
      'Accumulate',
      (scope: ScopeFacade, breakPipeline: () => void) => {
        const items = (scope.getValue('items') as string[]) ?? [];
        items.push(`item-${items.length}`);
        scope.setValue('items', items);

        if (items.length >= 4) {
          breakPipeline();
        }
      },
      'accumulate',
    )
      .loopTo('accumulate')
      .build();

    const executor = new FlowChartExecutor(chart);
    await executor.run({ input: {} });

    const snapshot = executor.getSnapshot();
    expect(snapshot?.sharedState?.items).toEqual(['item-0', 'item-1', 'item-2', 'item-3']);
  });
});
