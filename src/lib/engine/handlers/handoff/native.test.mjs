import { describe, expect, it } from 'vitest';
import { flowChart, FlowChartExecutor } from '../../../../index.ts';

function chart() {
  const child = flowChart(
    'Child',
    (s) => {
      s.answer = s.seed * 2;
    },
    'child',
  ).build();
  return flowChart(
    'Start',
    (s) => {
      s['literal.key'] = 7;
    },
    'start',
  )
    .addSubFlowChartNext('mount', child, 'Mount', { inputMapper: (p) => ({ seed: p['literal.key'] }) })
    .build();
}
function mounts(snapshot) {
  return [...new Set(Object.values(snapshot.subflowResults ?? {}))];
}
async function run(options = {}) {
  const executor = new FlowChartExecutor(chart(), options);
  await executor.run();
  return executor.getSnapshot();
}
describe('native input and fanout boundary observations', () => {
  it('joins only the actual landed seed and literal parent prefix', async () => {
    const snapshot = await run({ captureInputHandoff: true });
    const child = mounts(snapshot)[0];
    expect(child.treeContext.globalContext.answer).toBe(14);
    expect(child.inputHandoff).toMatchObject({
      version: 1,
      attribution: 'observed-read-prefix',
      status: 'captured',
      limitations: [],
      parent: { address: snapshot.logAddress, beforeCommitIdx: 1 },
      child: {
        address: child.treeContext.logAddress,
        runtimeStageId: child.treeContext.history[0].runtimeStageId,
        commitIdx: 0,
      },
      writes: [{ path: 'seed', reads: ['literal.key'] }],
    });
    expect(child.treeContext.history[0].trace[0].readKeys ?? []).toEqual([]);
  });
  it('all new channels are absent by default', async () => {
    const snapshot = await run();
    expect(mounts(snapshot)[0].inputHandoff).toBeUndefined();
    expect(snapshot.fanoutCollections).toBeUndefined();
  });
  it('collects actual ordered branch scopes once on the parent', async () => {
    const child = flowChart(
      'Work',
      (s) => {
        s.answer = s.item * 2;
      },
      'work',
    ).build();
    const built = flowChart(
      'Start',
      (s) => {
        s.items = [3, 1];
      },
      'start',
    )
      .addParallelForEach('Fan', 'fan', {
        items: (s) => s.items,
        branch: () => child,
        into: 'answers',
        maxBranches: 10,
      })
      .build();
    const executor = new FlowChartExecutor(built, { captureFanoutHandoff: true });
    await executor.run();
    const snapshot = executor.getSnapshot();
    expect(snapshot.sharedState.answers.map((s) => s.answer)).toEqual([6, 2]);
    expect(snapshot.fanoutCollections).toMatchObject({
      version: 1,
      status: 'captured',
      collections: [
        {
          parent: { address: snapshot.logAddress, path: 'answers' },
          totalItems: 2,
          branchCount: 2,
          status: 'captured',
          limitations: [],
          slots: [
            { index: 0, observation: 'scope-snapshot' },
            { index: 1, observation: 'scope-snapshot' },
          ],
        },
      ],
    });
    for (const result of mounts(snapshot))
      expect(result.inputHandoff?.writes).toEqual([
        { path: 'item', reads: ['items'] },
        { path: 'index', reads: ['items'] },
      ]);
  });
});

