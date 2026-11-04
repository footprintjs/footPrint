import { memorySink } from 'foottrace/write';
import { describe, expect, it } from 'vitest';

import type { BoundRun, FlowChart, PausableHandler, RunLifecycle, RunSlot, TypedScope } from '../../../src';
import { createRunLifecycle, flowChart, FlowChartExecutor } from '../../../src';

it('supports the explicit private component lifetime', () => {
  const chart = flowChart('root', () => undefined, 'root').build();
  const owner = createRunLifecycle(chart, { runnerId: 'component-owner' });
  expect(() => Reflect.apply(owner.slot, owner, ['component'])).not.toThrow();
});

interface PrivateCell {
  label: string;
  visits: number;
}
interface Visit {
  where: string;
  cell: PrivateCell;
  runtime: object;
  binding: BoundRun;
}
function value<T>(bound: BoundRun, slot: RunSlot<T>): T {
  const found = bound.read(slot);
  if (!found.present) throw new Error('test expected initialized component');
  return found.value;
}
function componentFixture(declareNow = true) {
  const visits: Visit[] = [];

  let component: RunSlot<PrivateCell> | undefined;

  let serial = 0;
  const visit = (where: string, scope: unknown) => {
    const binding = owner.forScope(scope);
    if (!component) throw new Error('test has not declared component slot');
    const cell = binding.local(component, () => ({ label: `private-${++serial}`, visits: 0 }));
    cell.visits++;
    visits.push({ where, cell, runtime: binding.local(runtime, () => ({})), binding });
  };
  const inner = flowChart<Record<string, unknown>>(
    'inner',
    async (scope) => {
      await Promise.resolve();
      visit('inner', scope);
    },
    'inner',
  ).build();
  const chart = flowChart<Record<string, unknown>>('root', (scope) => visit('root', scope), 'root')
    .addSubFlowChartNext('internal', inner, 'internal')
    .addFunction(
      'end',
      (scope) => {
        visit('end', scope);
        return 'public';
      },
      'end',
    )
    .build();
  const owner: RunLifecycle = createRunLifecycle(chart, { runnerId: 'component-fixture' });
  const runtime: RunSlot<object> = owner.slot('runtime');
  const declare = () => {
    component ??= owner.slot<PrivateCell>('component');
    return component;
  };
  if (declareNow) declare();
  return {
    chart,
    owner,
    visits,
    declare,
    get component() {
      return component!;
    },
  };
}
function expectComponents(visits: Visit[], count: number) {
  expect(visits).toHaveLength(count * 3);
  const components = new Set(visits.map((visit) => visit.cell));
  expect(components.size).toBe(count);
  for (const cell of components) {
    const rows = visits.filter((visit) => visit.cell === cell);
    expect(rows.map((row) => row.where)).toEqual(['root', 'inner', 'end']);
    expect(cell.visits).toBe(3);
    expect(rows[0].runtime).toBe(rows[2].runtime);
    expect(rows[0].runtime).not.toBe(rows[1].runtime);
  }
}

