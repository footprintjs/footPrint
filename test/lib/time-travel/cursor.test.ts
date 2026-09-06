/**
 * The reader's cursor: stops, movement, marks, and the strategy seam.
 *
 * The law under every movement test is the same one: A MISS NEVER MOVES. A
 * refused move returns why, and leaves the cursor exactly where it was — so a
 * panel showing step 4 keeps showing step 4 when someone mistypes an id.
 */

import fc from 'fast-check';

import type { CommitBundle } from '../../../src/lib/memory/types.js';
import type { TimeTravelStrategy } from '../../../src/trace.js';
import { commitStops, commitValueAt, stateAt, timeTravel } from '../../../src/trace.js';

// ── A tiny hand-built log, so the axis is fully predictable ────────────────

function bundle(stageId: string, idx: number, writes: Record<string, unknown>, rtid?: string): CommitBundle {
  return {
    idx,
    stage: stageId.toUpperCase(),
    stageId,
    runtimeStageId: rtid ?? `${stageId}#${idx}`,
    trace: Object.keys(writes).map((path) => ({ path, verb: 'set' as const })),
    redactedPaths: [],
    overwrite: { ...writes },
    updates: {},
  };
}

function tinyRun() {
  return {
    initialState: { seeded: true },
    commitLog: [bundle('a', 0, { x: 1 }), bundle('b', 1, { y: 2 }), bundle('c', 2, { z: 3 })],
  };
}

describe('commitStops', () => {
  it('bookends one stop per stage', () => {
    const stops = commitStops(tinyRun().commitLog);
    expect(stops.map((s) => [s.kind, s.stageId, s.commitIdx, s.lastCommitIdx])).toEqual([
      ['start', '', -1, -1],
      ['commit', 'a', 0, 0],
      ['commit', 'b', 1, 1],
      ['commit', 'c', 2, 2],
      ['end', '', 2, 2],
    ]);
  });

  it('an empty log has NO stops — not two bookends around nothing', () => {
    expect(commitStops([])).toEqual([]);
  });

  it('collapses a mount’s entry/exit pair onto one stop that folds through both', () => {
    const log = [
      bundle('a', 0, { x: 1 }),
      bundle('sf', 1, { out: 'v' }, 'sf#1'),
      bundle('sf', 2, {}, 'sf#1'),
      bundle('b', 3, { y: 2 }),
    ];
    const stops = commitStops(log);
    expect(stops.map((s) => [s.kind, s.runtimeStageId, s.commitIdx, s.lastCommitIdx])).toEqual([
      ['start', '', -1, -1],
      ['commit', 'a#0', 0, 0],
      ['mount', 'sf#1', 1, 2],
      ['commit', 'b#3', 3, 3],
      ['end', '', 3, 3],
    ]);
  });

  it('shows an interleaved fork child ONCE — repeats are empty positions, not stages', () => {
    const log = [
      bundle('c1', 0, { a: 1 }, 'c1#5'),
      bundle('c2', 1, { b: 2 }, 'c2#6'),
      bundle('c1', 2, {}, 'c1#5'),
      bundle('c2', 3, {}, 'c2#6'),
    ];
    const stops = commitStops(log);
    expect(stops.map((s) => [s.kind, s.runtimeStageId])).toEqual([
      ['start', ''],
      ['commit', 'c1#5'],
      ['commit', 'c2#6'],
      ['end', ''],
    ]);
    // The partition still covers every bundle.
    expect(stops[2].lastCommitIdx).toBe(3);
  });

  it('the execution tree names a mount even when its log shape does not', () => {
    const log = [bundle('sf', 0, { out: 'v' }, 'sf#0')];
    const tree = { id: 'root', logs: {}, errors: {}, metrics: {}, evals: {}, subflowId: 'sf', runtimeStageId: 'sf#0' };
    expect(commitStops(log)[1].kind).toBe('commit');
    expect(commitStops(log, tree as never)[1].kind).toBe('mount');
  });

  it('an id-less leading commit belongs to `start`, not to a stop of its own', () => {
    const log = [bundle('seed', 0, { given: 1 }, ''), bundle('a', 1, { x: 1 })];
    const stops = commitStops(log);
    expect(stops.map((s) => s.kind)).toEqual(['start', 'commit', 'end']);
    expect(stops[0].lastCommitIdx).toBe(0);
    expect(stateAt({ commitLog: log, initialState: {} }, stops[0].lastCommitIdx).state).toEqual({ given: 1 });
  });
});

