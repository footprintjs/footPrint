/**
 * Key queries see nested rows (F3, 9.33.0, ruling R4) — the NAMED answers that change, on real charts.
 *
 * Until 9.32 every key query matched rows on the exact path. A subflow's input seed writes `cfg␟a`, an
 * outputMapper merge-back writes `cfg␟b` — so `commitValueAt`, `findLastWriter`, `sliceForKey`, `keyTimeline`
 * and `forwardSliceForKey` called such a key "never written", or answered from an older write, while the fold
 * (`stateAt`, live state) applied them. Now every reader follows `memory/keyPaths.ts`: the writer rule (a row
 * on the key, inside it, or around it when that changed it), the value rule (the fold of every row under the
 * key's top-level key) and the read rule (a read on, inside or around the key is a read of it).
 *
 *   scenario  each named change, before → after, on the chart that shows it
 *   scenario  reads ON, INSIDE and AROUND a key, on a real chart (and a dotted read key stays literal)
 *   honesty   a write that reached the key only through paths inside it carries the `'nested-rows'` note, and
 *             never ends a forward life: the anchor's, a pre-run life's and a child's readers after it are listed
 *   edge      a write BESIDE a key, through a string-valued container, moves it — the writer rule finds it
 *   scenario  R13: the merge-back and the seed are recorded under the subflow MOUNT (they were stamped with the
 *             stage before the mount, or the decider, and '' through 9.33.0)
 *   regression  a recording in the pre-R13 shape still reads with every reader, with its old answers
 */
import type { CommitBundle } from '../../../src';
import { flowChart, FlowChartExecutor } from '../../../src';
import { deepFreeze } from '../../../src/lib/capture/freeze';
import { nativeGet } from '../../../src/lib/memory/pathOps';
import { DELIM } from '../../../src/lib/memory/paths';
import {
  arrayProvenance,
  causalChain,
  commitValueAt,
  findCommit,
  findLastWriter,
  forwardSliceForKey,
  keysReadFromExecutionTree,
  keysReadFromMap,
  keyTimeline,
  sliceForKey,
  stateAt,
  timeTravel,
} from '../../../src/trace';

const at = (...segments: string[]) => segments.join(DELIM);

/** Seed `cfg = { a: 1 }`; a LINEAR mount whose outputMapper merges `{ cfg: { b: 2 } }` back; a stage that reads cfg. */
async function mergeBackRun() {
  const inner = flowChart(
    'In',
    (s: any) => {
      s.r = 1;
    },
    'in',
  ).build();
  const chart = flowChart(
    'Seed',
    (s: any) => {
      s.cfg = { a: 1 };
    },
    'seed',
  )
    .addSubFlowChart('sub', inner, 'Sub', { inputMapper: () => ({ x: 1 }), outputMapper: () => ({ cfg: { b: 2 } }) })
    .addFunction(
      'Read',
      (s: any) => {
        s.out = Object.keys(s.cfg).join(',');
      },
      'read',
    )
    .build();
  const executor = new FlowChartExecutor(chart, { writeProvenance: 'reads-prefix' });
  await executor.run();
  const snap = executor.getSnapshot();
  const log = snap.commitLog as CommitBundle[];
  const mergeBack = log.findIndex((b) => b.trace.some((t) => t.path === at('cfg', 'b')));
  return { snap, log, mergeBack, reads: keysReadFromExecutionTree(snap.executionTree) };
}

