import { SharedMemory } from 'foottrace/write';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { ExecutionRuntime, ScopeFacade, StageContext } from '../../../src/advanced.js';
import type { EmitEvent, FlowChartExecutorOptions, RuntimeSnapshot, TypedScope } from '../../../src/index.js';
import { flowChart, FlowChartExecutor, interrupt } from '../../../src/index.js';
import { defineScopeFromZod } from '../../../src/zod.js';

type Delivery = 'inline' | 'deferred';
type Address = NonNullable<RuntimeSnapshot['logAddress']>;
type Position = NonNullable<EmitEvent['sourcePosition']>;

function position(event: EmitEvent): Position | undefined {
  return event.sourcePosition;
}

function address(snapshot: RuntimeSnapshot): Address | undefined {
  return snapshot.logAddress;
}

function record(executor: FlowChartExecutor, delivery: Delivery) {
  const events: EmitEvent[] = [];
  executor.attachEmitRecorder({ id: `position-${delivery}`, onEmit: (event) => events.push(event) }, { delivery });
  return events;
}

function eventNamed(events: EmitEvent[], name: string): EmitEvent {
  const event = events.find((candidate) => candidate.name === name);
  expect(event, `missing emitted event ${name}`).toBeDefined();
  if (!event) throw new Error(`Missing ${name}`);
  return event;
}

function expected(runId: string, committedThroughIdx: number, drillPath: string[] = [], logRunId = runId): Position {
  return { runId, logRunId, drillPath, committedThroughIdx };
}

