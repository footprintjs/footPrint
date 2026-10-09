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
 *   regression  a recording in the pre-R13 shape still reads with every reader, with its old answers
 *
 * The records are written through footprintjs/write (test/helpers/recordRun.ts): a subflow mount as the parent
 * log holds it — its merge-back rows, then its `'exit'` and `'repeat'` continuations — and the subflow's own log
 * where a test reads it; the same commit logs, byte for byte, the charts wrote through the engine (E1). R13 (the
 * engine stamps the merge-back and the seed with the MOUNT's names) is the engine's own behaviour: it lives in
 * nested-rows.engine.test.ts.
 */
import { deepFreeze } from '../../../src/lib/capture/freeze';
import { nativeGet } from '../../../src/lib/memory/pathOps';
import { DELIM } from '../../../src/lib/memory/paths';
import type { CommitBundle, ExecutionTree } from '../../../src/trace';
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
import { type RecordRun, type StepScope, recordRun } from '../../helpers/recordRun';

const at = (...segments: string[]) => segments.join(DELIM);

/**
 * As the engine's tree: a subflow mount (`mountId`) hangs under the stage before it, as its one child carrying its
 * `subflowId`, and that stage's `next` is the stage after the mount (`recordRun` writes a linear chart's tree).
 */
function withMount(node: ExecutionTree, mountId: string): ExecutionTree {
  const { next, ...rest } = node;
  if (!next) return rest;
  if (next.id !== mountId) return { ...rest, next: withMount(next, mountId) };
  const { next: after, ...mount } = next;
  return { ...rest, children: [{ ...mount, subflowId: mountId }], ...(after && { next: withMount(after, mountId) }) };
}

/**
 * A linear mount `sub` ('Sub') on the parent's log: the outputMapper's merge-back rows, then the mount's exit and the
 * fork-child settle — continuations of the same execution (`phase`). Its inner stages run on the subflow's own log,
 * so they take numbers from the parent's counter: a stage after the mount names its runtimeStageId.
 */
function mount(run: RecordRun, mergeBack: (s: StepScope) => void): void {
  run.step('sub', mergeBack, { name: 'Sub' });
  run.step('sub', undefined, { name: 'Sub', phase: 'exit' });
  run.step('sub', undefined, { name: 'Sub', phase: 'repeat' });
}

/** Seed `cfg = { a: 1 }`; a LINEAR mount whose outputMapper merges `{ cfg: { b: 2 } }` back; a stage that reads cfg. */
function mergeBackRun() {
  const run = recordRun({}, { writeProvenance: 'reads-prefix' });
  run.step('seed', (s) => s.set('cfg', { a: 1 }), { name: 'Seed' });
  mount(run, (s) => s.set('b', 2, undefined, ['cfg']));
  run.step('read', (s) => s.set('out', Object.keys(s.read('cfg') as object).join(',')), {
    name: 'Read',
    runtimeStageId: 'read#3', // sub/in#2 ran on the subflow's log
  });
  const snap = run.snapshot();
  const log = snap.commitLog;
  const mergeBack = log.findIndex((b) => b.trace.some((t) => t.path === at('cfg', 'b')));
  return { log, mergeBack, reads: keysReadFromExecutionTree(withMount(snap.executionTree!, 'sub')) };
}

describe('R4 — a subflow merge-back is a write of the key it merges into', () => {
  it('the log: the seed sets cfg, the merge-back writes cfg␟b — a nested row', () => {
    const { log, mergeBack } = mergeBackRun();
    expect(log[0].trace).toEqual([{ path: 'cfg', verb: 'set', readKeys: [] }]);
    expect(mergeBack).toBe(1);
  });

  it('commitValueAt(cfg) at the merge-back: { a: 1, b: 2 } — the fold — where it answered { a: 1 }', () => {
    const { log, mergeBack } = mergeBackRun();
    expect(commitValueAt(log, mergeBack, 'cfg')).toEqual({ a: 1, b: 2 });
    expect(commitValueAt(log, mergeBack, 'cfg')).toEqual(stateAt({ commitLog: log }, mergeBack).state.cfg);
    expect(commitValueAt(log, mergeBack, at('cfg', 'b'))).toBe(2);
  });

  it('findLastWriter / sliceForKey anchor at the merge-back bundle, where they anchored at the seed', () => {
    const { log, mergeBack, reads } = mergeBackRun();
    expect(findLastWriter(log, 'cfg')?.idx).toBe(mergeBack);
    expect(sliceForKey(log, 'cfg', reads).writer?.idx).toBe(mergeBack);
    expect(findLastWriter(log, 'cfg', mergeBack)?.idx).toBe(0); // before it, the seed
  });

  it('keyTimeline: the merge-back is a write moment and the reader sits in its life; the note names it', () => {
    const { log, mergeBack, reads } = mergeBackRun();
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

  it('forwardSliceForKey: the value it follows is the merged one, and the note says that write was partial', () => {
    const { log, mergeBack, reads } = mergeBackRun();
    const slice = forwardSliceForKey(log, 'cfg', reads);
    expect(slice.root?.commitIdx).toBe(mergeBack);
    expect(slice.root?.reads.map((r) => r.stageId)).toEqual(['read']);
    expect(slice.notes.map((n) => n.code)).toEqual(['nested-rows']);
  });

  it('findCommit with a key matches a commit that wrote it through a nested row', () => {
    const { log } = mergeBackRun();
    const onlyNested: CommitBundle[] = [log[1]]; // the merge-back alone
    expect(findCommit(onlyNested, 'sub', 'cfg')).toBe(log[1]); // the mount's commit (R13)
    expect(findCommit(onlyNested, 'sub', 'other')).toBeUndefined();
  });
});

describe('R4 — a subflow seed is a write of the key it seeds', () => {
  /** Seed `k`; a mount whose inputMapper seeds `{ cfg: { a: 1, b: 2 } }` and whose inner stage reads cfg → y. */
  function seededRun() {
    const parent = recordRun();
    parent.step('seed', (s) => s.set('k', 1), { name: 'Seed' });
    mount(parent, (s) => s.set('y', 3));
    // The subflow's own log: its seed (stamped with the mount's names), then its stage.
    const sub = recordRun();
    sub.step(
      'sub',
      (s) => {
        s.set('a', 1, undefined, ['cfg']);
        s.set('b', 2, undefined, ['cfg']);
      },
      { name: 'Sub', runtimeStageId: 'sub#1' },
    );
    sub.step(
      'sub/in',
      (s) => {
        const cfg = s.read('cfg') as { a: number; b: number };
        s.set('y', cfg.a + cfg.b);
      },
      { name: 'sub/In', runtimeStageId: 'sub/in#2' },
    );
    return {
      history: sub.snapshot().commitLog,
      reads: keysReadFromExecutionTree(withMount(parent.snapshot().executionTree!, 'sub')),
    };
  }

  it('the seed bundle writes cfg␟a and cfg␟b', () => {
    const { history } = seededRun();
    expect(history[0].trace.map((t) => t.path)).toEqual([at('cfg', 'a'), at('cfg', 'b')]);
  });

  it('findLastWriter(cfg) finds the seed and commitValueAt(cfg) is { a: 1, b: 2 } — both answered "never"', () => {
    const { history } = seededRun();
    expect(findLastWriter(history, 'cfg')?.idx).toBe(0);
    expect(commitValueAt(history, 0, 'cfg')).toEqual({ a: 1, b: 2 });
  });

  it("sliceForKey(cfg) has a writer, where it answered missing: 'never-written'", () => {
    const { history, reads } = seededRun();
    const slice = sliceForKey(history, 'cfg', reads);
    expect(slice.missing).toBeUndefined();
    expect(slice.writer?.idx).toBe(0);
  });
});

describe('R4 — a row AROUND a nested key: it writes the key only when it changed it', () => {
  /** Seed `cfg = { a: 1, list: [1, 2] }`; More `$update`s cfg with `{ list: [3] }` (a merge, no tracked read). */
  function aroundRun() {
    const run = recordRun();
    run.step('seed', (s) => s.set('cfg', { a: 1, list: [1, 2] }), { name: 'Seed' });
    run.step('more', (s) => s.merge('cfg', { list: [3] }), { name: 'More' });
    return run.snapshot().commitLog;
  }

  it('commitValueAt of a nested key folds the container: cfg␟a is 1, cfg␟list is [1, 2, 3] — both answered undefined', () => {
    const log = aroundRun();
    expect(log.map((b) => b.trace.map((t) => `${t.verb} ${t.path}`))).toEqual([['set cfg'], ['merge cfg']]);
    expect(commitValueAt(log, 0, at('cfg', 'a'))).toBe(1);
    expect(commitValueAt(log, 1, at('cfg', 'list'))).toEqual([1, 2, 3]);
  });

  it('findLastWriter(cfg␟a) is the set of cfg, NOT the merge of cfg that never reached a', () => {
    const log = aroundRun();
    expect(findLastWriter(log, at('cfg', 'a'))?.idx).toBe(0);
    expect(findLastWriter(log, at('cfg', 'list'))?.idx).toBe(1);
  });

  it("arrayProvenance(['cfg', 'list']) has births, where it answered missing: 'never-written'", () => {
    const log = aroundRun();
    const prov = arrayProvenance(log, ['cfg', 'list']);
    expect(prov.births?.map((b) => [b.commitIdx, b.basis])).toEqual([
      [0, 'whole-value'],
      [0, 'whole-value'],
      [1, 'prefix-inference'],
    ]);
  });
});

describe('R4 — delta mode: a merge-back into an object and an append to an array', () => {
  it('commitValueAt(obj) carries the merged-back field; the appended list folds as before', () => {
    // Seed obj + list; a mount whose outputMapper merges `{ obj: { deep: { q: 1 } }, list: [7] }` back (it reads
    // obj.deep first; arrays CONCAT, so list becomes [1, 7]).
    const run = recordRun({}, { commitValues: 'delta' });
    run.step(
      'seed',
      (s) => {
        s.set('obj', { x: 0 });
        s.set('list', [1]);
      },
      { name: 'Seed' },
    );
    mount(run, (s) => {
      s.read('deep', ['obj']);
      s.set('deep', { q: 1 }, undefined, ['obj']);
      s.set('list', [1, 7]);
    });
    const log = run.snapshot().commitLog;
    const last = log.length - 1;
    expect(commitValueAt(log, last, 'obj')).toEqual({ x: 0, deep: { q: 1 } });
    expect(commitValueAt(log, last, 'list')).toEqual([1, 7]);
    expect(arrayProvenance(log, 'list').births?.map((b) => b.basis)).toEqual(['whole-value', 'append-verb']);
  });
});

describe('READS — on, inside and around the key (a real chart)', () => {
  it('AROUND: a stage that read cfg read cfg␟b — it sits in the life of the merge-back that wrote cfg␟b', () => {
    const { log, mergeBack, reads } = mergeBackRun();
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

  it('INSIDE: a reads provider that names cfg␟a names a reader of cfg', () => {
    const { log, mergeBack } = mergeBackRun();
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

  it('a DOTTED read key stays the literal key it may be — "cfg.a" is not a read inside cfg', () => {
    const { log } = mergeBackRun();
    const read = log.findIndex((b) => b.stageId === 'read');
    const provider = keysReadFromMap({ [log[read].runtimeStageId]: ['cfg.a'] });
    expect(keyTimeline(log, 'cfg', provider).moments?.filter((m) => m.kind === 'read')).toEqual([]);
  });

  it('a key that is only READ around, never written, is known — not an unknown key', () => {
    const { log, reads } = mergeBackRun();
    const timeline = keyTimeline(log, ['cfg', 'zzz'], reads);
    expect(timeline.missing).toBeUndefined();
    expect(timeline.notes.map((n) => n.code)).not.toContain('unknown-key');
  });
});

describe("FORWARD — a write inside the key does not end a value's life, and every such life says so", () => {
  it("the anchor: the seed's life runs past the merge-back, so the Read stage that read cfg.a from the seed is listed", () => {
    const { log, mergeBack, reads } = mergeBackRun();
    const read = log.findIndex((b) => b.stageId === 'read');
    const slice = forwardSliceForKey(log, 'cfg', reads, { before: 1 });
    expect(slice.root?.commitIdx).toBe(0);
    expect(slice.root?.nextWriteIdx).toBeUndefined(); // the merge-back changed part of the value; it does not close the life
    expect(slice.root?.reads.map((r) => r.commitIdx)).toEqual([read]);
    expect(slice.notes.map((n) => n.code)).toEqual(['nested-rows']);
    expect(slice.notes[0].detail).toContain(`at commit ${mergeBack} —`);
  });

  it('a pre-run life: a seeded key read before and after a merge-back keeps both readers', () => {
    // Seeded `cfg = { a: 1 }`; Before reads cfg → out1; a mount merges `{ cfg: { b: 2 } }` back; After reads cfg.
    const run = recordRun({ cfg: { a: 1 } });
    run.step('before', (s) => s.set('out1', (s.read('cfg') as { a: number }).a), { name: 'Before' });
    mount(run, (s) => s.set('b', 2, undefined, ['cfg']));
    run.step('after', (s) => s.set('out2', Object.keys(s.read('cfg') as object).join(',')), {
      name: 'After',
      runtimeStageId: 'after#3', // sub/in#2 ran on the subflow's log
    });
    const snap = run.snapshot();
    const log = snap.commitLog;
    const mergeBack = log.findIndex((b) => b.trace.some((t) => t.path === at('cfg', 'b')));
    const slice = forwardSliceForKey(log, 'cfg', keysReadFromExecutionTree(withMount(snap.executionTree!, 'sub')), {
      before: mergeBack,
    });
    expect(slice.root?.origin).toBe('pre-run');
    // Each reader once: the merge-back is the mount's commit (R13), so Before's reads are named at Before's
    // commit only. Through 9.33.0 it carried Before's runtimeStageId and Before was listed twice.
    expect(slice.root?.reads.map((r) => r.stageId)).toEqual(['before', 'after']);
    expect(slice.notes.map((n) => n.code)).toContain('nested-rows');
  });

  it('a child life: a value fed into cfg, then crossed by a merge-back, keeps its later reader', () => {
    // Seed src; Make reads src → cfg = { a: src }; a mount merges `{ cfg: { b: 2 } }` back; Read reads cfg → out.
    const run = recordRun();
    run.step('seed', (s) => s.set('src', 1), { name: 'Seed' });
    run.step('make', (s) => s.set('cfg', { a: s.read('src') }), { name: 'Make' });
    mount(run, (s) => s.set('b', 2, undefined, ['cfg']));
    run.step('read', (s) => s.set('out', (s.read('cfg') as { a: number }).a), {
      name: 'Read',
      runtimeStageId: 'read#4', // sub/in#3 ran on the subflow's log
    });
    const snap = run.snapshot();
    const log = snap.commitLog;
    const slice = forwardSliceForKey(log, 'src', keysReadFromExecutionTree(withMount(snap.executionTree!, 'sub')));
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

  /**
   * A, B, a linear mount `sub` (its inputMapper seeds `{ seeded: 1 }`, its outputMapper merges `{ cfg: { m: 2 } }`
   * back), C reads cfg — as a snapshot: the parent's log and tree, and the subflow's result under both of its keys
   * (path and execution). The result carries what the readers read of it (`subflowId`, the history, its fold base,
   * its tree); the engine's `globalContext`, `logAddress` and `parentStageId` are left out — no reader here reads them.
   */
  function preR13Run() {
    const run = recordRun();
    run.step('a', (s) => s.set('cfg', { a: 1 }), { name: 'A' });
    run.step('b', (s) => s.set('b', 1), { name: 'B' });
    mount(run, (s) => s.set('m', 2, undefined, ['cfg']));
    run.step('c', (s) => s.set('c', Object.keys(s.read('cfg') as object).join(',')), {
      name: 'C',
      runtimeStageId: 'c#4', // sub/in#3 ran on the subflow's log
    });
    const sub = recordRun();
    sub.step('sub', (s) => s.set('seeded', 1), { name: 'Sub', runtimeStageId: 'sub#2' });
    sub.step('sub/in', (s) => s.set('r', 1), { name: 'sub/In', runtimeStageId: 'sub/in#3' });
    const inner = sub.snapshot();
    const result = {
      subflowId: 'sub',
      subflowName: 'Sub',
      // The subflow's tree starts at its first stage: the seed is the mount's commit, not a stage of it.
      treeContext: {
        stageContexts: inner.executionTree!.next,
        history: inner.commitLog,
        initialState: inner.initialState,
      },
    };
    const snap = run.snapshot();
    return {
      ...snap,
      executionTree: withMount(snap.executionTree!, 'sub'),
      subflowResults: { sub: result, 'sub#2': result },
    };
  }

  it('every reader answers on it without throwing', () => {
    const old = asRecordedThrough933(preR13Run());
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