describe('cursor movement', () => {
  it('starts at the first stop', () => {
    const cursor = timeTravel(tinyRun());
    expect(cursor.at()!.step).toBe(0);
    expect(cursor.at()!.kind).toBe('start');
  });

  it('next/prev walk the axis and clamp at both ends with a reason', () => {
    const cursor = timeTravel(tinyRun());
    expect(cursor.prev()).toMatchObject({ moved: false, reason: 'clamped' });
    expect(cursor.at()!.step).toBe(0);

    while (cursor.next().moved) {
      /* walk to the end */
    }
    expect(cursor.at()!.kind).toBe('end');
    expect(cursor.next()).toMatchObject({ moved: false, reason: 'clamped' });
    expect(cursor.at()!.kind).toBe('end');
  });

  it('first/last move and then refuse as clamped', () => {
    const cursor = timeTravel(tinyRun());
    expect(cursor.last()).toMatchObject({ moved: true });
    expect(cursor.last()).toMatchObject({ moved: false, reason: 'clamped' });
    expect(cursor.first()).toMatchObject({ moved: true });
    expect(cursor.first()).toMatchObject({ moved: false, reason: 'clamped' });
  });

  it('a move result names where it came from and where it went', () => {
    const cursor = timeTravel(tinyRun());
    const move = cursor.next();
    expect(move).toMatchObject({ moved: true });
    if (move.moved) {
      expect(move.from!.kind).toBe('start');
      expect(move.to.stageId).toBe('a');
    }
  });

  it('jumps by step and by runtimeStageId', () => {
    const cursor = timeTravel(tinyRun());
    expect(cursor.jumpTo('b#1')).toMatchObject({ moved: true });
    expect(cursor.at()!.stageId).toBe('b');
    expect(cursor.jumpTo(1)).toMatchObject({ moved: true });
    expect(cursor.at()!.stageId).toBe('a');
  });

  it('a miss NEVER moves, and names the nearest stop it can', () => {
    const cursor = timeTravel(tinyRun());
    cursor.jumpTo('b#1');
    const before = cursor.at();

    const miss = cursor.jumpTo('nope#9');
    expect(miss).toMatchObject({ moved: false, reason: 'miss' });
    expect(cursor.at()).toBe(before);

    // Same stage, different iteration → that stage is the nearest.
    const otherIteration = cursor.jumpTo('a#77');
    expect(otherIteration).toMatchObject({ moved: false, reason: 'miss' });
    if (!otherIteration.moved) expect(otherIteration.nearest!.stageId).toBe('a');
    expect(cursor.at()).toBe(before);
  });

  it('an out-of-range step clamps without moving, and names the end it hit', () => {
    const cursor = timeTravel(tinyRun());
    cursor.jumpTo(2);
    const before = cursor.at();
    const high = cursor.jumpTo(999);
    expect(high).toMatchObject({ moved: false, reason: 'clamped' });
    if (!high.moved) {
      expect(high.nearest!.kind).toBe('end');
      // 'clamped' does NOT mean "you are already there": `at` is where the
      // cursor still stands, `nearest` is the end the ask ran into, and on an
      // out-of-range jump they are different stops. The docs say so.
      expect(high.at).toBe(before);
      expect(high.nearest).not.toBe(high.at);
    }
    expect(cursor.at()).toBe(before);

    const low = cursor.jumpTo(-5);
    expect(low).toMatchObject({ moved: false, reason: 'clamped' });
    if (!low.moved) {
      expect(low.nearest!.kind).toBe('start');
      expect(low.at).toBe(before);
      expect(low.nearest).not.toBe(low.at);
    }
    expect(cursor.at()).toBe(before);
  });

  it('the OTHER clamp — asking for the stop you already stand on', () => {
    const cursor = timeTravel(tinyRun());
    cursor.jumpTo(2);
    const here = cursor.at()!;
    const same = cursor.jumpTo(2);
    expect(same).toMatchObject({ moved: false, reason: 'clamped' });
    // Here 'already there' IS the reason, and there is no end to name.
    if (!same.moved) {
      expect(same.at).toBe(here);
      expect(same.nearest).toBeUndefined();
    }
    expect(cursor.at()).toBe(here);
  });

  it('an empty-string id is not an address — the bookends are reached by step', () => {
    const cursor = timeTravel(tinyRun());
    cursor.jumpTo(1);
    expect(cursor.jumpTo('')).toMatchObject({ moved: false, reason: 'miss' });
    expect(cursor.at()!.step).toBe(1);
  });

  it('a cursor over an empty log refuses everything with `empty` and never throws', () => {
    const cursor = timeTravel({ commitLog: [], initialState: { seeded: true } });
    expect(cursor.stops).toEqual([]);
    expect(cursor.at()).toBeUndefined();
    for (const move of [
      cursor.first(),
      cursor.last(),
      cursor.prev(),
      cursor.next(),
      cursor.jumpTo(0),
      cursor.jumpTo('a#0'),
    ]) {
      expect(move).toMatchObject({ moved: false, reason: 'empty' });
    }
    expect(cursor.mark('x')).toBeUndefined();
    expect(cursor.changedSince()).toEqual([]);
    expect(cursor.stateAt().state).toEqual({ seeded: true });
  });
});

