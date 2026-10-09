/**
 * RecordFrame — the record half of one stage's frame (C3, L3), on its own: no engine, no scope, no
 * StageContext. Every case drives the frame directly over a heap and a log, one law per block
 * (src/lib/memory/RecordFrame.ts):
 *
 *   1  address      reads and writes at a path prefix the caller computed; moves only while nothing is staged
 *   2  first touch  the generation first touched is held by reference — the read view, then the diff base
 *   3  two tiers    the stage's view first, LIVE state for a key absent there; `detachBase` after the first write
 *   4  lazy buffer  built at the first write, on the first-touch base, at the address, under the encoding
 *   5  readKeys     under 'reads-prefix' each row carries the keys noted before it; `release` keeps them
 *   6  commit       the payload, then the names, to `recordCommit`; `release` ends the hold; `discard` drops everything
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { EventLog } from '../../../../src/lib/memory/EventLog';
import { RecordFrame } from '../../../../src/lib/memory/RecordFrame';
import { SharedMemory } from '../../../../src/lib/memory/SharedMemory';
import type { CommitBundle } from '../../../../src/lib/memory/types';

type Loose = Record<string, any>;

const RUN = ['runs', 'p1'];

/** A heap seeded with `initial`, its log, and a frame over both at `address`. */
function setup(initial: Loose = {}, address: string[] = []) {
  const state = new SharedMemory(undefined, initial);
  const log = new EventLog(state.getState());
  const frame = new RecordFrame(state, log, address);
  return { state, log, frame };
}

/** Commit what `frame` staged as stage `id`, then end its hold — the engine's two steps. */
function commitAs(frame: RecordFrame, id: string): void {
  frame.commit(() => ({ stage: id, stageId: id, runtimeStageId: `${id}#0` }));
  frame.release();
}

/** Another writer commits `key = value` at the root, under the frame's feet. */
function commitElsewhere(state: SharedMemory, log: EventLog, key: string, value: unknown): void {
  const other = new RecordFrame(state, log);
  other.getTransactionBuffer().set([key], value);
  commitAs(other, 'other');
}

const last = (log: EventLog): CommitBundle => log.list()[log.list().length - 1];

describe('RecordFrame — law 1: the address', () => {
  it('joins a path under the address, the root spelled without one', () => {
    expect(new RecordFrame(new SharedMemory()).at([], 'k')).toEqual(['k']);
    expect(new RecordFrame(new SharedMemory(), undefined, RUN).at([], 'k')).toEqual(['runs', 'p1', 'k']);
    expect(new RecordFrame(new SharedMemory(), undefined, RUN).at(['cfg', 'a'], 'k')).toEqual([
      'runs',
      'p1',
      'cfg',
      'a',
      'k',
    ]);
  });

  it('reads at the address first and falls back to the root; writes land at the address', () => {
    const { state, frame } = setup({ k: 'root', theme: 'light', runs: { p1: { k: 'p1' } } }, RUN);
    expect(frame.read([], 'k')).toBe('p1');
    expect(frame.read([], 'theme')).toBe('light'); // tier 2: live state, the root as the fallback
    frame.getTransactionBuffer().set(frame.at([], 'w'), 1);
    commitAs(frame, 's');
    expect(state.getState()).toEqual({ k: 'root', theme: 'light', runs: { p1: { k: 'p1', w: 1 } } });
    expect(frame.readLive('k')).toBe('p1');
    expect(frame.readGlobal('k')).toBe('root');
  });

  it('moves before the first write; the buffer is built at the address the frame has then', () => {
    const { state, log, frame } = setup({ runs: { p1: { k: 'p1' }, p2: { k: 'p2' } } }, RUN);
    expect(frame.hasStaged).toBe(false); // the caller's question before a move (StageContext · useAddressOf)
    frame.useAddress(['runs', 'p2']);
    expect(frame.address).toEqual(['runs', 'p2']);
    expect(frame.read([], 'k')).toBe('p2');
    frame.getTransactionBuffer().set(frame.at([], 'w'), { n: 1 });
    expect(frame.hasStaged).toBe(true);
    commitAs(frame, 's');
    expect((state.getState().runs as Loose).p2).toEqual({ k: 'p2', w: { n: 1 } });
    expect(last(log).trace).toEqual([{ path: 'runs\u001fp2\u001fw', verb: 'set' }]);
    frame.useAddress(RUN); // released: nothing staged any more
    expect(frame.read([], 'k')).toBe('p1');
  });
});

