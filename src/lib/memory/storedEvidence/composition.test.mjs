import { readRunEvidence, readStoredRecord } from 'foottrace';
import { memorySink } from 'foottrace/write';
import { expect, it } from 'vitest';

import { flowChart, FlowChartExecutor, select } from '../../../index.js';

function read(sink) {
  return readRunEvidence(readStoredRecord(sink.entries), sink.entries[0].address.logRunId);
}

it.each([false, true])('keeps a resumed mount explicit with fresh executor=%s', async (fresh) => {
  const sink = memorySink();
  const inner = flowChart(
    'Inside',
    (s) => {
      s.n = 1;
    },
    'inside',
  )
    .addPausableFunction(
      'Ask',
      {
        execute: () => ({ question: 'continue' }),
        resume: (s) => {
          s.n += 1;
        },
      },
      'ask',
    )
    .build();
  const chart = flowChart('Seed', () => {}, 'seed')
    .addSubFlowChartNext('child', inner, 'Child')
    .build();
  const first = new FlowChartExecutor(chart, { sink });
  await first.run();
  const checkpoint = first.getCheckpoint();
  const resumed = fresh ? new FlowChartExecutor(chart, { sink }) : first;
  await resumed.resume(checkpoint, {});
  const entries = sink.entries.filter((e) => e.kind === 'note' && e.note === 'run.stage' && e.data.resumes);
  expect(entries).toHaveLength(1);
  expect(entries[0].data.resumes).toBe(checkpoint.pausedExecution.runtimeStageId);
  expect(entries[0].data.id).toBe('child#4');
  const rootId = entries[0].address.logRunId;
  const run = readRunEvidence(readStoredRecord(sink.entries), rootId);
  expect(run.unread).toEqual([]);
  expect(sink.entries.filter((e) => e.kind === 'note' && e.note === 'run.stop')).toHaveLength(1);
});

it.each([false, true])('links actual mounted child logs and mapper reads with readSources=%s', async (readSources) => {
  const sink = memorySink();
  const inner = flowChart(
    'Inside',
    (s) => {
      s.output = s.$getArgs().value + 1;
    },
    'inside',
  ).build();
  const chart = flowChart(
    'Seed',
    (s) => {
      s.value = 4;
    },
    'seed',
  )
    .addSubFlowChartNext('child', inner, 'Child', {
      inputMapper: (parent) => ({ value: parent.value }),
      outputMapper: (child) => ({ result: child.output }),
    })
    .build();
  const ex = new FlowChartExecutor(chart, { sink, readSources });
  await ex.run();
  expect(ex.getSnapshot().sharedState.result).toBe(5);
  const run = read(sink);
  expect(run.unread).toEqual([]);
  const mount = sink.entries.find((e) => e.kind === 'note' && e.note === 'run.stage');
  expect(mount.data).toMatchObject({ id: 'child#1', parent: 'seed#0' });
  const opened = sink.entries.filter((e) => e.kind === 'opened');
  expect(opened).toHaveLength(2);
  expect(opened[1].address.drillPath).toEqual(['child#1']);
  expect(opened[1].collects).toEqual({ v: 1, reads: 'keys' });
  expect(run.stages.rows.find((row) => row.id === 'child/inside#2')).toMatchObject({ parent: 'child#1' });
  expect(run.reads.rows.find((row) => row.id === 'child#1').keys).toContain('value');
});