describe.each(['full', 'delta'] as const)('emit source position (%s commits)', (commitValues) => {
  it.each(['inline', 'deferred'] as const)(
    'samples the committed prefix, not pending writes or the future commit (%s)',
    async (delivery) => {
      const chart = flowChart<{ value?: number }>(
        'One',
        (scope) => {
          scope.$emit('one-before-write', {});
          scope.value = 1;
          scope.$emit('one-after-write', {});
        },
        'one',
      )
        .addFunction(
          'Two',
          (scope) => {
            scope.$emit('two-before-write', {});
            scope.value = 2;
            scope.$emit('two-after-write', {});
          },
          'two',
        )
        .build();
      const executor = new FlowChartExecutor(chart, { commitValues });
      const events = record(executor, delivery);
      const commits: string[] = [];
      executor.attachScopeRecorder({
        id: 'independent-commits',
        onCommit: (event) => commits.push(event.runtimeStageId),
      });

      await executor.run();

      const snapshot = executor.getSnapshot();
      expect(snapshot.sharedState).toEqual({ value: 2 });
      expect(commits).toEqual(['one#0', 'two#1']);
      expect(snapshot.commitLog.map((bundle) => bundle.runtimeStageId)).toEqual(commits);
      expect(events.map((event) => position(event))).toEqual([
        expected(snapshot.runId, -1),
        expected(snapshot.runId, -1),
        expected(snapshot.runId, 0),
        expected(snapshot.runId, 0),
      ]);
      expect(address(snapshot)).toEqual({ logRunId: snapshot.runId, drillPath: [] });
    },
  );

  it('survives real deferred backlog while arrival-time root counts advance', async () => {
    const sourceCounts: number[] = [];
    const inline: EmitEvent[] = [];
    const deferred: Array<{ event: EmitEvent; arrivedAt: number }> = [];
    const chart = flowChart<{ value?: number }>(
      'Burst',
      (scope) => {
        for (let n = 0; n < 100; n++) {
          sourceCounts.push(executor.getCommitCount());
          scope.$emit('burst', n);
        }
        scope.value = 1;
      },
      'burst',
    )
      .addFunction(
        'Tail',
        (scope) => {
          scope.value = 2;
        },
        'tail',
      )
      .build();
    const executor: FlowChartExecutor = new FlowChartExecutor(chart, { commitValues });
    executor.attachEmitRecorder({ id: 'inline', onEmit: (event) => inline.push(event) });
    executor.attachEmitRecorder(
      { id: 'deferred', onEmit: (event) => deferred.push({ event, arrivedAt: executor.getCommitCount() }) },
      {
        delivery: 'deferred',
        flushBudgetMs: Number.MIN_VALUE,
      },
    );

    await executor.run();

    expect(inline).toHaveLength(100);
    expect(deferred).toHaveLength(100);
    expect(sourceCounts).toEqual(Array(100).fill(0));
    expect(deferred.some(({ event, arrivedAt }) => arrivedAt !== sourceCounts[event.payload as number])).toBe(true);
    const runId = executor.getSnapshot().runId;
    expect(inline.map(position)).toEqual(Array(100).fill(expected(runId, -1)));
    expect(deferred.map(({ event }) => position(event))).toEqual(inline.map(position));
  });

  it.each(['inline', 'deferred'] as const)(
    'shares one log between parallel siblings without confusing branch namespaces (%s)',
    async (delivery) => {
      let releaseBCommit: () => void = () => undefined;
      const bCommitted = new Promise<void>((resolve) => {
        releaseBCommit = resolve;
      });
      const commits: string[] = [];
      const sourceIndices = new Map<string, number>();
      const emit = (scope: TypedScope<object>, name: string) => {
        sourceIndices.set(name, commits.length - 1);
        scope.$emit(name, {});
      };
      const chart = flowChart(
        'Parent',
        (scope) => {
          emit(scope, 'parent');
        },
        'parent',
      )
        .addListOfFunction([
          {
            id: 'a',
            name: 'A',
            fn: async (scope) => {
              emit(scope, 'a-before');
              await bCommitted;
              emit(scope, 'a-after-b-commit');
            },
          },
          {
            id: 'b',
            name: 'B',
            fn: (scope) => {
              emit(scope, 'b-before');
            },
          },
        ])
        .addFunction(
          'Join',
          (scope) => {
            emit(scope, 'join');
          },
          'join',
        )
        .build();
      const executor = new FlowChartExecutor(chart, { commitValues });
      const events = record(executor, delivery);
      executor.attachScopeRecorder({
        id: 'independent-commits',
        onCommit(event) {
          commits.push(event.runtimeStageId);
          if (event.stageId === 'b') releaseBCommit();
        },
      });

      await executor.run();

      const snapshot = executor.getSnapshot();
      expect(snapshot.commitLog.map((bundle) => bundle.runtimeStageId)).toEqual(commits);
      expect(sourceIndices.get('a-before')).toBe(0);
      expect(sourceIndices.get('a-after-b-commit')).toBeGreaterThan(0);
      expect(eventNamed(events, 'a-before').pipelineId).toBe('a');
      expect(eventNamed(events, 'b-before').pipelineId).toBe('b');
      for (const event of events)
        expect(position(event)).toEqual(expected(snapshot.runId, sourceIndices.get(event.name) as number));
      expect(address(snapshot)).toEqual({ logRunId: snapshot.runId, drillPath: [] });
    },
  );
});