describe('RecordFrame — law 2: the first-touch base', () => {
  it('a read pins the generation it touched: a later commit elsewhere does not move what it reads', () => {
    const { state, log, frame } = setup({ k: 1 });
    expect(frame.read([], 'k')).toBe(1);
    commitElsewhere(state, log, 'k', 2);
    expect(frame.read([], 'k')).toBe(1); // repeatable — the first-touch view
    expect(frame.readLive('k')).toBe(2); // live state did move
  });

  it('is the diff base, not the state at the first write — a sibling commit in the gap is no phantom change', () => {
    const { state, log, frame } = setup({ k: 1 });
    frame.read([], 'k'); // first touch: k = 1
    commitElsewhere(state, log, 'k', 2);
    frame.getTransactionBuffer().set(['k'], 1); // what the stage first saw
    commitAs(frame, 's');
    expect(last(log).overwrite).toEqual({}); // no net change against the first touch
    expect(last(log).trace).toEqual([]);
    expect(state.getState().k).toBe(2);
  });

  it('holds the committed generation by reference — no clone', () => {
    const { state, frame } = setup({ cfg: { a: 1 } });
    const committed = state.getState().cfg;
    expect(frame.baseAt(['cfg'])).toBe(committed);
    expect(frame.peek(['cfg'])).toBe(committed); // before the first write: the base itself
    expect(frame.read([], 'cfg')).toBe(committed); // a borrowed read
  });
});

describe('RecordFrame — law 3: two tiers', () => {
  it('serves a key absent at first touch from LIVE state, before and after the first write', () => {
    const { state, log, frame } = setup({ k: 1 });
    frame.read([], 'k');
    commitElsewhere(state, log, 'late', 'v1');
    expect(frame.read([], 'late')).toBe('v1');
    frame.getTransactionBuffer().set(['mine'], true);
    commitElsewhere(state, log, 'later', 'v2');
    expect(frame.read([], 'later')).toBe('v2');
    expect(frame.read([], 'mine')).toBe(true); // read-your-writes
  });

  it('after the first write, a read of a committed container is the stage’s own copy', () => {
    const { state, frame } = setup({ cfg: { a: 1 } });
    frame.getTransactionBuffer().set(['other'], 1);
    const own = frame.read([], 'cfg') as Loose;
    expect(own).toEqual({ a: 1 });
    expect(own).not.toBe(state.getState().cfg);
    expect(frame.peek(['cfg'])).toBe(own); // `peek` sees the working copy, takes no second copy
  });

  it('detaches the diff base before a tier-2 container goes out, so a write-back is recorded', () => {
    const { log, frame } = setup({ obj: { n: 1 } });
    const buffer = frame.getTransactionBuffer();
    buffer.delete(['obj']); // the working copy holds nothing at obj now
    const live = frame.read([], 'obj') as Loose; // tier 2: committed state itself
    live.n = 2; // out of contract — an in-place edit of a borrowed read
    buffer.set(['obj'], live);
    commitAs(frame, 's');
    expect(last(log).overwrite).toEqual({ obj: { n: 2 } }); // against a detached base, the edit is a change
  });
});