describe('marks live BESIDE the log', () => {
  it('survive a jump and resolve by stage, not by step number', () => {
    const cursor = timeTravel(tinyRun());
    cursor.jumpTo('b#1');
    const mark = cursor.mark('the interesting one')!;
    expect(mark).toEqual({ name: 'the interesting one', runtimeStageId: 'b#1', step: 2 });

    cursor.first();
    expect(cursor.jumpToMark('the interesting one')).toMatchObject({ moved: true });
    expect(cursor.at()!.runtimeStageId).toBe('b#1');
  });

  it('never appear in the commit log or the snapshot', () => {
    const run = tinyRun();
    const cursor = timeTravel(run);
    cursor.jumpTo('b#1');
    cursor.mark('note');
    expect(JSON.stringify(run)).not.toContain('note');
    expect(run.commitLog.every((b) => (b as Record<string, unknown>).marks === undefined)).toBe(true);
  });

  it('are returned detached — a caller cannot edit the cursor’s notes', () => {
    const cursor = timeTravel(tinyRun());
    cursor.jumpTo(1);
    cursor.mark('one');
    const listed = cursor.marks();
    expect(Object.isFrozen(listed)).toBe(true);
    expect(() => (listed as unknown as unknown[]).push({} as never)).toThrow();
    expect(cursor.marks()).toHaveLength(1);
  });

  it('re-marking a name replaces it rather than shadowing it', () => {
    const cursor = timeTravel(tinyRun());
    cursor.jumpTo(1);
    cursor.mark('here');
    cursor.jumpTo(2);
    cursor.mark('here');
    expect(cursor.marks()).toHaveLength(1);
    expect(cursor.marks()[0].runtimeStageId).toBe('b#1');
  });

  it('an unknown mark misses without moving; a mark can be seeded at construction', () => {
    const seeded = timeTravel(tinyRun(), { marks: [{ name: 'saved', runtimeStageId: 'c#2', step: 3 }] });
    expect(seeded.jumpToMark('saved')).toMatchObject({ moved: true });
    expect(seeded.at()!.stageId).toBe('c');
    const at = seeded.at();
    expect(seeded.jumpToMark('never-placed')).toMatchObject({ moved: false, reason: 'miss' });
    expect(seeded.at()).toBe(at);
  });

  it('a mark whose stage is not on this axis misses', () => {
    const cursor = timeTravel(tinyRun(), { marks: [{ name: 'elsewhere', runtimeStageId: 'sf/inner#9', step: 1 }] });
    expect(cursor.jumpToMark('elsewhere')).toMatchObject({ moved: false, reason: 'miss' });
    expect(cursor.at()!.step).toBe(0);
  });
});