describe('private component bank boundaries', () => {
  it('joins owned pre-origin initialization, onOrigin, root and internal scopes', async () => {
    const fixture = componentFixture();
    const initialized = { label: 'private-owned', visits: 0 };
    await fixture.owner.withRun(async (run) => {
      run.set(fixture.component, initialized);
      await run.execute(
        { kind: 'run' },
        {
          onOrigin: (cells) => {
            expect(cells.read(fixture.component)).toEqual({ present: true, value: initialized });
          },
        },
      );
      expect(run.read(fixture.component)).toEqual({ present: true, value: initialized });
    });
    expectComponents(fixture.visits, 1);
    expect(fixture.visits[0].cell).toBe(initialized);
    expect(JSON.stringify(fixture.owner.view()?.snapshot())).not.toContain('private-owned');
  });

  it('isolates sibling mounts of the same root in one leg and a direct overlap', async () => {
    const fixture = componentFixture();
    const chart = flowChart('parent', () => undefined, 'parent')
      .addSubFlowChart('left', fixture.chart, 'left')
      .addSubFlowChart('right', fixture.chart, 'right')
      .build();
    await Promise.all([
      new FlowChartExecutor(chart).run(),
      fixture.owner.withRun((run) => run.execute({ kind: 'run' })),
    ]);
    expectComponents(fixture.visits, 3);
    const runIds = new Set(fixture.visits.map((visit) => visit.binding.origin.runId));
    expect(runIds.size).toBe(2);
  });

  it('propagates root identity across multiple prefixes declared only after all parents are built', async () => {
    const fixture = componentFixture(false);
    const middle = flowChart('middle', () => undefined, 'middle')
      .addSubFlowChartNext('child', fixture.chart, 'child')
      .build();
    const outer = flowChart('outer', () => undefined, 'outer')
      .addSubFlowChartNext('one', middle, 'one')
      .addSubFlowChartNext('two', middle, 'two')
      .build();
    fixture.declare();
    await expect(new FlowChartExecutor(outer).run()).resolves.not.toBeInstanceOf(Error);
    expectComponents(fixture.visits, 2);
  });

  it('captures the entry boundary before the input mapper can declare the child', async () => {
    const fixture = componentFixture(false);
    const parent = flowChart('parent', () => undefined, 'parent')
      .addSubFlowChartNext('child', fixture.chart, 'child', {
        inputMapper: () => {
          fixture.declare();
          return {};
        },
      })
      .build();
    await expect(new FlowChartExecutor(parent).run()).rejects.toThrow('component boundary');
    expect(fixture.visits).toHaveLength(0);
    await new FlowChartExecutor(parent).run();
    expectComponents(fixture.visits, 1);
  });

  it('refuses component access declared after root entry and supports the next entry', async () => {
    let slot: RunSlot<number> | undefined;
    let pass = 0;
    const chart = flowChart(
      'root',
      (scope) => {
        slot ??= owner.slot<number>('component');
        const bound = owner.forScope(scope);
        if (pass++ === 0) expect(() => bound.set(slot!, 1)).toThrow('component boundary');
        else {
          bound.set(slot, 2);
          expect(bound.read(slot)).toEqual({ present: true, value: 2 });
        }
      },
      'root',
    ).build();
    const owner = createRunLifecycle(chart, { runnerId: 'late' });
    await new FlowChartExecutor(chart).run();
    await new FlowChartExecutor(chart).run();
    expect(pass).toBe(2);
  });

  it.each(['lazy', 'generated', 'selector', 'decider'] as const)(
    'starts real components through %s entry',
    async (shape) => {
      const fixture = componentFixture();
      const base = flowChart<Record<string, unknown>>('parent', () => undefined, 'parent');
      const parent =
        shape === 'lazy'
          ? base.addLazySubFlowChartNext('child', () => fixture.chart, 'child').build()
          : shape === 'generated'
          ? base
              .addParallelForEach('each', 'each', {
                items: () => [1, 2],
                branch: () => fixture.chart,
                into: 'results',
                maxBranches: 2,
              })
              .build()
          : shape === 'selector'
          ? base
              .addSelectorFunction('choose', () => ['one', 'two'], 'choose')
              .addSubFlowChartBranch('one', fixture.chart, 'one')
              .addSubFlowChartBranch('two', fixture.chart, 'two')
              .end()
              .build()
          : base
              .addDeciderFunction('choose', () => 'one', 'choose')
              .addSubFlowChartBranch('one', fixture.chart, 'one')
              .end()
              .build();
      await new FlowChartExecutor(parent).run();
      expectComponents(fixture.visits, shape === 'generated' || shape === 'selector' ? 2 : 1);
    },
  );

  it('allocates on each mount reentry while a stage loop keeps its existing component', async () => {
    const child = componentFixture();
    const parent = flowChart<{ rounds: number }>(
      'seed',
      (scope) => {
        scope.rounds = 0;
      },
      'seed',
    )
      .addSubFlowChartNext('member', child.chart, 'member')
      .addDeciderFunction('again', (scope) => (++scope.rounds < 2 ? 'repeat' : 'stop'), 'again')
      .addFunctionBranch('repeat', 'repeat', () => undefined, undefined, { loopTo: 'member' })
      .addFunctionBranch('stop', 'stop', (scope) => scope.$break())
      .end()
      .build();
    await new FlowChartExecutor(parent).run();
    expectComponents(child.visits, 2);

    const seen: object[] = [];
    const chart = flowChart(
      'seed',
      (scope) => {
        const cell = owner.forScope(scope).local(slot, () => ({ count: 0 }));
        cell.count++;
        seen.push(cell);
      },
      'seed',
    )
      .addDeciderFunction(
        'again',
        (scope) => (value(owner.forScope(scope), slot).count < 3 ? 'repeat' : 'stop'),
        'again',
      )
      .addFunctionBranch('repeat', 'repeat', () => undefined, undefined, { loopTo: 'seed' })
      .addFunctionBranch('stop', 'stop', (scope) => scope.$break())
      .end()
      .build();
    const owner = createRunLifecycle(chart, { runnerId: 'stage-loop' });
    const slot: RunSlot<{ count: number }> = owner.slot('component');
    await owner.withRun((run) => run.execute({ kind: 'run' }));
    expect(seen).toHaveLength(3);
    expect(new Set(seen).size).toBe(1);
  });

  it('separates declared nested roots, preserving the parent mapper bank across awaited child work', async () => {
    const child = componentFixture();

    const parentValue = {};
    const chart = flowChart(
      'parent',
      (scope) => {
        owner.forScope(scope).set(slot, parentValue);
      },
      'parent',
    )
      .addSubFlowChartNext('child', child.chart, 'child', {
        inputMapper: (_data, binding) => {
          expect(value(owner.forScope(binding), slot)).toBe(parentValue);
          return {};
        },
        outputMapper: (_data, _parent, binding) => {
          expect(value(owner.forScope(binding), slot)).toBe(parentValue);
          return {};
        },
      })
      .addFunction(
        'after',
        (scope) => {
          expect(value(owner.forScope(scope), slot)).toBe(parentValue);
          const oldChild = child.visits[0].binding;
          // A declared component now closes at its own terminal, while its
          // parent stays active. Captured reads remain; late writes refuse.
          expect(oldChild.retired).toBe(true);
          expect(value(oldChild, child.component)).toBe(child.visits[0].cell);
          expect(() => oldChild.set(child.component, { label: 'late-child', visits: 4 })).toThrow('retired');
          expect(value(owner.forScope(scope), slot)).toBe(parentValue);
        },
        'after',
      )
      .build();
    const owner = createRunLifecycle(chart, { runnerId: 'parent-component' });
    const slot: RunSlot<object> = owner.slot('component');
    await owner.withRun((run) => run.execute({ kind: 'run' }));
    expect(child.visits[0].binding.retired).toBe(true);
    expect(() => child.visits[0].binding.set(child.component, { label: 'late', visits: 0 })).toThrow('retired');
  });

  it.each(['same', 'fresh'] as const)(
    'uses fresh private banks on %s resume without serializing them',
    async (mode) => {
      const oldBindings: BoundRun[] = [];
      const handler: PausableHandler<TypedScope<Record<string, unknown>>> = {
        execute: async (scope) => {
          const bound = owner.forScope(scope);
          oldBindings.push(bound);
          bound.set(slot, { secret: 'PRIVATE-COMPONENT-VALUE', program: () => undefined });
          return { question: 'continue?' };
        },
        resume: async (scope) => {
          const bound = owner.forScope(scope);
          oldBindings.push(bound);
          expect(bound.read(slot)).toEqual({ present: false });
          bound.set(slot, { secret: 'PRIVATE-NEW-COMPONENT', program: () => undefined });
        },
      };
      const chart = flowChart('pause', handler, 'pause').build();
      const owner = createRunLifecycle(chart, { runnerId: 'resume-component' });
      const slot: RunSlot<{ secret: string; program: () => void }> = owner.slot('component');
      await owner.withRun((run) => run.execute({ kind: 'run' }));
      const continuation = owner.continuation()!;
      const checkpoint = JSON.parse(JSON.stringify(continuation.checkpoint()));
      expect(JSON.stringify(checkpoint)).not.toContain('PRIVATE-COMPONENT');
      await owner.withRun((run) =>
        run.execute(
          mode === 'same'
            ? { kind: 'resume', mode, continuation, input: 'yes' }
            : { kind: 'resume', mode, checkpoint, input: 'yes' },
        ),
      );
      expect(oldBindings[0].retired).toBe(true);
      expect(value(oldBindings[0], slot).secret).toBe('PRIVATE-COMPONENT-VALUE');
      expect(value(oldBindings[1], slot).secret).toBe('PRIVATE-NEW-COMPONENT');
      expect(JSON.stringify(owner.view()?.snapshot())).not.toContain('PRIVATE-');
    },
  );
});

