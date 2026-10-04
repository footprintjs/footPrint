import { describe, expect, it, vi } from 'vitest';

import { registerScopeRuntime } from '../../../../src/advanced';
import type { DecisionResult, SelectionResult } from '../../../../src/index';
import { decide, flowChart, FlowChartExecutor, select } from '../../../../src/index';
import { ScopeFacade } from '../../../../src/lib/scope/ScopeFacade';

function strictFactory(probes: (string | symbol)[], handlesAssignments = true) {
  return (ctx: any, name: string, input?: unknown, env?: any) => {
    const facade = new ScopeFacade(ctx, name, input, env);
    const proxy = new Proxy(
      {},
      {
        get(_target, key) {
          probes.push(key);
          if (key === 'amount') return facade.getValue('amount');
          throw new Error(`Unexpected user-scope probe: ${String(key)}`);
        },
        set(_target, key, value) {
          if (key !== 'amount') throw new Error('Unknown writable field');
          facade.setValue('amount', value);
          return true;
        },
      },
    );
    return registerScopeRuntime(proxy, { target: facade, handlesAssignments });
  };
}

describe('scope runtime protocol: strict proxies never receive engine probes', () => {
  it('exports an explicit registration door returning the same scope', () => {
    expect(registerScopeRuntime).toBeTypeOf('function');
    const scope = {};
    expect(registerScopeRuntime(scope, { target: {}, handlesAssignments: false })).toBe(scope);
  });

  it('runs and records through the separate port, without reading any control property on the user proxy', async () => {
    const probes: (string | symbol)[] = [];
    const events: string[] = [];
    const chart = flowChart(
      'Write',
      (s: any) => {
        s.amount = 21;
      },
      'write',
    )
      .addFunction('Read', (s: any) => s.amount * 2, 'read')
      .build();
    const executor = new FlowChartExecutor(chart, { scopeFactory: strictFactory(probes) });
    executor.attachScopeRecorder({
      id: 'runtime-port',
      onStageStart: (e) => events.push(`start:${e.stageName}`),
      onWrite: (e) => events.push(`write:${e.key}`),
      onRead: (e) => events.push(`read:${e.key}`),
      onCommit: (e) => events.push(`commit:${e.stageName}`),
    });
    expect(await executor.run()).toBe(42);
    expect(probes).toEqual(['amount']);
    expect(events).toEqual(['start:Write', 'write:amount', 'commit:Write', 'start:Read', 'read:amount', 'commit:Read']);
  });

  it('decision evidence resolves the registered port through the protection wrapper', async () => {
    const probes: (string | symbol)[] = [];
    const chart = flowChart(
      'Decide',
      (s: any) => decide(s, [{ when: () => true, then: 'yes', label: 'yes' }], 'no').branch,
      'decide',
    ).build();
    const executor = new FlowChartExecutor(chart, { scopeFactory: strictFactory(probes, false) });
    expect(await executor.run()).toBe('yes');
    expect(probes).toEqual([]);
  });

  it.each(['decide', 'select'] as const)(
    '%s collects function-rule evidence on a real facade with default protection',
    async (helper) => {
      const rules = [{ when: (scope: ScopeFacade) => (scope.getValue('score') as number) > 700, then: 'approved' }];
      const chart = flowChart<DecisionResult | SelectionResult, ScopeFacade>(
        'Seed',
        (scope: ScopeFacade) => {
          scope.setValue('score', 750);
        },
        'seed',
      )
        .addFunction(
          'Choose',
          (scope: ScopeFacade) => {
            const result = helper === 'decide' ? decide(scope, rules, 'rejected') : select(scope, rules);
            // Removing the temporary collector must leave the attached observer intact.
            expect(scope.getScopeRecorders()).toHaveLength(1);
            return result;
          },
          'choose',
        )
        .build();
      const executor = new FlowChartExecutor(chart, {
        scopeFactory: (ctx, name, input, env) => new ScopeFacade(ctx, name, input, env),
      });
      const reads: (string | undefined)[] = [];
      executor.attachScopeRecorder({ id: 'durable-observer', onRead: (event) => reads.push(event.key) });
      const result = (await executor.run()) as unknown as DecisionResult | SelectionResult;
      expect(result).toMatchObject(helper === 'decide' ? { branch: 'approved' } : { branches: ['approved'] });
      expect(result.evidence.rules).toEqual([
        {
          type: 'function',
          ruleIndex: 0,
          branch: 'approved',
          matched: true,
          inputs: [{ key: 'score', valueSummary: '750', redacted: false }],
        },
      ]);
      expect(reads).toEqual(['score']);
    },
  );

  it('dynamic fan-out lifecycle and result writes use the same runtime port', async () => {
    const probes: (string | symbol)[] = [];
    const chart = flowChart<unknown, object>('Seed', () => undefined, 'seed')
      .addParallelForEach('Each', 'each', {
        items: () => [2, 4],
        maxBranches: 2,
        into: 'results',
        branch: (n: number) =>
          flowChart(
            'Child',
            (s: any) => {
              s.amount = n * 3;
            },
            'child',
          ).build(),
      })
      .build();
    const executor = new FlowChartExecutor(chart, { scopeFactory: strictFactory(probes) });
    await executor.run();
    expect(executor.getSnapshot().sharedState.results).toEqual([
      { item: 2, index: 0, amount: 6 },
      { item: 4, index: 1, amount: 12 },
    ]);
    expect(probes).toEqual([]);
  });

  it('rejects an unregistered custom factory instead of silently dropping its hooks', async () => {
    const run = vi.fn();
    const chart = flowChart('Custom', run, 'custom').build();
    const executor = new FlowChartExecutor(chart, { scopeFactory: () => ({ notifyStageStart: vi.fn() }) });
    await expect(executor.run()).rejects.toThrow(/registerScopeRuntime/);
    expect(run).not.toHaveBeenCalled();
  });
});