describe('a fold result is detached', () => {
  it('is frozen all the way down and shares nothing with its source', () => {
    const run = {
      initialState: { config: { retries: 1 } },
      commitLog: [bundle('a', 0, { payload: { items: [1, 2] } })],
    };
    const folded = stateAt(run, 0);
    expect(Object.isFrozen(folded.state)).toBe(true);
    expect(() => (folded.state as any).payload.items.push(3)).toThrow();
    expect((run.commitLog[0].overwrite as any).payload.items).toEqual([1, 2]);
  });

  it('folding past the end clamps and reports where it stopped', () => {
    const folded = stateAt(tinyRun(), 999);
    expect(folded.throughCommitIdx).toBe(2);
    expect(folded.state).toEqual({ seeded: true, x: 1, y: 2, z: 3 });
  });

  it('folding before the beginning returns the base alone', () => {
    expect(stateAt(tinyRun(), -1)).toMatchObject({ throughCommitIdx: -1, state: { seeded: true } });
  });
});

describe('the strategy seam', () => {
  it('a consumer’s own stop grammar drives the same cursor', () => {
    const everySecondStage: TimeTravelStrategy = {
      stopsFor: (log) =>
        commitStops(log)
          .filter((stop) => stop.kind !== 'commit' || stop.commitIdx % 2 === 0)
          .map((stop, step) => ({ ...stop, step })),
    };
    const cursor = timeTravel(tinyRun(), { strategy: everySecondStage });
    expect(cursor.stops.map((s) => s.stageId)).toEqual(['', 'a', 'c', '']);
    cursor.jumpTo('c#2');
    expect(cursor.stateAt().state).toEqual({ seeded: true, x: 1, y: 2, z: 3 });
  });

  it('is inherited by a drilled cursor', () => {
    const labelled: TimeTravelStrategy = {
      stopsFor: (log, tree) => commitStops(log, tree).map((s) => ({ ...s, label: `» ${s.label}` })),
    };
    const run = {
      commitLog: [bundle('sf', 0, { out: 1 }, 'sf#0')],
      initialState: {},
      subflowResults: {
        'sf#0': {
          subflowId: 'sf',
          treeContext: { history: [bundle('in', 0, { v: 9 }, 'sf/in#1')], initialState: {} },
        },
      },
    };
    const cursor = timeTravel(run, { strategy: labelled });
    expect(cursor.stops[1].label.startsWith('» ')).toBe(true);
    expect(cursor.drill('sf#0')!.stops[1].label.startsWith('» ')).toBe(true);
  });
});

describe('property — the fold agrees with the per-key fold', () => {
  it('stateAt(log, i)[key] === commitValueAt(log, i, key) for every key and index', () => {
    const opArb = fc.record({
      stage: fc.constantFrom('a', 'b', 'c'),
      key: fc.constantFrom('k1', 'k2', 'k3'),
      value: fc.oneof(fc.integer(), fc.string(), fc.array(fc.integer(), { maxLength: 3 })),
    });

    fc.assert(
      fc.property(fc.array(opArb, { minLength: 1, maxLength: 25 }), (ops) => {
        const log: CommitBundle[] = ops.map((op, i) => bundle(op.stage, i, { [op.key]: op.value }));
        const keys = ['k1', 'k2', 'k3'];
        for (let i = 0; i < log.length; i++) {
          const folded = stateAt({ commitLog: log, initialState: {} }, i).state;
          for (const key of keys) {
            expect(folded[key]).toEqual(commitValueAt(log, i, key));
          }
        }
      }),
      { numRuns: 40 },
    );
  });
});