describe('R4 — a subflow merge-back is a write of the key it merges into', () => {
  it('the log: the seed sets cfg, the merge-back writes cfg␟b — a nested row', async () => {
    const { log, mergeBack } = await mergeBackRun();
    expect(log[0].trace).toEqual([{ path: 'cfg', verb: 'set', readKeys: [] }]);
    expect(mergeBack).toBe(1);
  });

  it('commitValueAt(cfg) at the merge-back: { a: 1, b: 2 } — the fold — where it answered { a: 1 }', async () => {
    const { log, mergeBack } = await mergeBackRun();
    expect(commitValueAt(log, mergeBack, 'cfg')).toEqual({ a: 1, b: 2 });
    expect(commitValueAt(log, mergeBack, 'cfg')).toEqual(stateAt({ commitLog: log }, mergeBack).state.cfg);
    expect(commitValueAt(log, mergeBack, at('cfg', 'b'))).toBe(2);
  });

  it('findLastWriter / sliceForKey anchor at the merge-back bundle, where they anchored at the seed', async () => {
    const { log, mergeBack, reads } = await mergeBackRun();
    expect(findLastWriter(log, 'cfg')?.idx).toBe(mergeBack);
    expect(sliceForKey(log, 'cfg', reads).writer?.idx).toBe(mergeBack);
    expect(findLastWriter(log, 'cfg', mergeBack)?.idx).toBe(0); // before it, the seed
  });

  it('keyTimeline: the merge-back is a write moment and the reader sits in its life; the note names it', async () => {
    const { log, mergeBack, reads } = await mergeBackRun();
    const timeline = keyTimeline(log, 'cfg', reads);
    const read = log.findIndex((b) => b.stageId === 'read');
    expect(timeline.moments?.map((m) => [m.kind, m.commitIdx, m.fromWriteIdx])).toEqual([
      ['write', 0, undefined],
      ['write', mergeBack, undefined],
      ['read', read, mergeBack],
    ]);
    expect(timeline.notes.map((n) => n.code)).toEqual(['nested-rows']);
    expect(timeline.notes[0].detail).toContain(`at commit ${mergeBack} —`);
  });

  it('forwardSliceForKey: the value it follows is the merged one, and the note says that write was partial', async () => {
    const { log, mergeBack, reads } = await mergeBackRun();
    const slice = forwardSliceForKey(log, 'cfg', reads);
    expect(slice.root?.commitIdx).toBe(mergeBack);
    expect(slice.root?.reads.map((r) => r.stageId)).toEqual(['read']);
    expect(slice.notes.map((n) => n.code)).toEqual(['nested-rows']);
  });

  it('findCommit with a key matches a commit that wrote it through a nested row', async () => {
    const { log } = await mergeBackRun();
    const onlyNested: CommitBundle[] = [log[1]]; // the merge-back alone
    expect(findCommit(onlyNested, 'sub', 'cfg')).toBe(log[1]); // the mount's commit (R13)
    expect(findCommit(onlyNested, 'sub', 'other')).toBeUndefined();
  });
});

describe('R4 — a subflow seed is a write of the key it seeds', () => {
  async function seededRun() {
    const inner = flowChart(
      'In',
      (s: any) => {
        s.y = s.cfg.a + s.cfg.b;
      },
      'in',
    ).build();
    const chart = flowChart(
      'Seed',
      (s: any) => {
        s.k = 1;
      },
      'seed',
    )
      .addSubFlowChart('sub', inner, 'Sub', {
        inputMapper: () => ({ cfg: { a: 1, b: 2 } }),
        outputMapper: (o: any) => ({ y: o.y }),
      })
      .build();
    const executor = new FlowChartExecutor(chart);
    await executor.run();
    const snap = executor.getSnapshot();
    const sub = (snap.subflowResults as Record<string, any>).sub.treeContext;
    return { history: sub.history as CommitBundle[], reads: keysReadFromExecutionTree(snap.executionTree) };
  }

  it('the seed bundle writes cfg␟a and cfg␟b', async () => {
    const { history } = await seededRun();
    expect(history[0].trace.map((t) => t.path)).toEqual([at('cfg', 'a'), at('cfg', 'b')]);
  });

  it('findLastWriter(cfg) finds the seed and commitValueAt(cfg) is { a: 1, b: 2 } — both answered "never"', async () => {
    const { history } = await seededRun();
    expect(findLastWriter(history, 'cfg')?.idx).toBe(0);
    expect(commitValueAt(history, 0, 'cfg')).toEqual({ a: 1, b: 2 });
  });

  it("sliceForKey(cfg) has a writer, where it answered missing: 'never-written'", async () => {
    const { history, reads } = await seededRun();
    const slice = sliceForKey(history, 'cfg', reads);
    expect(slice.missing).toBeUndefined();
    expect(slice.writer?.idx).toBe(0);
  });
});