describe.each(['inline', 'deferred'] as const)('emit log ownership (%s)', (delivery) => {
  it('addresses nested seeded logs by execution mounts, including repeated identical static paths', async () => {
    type State = { round?: number; seed?: number; out?: number };
    const inner = flowChart<State>(
      'Inner',
      (scope) => {
        scope.$emit('inner-start', scope.seed);
        scope.out = scope.seed;
      },
      'inner',
    )
      .addFunction(
        'InnerTail',
        (scope) => {
          scope.$emit('inner-tail', scope.seed);
        },
        'inner-tail',
      )
      .build();
    const outer = flowChart<State>(
      'Outer',
      (scope) => {
        scope.$emit('outer-start', scope.seed);
      },
      'outer',
    )
      .addSubFlowChartNext('inner-mount', inner, 'InnerMount', {
        inputMapper: (parent: State) => ({ seed: parent.seed }),
        outputMapper: (child: State) => ({ out: child.out }),
      })
      .addFunction(
        'OuterTail',
        (scope) => {
          scope.$emit('outer-tail', scope.seed);
        },
        'outer-tail',
      )
      .build();
    const chart = flowChart<State>(
      'Seed',
      (scope) => {
        scope.round = 0;
      },
      'seed',
    )
      .addSubFlowChartNext('outer-mount', outer, 'OuterMount', {
        inputMapper: (parent: State) => ({ seed: (parent.round ?? 0) + 1 }),
        outputMapper: (_child: State, parent: State) => ({ round: (parent.round ?? 0) + 1 }),
      })
      .addDeciderFunction('Route', (scope) => ((scope.round ?? 0) < 2 ? 'again' : 'done'), 'route')
      .addFunctionBranch('again', 'Again', () => {})
      .loopTo('outer-mount')
      .addFunctionBranch('done', 'Done', () => {})
      .end()
      .build();
    const executor = new FlowChartExecutor(chart);
    const events = record(executor, delivery);
    const mounts: string[] = [];
    executor.attachFlowRecorder({
      id: 'mounts',
      onSubflowEntry(event) {
        mounts.push(event.traversalContext?.runtimeStageId ?? '');
      },
    });

    await executor.run();

    const snapshot = executor.getSnapshot();
    expect(snapshot.sharedState.round).toBe(2);
    expect(mounts).toEqual([
      'outer-mount#1',
      'outer-mount/inner-mount#3',
      'outer-mount#9',
      'outer-mount/inner-mount#11',
    ]);
    expect(events.filter((event) => event.name === 'inner-start').map((event) => event.subflowPath)).toEqual([
      ['outer-mount', 'inner-mount'],
      ['outer-mount', 'inner-mount'],
    ]);
    for (let visit = 0; visit < 2; visit++) {
      const outerId = mounts[visit * 2];
      const innerId = mounts[visit * 2 + 1];
      const group = events.filter((event) => event.payload === visit + 1);
      expect(group.map((event) => event.name)).toEqual(['outer-start', 'inner-start', 'inner-tail', 'outer-tail']);
      expect(group.map(position)).toEqual([
        expected(snapshot.runId, 0, [outerId]),
        expected(snapshot.runId, 0, [outerId, innerId]),
        expected(snapshot.runId, 1, [outerId, innerId]),
        expected(snapshot.runId, 3, [outerId]),
      ]);
      const outerResult = snapshot.subflowResults?.[outerId] as {
        treeContext: { history: Array<{ runtimeStageId: string }>; logAddress?: Address };
      };
      const innerResult = snapshot.subflowResults?.[innerId] as {
        treeContext: { history: Array<{ runtimeStageId: string }>; logAddress?: Address };
      };
      expect(outerResult.treeContext.history[0].runtimeStageId).toBe(outerId);
      expect(innerResult.treeContext.history[0].runtimeStageId).toBe(innerId);
      expect(outerResult.treeContext.logAddress).toEqual({ logRunId: snapshot.runId, drillPath: [outerId] });
      expect(innerResult.treeContext.logAddress).toEqual({ logRunId: snapshot.runId, drillPath: [outerId, innerId] });
    }
  });

  it.each([false, true])('preserves emitting-frame ownership across resume, fresh executor=%s', async (fresh) => {
    type State = { started?: boolean; answer?: string };
    let held: TypedScope<State> | undefined;
    const chart = flowChart<State>(
      'Start',
      (scope) => {
        scope.started = true;
        scope.$emit('start', {});
      },
      'start',
    )
      .addFunction(
        'Ask',
        (scope) => {
          held ??= scope;
          scope.$emit('before-interrupt', {});
          scope.answer = interrupt<string>(scope, { reason: 'Proceed?' });
          scope.$emit('after-answer', {});
        },
        'ask',
      )
      .addFunction(
        'Done',
        (scope) => {
          held?.$emit('held-in-next-leg', {});
          scope.$emit('done', {});
        },
        'done',
      )
      .build();
    const first = new FlowChartExecutor(chart);
    const firstEvents = record(first, delivery);
    await first.run();
    const paused = first.getSnapshot();
    const checkpoint = first.getCheckpoint();
    expect(checkpoint).toBeDefined();
    if (!checkpoint) throw new Error('Expected checkpoint');
    const resumed = fresh ? new FlowChartExecutor(chart) : first;
    const resumedEvents = fresh ? record(resumed, delivery) : firstEvents;
    await resumed.resume(structuredClone(checkpoint), 'yes');
    await first.drainObservers();
    const snapshot = resumed.getSnapshot();
    expect(snapshot.runId).not.toBe(paused.runId);
    const logRunId = fresh ? snapshot.runId : paused.runId;
    expect(position(eventNamed(resumedEvents, 'after-answer'))).toEqual(
      expected(snapshot.runId, fresh ? -1 : 1, [], logRunId),
    );
    expect(position(eventNamed(firstEvents, 'held-in-next-leg'))).toEqual(
      expected(paused.runId, fresh ? 1 : 2, [], paused.runId),
    );
    expect(eventNamed(firstEvents, 'held-in-next-leg').runtimeStageId).toBe('ask#1');
    expect(position(eventNamed(resumedEvents, 'done'))).toEqual(expected(snapshot.runId, fresh ? 0 : 2, [], logRunId));
    expect(address(snapshot)).toEqual({ logRunId, drillPath: [] });
    expect(address(paused)).toEqual({ logRunId: paused.runId, drillPath: [] });
  });

  it.each([false, true])('gives resumed nested logs new mount addresses, fresh executor=%s', async (fresh) => {
    const inner = flowChart<{ answer?: string }>(
      'Ask',
      (scope) => {
        scope.$emit('inner-before', {});
        scope.answer = interrupt<string>(scope, { reason: 'Nested?' });
        scope.$emit('inner-after', {});
      },
      'ask',
    ).build();
    const outer = flowChart('Outer', () => {}, 'outer')
      .addSubFlowChartNext('inner-mount', inner, 'Inner', {
        inputMapper: () => ({ seed: 1 }),
        outputMapper: (child: { answer?: string }) => ({ answer: child.answer }),
      })
      .build();
    const chart = flowChart('Start', () => {}, 'start')
      .addSubFlowChartNext('outer-mount', outer, 'Outer', {
        inputMapper: () => ({ outerSeed: 2 }),
        outputMapper: (child: { answer?: string }) => ({ answer: child.answer }),
      })
      .build();
    const first = new FlowChartExecutor(chart);
    const firstEvents = record(first, delivery);
    await first.run();
    const paused = first.getSnapshot();
    const checkpoint = first.getCheckpoint();
    if (!checkpoint) throw new Error('Expected nested checkpoint');
    const resumed = fresh ? new FlowChartExecutor(chart) : first;
    const resumedEvents = fresh ? record(resumed, delivery) : firstEvents;
    await resumed.resume(structuredClone(checkpoint), 'yes');
    const snapshot = resumed.getSnapshot();
    const paths = ['outer-mount#5', 'outer-mount/inner-mount#6'];
    expect(snapshot.sharedState.answer).toBe('yes');
    expect(position(eventNamed(firstEvents, 'inner-before'))).toEqual(
      expected(paused.runId, 0, ['outer-mount#1', 'outer-mount/inner-mount#3']),
    );
    expect(position(eventNamed(resumedEvents, 'inner-after'))).toEqual(expected(snapshot.runId, 0, paths));
    const result = snapshot.subflowResults?.[paths[1]] as { treeContext: { logAddress?: Address } };
    expect(result.treeContext.logAddress).toEqual({ logRunId: snapshot.runId, drillPath: paths });
    expect(address(snapshot)).toEqual({ logRunId: fresh ? snapshot.runId : paused.runId, drillPath: [] });
  });
});

