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
import { flowChart, FlowChartExecutor } from '../../../../src';

describe('Scenario: loopTo runtime execution', () => {
  it('basic loop: a → b → loopTo(a), breaks after N iterations', async () => {
    const order: string[] = [];

    const chart = flowChart(
      'StepA',
      (scope: any) => {
        const count = (scope.count as number) ?? 0;
        scope.count = count + 1;
        order.push(`a-${count}`);
      },
      'step-a',
    )
      .addFunction(
        'StepB',
        (scope: any) => {
          const count = scope.count as number;
          order.push(`b-${count}`);
          if (count >= 3) {
            scope.result = 'done';
            scope.$break();
          }
        },
        'step-b',
      )
      .loopTo('step-a')
      .build();

    const executor = new FlowChartExecutor(chart);
    executor.enableNarrative();
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
      (scope: any) => {
        scope.count = 0;
        order.push('init');
      },
      'init',
    )
      .addFunction(
        'Process',
        (scope: any) => {
          const count = (scope.count as number) ?? 0;
          scope.count = count + 1;
          order.push(`process-${count}`);
        },
        'process',
      )
      .addFunction(
        'Check',
        (scope: any) => {
          const count = scope.count as number;
          order.push(`check-${count}`);
          if (count >= 2) {
            scope.$break();
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
      (scope: any) => {
        const n = (scope.n as number) ?? 0;
        scope.n = n + 1;
      },
      'counter',
    )
      .addFunction(
        'Gate',
        (scope: any) => {
          if ((scope.n as number) >= 2) scope.$break();
        },
        'gate',
      )
      .loopTo('counter')
      .build();

    const executor = new FlowChartExecutor(chart);
    executor.enableNarrative();
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
      (scope: any) => {
        const attempt = (scope.attempt as number) ?? 0;
        scope.attempt = attempt + 1;
        order.push(`fetch-${attempt}`);
      },
      'fetch',
    )
      .addDeciderFunction(
        'Decide',
        (scope: any) => {
          const attempt = scope.attempt as number;
          return attempt >= 3 ? 'done' : 'retry';
        },
        'decide',
      )
      .addFunctionBranch('retry', 'Retry', () => {
        order.push('retry');
      })
      .addFunctionBranch('done', 'Done', (scope: any) => {
        scope.result = 'finished';
        order.push('done');
        scope.$break(); // Stop the loop when done
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
      (scope: any) => {
        iterations++;
        if (iterations >= 5) {
          scope.$break();
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
      (scope: any) => {
        const items = (scope.items as string[]) ?? [];
        items.push(`item-${items.length}`);
        scope.items = items;

        if (items.length >= 4) {
          scope.$break();
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