it('isolates recursive entries of the same canonical root', async () => {
  const seen: object[] = [];
  const chart: FlowChart<Record<string, unknown>> = flowChart<Record<string, unknown>>(
    'root',
    (scope) => {
      seen.push(owner.forScope(scope).local(slot, () => ({})));
      scope.remaining = scope.$getArgs<{ depth: number }>().depth;
    },
    'root',
  )
    .addDeciderFunction('recurse', (scope) => (Number(scope.remaining) > 0 ? 'more' : 'done'), 'recurse')
    .addLazySubFlowChartBranch('more', () => chart, 'more', {
      inputMapper: (parent) => ({ depth: Number(parent.remaining) - 1 }),
    })
    .addFunctionBranch('done', 'done', () => 'done')
    .end()
    .build();
  const owner: RunLifecycle = createRunLifecycle(chart, { runnerId: 'recursive' });
  const slot: RunSlot<object> = owner.slot('component');
  await owner.withRun((run) => run.execute({ kind: 'run', options: { input: { depth: 3 } } }));
  expect(seen).toHaveLength(4);
  expect(new Set(seen).size).toBe(4);
});

it('keeps lifecycle namespaces distinct on one declared component and refuses fabricated keys', async () => {
  let probes = 0;
  const fakeScope = new Proxy(
    {},
    {
      get() {
        probes++;
        throw new Error('unregistered scope was probed');
      },
    },
  );
  const chart = flowChart(
    'root',
    (scope) => {
      const a = one.forScope(scope);
      const b = two.forScope(scope);
      a.set(first, 'one');
      b.set(second, 'two');
      expect(a.read(first)).toEqual({ present: true, value: 'one' });
      expect(b.read(second)).toEqual({ present: true, value: 'two' });
      for (const key of [second, {} as typeof first, { ...first } as typeof first, new Proxy(first, {})]) {
        expect(() => a.read(key)).toThrow('another lifecycle or is fabricated');
        expect(() => a.set(key, 'foreign')).toThrow('another lifecycle or is fabricated');
      }
      expect(() => one.forScope(fakeScope)).toThrow('no registered native');
      expect(probes).toBe(0);
    },
    'root',
  ).build();
  const one: RunLifecycle = createRunLifecycle(chart, { runnerId: 'one' });
  const two: RunLifecycle = createRunLifecycle(chart, { runnerId: 'two' });
  const first: RunSlot<string> = one.slot('component');
  const second: RunSlot<string> = two.slot('component');
  await one.withRun((run) => run.execute({ kind: 'run' }));
});

