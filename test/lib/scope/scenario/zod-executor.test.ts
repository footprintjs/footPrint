import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { registerScopeResolver, toScopeFactory } from '../../../../src/advanced.js';
import { flowChart, FlowChartExecutor, interrupt } from '../../../../src/index.js';
import { __clearScopeResolversForTests } from '../../../../src/lib/scope/providers/registry.js';
import { defineScopeFromZod, defineScopeSchema, ZodScopeResolver } from '../../../../src/zod.js';

type FactoryKind = 'direct' | 'resolver';

function factory(kind: FactoryKind, shape: z.ZodRawShape) {
  if (kind === 'direct') return defineScopeFromZod(z.object(shape), { strict: 'deny' });
  registerScopeResolver(ZodScopeResolver);
  try {
    return toScopeFactory<any>(defineScopeSchema(shape), { zod: { strict: 'deny' } });
  } finally {
    __clearScopeResolversForTests();
  }
}

describe.each(['direct', 'resolver'] as const)('Zod executor: %s factory', (kind) => {
  it.each(['inline', 'deferred'] as const)(
    'preserves data, lifecycle and emit recording with %s delivery',
    async (delivery) => {
      const order: string[] = [];
      const emits: Array<{ id: string; payload: unknown }> = [];
      const observerErrors: string[] = [];
      const chart = flowChart<any>(
        'Seed',
        (scope) => {
          expect(scope.getArgs()).toEqual({ inputOnly: 3 });
          expect(scope.getEnv().traceId).toBe('zod-trace');
          scope.count.set(2);
        },
        'seed',
      )
        .addFunction(
          'Read',
          (scope) => {
            scope.total.set(scope.count.get() + 1);
            scope.emitEvent('calculated', { total: 3 });
          },
          'read',
        )
        .build();
      const executor = new FlowChartExecutor(chart, {
        scopeFactory: factory(kind, { count: z.number(), total: z.number() }),
      });
      executor.attachScopeRecorder(
        {
          id: 'throwing-observer',
          onWrite: () => {
            throw new Error('observer failure');
          },
        },
        { delivery },
      );
      executor.attachCombinedRecorder(
        {
          id: 'events',
          onStageStart: (event) => {
            order.push(`start:${event.stageId}`);
          },
          onStageEnd: (event) => {
            order.push(`end:${event.stageId}`);
          },
          onRead: (event) => {
            order.push(`read:${event.stageId}:${event.key}:${event.value}`);
          },
          onWrite: (event) => {
            order.push(`write:${event.stageId}:${event.key}:${event.value}`);
          },
          onCommit: (event) => {
            order.push(`commit:${event.stageId}`);
          },
          onEmit: (event) => {
            emits.push({ id: event.runtimeStageId, payload: event.payload });
            order.push(`emit:${event.name}`);
          },
          onError: (event) => {
            if (Object.prototype.hasOwnProperty.call(event, 'error')) {
              observerErrors.push((event as { error: { message: string } }).error.message);
            }
          },
        },
        { delivery },
      );

      await executor.run({ input: { inputOnly: 3 }, env: { traceId: 'zod-trace' } });

      expect(executor.getSnapshot().sharedState).toMatchObject({ count: 2, total: 3 });
      expect(emits).toEqual([{ id: expect.stringMatching(/^read#/), payload: { total: 3 } }]);
      expect(observerErrors).toEqual(['observer failure', 'observer failure']);
      expect(order).toEqual([
        'start:seed',
        'write:seed:count:2',
        'end:seed',
        'commit:seed',
        'start:read',
        'read:read:count:2',
        'write:read:total:3',
        'emit:calculated',
        'end:read',
        'commit:read',
      ]);
      expect(executor.getSnapshot().commitLog.find((entry) => entry.stageId === 'seed')?.untrackedSources).toEqual(
        expect.arrayContaining(['args', 'env']),
      );
    },
  );
});

describe('Zod executor integration boundaries', () => {
  it('keeps nested paths, literal dotted fields and empty keys distinct', async () => {
    const shape = {
      'a.b': z.number(),
      '': z.number(),
      a: z.object({ b: z.number() }),
      records: z.record(z.string(), z.number()),
    };
    const seen: unknown[] = [];
    const chart = flowChart<any>(
      'Write',
      (scope) => {
        scope['a.b'].set(1);
        scope[''].set(2);
        scope.a.b.set(3);
        scope.records.at('x.y').set(4);
        scope.records.at('').set(5);
      },
      'write',
    )
      .addFunction(
        'Read',
        (scope) => {
          seen.push(scope['a.b'].get(), scope[''].get(), scope.a.b.get(), scope.records.get());
        },
        'read',
      )
      .build();
    const executor = new FlowChartExecutor(chart, { scopeFactory: factory('direct', shape) });
    await executor.run();
    expect(seen).toEqual([1, 2, 3, { 'x.y': 4, '': 5 }]);
    expect(executor.getSnapshot().sharedState).toMatchObject({
      'a.b': 1,
      '': 2,
      a: { b: 3 },
      records: { 'x.y': 4, '': 5 },
    });
  });

  it('keeps lifecycle-named fields usable without impersonating engine methods', async () => {
    const keys = [
      'useSharedRedactedKeys',
      'useRedactionPolicy',
      'attachScopeRecorder',
      'notifyStageStart',
      'notifyStageEnd',
      'notifyPause',
      'notifyResume',
    ];
    const visited: string[] = [];
    const starts: string[] = [];
    const chart = flowChart<any>(
      'Write',
      (scope) => {
        for (const key of keys) scope[key].set(key);
      },
      'write',
    )
      .addFunction(
        'Read and stop',
        (scope, stop) => {
          for (const key of keys) expect(scope[key].get()).toBe(key);
          visited.push('read');
          stop();
        },
        'read',
      )
      .addFunction(
        'Never',
        () => {
          visited.push('never');
        },
        'never',
      )
      .build();
    const executor = new FlowChartExecutor(chart, {
      scopeFactory: factory('direct', Object.fromEntries(keys.map((key) => [key, z.string()]))),
    });
    executor.attachScopeRecorder({
      id: 'lifecycle',
      onStageStart: (event) => {
        starts.push(event.stageId);
      },
    });
    await executor.run();
    expect(starts).toEqual(['write', 'read']);
    expect(visited).toEqual(['read']);
  });

  it('retries with fresh scope behavior and commits only the successful attempt', async () => {
    let attempts = 0;
    const runtimeIds: string[] = [];
    const committed: unknown[] = [];
    const chart = flowChart<any>(
      'Retry',
      (scope) => {
        attempts++;
        expect(scope.count.get()).toBeUndefined();
        scope.count.set(attempts === 1 ? 10 : 2);
        if (attempts === 1) throw new Error('transient');
      },
      'retry',
    )
      .retry({ attempts: 2, backoffMs: 0 })
      .build();
    const executor = new FlowChartExecutor(chart, { scopeFactory: factory('direct', { count: z.number() }) });
    executor.attachScopeRecorder({
      id: 'retry-recording',
      onStageStart: (event) => {
        runtimeIds.push(event.runtimeStageId);
      },
      onCommit: (event) => {
        committed.push(event.mutations);
      },
    });
    await executor.run();
    expect(attempts).toBe(2);
    expect(runtimeIds).toHaveLength(2);
    expect(new Set(runtimeIds).size).toBe(1);
    expect(committed).toEqual([[{ key: 'count', value: 2, operation: 'set' }]]);
    expect(executor.getSnapshot().sharedState.count).toBe(2);
  });

  it.each(['pausable', 'interrupt'] as const)(
    'preserves %s checkpoints and resumes on a fresh executor',
    async (mode) => {
      const shape = { value: z.number(), approved: z.boolean(), done: z.boolean() };
      let builder = flowChart<any>(
        'Seed',
        (scope) => {
          scope.value.set(7);
        },
        'seed',
      );
      if (mode === 'pausable') {
        builder = builder.addPausableFunction(
          'Approve',
          {
            execute: () => ({ question: 'Approve?' }),
            resume: (scope, input) => {
              scope.approved.set((input as { approved: boolean }).approved);
            },
          },
          'approve',
        );
      } else {
        builder = builder.addFunction(
          'Approve',
          (scope) => {
            const answer = interrupt<{ approved: boolean }>(scope, { reason: 'Approve?' });
            scope.approved.set(answer.approved);
          },
          'approve',
        );
      }
      const chart = builder
        .addFunction(
          'Done',
          (scope) => {
            expect(scope.value.get()).toBe(7);
            expect(scope.approved.get()).toBe(true);
            scope.done.set(true);
          },
          'done',
        )
        .build();
      const paused: string[] = [];
      const original = new FlowChartExecutor(chart, { scopeFactory: factory('direct', shape) });
      original.attachScopeRecorder({
        id: 'pause',
        onPause: (event) => {
          paused.push(event.stageId);
        },
      });
      await original.run();
      expect(paused).toEqual(['approve']);
      const checkpoint = JSON.parse(JSON.stringify(original.getCheckpoint()));
      expect(checkpoint.sharedState.value).toBe(7);
      const resumed: string[] = [];
      const fresh = new FlowChartExecutor(chart, { scopeFactory: factory('resolver', shape) });
      fresh.attachScopeRecorder({
        id: 'resume',
        onResume: (event) => {
          resumed.push(event.stageId);
        },
      });
      await fresh.resume(checkpoint, { approved: true });
      expect(resumed).toEqual(['approve']);
      expect(fresh.getSnapshot().sharedState).toMatchObject({ value: 7, approved: true, done: true });
    },
  );

  it.each([0, 2])('records parallelForEach result writes with %i branches', async (count) => {
    const branch = flowChart<any>(
      'Score',
      (scope) => {
        scope.score.set(scope.getArgs().item * 2);
      },
      'score',
    ).build();
    const items = Array.from({ length: count }, (_, index) => index + 1);
    const chart = flowChart<any>(
      'Seed',
      (scope) => {
        scope.items.set(items);
      },
      'seed',
    )
      .addParallelForEach('Each', 'each', {
        items: (scope) => scope.items.get(),
        branch: () => branch,
        maxBranches: 3,
        into: 'results',
      })
      .build();
    const executor = new FlowChartExecutor(chart, {
      scopeFactory: factory('direct', { items: z.array(z.number()), score: z.number(), results: z.array(z.unknown()) }),
    });
    const writes: unknown[] = [];
    executor.attachScopeRecorder({
      id: 'results',
      onWrite: (event) => {
        if (event.stageId === 'each') writes.push(event.value);
      },
    });
    await executor.run();
    const results = executor.getSnapshot().sharedState.results as Array<{ score: number }>;
    expect(results.map((entry) => entry.score)).toEqual(items.map((item) => item * 2));
    expect(writes).toEqual([results]);
  });

  it('inherits environment and recording through subflow input and output mapping', async () => {
    const child = flowChart<any>(
      'Child',
      (scope) => {
        expect(scope.getArgs()).toEqual({ source: 4 });
        expect(scope.getEnv().traceId).toBe('nested-trace');
        scope.output.set(scope.source.get() + 1);
        scope.emitEvent('child-result', { value: 5 });
      },
      'child',
    ).build();
    const chart = flowChart<any>(
      'Seed',
      (scope) => {
        scope.source.set(4);
      },
      'seed',
    )
      .addSubFlowChartNext('mount', child, 'Mount', {
        inputMapper: (state) => ({ source: state.source }),
        outputMapper: (state) => ({ result: state.output }),
      })
      .build();
    const writes: Array<{ id: string; key: string }> = [];
    const emits: unknown[] = [];
    const executor = new FlowChartExecutor(chart, {
      scopeFactory: factory('resolver', { source: z.number(), output: z.number(), result: z.number() }),
    });
    executor.attachCombinedRecorder({
      id: 'subflow',
      onWrite: (event) => {
        writes.push({ id: event.runtimeStageId, key: event.key });
      },
      onEmit: (event) => {
        emits.push({ path: event.subflowPath, payload: event.payload });
      },
    });
    await executor.run({ env: { traceId: 'nested-trace' } });
    expect(executor.getSnapshot().sharedState.result).toBe(5);
    expect(writes).toContainEqual({ id: expect.stringMatching(/^mount\/child#/), key: 'output' });
    expect(emits).toEqual([{ path: ['mount'], payload: { value: 5 } }]);
  });

  it('continues to reject unknown user fields instead of silently returning undefined', async () => {
    const executor = new FlowChartExecutor(
      flowChart<any>(
        'Typo',
        (scope) => {
          scope.typo.get();
        },
        'typo',
      ).build(),
      {
        scopeFactory: factory('direct', { value: z.number() }),
      },
    );
    await expect(executor.run()).rejects.toThrow(/Unknown field 'typo'/);
  });
});
