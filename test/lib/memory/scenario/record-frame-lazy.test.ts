/**
 * Record-owned lazy-buffer scenarios (#13), exercised through the public writer alone.
 *
 * A frame reads without creating a buffer, stages at its explicit address, and commits a net
 * change against its first-touch generation. Empty commits preserve the record's bytes while
 * leaving the heap alone. The tracked-read, observer and chart witnesses remain in lazy-buffer.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { EventLog, RecordFrame, SharedMemory } from '../../../../src/write';

/** Commit one frame, then release its hold on the generation, as the writer contract prescribes. */
function commitAs(frame: RecordFrame, id: string): void {
  frame.commit(() => ({ stage: id, stageId: id, runtimeStageId: `${id}#${frame.log?.length ?? 0}` }));
  frame.release();
}

/** Seed through the writer, then return the next frame at the same explicit address. */
function seededFrame() {
  const mem = new SharedMemory();
  const log = new EventLog(mem.getState());
  const address = ['runs', 'p1'];
  const seed = new RecordFrame(mem, log, address);
  seed.write(seed.at([], 'greeting'), 'hello', 'set');
  seed.write(seed.at([], 'config'), { retries: 3 }, 'set');
  commitAs(seed, 'seed');
  const frame = new RecordFrame(mem, log, address);
  return { mem, log, frame };
}