describe('performance and load', () => {
  function bigLog(n: number): CommitBundle[] {
    const log: CommitBundle[] = [];
    for (let i = 0; i < n; i++) log.push(bundle(`s${i % 50}`, i, { [`k${i % 20}`]: i }));
    return log;
  }

  // NOTE: these assert WORK DONE, never elapsed milliseconds. A wall-clock
  // expectation turns a loaded CI machine into a red suite while saying
  // nothing about the code — and cannot be reproduced afterwards. The shapes
  // below fail loudly on an algorithmic regression (a quadratic fold, a stop
  // derivation that drops or duplicates commits) and stay green under load.

  it('derives one stop per commit over a 10k-commit log, plus the two bookends', () => {
    const log = bigLog(10_000);
    const stops = commitStops(log);
    expect(stops).toHaveLength(10_000 + 2);
    // Every commit index appears exactly once as some stop's first commit.
    expect(new Set(stops.map((s) => s.commitIdx)).size).toBe(10_000 + 1);
  });

  it('folds a 10k-commit log to the last value written for each of its 20 keys', () => {
    const log = bigLog(10_000);
    const folded = stateAt({ commitLog: log, initialState: {} }, log.length - 1);
    expect(Object.keys(folded.state)).toHaveLength(20);
    // bigLog writes `k{i%20} = i`, so the surviving value for each key is the
    // last i below 10_000 congruent to that key — the fold, not a partial one.
    for (let k = 0; k < 20; k++) {
      expect(folded.state[`k${k}`]).toBe(10_000 - 20 + k);
    }
  });

  it('50k cursor moves leave the cursor on a real stop and never throw', () => {
    const cursor = timeTravel({ commitLog: bigLog(1_000), initialState: {} });
    let advanced = 0;
    let wrapped = 0;
    for (let i = 0; i < 50_000; i++) {
      if (cursor.next().moved) advanced++;
      else {
        wrapped++;
        cursor.first();
      }
    }
    // 1_000 commits ⇒ 1_002 stops ⇒ 1_001 forward moves per lap.
    expect(advanced + wrapped).toBe(50_000);
    expect(wrapped).toBeGreaterThan(0);
    expect(cursor.at()).toBeDefined();
    expect(cursor.stops).toContain(cursor.at());
  });
});

// ── Fix-pass regressions ───────────────────────────────────────────────────

describe('law 3, both halves — the fold is detached AND leaves the log alone', () => {
  /**
   * `applySmartMerge` clones what it OVERWRITES, but its merge arm's array
   * union (`deepSmartMerge`) carries the SOURCE ELEMENT references straight
   * out of `bundle.updates`. Freezing the fold result therefore used to
   * freeze the engine's own recorded bundle — a read-only query mutating the
   * record it read. `stateAt` clones once before freezing.
   */
  function mergeRun() {
    const log: CommitBundle[] = [
      {
        idx: 0,
        stage: 'ADD',
        stageId: 'add',
        runtimeStageId: 'add#0',
        trace: [{ path: 'bag', verb: 'merge' as const }],
        redactedPaths: [],
        overwrite: {},
        updates: { bag: { list: [{ id: 1 }] } },
      },
    ];
    return { initialState: { bag: { list: [{ id: 0 }] } }, commitLog: log };
  }

  it('a merged array element is a COPY, not the bundle’s own object', () => {
    const run = mergeRun();
    const folded = stateAt(run, 0);

    expect(folded.state).toEqual({ bag: { list: [{ id: 0 }, { id: 1 }] } });
    const fromLog = (run.commitLog[0].updates as any).bag.list[0];
    expect((folded.state as any).bag.list[1]).not.toBe(fromLog);
  });

  it('folding does not freeze the commit log it folded', () => {
    const run = mergeRun();
    const fromLog = (run.commitLog[0].updates as any).bag.list[0];
    expect(Object.isFrozen(fromLog)).toBe(false);

    stateAt(run, 0);

    expect(Object.isFrozen(fromLog)).toBe(false);
    // …and the bundle is still usable: a second fold gives the same answer.
    expect(stateAt(run, 0).state).toEqual({ bag: { list: [{ id: 0 }, { id: 1 }] } });
  });

  it('the fold result itself is still deeply frozen', () => {
    const folded = stateAt(mergeRun(), 0);
    expect(Object.isFrozen(folded.state)).toBe(true);
    expect(Object.isFrozen((folded.state as any).bag.list)).toBe(true);
    expect(Object.isFrozen((folded.state as any).bag.list[1])).toBe(true);
  });
});

