import { z } from 'zod';

import type { ScopeFactory } from '../../../../src';
import { flowChart, FlowChartExecutor, ScopeFacade } from '../../../../src';

describe('Scenario: runtime input validation via inputSchema', () => {
  const scopeFactory: ScopeFactory = (ctx, stageName, readOnly) => new ScopeFacade(ctx, stageName, readOnly);

  it('valid input passes schema validation and is accessible via getArgs()', async () => {
    let capturedArgs: any = null;

    const chart = flowChart(
      'entry',
      async (scope: ScopeFacade) => {
        capturedArgs = scope.getArgs<{ name: string; amount: number }>();
        scope.setValue('result', 'ok');
      },
      'entry',
    )
      .contract({ input: z.object({ name: z.string(), amount: z.number() }) })
      .build();

    const executor = new FlowChartExecutor(chart, scopeFactory);
    await executor.run({ input: { name: 'Alice', amount: 5000 } });

    expect(capturedArgs).toEqual({ name: 'Alice', amount: 5000 });
  });

  it('invalid input throws before pipeline execution starts', async () => {
    let stageExecuted = false;

    const chart = flowChart(
      'entry',
      async (scope: ScopeFacade) => {
        stageExecuted = true;
      },
      'entry',
    )
      .contract({ input: z.object({ name: z.string(), amount: z.number() }) })
      .build();

    const executor = new FlowChartExecutor(chart, scopeFactory);

    await expect(executor.run({ input: { name: 'Alice', amount: 'not-a-number' } as any })).rejects.toThrow(
      'Input validation failed',
    );

    expect(stageExecuted).toBe(false);
  });

  it('transformed input is passed to scope after validation', async () => {
    let capturedArgs: any = null;

    const chart = flowChart(
      'entry',
      async (scope: ScopeFacade) => {
        capturedArgs = scope.getArgs();
      },
      'entry',
    )
      .contract({ input: z.object({ name: z.string().transform((s) => s.toUpperCase()) }) })
      .build();

    const executor = new FlowChartExecutor(chart, scopeFactory);
    await executor.run({ input: { name: 'alice' } });

    expect(capturedArgs).toEqual({ name: 'ALICE' });
  });

  it('no inputSchema — input passes through without validation', async () => {
    let capturedArgs: any = null;

    const chart = flowChart(
      'entry',
      async (scope: ScopeFacade) => {
        capturedArgs = scope.getArgs();
      },
      'entry',
    ).build();

    const executor = new FlowChartExecutor(chart, scopeFactory);
    await executor.run({ input: { anything: 'goes' } });

    expect(capturedArgs).toEqual({ anything: 'goes' });
  });

  it('no input — skips validation even with inputSchema', async () => {
    const chart = flowChart(
      'entry',
      async (scope: ScopeFacade) => {
        scope.setValue('result', 'done');
      },
      'entry',
    )
      .contract({ input: z.object({ name: z.string() }) })
      .build();

    const executor = new FlowChartExecutor(chart, scopeFactory);
    // No input provided — should not throw
    await executor.run();

    expect(executor.getSnapshot().sharedState.result).toBe('done');
  });

  it('extra fields are stripped when using Zod strict()', async () => {
    let capturedArgs: any = null;

    const chart = flowChart(
      'entry',
      async (scope: ScopeFacade) => {
        capturedArgs = scope.getArgs();
      },
      'entry',
    )
      .contract({ input: z.object({ name: z.string() }).strict() })
      .build();

    const executor = new FlowChartExecutor(chart, scopeFactory);

    await expect(executor.run({ input: { name: 'Alice', extra: 'field' } as any })).rejects.toThrow(
      'Input validation failed',
    );
  });
});
