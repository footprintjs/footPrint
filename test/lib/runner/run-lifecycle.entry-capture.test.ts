import { memorySink } from 'foottrace/write';
import { expect, it, vi } from 'vitest';

import {
  type RunSlot,
  createRunLifecycle,
  disableDevMode,
  enableDevMode,
  flowChart,
  FlowChartExecutor,
  isDevMode,
} from '../../../src';

function originMutationFixture() {
  const seen: Array<{ body: string; value: unknown }> = [];
  const original = flowChart(
    'original',
    (scope) => {
      const value = owner.forScope(scope).read(slot);
      seen.push({ body: 'original', value });
      return 'original';
    },
    'original',
  ).build();
  const replacement = flowChart(
    'replacement',
    (scope) => {
      const value = owner.forScope(scope).read(slot);
      seen.push({ body: 'replacement', value });
      return 'replacement';
    },
    'replacement',
  ).build();
  const owner = createRunLifecycle(original, { runnerId: 'entry-capture' });
  const slot: RunSlot<string> = owner.slot('component');
  const execute = () =>
    owner.withRun((run) => {
      run.set(slot, 'PRIVATE-ENTRY-CANARY');
      return run.execute(
        { kind: 'run' },
        {
          onOrigin: () => {
            original.root = replacement.root;
          },
        },
      );
    });
  return { execute, seen };
}

it('executes the root captured before onOrigin can replace the chart entry', async () => {
  const fixture = originMutationFixture();
  await expect(fixture.execute()).resolves.toBe('original');
});
it('never lends the original private bank to a replacement root', async () => {
  const fixture = originMutationFixture();
  await fixture.execute();
  expect(fixture.seen).not.toContainEqual({
    body: 'replacement',
    value: { present: true, value: 'PRIVATE-ENTRY-CANARY' },
  });
});
it('uses one root across recorder reset, runtime naming and traversal', async () => {
  const original = flowChart('original', () => 'original', 'original').build();
  const replacement = flowChart('replacement', () => 'replacement', 'replacement').build();
  const executor = new FlowChartExecutor(original);
  executor.attachFlowRecorder({
    id: 'entry-swap',
    clear: () => {
      original.root = replacement.root;
    },
  });
  await expect(executor.run()).resolves.toBe('original');
  expect(executor.getSnapshot().executionTree[0]?.id).toBe('original');
  await expect(executor.run()).resolves.toBe('replacement');
});

it('observes a run entry root once and uses it for runtime and traversal', async () => {
  const chart = flowChart('original', () => 'original', 'original').build();
  const executor = new FlowChartExecutor(chart);
  const a = chart.root;
  const b = flowChart('replacement', () => 'replacement', 'replacement').build().root;
  const descriptor = Object.getOwnPropertyDescriptor(chart, 'root');
  if (!descriptor) throw new Error('Fixture chart needs an own root descriptor');
  let reads = 0;
  Object.defineProperty(chart, 'root', { configurable: true, get: () => (++reads === 1 ? a : b) });
  let result: unknown;
  try {
    result = await executor.run();
  } finally {
    Object.defineProperty(chart, 'root', descriptor);
  }
  expect({ reads, result, root: executor.getRuntimeRoot().name }).toEqual({
    reads: 1,
    result: 'original',
    root: 'original',
  });
});

it.each(['same', 'fresh'] as const)(
  'observes one coherent root through %s resume planning and traversal',
  async (mode) => {
    let resumed = 0;
    const chart = flowChart(
      'pause',
      {
        execute: async () => ({ question: 'continue?' }),
        resume: async () => {
          resumed++;
        },
      },
      'pause',
    ).build();
    const first = new FlowChartExecutor(chart);
    await first.run();
    const checkpoint = JSON.parse(JSON.stringify(first.getCheckpoint()));
    const executor = mode === 'same' ? first : new FlowChartExecutor(chart);
    const a = chart.root;
    const b = flowChart('replacement', () => undefined, 'pause').build().root;
    const descriptor = Object.getOwnPropertyDescriptor(chart, 'root');
    if (!descriptor) throw new Error('Fixture chart needs an own root descriptor');
    let reads = 0;
    Object.defineProperty(chart, 'root', { configurable: true, get: () => (++reads === 1 ? a : b) });
    try {
      await executor.resume(checkpoint, 'yes');
    } finally {
      Object.defineProperty(chart, 'root', descriptor);
    }
    expect({ reads, resumed, root: executor.getRuntimeRoot().name }).toEqual({ reads: 1, resumed: 1, root: 'pause' });
  },
);

