import type { ExecutionEnv } from '../../../../src';
import { flowChart, FlowChartExecutor, ScopeFacade } from '../../../../src';

describe('ExecutionEnv propagation', () => {
  it('stages can read env via scope.getEnv()', async () => {
    let capturedEnv: ExecutionEnv | undefined;

    const chart = flowChart(
      'ReadEnv',
      (scope: ScopeFacade) => {
        capturedEnv = scope.getEnv();
      },
      'read-env',
    ).build();

    const executor = new FlowChartExecutor(chart);
    await executor.run({
      input: { message: 'hello' },
      env: { traceId: 'trace-abc', timeoutMs: 5000 },
    });

    expect(capturedEnv).toBeDefined();
    expect(capturedEnv!.traceId).toBe('trace-abc');
    expect(capturedEnv!.timeoutMs).toBe(5000);
  });

  it('env persists across multiple stages', async () => {
    const captured: ExecutionEnv[] = [];

    const chart = flowChart(
      'Stage1',
      (scope: ScopeFacade) => {
        captured.push(scope.getEnv());
      },
      'stage-1',
    )
      .addFunction(
        'Stage2',
        (scope: ScopeFacade) => {
          captured.push(scope.getEnv());
        },
        'stage-2',
      )
      .addFunction(
        'Stage3',
        (scope: ScopeFacade) => {
          captured.push(scope.getEnv());
        },
        'stage-3',
      )
      .build();

    const executor = new FlowChartExecutor(chart);
    await executor.run({ env: { traceId: 'multi-stage' } });

    expect(captured).toHaveLength(3);
    for (const env of captured) {
      expect(env.traceId).toBe('multi-stage');
    }
  });

  it('env is empty when not provided', async () => {
    let capturedEnv: ExecutionEnv | undefined;

    const chart = flowChart(
      'NoEnv',
      (scope: ScopeFacade) => {
        capturedEnv = scope.getEnv();
      },
      'no-env',
    ).build();

    const executor = new FlowChartExecutor(chart);
    await executor.run();

    expect(capturedEnv).toBeDefined();
    expect(capturedEnv!.traceId).toBeUndefined();
    expect(capturedEnv!.signal).toBeUndefined();
    expect(capturedEnv!.timeoutMs).toBeUndefined();
  });

  it('env is frozen — stages cannot mutate it', async () => {
    let mutationThrew = false;

    const chart = flowChart(
      'MutateEnv',
      (scope: ScopeFacade) => {
        const env = scope.getEnv();
        try {
          (env as any).traceId = 'hacked';
        } catch {
          mutationThrew = true;
        }
      },
      'mutate-env',
    ).build();

    const executor = new FlowChartExecutor(chart);
    await executor.run({ env: { traceId: 'original' } });

    expect(mutationThrew).toBe(true);
  });

  it('env propagates to subflows', async () => {
    let subflowEnv: ExecutionEnv | undefined;

    const subChart = flowChart(
      'SubStage',
      (scope: ScopeFacade) => {
        subflowEnv = scope.getEnv();
      },
      'sub-stage',
    ).build();

    const chart = flowChart(
      'Parent',
      (scope: ScopeFacade) => {
        // parent stage — env should be available here too
      },
      'parent',
    )
      .addSubFlowChart('ChildFlow', subChart, 'child-flow')
      .build();

    const executor = new FlowChartExecutor(chart);
    await executor.run({ env: { traceId: 'parent-trace', timeoutMs: 10000 } });

    expect(subflowEnv).toBeDefined();
    expect(subflowEnv!.traceId).toBe('parent-trace');
    expect(subflowEnv!.timeoutMs).toBe(10000);
  });

  it('env is independent from args', async () => {
    let capturedArgs: any;
    let capturedEnv: ExecutionEnv | undefined;

    const chart = flowChart(
      'Both',
      (scope: ScopeFacade) => {
        capturedArgs = scope.getArgs();
        capturedEnv = scope.getEnv();
      },
      'both',
    ).build();

    const executor = new FlowChartExecutor(chart);
    await executor.run({
      input: { userId: 42, query: 'test' },
      env: { traceId: 'req-789' },
    });

    // Args has business data
    expect(capturedArgs.userId).toBe(42);
    expect(capturedArgs.query).toBe('test');
    expect(capturedArgs.traceId).toBeUndefined();

    // Env has infrastructure data
    expect(capturedEnv!.traceId).toBe('req-789');
    expect((capturedEnv as any).userId).toBeUndefined();
  });
});