describe('RecordFrame: lazy buffer without the engine', () => {
  describe('zero clones for frames that never write', () => {
    const realClone = globalThis.structuredClone;
    let cloneCalls: unknown[];

    beforeEach(() => {
      cloneCalls = [];
      globalThis.structuredClone = ((value: unknown, opts?: StructuredSerializeOptions) => {
        cloneCalls.push(value);
        return realClone(value, opts);
      }) as typeof structuredClone;
    });

    afterEach(() => {
      globalThis.structuredClone = realClone;
    });

    it('read + commit performs ZERO structuredClones and never builds a buffer', () => {
      const { frame } = seededFrame();
      cloneCalls = [];

      expect(frame.read([], 'greeting')).toBe('hello');
      expect(frame.hasStaged).toBe(false);
      commitAs(frame, 'stage2');

      expect(cloneCalls).toHaveLength(0);
      expect(frame.hasStaged).toBe(false);
    });

    it('no-touch commit leaves the shared state object untouched (no applyPatch replay)', () => {
      const { mem, frame } = seededFrame();
      const stateRef = mem.getState();
      cloneCalls = [];

      commitAs(frame, 'stage2');

      expect(cloneCalls).toHaveLength(0);
      expect(frame.hasStaged).toBe(false);
      expect(mem.getState()).toBe(stateRef);
    });
  });

  describe('read-your-writes after the first write', () => {
    it('write then read in the same frame sees the new value', () => {
      const { frame } = seededFrame();
      frame.write(frame.at([], 'greeting'), 'updated', 'set');
      expect(frame.hasStaged).toBe(true);
      expect(frame.read([], 'greeting')).toBe('updated');
    });

    it('merge then read in the same frame sees the merged value', () => {
      const { frame } = seededFrame();
      frame.write(frame.at([], 'config'), { mode: 'fast' }, 'merge');
      expect(frame.read([], 'config')).toEqual({ retries: 3, mode: 'fast' });
    });
  });

  describe('read-before-write semantics', () => {
    it('reads before the first write return the committed value; after, the buffered one', () => {
      const { mem, frame } = seededFrame();

      expect(frame.read([], 'greeting')).toBe('hello');
      frame.write(frame.at([], 'greeting'), 'changed', 'set');
      expect(frame.read([], 'greeting')).toBe('changed');

      expect(mem.getValue(['runs', 'p1'], [], 'greeting')).toBe('hello');
      commitAs(frame, 'stage2');
      expect(mem.getValue(['runs', 'p1'], [], 'greeting')).toBe('changed');
    });

    it('after the first write, reads of OTHER keys still see committed values', () => {
      const { frame } = seededFrame();
      frame.write(frame.at([], 'newKey'), 1, 'set');
      expect(frame.read([], 'greeting')).toBe('hello');
      expect(frame.read([], 'config')).toEqual({ retries: 3 });
    });

    it('root fallback works with and without a buffer at an explicit address', () => {
      const mem = new SharedMemory(undefined, { globalKey: 'globalVal' });
      const log = new EventLog(mem.getState());
      const frame = new RecordFrame(mem, log, ['runs', 'p1']);

      expect(frame.read([], 'globalKey')).toBe('globalVal');
      frame.write(frame.at([], 'localKey'), 1, 'set');
      expect(frame.read([], 'globalKey')).toBe('globalVal');
    });
  });

  describe('net-change commit semantics', () => {
    it('writing the same value produces an EMPTY commit bundle', () => {
      const { log, frame } = seededFrame();
      frame.write(frame.at([], 'greeting'), 'hello', 'set');
      commitAs(frame, 'stage2');

      const bundle = log.list()[1];
      expect(bundle.overwrite).toEqual({});
      expect(bundle.updates).toEqual({});
      expect(bundle.trace).toEqual([]);
    });

    it('writing a new value produces the diff', () => {
      const { log, frame } = seededFrame();
      frame.write(frame.at([], 'greeting'), 'world', 'set');
      commitAs(frame, 'stage2');

      const bundle = log.list()[1];
      expect(bundle.overwrite).toEqual({ runs: { p1: { greeting: 'world' } } });
      expect(bundle.trace).toHaveLength(1);
    });

    it('write-then-revert nets to an empty commit', () => {
      const { log, frame } = seededFrame();
      frame.write(frame.at([], 'greeting'), 'temp', 'set');
      frame.write(frame.at([], 'greeting'), 'hello', 'set');
      commitAs(frame, 'stage2');

      const bundle = log.list()[1];
      expect(bundle.overwrite).toEqual({});
      expect(bundle.trace).toEqual([]);
    });
  });

  it('a no-touch frame records the same empty bundle shape, key order included', () => {
    const { log, frame } = seededFrame();
    commitAs(frame, 'stage2');

    const bundle = log.list()[1];
    expect(bundle).toEqual({
      overwrite: {},
      updates: {},
      redactedPaths: [],
      trace: [],
      stage: 'stage2',
      stageId: 'stage2',
      runtimeStageId: 'stage2#1',
      idx: 1,
    });
    // Key ORDER pins JSON byte-identity with the eager-buffer bundles.
    expect(Object.keys(bundle)).toEqual([
      'overwrite',
      'updates',
      'redactedPaths',
      'trace',
      'stage',
      'stageId',
      'runtimeStageId',
      'idx',
    ]);
  });

  describe('first-touch anchor: another commit in the read→write gap', () => {
    it('commit baseline stays at first touch — rewriting the first-read value nets EMPTY', () => {
      const mem = new SharedMemory();
      const log = new EventLog(mem.getState());

      const seed = new RecordFrame(mem, log);
      seed.write(['g'], 'orig', 'set');
      commitAs(seed, 'seed');

      const b = new RecordFrame(mem, log, ['runs', 'b']);
      expect(b.read([], 'g')).toBe('orig');

      const a = new RecordFrame(mem, log, ['runs', 'a']);
      a.write(['g'], 'A', 'set');
      commitAs(a, 'a');

      // The addressed view misses g, so the fallback sees LIVE state; only the diff base is pinned.
      expect(b.read([], 'g')).toBe('A');
      b.write(['g'], 'orig', 'set');
      commitAs(b, 'b');

      const bundle = log.list().find((entry) => entry.stageId === 'b');
      expect(bundle?.overwrite).toEqual({});
      expect(bundle?.updates).toEqual({});
      expect(bundle?.trace).toEqual([]);
      expect(mem.getValue([], [], 'g')).toBe('A');
    });

    it('keys present in the view at first touch read repeatably from it', () => {
      const { mem, log, frame } = seededFrame();
      expect(frame.read([], 'greeting')).toBe('hello');

      const intruder = new RecordFrame(mem, log, ['runs', 'p1']);
      intruder.write(intruder.at([], 'greeting'), 'changed', 'set');
      commitAs(intruder, 'intruder');
      expect(mem.getValue(['runs', 'p1'], [], 'greeting')).toBe('changed');

      expect(frame.read([], 'greeting')).toBe('hello');
    });
  });
});