it('opens a record for the same root captured before origin setup', async () => {
  const sink = memorySink();
  const chart = flowChart('original', () => 'original', 'original').build();
  const replacement = flowChart('replacement', () => 'replacement', 'replacement').build();
  const owner = createRunLifecycle(chart, { runnerId: 'record-entry', executorOptions: { sink } });
  owner.slot('component');
  await owner.withRun((run) =>
    run.execute(
      { kind: 'run' },
      {
        onOrigin: () => {
          chart.root = replacement.root;
        },
      },
    ),
  );
  const opened = sink.entries.find((entry) => entry.kind === 'opened');
  expect(opened?.kind).toBe('opened');
  if (opened?.kind !== 'opened') throw new Error('Fixture needs the root record opening');
  expect(opened.meta?.chart).toEqual({ id: 'original', name: 'original' });
});

it('names the captured entry in budget diagnostics after an options callback changes the future root', async () => {
  const wasDev = isDevMode();
  enableDevMode();
  const chart = flowChart('original', () => 'original', 'original', { retry: { attempts: 1, timeoutMs: 100 } })
    .budget(1000)
    .build();
  const replacement = flowChart('replacement', () => 'replacement', 'replacement').build();
  const executor = new FlowChartExecutor(chart);
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  try {
    const result = await executor.run({
      get env() {
        chart.root = replacement.root;
        return {};
      },
      timeoutMs: 500,
    });
    expect({
      result,
      warningNamesOriginal: warn.mock.calls.some((row) => String(row[0]).includes("('original')")),
    }).toEqual({ result: 'original', warningNamesOriginal: true });
  } finally {
    warn.mockRestore();
    if (!wasDev) disableDevMode();
  }
});

it.each(['same', 'fresh'] as const)(
  'keeps the previously planned %s resume body when onOrigin replaces a future root',
  async (mode) => {
    const seen: string[] = [];
    const chart = flowChart(
      'pause',
      {
        execute: async () => ({ question: 'continue?' }),
        resume: async (scope) => {
          expect(owner.forScope(scope).read(slot)).toEqual({ present: false });
          seen.push('original');
        },
      },
      'pause',
    ).build();
    const replacement = flowChart(
      'replacement',
      () => {
        seen.push('replacement');
      },
      'pause',
    ).build();
    const owner = createRunLifecycle(chart, { runnerId: 'resume-body' });
    const slot = owner.slot<string>('component');
    await owner.withRun((run) => {
      run.set(slot, 'PRIVATE-OLD');
      return run.execute({ kind: 'run' });
    });
    const continuation = owner.continuation();
    expect(continuation).toBeDefined();
    if (!continuation) throw new Error('Fixture must pause before resume');
    const checkpoint = JSON.parse(JSON.stringify(continuation.checkpoint()));
    await owner.withRun((run) =>
      run.execute(
        mode === 'same'
          ? { kind: 'resume', mode, continuation, input: 'yes' }
          : { kind: 'resume', mode, checkpoint, input: 'yes' },
        {
          onOrigin: () => {
            chart.root = replacement.root;
          },
        },
      ),
    );
    expect(seen).toEqual(['original']);
  },
);

it('keeps a mounted resolved entry coherent when its dictionary is replaced inside mapping', async () => {
  const seen: string[] = [];
  const child = flowChart(
    'original',
    (scope) => {
      owner.forScope(scope).local(slot, () => 'PRIVATE-MOUNT');
      seen.push('original');
    },
    'original',
  ).build();
  const owner = createRunLifecycle(child, { runnerId: 'mounted-entry' });
  const slot = owner.slot<string>('component');
  const replacement = flowChart(
    'replacement',
    () => {
      seen.push('replacement');
    },
    'replacement',
  ).build();
  const parent = flowChart('parent', () => undefined, 'parent')
    .addSubFlowChartNext('child', child, 'child', {
      inputMapper: () => {
        const dictionary = parent.subflows;
        if (!dictionary?.child) throw new Error('Fixture needs its registered child');
        dictionary.child.root = replacement.root;
        return {};
      },
    })
    .build();
  await new FlowChartExecutor(parent).run();
  expect(seen).toEqual(['original']);
});
