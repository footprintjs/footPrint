/**
 * Unit tests for the default scopeFactory behavior.
 *
 * Verifies that FlowChartExecutor creates a working scope
 * when no scopeFactory is provided. Since flowChart() now auto-embeds
 * TypedScope, tests use typed property access instead of setValue/getValue.
 */

import { flowChart } from '../../../../src/lib/builder';
import { FlowChartExecutor } from '../../../../src/lib/runner';

describe('FlowChartExecutor — default scopeFactory (unit)', () => {
  it('executes without scopeFactory argument', async () => {
    const chart = flowChart('A', () => 'done', 'a').build();
    const executor = new FlowChartExecutor(chart);
    const result = await executor.run();
    expect(result).toBe('done');
  });

  it('provides usable scope instances to stage functions', async () => {
    let scopeWorks = false;
    const chart = flowChart(
      'check',
      (scope: any) => {
        scope.test = 42;
        scopeWorks = scope.test === 42;
      },
      'check',
    ).build();

    await new FlowChartExecutor(chart).run();

    expect(scopeWorks).toBe(true);
  });

  it('typed property access works with the default factory', async () => {
    const chart = flowChart(
      'write',
      (scope: any) => {
        scope.x = 42;
      },
      'write',
    )
      .addFunction(
        'read',
        (scope: any) => {
          return scope.x;
        },
        'read',
      )
      .build();

    const result = await new FlowChartExecutor(chart).run();
    expect(result).toBe(42);
  });

  it('handles explicit undefined as scopeFactory (falls back to default)', async () => {
    const chart = flowChart(
      'A',
      (scope: any) => {
        scope.key = 'value';
      },
      'a',
    )
      .addFunction(
        'B',
        (scope: any) => {
          return scope.key;
        },
        'b',
      )
      .build();

    const executor = new FlowChartExecutor(chart, undefined);
    const result = await executor.run();
    expect(result).toBe('value');
  });

  it('explicit undefined scopeFactory still allows positional params after it', async () => {
    const tokens: string[] = [];
    const chart = flowChart('entry', () => {}, 'entry')
      .addStreamingFunction(
        'stream',
        async (_s: any, _b: any, emit: any) => {
          emit('tok');
        },
        'stream',
        'test',
      )
      .build();

    const executor = new FlowChartExecutor(
      chart,
      undefined, // scopeFactory — default
      undefined, // defaultValuesForContext
      undefined, // initialContext
      undefined, // readOnlyContext
      undefined, // throttlingErrorChecker
      { onToken: (_id, t) => tokens.push(t) }, // streamHandlers
    );
    await executor.run();

    expect(tokens).toEqual(['tok']);
  });
});
