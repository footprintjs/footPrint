/**
 * RFC-001 Blocks 6–7 — INTEGRATION tests: deferred observers cooperating
 * with the full engine (combined recorders across all three channels,
 * subflows, deciders, multi-listener fan-out, run-reset, pause/resume).
 */
import { describe, expect, it } from 'vitest';

import type { PausableHandler, WriteEvent } from '../../../../src/index';
import { flowChart, FlowChartExecutor } from '../../../../src/index';

type Loose = Record<string, unknown>;

describe('Blocks 6–7 — engine integration', () => {
  it('a deferred CombinedRecorder receives scope + flow + emit events through one registration', async () => {
    const chart = flowChart<Loose>(
      'Seed',
      async (scope) => {
        scope.$setValue('score', 700);
        scope.$emit('app.scored', { score: 700 });
      },
      'seed',
    )
      .addDeciderFunction('Route', async (scope) => ((scope.$getValue('score') as number) > 600 ? 'hi' : 'lo'), 'route')
      .addFunctionBranch('hi', 'High', async (scope: { $setValue(k: string, v: unknown): void }) => {
        scope.$setValue('tier', 'high');
      })
      .addFunctionBranch('lo', 'Low', async (scope: { $setValue(k: string, v: unknown): void }) => {
        scope.$setValue('tier', 'low');
      })
      .setDefault('lo')
      .end()
      .build();

    const seen = { writes: [] as string[], decisions: [] as string[], emits: [] as string[] };
    const executor = new FlowChartExecutor(chart);
    executor.attachCombinedRecorder(
      {
        id: 'tri-channel',
        onWrite: (e) => seen.writes.push((e as WriteEvent).key),
        onDecision: (e) => seen.decisions.push(e.chosen),
        onEmit: (e) => seen.emits.push(e.name),
      },
      { delivery: 'deferred', capture: 'clone' },
    );
    await executor.run();

    expect(seen.writes).toContain('score');
    expect(seen.writes).toContain('tier');
    expect(seen.decisions).toEqual(['High']); // onDecision carries the chosen branch NAME
    expect(seen.emits).toContain('app.scored');
  });

  it('subflow boundaries reach deferred flow recorders (entry + exit)', async () => {
    const inner = flowChart<Loose>(
      'InnerWork',
      async (scope) => {
        scope.$setValue('innerDone', true);
      },
      'inner-work',
    ).build();
    const chart = flowChart<Loose>(
      'Outer',
      async (scope) => {
        scope.$setValue('outer', 1);
      },
      'outer',
    )
      .addSubFlowChartNext('sf-inner', inner, 'Inner', {
        inputMapper: () => ({}),
        outputMapper: (out: Loose) => ({ innerDone: out.innerDone }),
      })
      .build();

    const boundaries: string[] = [];
    const executor = new FlowChartExecutor(chart);
    executor.attachFlowRecorder(
      {
        id: 'sf-watch',
        onSubflowEntry: (e) => boundaries.push(`entry:${e.subflowId}`),
        onSubflowExit: (e) => boundaries.push(`exit:${e.subflowId}`),
      },
      { delivery: 'deferred', capture: 'clone' },
    );
    await executor.run();
    expect(boundaries).toEqual(['entry:sf-inner', 'exit:sf-inner']);
  });

  it('multiple deferred listeners each receive the full stream; per-listener stats track both ids', async () => {
    const chart = flowChart<Loose>(
      'Seed',
      async (scope) => {
        scope.$setValue('a', 1);
        scope.$setValue('b', 2);
      },
      'seed',
    ).build();
    const first: string[] = [];
    const second: string[] = [];
    const executor = new FlowChartExecutor(chart);
    executor.attachScopeRecorder(
      { id: 'first', onWrite: (e) => first.push(e.key) },
      { delivery: 'deferred', capture: 'clone' },
    );
    executor.attachScopeRecorder(
      { id: 'second', onWrite: (e) => second.push(e.key) },
      { delivery: 'deferred', capture: 'clone' },
    );
    await executor.run();
    expect(first).toEqual(['a', 'b']);
    expect(second).toEqual(['a', 'b']);
    const stats = executor.getSnapshot().observerStats!;
    expect(stats.perListener.first.events).toBeGreaterThan(0);
    expect(stats.perListener.second.events).toBeGreaterThan(0);
  });

  it('a throwing deferred listener never affects siblings or the run; the error routes to sibling onError', async () => {
    const chart = flowChart<Loose>(
      'Seed',
      async (scope) => {
        scope.$setValue('k', 1);
      },
      'seed',
    ).build();
    const healthy: string[] = [];
    const routedErrors: Array<{ operation: string }> = [];
    const executor = new FlowChartExecutor(chart);
    executor.attachScopeRecorder(
      {
        id: 'broken',
        onWrite: () => {
          throw new Error('listener boom');
        },
      },
      // Same capture policy as the sibling — the dispatcher config is
      // first-attach-wins, and this attach happens first.
      { delivery: 'deferred', capture: 'clone' },
    );
    executor.attachScopeRecorder(
      {
        id: 'healthy',
        onWrite: (e) => healthy.push(e.key),
        onError: (e) => routedErrors.push({ operation: e.operation }),
      },
      { delivery: 'deferred', capture: 'clone' },
    );
    await executor.run(); // resolving at all proves the producer was unaffected
    expect(healthy).toEqual(['k']);
    expect(routedErrors.length).toBeGreaterThan(0);
    expect(routedErrors[0].operation).toBe('write');
  });

  it('clear() fires on deferred recorders at each fresh run (no cross-run accumulation)', async () => {
    const chart = flowChart<Loose>(
      'Seed',
      async (scope) => {
        scope.$setValue('k', 1);
      },
      'seed',
    ).build();
    let cleared = 0;
    const keys: string[] = [];
    const executor = new FlowChartExecutor(chart);
    executor.attachScopeRecorder(
      { id: 'resettable', onWrite: (e) => keys.push(e.key), clear: () => (cleared += 1) },
      { delivery: 'deferred', capture: 'clone' },
    );
    await executor.run();
    await executor.run();
    expect(cleared).toBe(2);
    expect(keys).toEqual(['k', 'k']); // both runs delivered
  });

  it('pause/resume: synthetic onResume reaches deferred recorders on both channels', async () => {
    const handler: PausableHandler<Loose> = {
      execute: async () => ({ question: 'ok?' }),
      resume: async (scope, input) => {
        (scope as Loose & { $setValue(k: string, v: unknown): void }).$setValue('answer', (input as Loose).approved);
      },
    };
    const chart = flowChart<Loose>(
      'Seed',
      async (scope) => {
        scope.$setValue('k', 'pre');
      },
      'seed',
    )
      .addPausableFunction('Approve', handler, 'approve')
      .addFunction(
        'Finish',
        async (scope) => {
          scope.$setValue('done', true);
        },
        'finish',
      )
      .build();

    const resumes: string[] = [];
    const writes: string[] = [];
    const executor = new FlowChartExecutor(chart);
    executor.attachCombinedRecorder(
      {
        id: 'resume-watch',
        onResume: (e) => resumes.push((e as { channel?: string }).channel ?? 'unknown'),
        onWrite: (e) => writes.push((e as WriteEvent).key),
      },
      { delivery: 'deferred', capture: 'clone' },
    );
    await executor.run();
    expect(executor.isPaused()).toBe(true);
    await executor.resume(executor.getCheckpoint()!, { approved: true });
    expect(resumes).toContain('flow');
    expect(resumes).toContain('scope');
    expect(writes).toContain('answer');
    expect(writes).toContain('done');
  });

  it('getSnapshot() collects toSnapshot() from deferred recorders exactly once', async () => {
    const chart = flowChart<Loose>(
      'Seed',
      async (scope) => {
        scope.$setValue('k', 1);
      },
      'seed',
    ).build();
    let count = 0;
    const executor = new FlowChartExecutor(chart);
    executor.attachCombinedRecorder(
      {
        id: 'snapper',
        onWrite: () => (count += 1),
        onStageExecuted: () => undefined, // registers on BOTH lists
        toSnapshot: () => ({ name: 'snapper', data: { count } }),
      },
      { delivery: 'deferred', capture: 'clone' },
    );
    await executor.run();
    const recorders = executor.getSnapshot().recorders ?? [];
    expect(recorders.filter((r) => r.id === 'snapper').length).toBe(1);
    expect((recorders.find((r) => r.id === 'snapper')?.data as { count: number }).count).toBeGreaterThan(0);
  });
});