describe('RecordFrame — law 4: the lazy buffer', () => {
  const realClone = globalThis.structuredClone;
  let clones = 0;
  beforeEach(() => {
    clones = 0;
    globalThis.structuredClone = ((value: unknown, options?: StructuredSerializeOptions) => {
      clones += 1;
      return realClone(value, options);
    }) as typeof structuredClone;
  });
  afterEach(() => {
    globalThis.structuredClone = realClone;
  });

  it('reads never build it; the commit of a frame that never wrote is empty, with zero clones', () => {
    const { state, log, frame } = setup({ k: { deep: [1, 2] } });
    const generation = state.getState();
    clones = 0;
    frame.read([], 'k');
    frame.read([], 'missing');
    expect(frame.hasStaged).toBe(false);
    commitAs(frame, 'reader');
    expect(clones).toBe(0);
    expect(state.getState()).toBe(generation);
    const bundle = last(log);
    expect([bundle.overwrite, bundle.updates, bundle.redactedPaths, bundle.trace]).toEqual([{}, {}, [], []]);
    expect(bundle.stageId).toBe('reader');
  });

  it('builds one buffer at the first write and keeps it until release', () => {
    const { frame } = setup();
    const buffer = frame.getTransactionBuffer();
    expect(frame.hasStaged).toBe(true);
    expect(frame.getTransactionBuffer()).toBe(buffer);
    frame.release();
    expect(frame.hasStaged).toBe(false);
    expect(frame.getTransactionBuffer()).not.toBe(buffer);
  });

  it('encodes under the encoding it holds when the buffer is built — full by default, delta on request', () => {
    const grow = (frame: RecordFrame) => {
      frame.getTransactionBuffer().set(['list'], [1, 2, 3]);
      commitAs(frame, 's');
    };
    const full = setup({ list: [1, 2] });
    grow(full.frame);
    expect(last(full.log).trace).toEqual([{ path: 'list', verb: 'set' }]);

    const delta = setup({ list: [1, 2] });
    delta.frame.useEncoding({ commitValues: 'delta', writeProvenance: 'off' });
    grow(delta.frame);
    expect(last(delta.log).trace).toEqual([{ path: 'list', verb: 'append' }]);
    expect(last(delta.log).overwrite).toEqual({ list: [3] });
  });
});

describe('RecordFrame — law 5: the readKeys list', () => {
  const PREFIX = { commitValues: 'full', writeProvenance: 'reads-prefix' } as const;

  it('stamps each staged row with the keys noted before it — dotted for a nested path, each once', () => {
    const { log, frame } = setup({ a: 1, cfg: { k: 2 } });
    frame.useEncoding(PREFIX);
    frame.noteRead([], 'a');
    frame.getTransactionBuffer().set(['x'], 1);
    frame.noteRead(['cfg'], 'k');
    frame.noteRead([], 'a');
    frame.getTransactionBuffer().set(['y'], 2);
    commitAs(frame, 's');
    expect(last(log).trace).toEqual([
      { path: 'x', verb: 'set', readKeys: ['a'] },
      { path: 'y', verb: 'set', readKeys: ['a', 'cfg.k'] },
    ]);
  });

  it("keeps nothing unless the frame encodes under 'reads-prefix'", () => {
    const { log, frame } = setup({ a: 1 });
    frame.noteRead([], 'a');
    frame.getTransactionBuffer().set(['x'], 1);
    commitAs(frame, 's');
    expect(last(log).trace).toEqual([{ path: 'x', verb: 'set' }]);
  });

  it('survives a release (a re-used frame) and goes with a discard (a failed attempt)', () => {
    const { log, frame } = setup({ a: 1, b: 2 });
    frame.useEncoding(PREFIX);
    frame.noteRead([], 'a');
    commitAs(frame, 'first');
    frame.getTransactionBuffer().set(['x'], 1);
    commitAs(frame, 'again');
    expect(last(log).trace).toEqual([{ path: 'x', verb: 'set', readKeys: ['a'] }]);

    frame.noteRead([], 'b');
    frame.discard();
    frame.getTransactionBuffer().set(['y'], 2);
    commitAs(frame, 'retried');
    expect(last(log).trace).toEqual([{ path: 'y', verb: 'set', readKeys: [] }]);
  });
});