it('freezes the source-time position before inline dispatch and keeps late emits distinct from staged writes', async () => {
  let held: TypedScope<{ value?: number }> | undefined;
  const executor = new FlowChartExecutor(
    flowChart<{ value?: number }>(
      'Hold',
      (scope) => {
        held = scope;
        scope.$emit('live', {});
        scope.value = 1;
      },
      'hold',
    )
      .addFunction(
        'Tail',
        (scope) => {
          scope.value = 2;
        },
        'tail',
      )
      .build(),
  );
  const observations: Array<{ positionFrozen: boolean; pathFrozen: boolean }> = [];
  executor.attachEmitRecorder({
    id: 'freeze-check',
    onEmit(event) {
      observations.push({
        positionFrozen: Object.isFrozen(position(event)),
        pathFrozen: Object.isFrozen(position(event)?.drillPath),
      });
    },
  });
  const events = record(executor, 'inline');
  await executor.run();
  held?.$emit('late', {});
  const snapshot = executor.getSnapshot();
  expect(events.map(position)).toEqual([expected(snapshot.runId, -1), expected(snapshot.runId, 1)]);
  expect(observations).toEqual([
    { positionFrozen: true, pathFrozen: true },
    { positionFrozen: true, pathFrozen: true },
  ]);
  expect(() => {
    if (held) held.value = 3;
  }).toThrow();
  expect(snapshot.sharedState.value).toBe(2);
});