it('keeps the logical lease through held failing cleanup and retries failed initialization safely', async () => {
  const fixture = componentFixture();
  let release!: () => void;
  let started!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const reached = new Promise<void>((resolve) => {
    started = resolve;
  });
  const cleanupError = new Error('cleanup failed');
  const initialized = { label: 'owned-after-failed-init', visits: 0 };
  const run = fixture.owner.withRun(async (owned) => {
    expect(() =>
      owned.local(fixture.component, () => {
        expect(() => owned.local(fixture.component, () => initialized)).toThrow('being initialized');
        throw new Error('initializer failed');
      }),
    ).toThrow('initializer failed');
    expect(owned.read(fixture.component)).toEqual({ present: false });
    owned.set(fixture.component, initialized);
    owned.onFinalize(async () => {
      expect(owned.read(fixture.component)).toEqual({ present: true, value: initialized });
      expect(() => fixture.visits[0].binding.set(fixture.component, initialized)).toThrow('retired');
      started();
      await held;
      throw cleanupError;
    });
    await owned.execute({ kind: 'run' });
  });
  const observed = run.then(
    (result) => ({ result }),
    (error: unknown) => ({ error }),
  );
  try {
    await reached;
    await expect(fixture.owner.withRun(() => undefined)).rejects.toMatchObject({ code: 'ERR_RUN_IN_FLIGHT' });
  } finally {
    release();
    await observed;
  }
  await expect(run).rejects.toBe(cleanupError);
  await fixture.owner.withRun((owned) => {
    expect(owned.read(fixture.component)).toEqual({ present: false });
    return owned.execute({ kind: 'run' });
  });
  expect(fixture.visits[0].cell).not.toBe(fixture.visits[3].cell);
});