describe('R4 — a row AROUND a nested key: it writes the key only when it changed it', () => {
  async function aroundRun() {
    const chart = flowChart(
      'Seed',
      (s: any) => {
        s.cfg = { a: 1, list: [1, 2] };
      },
      'seed',
    )
      .addFunction('More', (s: any) => s.$update('cfg', { list: [3] }), 'more')
      .build();
    const executor = new FlowChartExecutor(chart);
    await executor.run();
    return executor.getSnapshot().commitLog as CommitBundle[];
  }

  it('commitValueAt of a nested key folds the container: cfg␟a is 1, cfg␟list is [1, 2, 3] — both answered undefined', async () => {
    const log = await aroundRun();
    expect(log.map((b) => b.trace.map((t) => `${t.verb} ${t.path}`))).toEqual([['set cfg'], ['merge cfg']]);
    expect(commitValueAt(log, 0, at('cfg', 'a'))).toBe(1);
    expect(commitValueAt(log, 1, at('cfg', 'list'))).toEqual([1, 2, 3]);
  });

  it('findLastWriter(cfg␟a) is the set of cfg, NOT the merge of cfg that never reached a', async () => {
    const log = await aroundRun();
    expect(findLastWriter(log, at('cfg', 'a'))?.idx).toBe(0);
    expect(findLastWriter(log, at('cfg', 'list'))?.idx).toBe(1);
  });

  it("arrayProvenance(['cfg', 'list']) has births, where it answered missing: 'never-written'", async () => {
    const log = await aroundRun();
    const prov = arrayProvenance(log, ['cfg', 'list']);
    expect(prov.births?.map((b) => [b.commitIdx, b.basis])).toEqual([
      [0, 'whole-value'],
      [0, 'whole-value'],
      [1, 'prefix-inference'],
    ]);
  });
});

describe('R4 — delta mode: a merge-back into an object and an append to an array', () => {
  it('commitValueAt(obj) carries the merged-back field; the appended list folds as before', async () => {
    const inner = flowChart(
      'In',
      (s: any) => {
        s.r = 1;
      },
      'in',
    ).build();
    const chart = flowChart(
      'Seed',
      (s: any) => {
        s.obj = { x: 0 };
        s.list = [1];
      },
      'seed',
    )
      .addSubFlowChart('sub', inner, 'Sub', {
        inputMapper: () => ({}),
        outputMapper: () => ({ obj: { deep: { q: 1 } }, list: [7] }),
      })
      .build();
    const executor = new FlowChartExecutor(chart, { commitValues: 'delta' });
    await executor.run();
    const log = executor.getSnapshot().commitLog as CommitBundle[];
    const last = log.length - 1;
    expect(commitValueAt(log, last, 'obj')).toEqual({ x: 0, deep: { q: 1 } });
    expect(commitValueAt(log, last, 'list')).toEqual([1, 7]);
    expect(arrayProvenance(log, 'list').births?.map((b) => b.basis)).toEqual(['whole-value', 'append-verb']);
  });
});