describe('stateAt — an out-of-contract index still answers honestly', () => {
  it('a non-finite index folds nothing and reports where it stopped', () => {
    const folded = stateAt(tinyRun(), Number.NaN);

    expect(folded.state).toEqual({ seeded: true });
    // The honesty field must be a NUMBER a consumer can read (NaN serializes
    // as `null` and says nothing).
    expect(Number.isFinite(folded.throughCommitIdx)).toBe(true);
    expect(folded.throughCommitIdx).toBe(-1);
    expect(folded.basis).toBe('initial+log');
  });

  it('Infinity clamps to the end of the log, like any index past it', () => {
    const folded = stateAt(tinyRun(), Number.POSITIVE_INFINITY);
    expect(folded.throughCommitIdx).toBe(2);
    expect(folded.state).toEqual({ seeded: true, x: 1, y: 2, z: 3 });
  });
});

describe('`clamped` means the cursor is already there', () => {
  it('jumping by id to the stop you already stand on refuses without moving', () => {
    const cursor = timeTravel(tinyRun());
    expect(cursor.jumpTo('a#0').moved).toBe(true);

    const again = cursor.jumpTo('a#0');
    expect(again.moved).toBe(false);
    expect(again.moved === false && again.reason).toBe('clamped');
    expect(cursor.at()!.runtimeStageId).toBe('a#0');
  });

  it('jumping by step to the step you already stand on does the same', () => {
    const cursor = timeTravel(tinyRun());
    cursor.jumpTo(2);
    const again = cursor.jumpTo(2);
    expect(again.moved).toBe(false);
    expect(again.moved === false && again.reason).toBe('clamped');
    expect(cursor.at()!.step).toBe(2);
  });
});

describe('the execution tree OVERRULES the mount shape-heuristic', () => {
  /**
   * A single-child fork commits twice under one id — the same shape a subflow
   * mount has. With the tree in hand the engine's own mount set is the
   * authority, so that child must be a plain `'commit'`: a UI that offers
   * `drill()` on it gets `undefined`, which is a promise the axis broke.
   */
  const forkLog = [
    bundle('seed', 0, { s: 1 }, 'seed#0'),
    bundle('only', 1, { a: 1 }, 'only#1'),
    bundle('only', 2, {}, 'only#1'),
    bundle('after', 3, { b: 2 }, 'after#2'),
  ];
  const treeWithNoMounts = { id: 'root', logs: {}, errors: {}, metrics: {}, evals: {}, runtimeStageId: 'seed#0' };

  it('labels a lone fork child `commit` when the tree says nothing is a mount', () => {
    const stops = commitStops(forkLog, treeWithNoMounts as never);
    expect(stops.map((s) => [s.kind, s.runtimeStageId])).toEqual([
      ['start', ''],
      ['commit', 'seed#0'],
      ['commit', 'only#1'],
      ['commit', 'after#2'],
      ['end', ''],
    ]);
    // The stop still owns BOTH of that stage's bundles.
    expect(stops[2].lastCommitIdx).toBe(2);
  });

  it('keeps the shape heuristic for a log handed over WITHOUT its tree', () => {
    expect(commitStops(forkLog)[2].kind).toBe('mount');
  });

  it('a stop labelled `commit` is never offered as drillable', () => {
    const cursor = timeTravel({
      initialState: {},
      commitLog: forkLog,
      executionTree: treeWithNoMounts as never,
    });
    for (const stop of cursor.stops) {
      if (stop.kind === 'mount') continue;
      expect(cursor.drill(stop.runtimeStageId)).toBeUndefined();
    }
    expect(cursor.stops.some((s) => s.kind === 'mount')).toBe(false);
  });
});