for (const commitValues of ['full', 'delta'] as const) {
  for (const mirror of [false, true]) {
    it(`keeps private components out of records (${commitValues}, mirror ${mirror})`, async () => {
      const sink = memorySink();
      const events: unknown[] = [];
      const secret = {
        text: 'PRIVATE-COMPONENT-RETENTION',
        program: () => undefined,
        toJSON() {
          throw new Error('private component was serialized');
        },
      };

      const chart = flowChart<{ visible?: string }>(
        'root',
        (scope) => {
          expect(owner.forScope(scope).read(slot)).toEqual({ present: true, value: secret });
          scope.visible = 'public';
          scope.$emit('public', { result: 'public' });
        },
        'root',
      ).build();
      const owner = createRunLifecycle(chart, { runnerId: 'private', executorOptions: { sink, commitValues } });
      const slot: RunSlot<typeof secret> = owner.slot('component');
      await owner.withRun((owned) => {
        owned.set(slot, secret);
        return owned.execute(
          { kind: 'run' },
          {
            narrative: {},
            ...(mirror && { redaction: { keys: ['unused'] } }),
            attachments: [
              {
                recorder: {
                  id: 'all',
                  onEmit: (event) => {
                    events.push(event);
                  },
                  onWrite: (event) => {
                    events.push(event);
                  },
                },
              },
            ],
          },
        );
      });
      for (const artifact of [owner.view()?.snapshot(), owner.view()?.getNarrativeEntries(), sink.entries, events]) {
        expect(JSON.stringify(artifact)).not.toContain('PRIVATE-COMPONENT-RETENTION');
      }
    });
  }
}

it('a root declared by one lifecycle is a boundary for an unrelated lifecycle too', async () => {
  const cells: object[] = [];
  const chart = flowChart(
    'root',
    (scope) => {
      cells.push(declared.forScope(scope).local(slot, () => ({})));
    },
    'root',
  ).build();
  const declared: RunLifecycle = createRunLifecycle(chart, { runnerId: 'declaring-owner' });
  const slot: RunSlot<object> = declared.slot('component');
  const unrelated = createRunLifecycle(chart, { runnerId: 'runtime-only-owner' });
  unrelated.slot('runtime');
  await Promise.all([
    declared.withRun((run) => run.execute({ kind: 'run' })),
    unrelated.withRun((run) => run.execute({ kind: 'run' })),
  ]);
  expect(cells).toHaveLength(2);
  expect(cells[0]).not.toBe(cells[1]);
});

it('pins one chart-root observation throughout component slot issuance', async () => {
  const chart = flowChart(
    'root',
    (scope) => {
      expect(owner.forScope(scope).read(first)).toEqual({ present: true, value: 'original' });
    },
    'root',
  ).build();
  const owner: RunLifecycle = createRunLifecycle(chart, { runnerId: 'root-observation' });
  const first: RunSlot<string> = owner.slot('component');
  const original = Object.getOwnPropertyDescriptor(chart, 'root')!;
  const rootA = chart.root;
  const rootB = flowChart('other', () => undefined, 'other').build().root;
  let reads = 0;
  Object.defineProperty(chart, 'root', { configurable: true, get: () => (++reads === 1 ? rootA : rootB) });
  try {
    owner.slot('component');
  } finally {
    Object.defineProperty(chart, 'root', original);
  }
  expect(reads).toBe(1);
  await expect(
    owner.withRun((run) => {
      run.set(first, 'original');
      return run.execute({ kind: 'run' });
    }),
  ).resolves.not.toBeInstanceOf(Error);
});