it('records a returned subflow once with its actual distinct mount execution', async () => {
  const sink = memorySink();
  let called = 0;
  const inner = flowChart(
    'Inside',
    () => {
      called++;
    },
    'inside',
  ).build();
  const chart = flowChart(
    'Return',
    () => ({
      name: 'Dynamic',
      isSubflowRoot: true,
      subflowId: 'dynamic',
      subflowDef: { root: inner.root, stageMap: inner.stageMap, buildTimeStructure: inner.buildTimeStructure },
    }),
    'return',
  ).build();
  await new FlowChartExecutor(chart, { sink }).run();
  expect(called).toBe(1);
  const run = read(sink);
  expect(run.unread).toEqual([]);
  const entered = sink.entries.filter((e) => e.kind === 'note' && e.note === 'run.stage');
  expect(entered).toHaveLength(1);
  expect(entered[0].data).toMatchObject({ id: 'return#1' });
  expect(entered[0].data).not.toHaveProperty('parent');
  expect(run.control('return#1').status).toBe('partial');
  expect(run.stages.rows.find((row) => row.id === 'inside#2')).toMatchObject({ parent: 'return#1' });
});

it('records both selected branches and their actual shared dispatch parent', async () => {
  const sink = memorySink();
  const chart = flowChart(
    'Seed',
    (s) => {
      s.pick = true;
    },
    'seed',
  )
    .addSelectorFunction(
      'Pick',
      (s) =>
        select(s, [
          { when: { pick: { eq: true } }, then: 'a' },
          { when: { pick: { eq: true } }, then: 'b' },
        ]),
      'pick',
    )
    .addFunctionBranch('a', 'A', (s) => {
      s.a = 1;
    })
    .addFunctionBranch('b', 'B', (s) => {
      s.b = 1;
    })
    .end()
    .build();
  await new FlowChartExecutor(chart, { sink }).run();
  const run = read(sink);
  expect(run.unread).toEqual([]);
  expect(run.decisions.rows).toMatchObject([{ id: 'pick#1', by: 'select', chosen: ['A', 'B'], total: 2 }]);
  for (const stage of run.stages.rows.filter((row) => row.id === 'a#2' || row.id === 'b#3'))
    expect(stage.parent).toBe('pick#1');
  expect(run.stages.rows.filter((row) => row.id === 'a#2' || row.id === 'b#3')).toHaveLength(2);
});

it('keeps fork continuation annotations on the first commit only', async () => {
  const sink = memorySink();
  const chart = flowChart('Seed', () => {}, 'seed')
    .addListOfFunction([
      {
        id: 'a',
        name: 'A',
        fn: (s) => {
          s.a = 1;
        },
      },
      {
        id: 'b',
        name: 'B',
        fn: (s) => {
          s.b = 1;
        },
      },
    ])
    .build();
  await new FlowChartExecutor(chart, { sink }).run();
  expect(read(sink).unread).toEqual([]);
  const counts = new Map();
  for (const entry of sink.entries.filter((e) => e.kind === 'commit' && e.about))
    counts.set(entry.bundle.runtimeStageId, (counts.get(entry.bundle.runtimeStageId) ?? 0) + 1);
  expect([...counts.values()].every((count) => count === 1)).toBe(true);
  expect(
    sink.entries.filter((e) => e.kind === 'commit' && e.bundle.phase).every((e) => !Object.hasOwn(e, 'about')),
  ).toBe(true);
});

it('exposes dropped decision notes and named-field adapter omissions as missing evidence', async () => {
  for (const drop of ['note', 'about', 'collects']) {
    const sink = memorySink();
    const adapter = {
      opened: ({ collects, ...entry }) => sink.opened(drop === 'collects' ? entry : { ...entry, collects }),
      commit: ({ about, ...entry }) => sink.commit(drop === 'about' ? entry : { ...entry, about }),
      note: (entry) => {
        if (drop !== 'note') sink.note(entry);
      },
      closed: (entry) => sink.closed(entry),
    };
    const chart = flowChart('Seed', () => {}, 'seed')
      .addDeciderFunction('Pick', () => 'a', 'pick')
      .addFunctionBranch('a', 'A', () => {})
      .end()
      .build();
    await new FlowChartExecutor(chart, { sink: adapter }).run();
    const run = read(sink);
    if (drop === 'note') expect(run.decisions.status).toBe('partial');
    if (drop === 'about') expect(run.reads.status).toBe('partial');
    if (drop === 'collects') expect(run.decisions.status).toBe('not-collected');
  }
});
