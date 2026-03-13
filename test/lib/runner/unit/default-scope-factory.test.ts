/**
 * Unit tests for the default scopeFactory behavior.
 *
 * Verifies that FlowChartExecutor creates a working ScopeFacade
 * when no scopeFactory is provided.
 */

import { flowChart } from '../../../../src/lib/builder';
import { FlowChartExecutor } from '../../../../src/lib/runner';
import { ScopeFacade } from '../../../../src/lib/scope';

describe('FlowChartExecutor — default scopeFactory (unit)', () => {
  it('executes without scopeFactory argument', async () => {
    const chart = flowChart('A', () => 'done', 'a').build();
    const executor = new FlowChartExecutor(chart);
    const result = await executor.run();
    expect(result).toBe('done');
  });

  it('provides ScopeFacade instances to stage functions', async () => {
    let receivedScope: unknown;
    const chart = flowChart(
      'check',
      (scope: ScopeFacade) => {
        receivedScope = scope;
      },
      'check',
    ).build();

    await new FlowChartExecutor(chart).run();

    expect(receivedScope).toBeInstanceOf(ScopeFacade);
  });

  it('setValue / getValue work with the default factory', async () => {
    const chart = flowChart(
      'write',
      (scope: ScopeFacade) => {
        scope.setValue('x', 42);
      },
      'write',
    )
      .addFunction(
        'read',
        (scope: ScopeFacade) => {
          return scope.getValue('x');
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
      (scope: ScopeFacade) => {
        scope.setValue('key', 'value');
      },
      'a',
    )
      .addFunction(
        'B',
        (scope: ScopeFacade) => {
          return scope.getValue('key');
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