describe.each(['facade', 'zod'] as const)('canonical %s scope factory', (kind) => {
  it.each(['inline', 'deferred'] as const)(
    'uses the runtime position through the real factory (%s)',
    async (delivery) => {
      const options: FlowChartExecutorOptions = {
        scopeFactory:
          kind === 'zod'
            ? defineScopeFromZod(z.object({}), { strict: 'deny' })
            : (context, name, readOnly, env) => new ScopeFacade(context, name, readOnly, env),
      };
      const chart = flowChart<any>(
        'One',
        (scope) => {
          scope.emitEvent('first', { ok: true });
        },
        'one',
      )
        .addFunction(
          'Two',
          (scope) => {
            scope.emitEvent('second', { ok: true });
          },
          'two',
        )
        .build();
      const executor = new FlowChartExecutor(chart, options);
      const events = record(executor, delivery);
      await executor.run();
      const snapshot = executor.getSnapshot();
      expect(events.map(position)).toEqual([expected(snapshot.runId, -1), expected(snapshot.runId, 0)]);
      expect(events.map((event) => event.payload)).toEqual([{ ok: true }, { ok: true }]);
      expect(snapshot.commitLog).toHaveLength(2);
    },
  );
});

it.each(['inline', 'deferred'] as const)(
  'does not invent a committed position for discarded retry writes (%s)',
  async (delivery) => {
    let attempt = 0;
    const chart = flowChart<{ value?: number }>(
      'Retry',
      (scope) => {
        attempt++;
        scope.value = attempt;
        scope.$emit('attempt', attempt);
        if (attempt === 1) throw new Error('retry once');
      },
      'retry',
    )
      .retry({ attempts: 2 })
      .build();
    const executor = new FlowChartExecutor(chart);
    const events = record(executor, delivery);
    await executor.run();
    const snapshot = executor.getSnapshot();
    expect(events.map((event) => event.payload)).toEqual([1, 2]);
    expect(events.map((event) => event.runtimeStageId)).toEqual(['retry#0', 'retry#0']);
    expect(events.map(position)).toEqual([expected(snapshot.runId, -1), expected(snapshot.runId, -1)]);
    expect(snapshot.commitLog).toHaveLength(1);
    expect(snapshot.sharedState.value).toBe(2);
  },
);

it('addresses the root log without requiring an attached observer', async () => {
  const executor = new FlowChartExecutor(
    flowChart(
      'Only',
      (scope) => {
        scope.$emit('ignored', {});
      },
      'only',
    ).build(),
  );
  await executor.run();
  const snapshot = executor.getSnapshot();
  expect(snapshot.commitLog).toHaveLength(1);
  expect(address(snapshot)).toEqual({ logRunId: snapshot.runId, drillPath: [] });
  expect(snapshot.recorders).toBeUndefined();
});

