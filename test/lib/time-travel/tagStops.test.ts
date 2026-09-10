/**
 * `tagStops(tags?)` — the stops a chart DECLARED, read back off its log.
 *
 * One expression over `filterStops(commitStops(...))`: keep the stops whose
 * FIRST bundle carries a tag (any of the asked-for ones; every tagged stop
 * when none are asked for), give the survivors the log back, carry the
 * bundle's whole tag array as `meta`.
 *
 * Test types: Unit (keep-by-any-of, omitted list, unmatched list) ·
 * Functional (absorption BEFORE, `prologue` on an absorbing start, `meta` is
 * the array) · Property (the equivalence law: a filtering axis moves the
 * stops, never the log) · Boundary (untagged run → bookends only; empty log
 * → `[]`) · Integration (a stored recording: JSON round trip; a row with
 * `tags` is accepted by `bundleRefusal`).
 */
import { describe, expect, it } from 'vitest';

import { flowChart, FlowChartExecutor } from '../../../src/index.js';
import { bundleRefusal } from '../../../src/lib/time-travel/bundles.js';
import { commitStops, isCommitBundle, splitAxis, stateAt, tagStops, timeTravel } from '../../../src/trace.js';

interface State {
  trail?: string[];
  n?: number;
  [key: string]: unknown;
}

const push = (name: string) => (s: State) => {
  s.trail = [...(s.trail ?? []), name];
  s.n = (s.n ?? 0) + 1;
};

/** seed → a[llm-turn] → b → c[decision, audit] → d — two tagged, three not. */
function buildTagged() {
  return flowChart<State>('Seed', push('seed'), 'seed')
    .addFunction('A', push('a'), 'a')
    .tag('milestone:llm-turn')
    .addFunction('B', push('b'), 'b')
    .addFunction('C', push('c'), 'c')
    .tag('milestone:decision', 'audit')
    .addFunction('D', push('d'), 'd')
    .build();
}

async function runTagged() {
  const executor = new FlowChartExecutor(buildTagged());
  await executor.run();
  return executor.getSnapshot();
}

describe('tagStops — keep rule', () => {
  it('with no list, every tagged stop survives, in order, with meta = the bundle’s array', async () => {
    const snapshot = await runTagged();
    const stops = tagStops().stopsFor(snapshot.commitLog, snapshot.executionTree);
    expect(stops.map((s) => [s.kind, s.label, s.meta])).toEqual([
      ['start', 'Run start', undefined],
      ['commit', 'A', ['milestone:llm-turn']],
      ['commit', 'C', ['milestone:decision', 'audit']],
      ['end', 'Run end', undefined],
    ]);
  });

  it('any-of: a stop survives when it shares ONE name with the list; meta is still the whole array', async () => {
    const snapshot = await runTagged();
    const audit = tagStops(['audit']).stopsFor(snapshot.commitLog, snapshot.executionTree);
    expect(audit.filter((s) => s.kind === 'commit').map((s) => s.label)).toEqual(['C']);
    expect(audit[1].meta).toEqual(['milestone:decision', 'audit']);

    const either = tagStops(['milestone:llm-turn', 'audit']).stopsFor(snapshot.commitLog, snapshot.executionTree);
    expect(either.filter((s) => s.kind === 'commit').map((s) => s.label)).toEqual(['A', 'C']);
  });

  it('a list nothing matches yields the two bookends only — the truthful shape, not []', async () => {
    const snapshot = await runTagged();
    const stops = tagStops(['nope']).stopsFor(snapshot.commitLog, snapshot.executionTree);
    expect(stops.map((s) => s.kind)).toEqual(['start', 'end']);
    expect(stops[0].prologue).toBe(true);
  });

  it('an EMPTY list means "no filter" — the same as omitting it', async () => {
    const snapshot = await runTagged();
    expect(tagStops([]).stopsFor(snapshot.commitLog)).toEqual(tagStops().stopsFor(snapshot.commitLog));
  });
});