describe('READS — on, inside and around the key (a real chart)', () => {
  it('AROUND: a stage that read cfg read cfg␟b — it sits in the life of the merge-back that wrote cfg␟b', async () => {
    const { log, mergeBack, reads } = await mergeBackRun();
    const read = log.findIndex((b) => b.stageId === 'read');
    const timeline = keyTimeline(log, ['cfg', 'b'], reads);
    expect(timeline.moments?.map((m) => [m.kind, m.commitIdx, m.fromWriteIdx])).toEqual([
      ['write', mergeBack, undefined],
      ['read', read, mergeBack],
    ]);
    const slice = forwardSliceForKey(log, ['cfg', 'b'], reads);
    expect(slice.root?.reads.map((r) => r.commitIdx)).toEqual([read]);
    // per-write provenance: the reader's write of `out` read cfg — around cfg␟b — so the fed edge is exact
    expect(slice.root?.fedEdges.map((e) => [e.child.key, e.basis])).toEqual([['out', 'per-write']]);
  });

  it('INSIDE: a reads provider that names cfg␟a names a reader of cfg', async () => {
    const { log, mergeBack } = await mergeBackRun();
    const read = log.findIndex((b) => b.stageId === 'read');
    const provider = keysReadFromMap({ [log[read].runtimeStageId]: [at('cfg', 'a')] });
    expect(
      keyTimeline(log, 'cfg', provider)
        .moments?.filter((m) => m.kind === 'read')
        .map((m) => m.commitIdx),
    ).toEqual([read]);
    expect(forwardSliceForKey(log, 'cfg', provider).root?.reads.map((r) => r.commitIdx)).toEqual([read]);
    expect(forwardSliceForKey(log, 'cfg', provider).root?.commitIdx).toBe(mergeBack);
  });

  it('a DOTTED read key stays the literal key it may be — "cfg.a" is not a read inside cfg', async () => {
    const { log } = await mergeBackRun();
    const read = log.findIndex((b) => b.stageId === 'read');
    const provider = keysReadFromMap({ [log[read].runtimeStageId]: ['cfg.a'] });
    expect(keyTimeline(log, 'cfg', provider).moments?.filter((m) => m.kind === 'read')).toEqual([]);
  });

  it('a key that is only READ around, never written, is known — not an unknown key', async () => {
    const { log, reads } = await mergeBackRun();
    const timeline = keyTimeline(log, ['cfg', 'zzz'], reads);
    expect(timeline.missing).toBeUndefined();
    expect(timeline.notes.map((n) => n.code)).not.toContain('unknown-key');
  });
});

describe("FORWARD — a write inside the key does not end a value's life, and every such life says so", () => {
  it("the anchor: the seed's life runs past the merge-back, so the Read stage that read cfg.a from the seed is listed", async () => {
    const { log, mergeBack, reads } = await mergeBackRun();
    const read = log.findIndex((b) => b.stageId === 'read');
    const slice = forwardSliceForKey(log, 'cfg', reads, { before: 1 });
    expect(slice.root?.commitIdx).toBe(0);
    expect(slice.root?.nextWriteIdx).toBeUndefined(); // the merge-back changed part of the value; it does not close the life
    expect(slice.root?.reads.map((r) => r.commitIdx)).toEqual([read]);
    expect(slice.notes.map((n) => n.code)).toEqual(['nested-rows']);
    expect(slice.notes[0].detail).toContain(`at commit ${mergeBack} —`);
  });

  it('a pre-run life: a seeded key read before and after a merge-back keeps both readers', async () => {
    const inner = flowChart(
      'In',
      (s: any) => {
        s.r = 1;
      },
      'in',
    ).build();
    const chart = flowChart(
      'Before',
      (s: any) => {
        s.out1 = s.cfg.a;
      },
      'before',
    )
      .addSubFlowChart('sub', inner, 'Sub', { inputMapper: () => ({}), outputMapper: () => ({ cfg: { b: 2 } }) })
      .addFunction(
        'After',
        (s: any) => {
          s.out2 = Object.keys(s.cfg).join(',');
        },
        'after',
      )
      .build();
    const executor = new FlowChartExecutor(chart, { initialContext: { cfg: { a: 1 } } });
    await executor.run();
    const snap = executor.getSnapshot();
    const log = snap.commitLog as CommitBundle[];
    const mergeBack = log.findIndex((b) => b.trace.some((t) => t.path === at('cfg', 'b')));
    const slice = forwardSliceForKey(log, 'cfg', keysReadFromExecutionTree(snap.executionTree), { before: mergeBack });
    expect(slice.root?.origin).toBe('pre-run');
    // Each reader once: the merge-back is the mount's commit (R13), so Before's reads are named at Before's
    // commit only. Through 9.33.0 it carried Before's runtimeStageId and Before was listed twice.
    expect(slice.root?.reads.map((r) => r.stageId)).toEqual(['before', 'after']);
    expect(slice.notes.map((n) => n.code)).toContain('nested-rows');
  });

  it('a child life: a value fed into cfg, then crossed by a merge-back, keeps its later reader', async () => {
    const inner = flowChart(
      'In',
      (s: any) => {
        s.r = 1;
      },
      'in',
    ).build();
    const chart = flowChart(
      'Seed',
      (s: any) => {
        s.src = 1;
      },
      'seed',
    )
      .addFunction(
        'Make',
        (s: any) => {
          s.cfg = { a: s.src };
        },
        'make',
      )
      .addSubFlowChart('sub', inner, 'Sub', { inputMapper: () => ({}), outputMapper: () => ({ cfg: { b: 2 } }) })
      .addFunction(
        'Read',
        (s: any) => {
          s.out = s.cfg.a;
        },
        'read',
      )
      .build();
    const executor = new FlowChartExecutor(chart);
    await executor.run();
    const snap = executor.getSnapshot();
    const log = snap.commitLog as CommitBundle[];
    const slice = forwardSliceForKey(log, 'src', keysReadFromExecutionTree(snap.executionTree));
    const child = slice.root?.fedEdges.find((e) => e.child.key === 'cfg')?.child;
    expect(child?.reads.map((r) => r.stageId)).toEqual(['read']);
    expect(slice.notes.map((n) => n.code)).toContain('nested-rows');
  });
});