describe('native capture controls', () => {
  for (const input of [false, true])
    for (const fanout of [false, true])
      for (const output of [false, true]) {
        it(`keeps independent ordinary flags input=${input} fanout=${fanout} output=${output}`, async () => {
          const child = flowChart(
            'Child',
            (s) => {
              s.out = s.seed + 1;
            },
            'child',
          ).build();
          const built = flowChart(
            'Start',
            (s) => {
              s.source = 7;
            },
            'start',
          )
            .addSubFlowChartNext('mount', child, 'Mount', {
              inputMapper: (p) => ({ seed: p.source }),
              outputMapper: (c) => ({ answer: c.out }),
            })
            .build();
          const executor = new FlowChartExecutor(built, {
            captureInputHandoff: input,
            captureFanoutHandoff: fanout,
            captureOutputHandoff: output,
          });
          await executor.run();
          const snapshot = executor.getSnapshot();
          const result = mounts(snapshot)[0];
          expect(snapshot.sharedState.answer).toBe(8);
          expect(!!result.inputHandoff).toBe(input);
          expect(!!result.outputHandoff).toBe(output);
          expect(snapshot.fanoutCollections).toBeUndefined();
        });
      }
  for (const fanout of [false, true])
    it(`generated seed input-only is honest, fanout=${fanout}`, async () => {
      const built = flowChart(
        'Start',
        (s) => {
          s.items = [1];
        },
        'start',
      )
        .addParallelForEach('Fan', 'fan', {
          items: (s) => s.items,
          branch: () => flowChart('Work', () => {}, 'work').build(),
          into: 'answers',
          maxBranches: 2,
        })
        .build();
      const executor = new FlowChartExecutor(built, { captureInputHandoff: true, captureFanoutHandoff: fanout });
      await executor.run();
      const snapshot = executor.getSnapshot();
      const input = mounts(snapshot)[0].inputHandoff;
      expect(input.status).toBe(fanout ? 'captured' : 'partial');
      expect(input.limitations).toEqual(fanout ? [] : ['selector-reads-unavailable']);
      expect(input.writes[0].reads).toEqual(fanout ? ['items'] : []);
      expect(!!snapshot.fanoutCollections).toBe(fanout);
    });
  it('maps nested seed paths, including mapper result getters, without changing local readKeys', async () => {
    const child = flowChart('Child', () => {}, 'child').build();
    const built = flowChart(
      'Start',
      (s) => {
        s['a.b'] = 3;
      },
      'start',
    )
      .addSubFlowChartNext('mount', child, 'Mount', {
        inputMapper: (p) => ({
          get nested() {
            return { leaf: p['a.b'] };
          },
        }),
      })
      .build();
    const executor = new FlowChartExecutor(built, { captureInputHandoff: true, writeProvenance: 'reads-prefix' });
    await executor.run();
    const result = mounts(executor.getSnapshot())[0];
    expect(result.inputHandoff.writes).toEqual(
      result.treeContext.history[0].trace.map((row) => ({ path: row.path, reads: ['a.b'] })),
    );
    for (const row of result.treeContext.history[0].trace) expect(row.readKeys).toEqual([]);
  });
  it('never publishes a successful mapped seed after mapper or seed failure', async () => {
    const failure = new Error('mapper failed');
    for (const mapper of [
      () => {
        throw failure;
      },
      () => ({ bad: () => {} }),
    ]) {
      const child = flowChart('Child', () => {}, 'child').build();
      const built = flowChart('Start', () => {}, 'start')
        .addSubFlowChartNext('mount', child, 'Mount', { inputMapper: mapper })
        .build();
      const executor = new FlowChartExecutor(built, { captureInputHandoff: true });
      await expect(executor.run()).rejects.toBeDefined();
      expect(mounts(executor.getSnapshot())).toEqual([]);
    }
  });
  it('redacts references at root and nested projection, preserving runtime/static twins', async () => {
    const branch = flowChart(
      'Branch',
      (s) => {
        s.out = s.item;
      },
      'branch',
    ).build();
    const nested = flowChart(
      'Items',
      (s) => {
        s.items = [2];
      },
      'items',
    )
      .addParallelForEach('Fan', 'fan', {
        items: (s) => s.items,
        branch: () => branch,
        into: 'answers',
        maxBranches: 2,
      })
      .build();
    const outer = flowChart(
      'Start',
      (s) => {
        s.source = 5;
      },
      'start',
    )
      .addSubFlowChartNext('mount', nested, 'Mount', { inputMapper: (p) => ({ seed: p.source }) })
      .build();
    const executor = new FlowChartExecutor(outer, { captureInputHandoff: true, captureFanoutHandoff: true });
    await executor.run();
    const raw = executor.getSnapshot();
    const safe = executor.getSnapshot({ redact: true });
    const result = mounts(safe).find((r) => r.subflowId === 'mount');
    expect(result.inputHandoff.limitations).toContain('privacy-active');
    expect(result.inputHandoff.writes.every((w) => w.reads.length === 0)).toBe(true);
    expect(result.treeContext.fanoutCollections.collections[0].slots).toEqual([]);
    expect(result.treeContext.fanoutCollections.collections[0].limitations).toContain('privacy-active');
    const id = result.inputHandoff.child.runtimeStageId;
    expect(safe.subflowResults[id]).toBe(safe.subflowResults.mount);
    expect(
      mounts(raw).find((r) => r.subflowId === 'mount').treeContext.fanoutCollections.collections[0].slots,
    ).toHaveLength(1);
    expect(() => JSON.parse(JSON.stringify(safe))).not.toThrow();
  });
  it('active privacy retains no source names or child slots and preserves mapper taint', async () => {
    const executor = new FlowChartExecutor(chart(), { captureInputHandoff: true });
    executor.setRedactionPolicy({ keys: ['literal.key'] });
    await executor.run();
    const result = mounts(executor.getSnapshot())[0];
    expect(result.inputHandoff.limitations).toContain('privacy-active');
    expect(result.inputHandoff.writes[0].reads).toEqual([]);
    expect(result.treeContext.history[0].overwrite.seed).toBe('REDACTED');
  });
  it('orders actual scope slots despite reversed completion and labels explicit outputs/failures', async () => {
    const child = (_, index) =>
      flowChart(
        'Work',
        async (s) => {
          if (index === 0) await new Promise((r) => setTimeout(r, 10));
          if (index === 1) throw new Error('branch');
          if (index === 2) return { explicit: 3 };
          s.out = s.item;
        },
        'work',
      ).build();
    const built = flowChart(
      'Start',
      (s) => {
        s.items = [0, 1, 2, 3];
      },
      'start',
    )
      .addParallelForEach('Fan', 'fan', {
        items: (s) => [...s.items].reverse(),
        branch: child,
        into: 'answers',
        maxBranches: 3,
      })
      .build();
    const executor = new FlowChartExecutor(built, { captureFanoutHandoff: true });
    await executor.run();
    const snapshot = executor.getSnapshot();
    const collection = snapshot.fanoutCollections.collections[0];
    expect(collection.slots.map((slot) => [slot.index, slot.observation])).toEqual([
      [0, 'scope-snapshot'],
      [1, 'failed-slot'],
      [2, 'explicit-output'],
    ]);
    expect(collection.limitations).toEqual(
      expect.arrayContaining(['branches-truncated', 'failed-slot', 'explicit-output']),
    );
    expect(collection.status).toBe('partial');
    for (const result of mounts(snapshot)) expect(result.inputHandoff.writes[0].reads).toEqual(['items']);
  });
  it('records a real zero-branch write and resets on a fresh run without editing held snapshots', async () => {
    let count = 1;
    const built = flowChart(
      'Start',
      (s) => {
        s.items = Array.from({ length: count }, () => 1);
      },
      'start',
    )
      .addParallelForEach('Fan', 'fan', {
        items: (s) => s.items,
        branch: () => flowChart('Work', () => {}, 'work').build(),
        into: 'answers',
        maxBranches: 2,
      })
      .build();
    const executor = new FlowChartExecutor(built, { captureFanoutHandoff: true });
    await executor.run();
    const first = executor.getSnapshot();
    count = 0;
    await executor.run();
    const second = executor.getSnapshot();
    expect(second.fanoutCollections).toBeDefined();
    expect(second.fanoutCollections.collections).toHaveLength(1);
    expect(second.fanoutCollections.collections[0]).toMatchObject({
      branchCount: 0,
      totalItems: 0,
      status: 'captured',
      slots: [],
    });
    expect(first.fanoutCollections.collections[0].slots).toHaveLength(1);
    expect(first.logAddress.logRunId).not.toBe(second.logAddress.logRunId);
  });
});

