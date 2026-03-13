import type { ScopeFactory } from '../../../../src';
import { flowChart, FlowChartExecutor, ScopeFacade } from '../../../../src';

describe('Scenario: runtime input flow via run({ input })', () => {
  const scopeFactory: ScopeFactory = (ctx, stageName, readOnly) => new ScopeFacade(ctx, stageName, readOnly);

  it('input passed to run() is accessible via scope.getArgs()', async () => {
    let capturedArgs: any = null;

    const chart = flowChart(
      'entry',
      async (scope: ScopeFacade) => {
        capturedArgs = scope.getArgs<{ name: string; amount: number }>();
        scope.setValue('result', `processed ${capturedArgs.name}`);
      },
      'entry',
    ).build();

    const executor = new FlowChartExecutor(chart, scopeFactory);
    await executor.run({ input: { name: 'Alice', amount: 5000 } });

    expect(capturedArgs).toEqual({ name: 'Alice', amount: 5000 });
  });

  it('input keys are protected from setValue overwrites', async () => {
    let error: Error | null = null;

    const chart = flowChart(
      'entry',
      async (scope: ScopeFacade) => {
        try {
          scope.setValue('name', 'hacked');
        } catch (e) {
          error = e as Error;
        }
      },
      'entry',
    ).build();

    const executor = new FlowChartExecutor(chart, scopeFactory);
    await executor.run({ input: { name: 'Alice' } });

    expect(error).not.toBeNull();
    expect(error!.message).toContain('readonly input key "name"');
  });

  it('stages can write to non-input keys alongside readonly input', async () => {
    const chart = flowChart(
      'entry',
      async (scope: ScopeFacade) => {
        const { name } = scope.getArgs<{ name: string }>();
        scope.setValue('greeting', `Hello, ${name}`);
      },
      'entry',
    ).build();

    const executor = new FlowChartExecutor(chart, scopeFactory);
    await executor.run({ input: { name: 'Alice' } });

    const snapshot = executor.getSnapshot();
    expect(snapshot.sharedState.greeting).toBe('Hello, Alice');
  });

  it('multi-stage pipeline shares input across all stages', async () => {
    const capturedByStage: Record<string, any> = {};

    const chart = flowChart(
      'stage1',
      async (scope: ScopeFacade) => {
        capturedByStage.stage1 = scope.getArgs<any>();
        scope.setValue('step1Done', true);
      },
      'stage1',
    )
      .addFunction(
        'stage2',
        async (scope: ScopeFacade) => {
          capturedByStage.stage2 = scope.getArgs<any>();
          scope.setValue('step2Done', true);
        },
        'stage2',
      )
      .build();

    const executor = new FlowChartExecutor(chart, scopeFactory);
    await executor.run({ input: { tenant: 'acme', requestId: 'req-123' } });

    expect(capturedByStage.stage1).toEqual({ tenant: 'acme', requestId: 'req-123' });
    expect(capturedByStage.stage2).toEqual({ tenant: 'acme', requestId: 'req-123' });
  });

  it('run without input works normally (backward compatible)', async () => {
    const chart = flowChart(
      'entry',
      async (scope: ScopeFacade) => {
        scope.setValue('result', 'done');
      },
      'entry',
    ).build();

    const executor = new FlowChartExecutor(chart, scopeFactory);
    await executor.run();

    const snapshot = executor.getSnapshot();
    expect(snapshot.sharedState.result).toBe('done');
  });

  it('input overrides constructor readOnlyContext', async () => {
    let capturedArgs: any = null;

    const chart = flowChart(
      'entry',
      async (scope: ScopeFacade) => {
        capturedArgs = scope.getArgs<any>();
      },
      'entry',
    ).build();

    // Constructor has readOnlyContext as 5th param
    const executor = new FlowChartExecutor(chart, scopeFactory, undefined, undefined, {
      original: 'constructor-value',
    });

    // run() input overrides constructor readOnlyContext
    await executor.run({ input: { overridden: 'run-value' } });

    expect(capturedArgs).toEqual({ overridden: 'run-value' });
  });

  it('re-run without input reverts to constructor readOnlyContext', async () => {
    let capturedArgs: any = null;

    const chart = flowChart(
      'entry',
      async (scope: ScopeFacade) => {
        capturedArgs = scope.getArgs<any>();
      },
      'entry',
    ).build();

    const executor = new FlowChartExecutor(chart, scopeFactory, undefined, undefined, { original: 'from-constructor' });

    // First run with input override
    await executor.run({ input: { temp: 'override' } });
    expect(capturedArgs).toEqual({ temp: 'override' });

    // Second run without input — should revert to constructor readOnlyContext
    await executor.run();
    expect(capturedArgs).toEqual({ original: 'from-constructor' });
  });
});