describe('WRITER RULE — a write BESIDE a key through a string-valued container moves the key (review fix 4)', () => {
  // commit 1 merges r with the string 'ab', so r␟1 reads 'b'; commit 2 writes r␟a␟1 THROUGH that string, which
  // nativeSet replaces with an object — r␟1 is gone. No row of commit 2 is on, inside or around r␟1.
  const hand = () => {
    const bundle = (
      n: number,
      trace: CommitBundle['trace'],
      overwrite: object,
      updates: object = {},
    ): CommitBundle => ({
      idx: n,
      stage: `S${n}`,
      stageId: `s${n}`,
      runtimeStageId: `s${n}#${n}`,
      trace,
      overwrite,
      updates,
      redactedPaths: [],
    });
    return [
      bundle(0, [{ path: 'other', verb: 'set' }], { other: 1 }),
      bundle(1, [{ path: 'r', verb: 'merge' }], {}, { r: 'ab' }),
      bundle(2, [{ path: at('r', 'a', '1'), verb: 'set' }], { r: { a: { 1: 'x' } } }),
    ];
  };

  it('findLastWriter(r␟1) is commit 2 — where stateAt changes — on a hand-built log and on a frozen one', () => {
    for (const log of [hand(), deepFreeze(hand(), 'indices')]) {
      expect(nativeGet(stateAt({ commitLog: log }, 1).state, ['r', '1'])).toBe('b');
      expect(nativeGet(stateAt({ commitLog: log }, 2).state, ['r', '1'])).toBeUndefined();
      expect(findLastWriter(log, at('r', '1'), 3)?.idx).toBe(2);
      expect(findLastWriter(log, at('r', '1'), 2)?.idx).toBe(1);
      expect(commitValueAt(log, 1, at('r', '1'))).toBe('b');
      expect(commitValueAt(log, 2, at('r', '1'))).toBeUndefined();
    }
  });
});

describe('arrayProvenance — an append AROUND the key is a whole-value change, not a tail (counterexample, seed 567362012)', () => {
  // Bundle 1's `append a` carries a non-array tail, so it REPLACES `a` — and `a␟b` with it. Read as a tail of
  // `a␟b`, it kept two births for a one-element array, and the next append made three for two.
  it('births stay aligned with the value', () => {
    const bundle = (n: number, trace: CommitBundle['trace']): CommitBundle => ({
      idx: n,
      stage: 'S',
      stageId: `s${n}`,
      runtimeStageId: `s${n}#${n}`,
      trace,
      overwrite: { a: { b: [{ n: 0 }] } },
      updates: {},
      redactedPaths: [],
    });
    const key = at('a', 'b');
    const log = [
      bundle(0, [
        { path: 'a', verb: 'set' },
        { path: key, verb: 'append' },
      ]),
      bundle(1, [
        { path: 'a', verb: 'append' },
        { path: key, verb: 'append' },
      ]),
    ];
    const prov = arrayProvenance(log, ['a', 'b'], { atIdx: 1 });
    expect(commitValueAt(log, 1, key)).toEqual([{ n: 0 }, { n: 0 }]);
    expect(prov.length).toBe(2);
    expect(prov.births?.map((b) => [b.index, b.commitIdx, b.basis])).toEqual([
      [0, 1, 'whole-value'],
      [1, 1, 'append-verb'],
    ]);
  });
});