describe('RecordFrame — law 6: commit, release, discard', () => {
  it('lands a commit on live state, the log and the mirror — the mirror and the log scrubbed', () => {
    const { state, log, frame } = setup();
    const mirror = new SharedMemory();
    frame.useMirror(mirror);
    expect(frame.mirror).toBe(mirror);
    frame.getTransactionBuffer().set(['token'], 'sk-1', /* redact */ true);
    frame.getTransactionBuffer().set(['n'], 1);
    frame.commit(() => ({ stage: 'Seed', stageId: 'seed', runtimeStageId: 'seed#0', tags: ['audit'] }));
    expect(state.getState()).toEqual({ token: 'sk-1', n: 1 });
    expect(mirror.getState()).toEqual({ token: 'REDACTED', n: 1 });
    const bundle = last(log);
    expect(Object.keys(bundle)).toEqual([
      'overwrite',
      'updates',
      'redactedPaths',
      'trace',
      'stage',
      'stageId',
      'runtimeStageId',
      'tags',
      'idx',
    ]);
    expect(bundle.overwrite).toEqual({ token: 'REDACTED', n: 1 });
  });

  it('reads the names once the payload is built: a getter that names the stage while its values are taken counts', () => {
    const { log, frame } = setup();
    let tags: readonly string[] | undefined;
    const value = {};
    Object.defineProperty(value, 'g', {
      enumerable: true,
      get: () => {
        tags = ['late']; // user code, run by the net-change compare and the commit-time clone
        return 1;
      },
    });
    frame.getTransactionBuffer().set(['v'], value);
    frame.commit(() => ({ stage: 's', stageId: 's', runtimeStageId: 's#0', tags }));
    expect(last(log).tags).toEqual(['late']);
    expect(last(log).overwrite).toEqual({ v: { g: 1 } });
  });

  it('answers a report (the dev-mode guard) without a copy: what was staged, what the stage has seen, the base', () => {
    const { state, frame } = setup({ cfg: { a: 1 }, list: [1] }, RUN);
    expect(frame.wasStaged(frame.at([], 'cfg'))).toBe(false); // no buffer yet
    const before = state.getState().cfg;
    expect(frame.peek(['cfg'])).toBe(before); // the first-touch base itself
    frame.getTransactionBuffer().set(frame.at(['cfg'], 'a'), 2);
    expect(frame.wasStaged(frame.at([], 'cfg'))).toBe(true); // below it
    expect(frame.wasStaged(frame.at(['cfg', 'a'], 'deep'))).toBe(true); // above it
    expect(frame.wasStaged(frame.at([], 'list'))).toBe(false);
    expect(frame.baseAt(['cfg'])).toBe(before); // the base keeps what was committed
    commitAs(frame, 's');
    expect(frame.wasStaged(frame.at([], 'cfg'))).toBe(false); // released
  });

  it('commit records and release ends the hold: two steps, so a caller can run its own between them', () => {
    const { state, frame } = setup({ k: 1 });
    frame.read([], 'k');
    frame.getTransactionBuffer().set(['k'], 2);
    frame.commit(() => ({ stage: 's', stageId: 's', runtimeStageId: 's#0' }));
    expect(state.getState().k).toBe(2);
    expect(frame.hasStaged).toBe(true); // committed, still held
    frame.release();
    expect(frame.hasStaged).toBe(false);
    expect(frame.read([], 'k')).toBe(2); // re-anchored on the state as it stands now
  });

  it('a released frame re-used for a second commit diffs against the state after the first', () => {
    const { log, frame } = setup();
    frame.getTransactionBuffer().set(['k'], 'v');
    commitAs(frame, 's');
    frame.getTransactionBuffer().set(['k'], 'v'); // the same value again
    commitAs(frame, 's');
    expect(log.list().map((b) => b.overwrite)).toEqual([{ k: 'v' }, {}]);
  });

  it('discard drops what was staged: nothing reaches state or the log, and the next read re-anchors', () => {
    const { state, log, frame } = setup({ k: 1 });
    frame.read([], 'k');
    frame.getTransactionBuffer().set(['k'], 99);
    commitElsewhere(state, log, 'k', 2);
    const logged = log.list().length;
    frame.discard();
    expect(frame.hasStaged).toBe(false);
    expect(log.list()).toHaveLength(logged);
    expect(state.getState().k).toBe(2);
    expect(frame.read([], 'k')).toBe(2); // a fresh first touch
  });
});