describe('tagStops — attribution by precedence', () => {
  it('an untagged stage folds into the tagged stop BEFORE it; the prologue is absorbed by start', async () => {
    const snapshot = await runTagged();
    const stops = tagStops().stopsFor(snapshot.commitLog, snapshot.executionTree);
    const [start, a, c, end] = stops;
    // seed ran before the first tagged stage → start absorbed it.
    expect(start.prologue).toBe(true);
    expect(start.lastCommitIdx).toBe(a.commitIdx - 1);
    // b belongs to A; d belongs to C.
    expect(a.lastCommitIdx).toBe(c.commitIdx - 1);
    expect(c.lastCommitIdx).toBe(end.lastCommitIdx);
    // Nothing orphaned: the ranges tile the log.
    expect(start.lastCommitIdx + 1).toBe(a.commitIdx);
    expect(a.lastCommitIdx + 1).toBe(c.commitIdx);
    expect(c.lastCommitIdx).toBe(snapshot.commitLog.length - 1);
  });

  it('a start that absorbed nothing says nothing (no prologue) when the first stage is tagged', async () => {
    const chart = flowChart<State>('Seed', push('seed'), 'seed').tag('first').addFunction('A', push('a'), 'a').build();
    const executor = new FlowChartExecutor(chart);
    await executor.run();
    const stops = tagStops().stopsFor(executor.getSnapshot().commitLog);
    expect(stops[0].kind).toBe('start');
    expect(stops[0]).not.toHaveProperty('prologue');
  });
});

describe('tagStops — the equivalence law', () => {
  it('every kept stop sits at the SAME commit as commitStops’s stop for that stage, and folds the same', async () => {
    const snapshot = await runTagged();
    const commitAxis = commitStops(snapshot.commitLog, snapshot.executionTree);
    const tagAxis = tagStops().stopsFor(snapshot.commitLog, snapshot.executionTree);

    for (const stop of tagAxis.filter((s) => s.kind === 'commit')) {
      const twin = commitAxis.find((s) => s.runtimeStageId === stop.runtimeStageId)!;
      expect(stop.commitIdx).toBe(twin.commitIdx);
      expect(stateAt(snapshot, stop.commitIdx).state).toEqual(stateAt(snapshot, twin.commitIdx).state);
    }

    // Through the cursor: the tag stop's fold (through lastCommitIdx) equals
    // the commit axis folded at that same last index — the state the next
    // tagged stage started from.
    const tagged = timeTravel(snapshot, { strategy: tagStops() });
    const plain = timeTravel(snapshot);
    for (const stop of tagged.stops) {
      const twin =
        plain.stops.find((s) => s.lastCommitIdx === stop.lastCommitIdx && s.kind !== 'end') ?? plain.stops.at(-1)!;
      expect(tagged.stateAt(stop).state).toEqual(plain.stateAt(twin).state);
    }
    expect(tagged.stateAt(tagged.stops[1]).state).toEqual({ trail: ['seed', 'a', 'b'], n: 3 });
  });
});

describe('tagStops — boundaries and stored recordings', () => {
  it('an untagged run yields the two bookends; an empty log yields []', async () => {
    const chart = flowChart<State>('Seed', push('seed'), 'seed').addFunction('A', push('a'), 'a').build();
    const executor = new FlowChartExecutor(chart);
    await executor.run();
    const stops = tagStops().stopsFor(executor.getSnapshot().commitLog);
    expect(stops.map((s) => s.kind)).toEqual(['start', 'end']);
    expect(splitAxis(stops).ok).toBe(true);
    expect(tagStops().stopsFor([])).toEqual([]);
  });

  it('a stored row with `tags` is a bundle to `bundleRefusal`; a JSON round trip keeps the axis', async () => {
    const snapshot = await runTagged();
    const stored = JSON.parse(JSON.stringify(snapshot)) as {
      commitLog: unknown[];
      initialState: Record<string, unknown>;
      executionTree: unknown;
    };
    for (const row of stored.commitLog) {
      expect(bundleRefusal(row)).toBeUndefined();
      expect(isCommitBundle(row)).toBe(true);
    }
    expect((stored.commitLog[1] as { tags?: string[] }).tags).toEqual(['milestone:llm-turn']);

    const cursor = timeTravel(stored, { strategy: tagStops(['milestone:decision']) });
    expect(cursor.stops.map((s) => s.label)).toEqual(['Run start', 'C', 'Run end']);
    expect(cursor.stops[1].meta).toEqual(['milestone:decision', 'audit']);
  });

  it('a row whose `tags` is not an array is still a bundle — tags are read leniently, never validated', () => {
    const row = {
      runtimeStageId: 'x#0',
      stageId: 'x',
      stage: 'X',
      trace: [],
      overwrite: {},
      updates: {},
      tags: 'oops',
    };
    expect(bundleRefusal(row)).toBeUndefined();
    expect(
      tagStops()
        .stopsFor([row as never])
        .map((s) => s.kind),
    ).toEqual(['start', 'end']);
  });
});