describe('R13 — the merge-back and the seed are recorded under the subflow MOUNT', () => {
  // `SubflowExecutor · executeSubflow` stages and commits the output mapping on the MOUNT's frame (at its parent's
  // address, so the values land where they always did), and stamps the subflow's seed with the mount's names.
  // Through 9.33.0 the merge-back was committed on the frame before a branch / fork-child mount — its bundle named
  // the stage before the mount, or the decider — and the seed carried runtimeStageId ''.

  async function linearMountRun() {
    const inner = flowChart(
      'In',
      (s: any) => {
        s.r = 1;
      },
      'in',
    ).build();
    const chart = flowChart(
      'A',
      (s: any) => {
        s.cfg = { a: 1 };
      },
      'a',
    )
      .addFunction(
        'B',
        (s: any) => {
          s.b = 1;
        },
        'b',
      )
      .addSubFlowChart('sub', inner, 'Sub', {
        inputMapper: () => ({ seeded: 1 }),
        outputMapper: () => ({ cfg: { m: 2 } }),
      })
      .build();
    const executor = new FlowChartExecutor(chart);
    await executor.run();
    return executor.getSnapshot();
  }

  it("a fork-child mount: the merge-back is the first of the mount's three bundles", async () => {
    const log = (await linearMountRun()).commitLog as CommitBundle[];
    expect(log.map((b) => [b.runtimeStageId, b.stageId, b.trace.map((t) => t.path)])).toEqual([
      ['a#0', 'a', ['cfg']],
      ['b#1', 'b', ['b']],
      ['sub#2', 'sub', [at('cfg', 'm')]],
      ['sub#2', 'sub', []],
      ['sub#2', 'sub', []],
    ]);
    expect(findLastWriter(log, 'cfg')?.runtimeStageId).toBe('sub#2');
    expect(findLastWriter(log, 'b')?.runtimeStageId).toBe('b#1');
  });

  it('a decider-branch mount: the merge-back bundle names the branch mount, not the decider', async () => {
    const inner = flowChart(
      'In',
      (s: any) => {
        s.r = 1;
      },
      'in',
    ).build();
    const chart = flowChart(
      'A',
      (s: any) => {
        s.cfg = { a: 1 };
      },
      'a',
    )
      .addDeciderFunction('D', () => 'go', 'd')
      .addSubFlowChartBranch('go', inner, 'Go', { inputMapper: () => ({}), outputMapper: () => ({ cfg: { m: 3 } }) })
      .end()
      .build();
    const executor = new FlowChartExecutor(chart);
    await executor.run();
    const log = executor.getSnapshot().commitLog as CommitBundle[];
    const mergeBack = log.find((b) => b.trace.some((t) => t.path === at('cfg', 'm')))!;
    expect([mergeBack.runtimeStageId, mergeBack.stageId, mergeBack.stage]).toEqual(['go#2', 'go', 'Go']);
    expect(log.filter((b) => b.runtimeStageId === 'd#1').every((b) => b.trace.length === 0)).toBe(true);
  });

  it("a causal walk from the reader reaches the merge-back as the mount's own commit", async () => {
    const { log, mergeBack, reads } = await mergeBackRun();
    const readId = log.find((b) => b.stageId === 'read')!.runtimeStageId;
    const root = causalChain(log, readId, reads.lookup);
    expect(log[mergeBack].runtimeStageId).toBe('sub#1');
    expect(root?.parents.map((p) => p.runtimeStageId)).toEqual(['sub#1']);
  });

  it("a subflow's input seed names its mount", async () => {
    const snap = await linearMountRun();
    const history = (snap.subflowResults as Record<string, any>).sub.treeContext.history as CommitBundle[];
    expect([history[0].runtimeStageId, history[0].stageId, history[0].stage]).toEqual(['sub#2', 'sub', 'Sub']);
    expect(findLastWriter(history, 'seeded')?.runtimeStageId).toBe('sub#2');
    // The drilled cursor still folds the seed into its 'start' bookend — the input the subflow began with.
    const inner = timeTravel(snap).drill('sub#2')!;
    expect(inner.stops.map((s) => s.kind)).toEqual(['start', 'commit', 'end']);
    expect(inner.stops[0].lastCommitIdx).toBe(0);
  });
});