it('bounds real parent collections at128 without changing129 successful native fanouts', async () => {
  let builder = flowChart('Start', () => {}, 'start');
  for (let i = 0; i < 129; i++)
    builder = builder.addParallelForEach('Fan', `fan${i}`, {
      items: () => [],
      branch: () => flowChart('Unused', () => {}, 'unused').build(),
      into: `answers${i}`,
      maxBranches: 2,
    });
  const executor = new FlowChartExecutor(builder.build(), { captureFanoutHandoff: true });
  await executor.run();
  const snapshot = executor.getSnapshot();
  expect(snapshot.sharedState.answers128).toEqual([]);
  expect(snapshot.fanoutCollections).toBeDefined();
  expect(snapshot.fanoutCollections.collections).toHaveLength(128);
  expect(snapshot.fanoutCollections.status).toBe('partial');
  expect(snapshot.fanoutCollections.collections.at(-1).limitations).toContain('budget-exhausted');
});

it('runs the shared protocol fixture through real public exports', async () => {
  const { default: fixture } = await import('../../../../../test/fixtures/subflow-provenance/produce.cjs');
  const { snapshot, redacted } = await fixture.produce(
    { flowChart, FlowChartExecutor },
    { captureInputHandoff: true, captureFanoutHandoff: true, captureOutputHandoff: true },
  );
  expect(snapshot.sharedState.answer).toBe(14);
  expect(snapshot.sharedState['literal.source']).toBe(999);
  expect(snapshot.sharedState.answers.map((result) => result.branchAnswer)).toEqual([3, 9]);
  expect(snapshot.fanoutCollections.collections).toHaveLength(1);
  expect(snapshot.subflowResults.nested.treeContext.fanoutCollections.collections).toHaveLength(1);
  expect(snapshot.subflowResults.mapped.inputHandoff.parent.beforeCommitIdx).toBe(1);
  expect(redacted.fanoutCollections.collections[0].slots).toEqual([]);
});

it('keeps literal dotted selector roots through generated dispatch input', async () => {
  const built = flowChart(
    'Start',
    (s) => {
      s['literal.items'] = [4];
    },
    'start',
  )
    .addParallelForEach('Fan', 'fan', {
      items: (s) => s['literal.items'],
      branch: () => flowChart('Work', () => {}, 'work').build(),
      into: 'answers',
      maxBranches: 2,
    })
    .build();
  const executor = new FlowChartExecutor(built, { captureFanoutHandoff: true });
  await executor.run();
  expect(mounts(executor.getSnapshot())[0].inputHandoff.writes[0].reads).toEqual(['literal.items']);
});