it('does not fabricate a position for a standalone unbound facade', () => {
  const context = new StageContext('custom-namespace', 'Bare', 'bare', new SharedMemory());
  const facade = new ScopeFacade(context, 'Bare');
  const events: EmitEvent[] = [];
  facade.attachScopeRecorder({ id: 'bare', onEmit: (event) => events.push(event) });
  facade.emitEvent('bare', {});
  expect(events).toHaveLength(1);
  expect(events[0].pipelineId).toBe('custom-namespace');
  expect(events[0]).not.toHaveProperty('sourcePosition');
});

it.each(['inline', 'deferred'] as const)(
  'retires source coordinates after clearing a running log (%s)',
  async (delivery) => {
    let held: TypedScope<{ value?: number }> | undefined;
    let beforeClear: RuntimeSnapshot | undefined;
    const chart = flowChart<{ value?: number }>(
      'First',
      (scope) => {
        held = scope;
        scope.value = 1;
        scope.$emit('first-before-commit', {});
      },
      'first',
    )
      .addFunction(
        'Later',
        (scope) => {
          scope.$emit('later-after-rebind', {});
          scope.value = 2;
        },
        'later',
      )
      .build();
    const executor = new FlowChartExecutor(chart);
    const events = record(executor, delivery);
    executor.attachScopeRecorder({
      id: 'clear-on-first-commit',
      onCommit(event) {
        if (event.stageId !== 'first') return;
        held?.$emit('first-after-commit', {});
        beforeClear = executor.getSnapshot();
        (executor.getRuntime() as ExecutionRuntime).executionHistory.clear();
        held?.$emit('held-after-clear', {});
      },
    });

    await executor.run();

    const snapshot = executor.getSnapshot();
    expect(snapshot.sharedState).toEqual({ value: 2 });
    expect(snapshot.commitLog.map((bundle) => bundle.runtimeStageId)).toEqual(['later#1']);
    expect(position(eventNamed(events, 'first-before-commit'))).toEqual(expected(snapshot.runId, -1));
    expect(position(eventNamed(events, 'first-after-commit'))).toEqual(expected(snapshot.runId, 0));
    expect(eventNamed(events, 'held-after-clear')).not.toHaveProperty('sourcePosition');
    expect(eventNamed(events, 'later-after-rebind')).not.toHaveProperty('sourcePosition');
    expect(snapshot).not.toHaveProperty('logAddress');
    expect(beforeClear?.logAddress).toEqual({ logRunId: snapshot.runId, drillPath: [] });
    expect(beforeClear?.commitLog.map((bundle) => bundle.runtimeStageId)).toEqual(['first#0']);
  },
);

it.each([false, true])(
  'preserves source positions through deferred ref capture and emit redaction=%s',
  async (redact) => {
    const payload = { secret: 'synthetic-private-value' };
    const executor = new FlowChartExecutor(
      flowChart(
        'Emit',
        (scope) => {
          scope.$emit('private.event', payload);
          scope.$emit('private.event', payload);
        },
        'emit',
      ).build(),
    );
    if (redact) executor.setRedactionPolicy({ emitPatterns: [/^private\./g] });
    const inline = record(executor, 'inline');
    const deferred: EmitEvent[] = [];
    executor.attachEmitRecorder(
      { id: 'ref-events', onEmit: (event) => deferred.push(event) },
      { delivery: 'deferred', capture: 'ref' },
    );

    await executor.run();

    const runId = executor.getSnapshot().runId;
    expect(inline).toHaveLength(2);
    expect(deferred).toHaveLength(2);
    for (let index = 0; index < inline.length; index++) {
      expect(deferred[index]).toBe(inline[index]);
      expect(position(deferred[index])).toEqual(expected(runId, -1));
      expect(Object.isFrozen(position(deferred[index]))).toBe(true);
      expect(Object.isFrozen(position(deferred[index])?.drillPath)).toBe(true);
      expect(deferred[index].payload).toBe(redact ? '[REDACTED]' : payload);
    }
    expect(payload.secret).toBe('synthetic-private-value');
  },
);