describe('a recording in the pre-R13 shape (through 9.33.0) still reads, with its old answers', () => {
  /** Put a run back into the old shape: the merge-back named after the stage before the mount, the seed ''. */
  function asRecordedThrough933(snap: any) {
    const old = structuredClone(snap);
    const log = old.commitLog as CommitBundle[];
    const merge = log.findIndex((b) => b.trace.some((t) => t.path === at('cfg', 'm')));
    Object.assign(log[merge], { stage: 'B', stageId: 'b', runtimeStageId: 'b#1' });
    for (const result of Object.values(old.subflowResults as Record<string, any>)) {
      Object.assign(result.treeContext.history[0], { stage: 'In', stageId: 'sub/in', runtimeStageId: '' });
    }
    return old;
  }

  it('every reader answers on it without throwing', async () => {
    const inner = flowChart(
      'In',
      (s: any) => {
        s.r = 1;
      },
      'in',
    ).build();
    const chart = flowChart(
      'A',
      (s: any) => {
        s.cfg = { a: 1 };
      },
      'a',
    )
      .addFunction(
        'B',
        (s: any) => {
          s.b = 1;
        },
        'b',
      )
      .addSubFlowChart('sub', inner, 'Sub', {
        inputMapper: () => ({ seeded: 1 }),
        outputMapper: () => ({ cfg: { m: 2 } }),
      })
      .addFunction(
        'C',
        (s: any) => {
          s.c = Object.keys(s.cfg).join(',');
        },
        'c',
      )
      .build();
    const executor = new FlowChartExecutor(chart);
    await executor.run();
    const old = asRecordedThrough933(executor.getSnapshot());
    const log = old.commitLog as CommitBundle[];
    const reads = keysReadFromExecutionTree(old.executionTree);
    const history = old.subflowResults.sub.treeContext.history as CommitBundle[];

    expect(findLastWriter(log, 'cfg')?.runtimeStageId).toBe('b#1'); // the old (wrong) name, read as recorded
    expect(commitValueAt(log, log.length - 1, 'cfg')).toEqual({ a: 1, m: 2 });
    expect(causalChain(log, 'c#4', reads.lookup)?.parents.map((p) => p.runtimeStageId)).toEqual(['b#1']);
    expect(sliceForKey(log, 'cfg', reads)).toBeDefined();
    expect(forwardSliceForKey(log, 'cfg', reads).root).toBeDefined();
    expect(keyTimeline(log, 'cfg', reads).missing).toBeUndefined();
    expect(stateAt({ commitLog: log }, log.length - 1).state).toMatchObject({ cfg: { a: 1, m: 2 } });
    expect(findLastWriter(history, 'seeded')?.runtimeStageId).toBe('');
    const cursor = timeTravel(old);
    expect(cursor.stops.map((s) => s.runtimeStageId)).toEqual(['', 'a#0', 'b#1', 'sub#2', 'c#4', '']);
    const drilled = cursor.drill('sub#2')!;
    expect(drilled.stops.map((s) => s.kind)).toEqual(['start', 'commit', 'end']);
    expect(drilled.stops[0].lastCommitIdx).toBe(0); // the id-less seed folds into 'start', as before
  });
});
