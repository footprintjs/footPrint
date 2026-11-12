import { EventLog, RecordFrame, SharedMemory } from 'foottrace/write';
import { describe, expect, it } from 'vitest';

import { runPolicy } from '../../../src/lib/memory/runPolicy.js';
import { StageContext } from '../../../src/lib/memory/StageContext.js';
import { pinnedText } from '../../fixtures/bytes.js';

// These observe native resolution behavior for #113's design, including the
// corrected same-stage read-after-delete law (#124). They do
// not implement source capture or infer sources from a finished commit log.
function setup(initial: Record<string, unknown> = {}) {
  const state = new SharedMemory(undefined, initial);
  const log = new EventLog(state.getState());
  return { state, log, frame: () => new RecordFrame(state, log) };
}

function commit(frame: RecordFrame, id: string) {
  frame.commit(() => ({ stage: id, stageId: id, runtimeStageId: `${id}#0` }));
  frame.release();
}

describe('#113 native read-resolution witnesses (not a source-capture implementation)', () => {
  it('keeps a first-touch value even after another frame commits a newer version', () => {
    const { frame, log } = setup({ count: 1 });
    const reader = frame();
    expect(reader.read([], 'count')).toBe(1);
    const writer = frame();
    writer.write(['count'], 2, 'set');
    commit(writer, 'writer');
    expect(log.list()[0].overwrite).toEqual({ count: 2 });
    expect(reader.read([], 'count')).toBe(1);
  });

  it('lets a first-touch-missing key see a sibling commit through the live fallback', () => {
    const { frame } = setup({ anchor: 1 });
    const reader = frame();
    expect(reader.read([], 'anchor')).toBe(1);
    expect(reader.read([], 'later')).toBeUndefined();
    const writer = frame();
    writer.write(['later'], 2, 'set');
    commit(writer, 'writer');
    expect(reader.read([], 'later')).toBe(2);
  });

  // Before foottrace 1.13.0 this witness read "can produce identical commit logs after different observed
  // read values": the log could not tell the two reads apart at all. The read window (1.13.0) now dates
  // the reader's reads against the log: a reader that looked before the writer committed says so on its
  // first bundle (`beganAt: 0`, the log's length when it looked); one that looked only after carries
  // nothing. WHICH value it saw is still not in the record: apart from that one stamp the logs are equal.
  it('tells different observed read values apart only by the read window (beganAt), not by the values', () => {
    function run(readBeforeWrite: boolean) {
      const { frame, log } = setup({ count: 1 });
      const reader = frame();
      const writer = frame();
      let observed: unknown;
      if (readBeforeWrite) observed = reader.read([], 'count');
      writer.write(['count'], 2, 'set');
      commit(writer, 'writer');
      if (!readBeforeWrite) observed = reader.read([], 'count');
      commit(reader, 'reader');
      return { observed, commits: log.list() };
    }
    const early = run(true);
    const late = run(false);
    expect([early.observed, late.observed]).toEqual([1, 2]);
    const [earlyWriter, earlyReader] = early.commits;
    const [, lateReader] = late.commits;
    expect([earlyReader.stageId, lateReader.stageId]).toEqual(['reader', 'reader']);
    expect(earlyReader.beganAt).toBe(0);
    expect(Object.hasOwn(earlyReader, 'sawUntil')).toBe(false);
    expect(Object.hasOwn(lateReader, 'beganAt')).toBe(false);
    expect(Object.hasOwn(lateReader, 'sawUntil')).toBe(false);
    const earlyReaderRest = { ...earlyReader };
    delete earlyReaderRest.beganAt;
    expect([earlyWriter, earlyReaderRest]).toEqual(late.commits);
  });

  it('serves several staged generations although the commit keeps only the final change', () => {
    const { frame, log } = setup({ count: 1 });
    const stage = frame();
    const observed = [stage.read([], 'count')];
    stage.write(['count'], 2, 'set');
    observed.push(stage.read([], 'count'));
    stage.write(['count'], 3, 'set');
    observed.push(stage.read([], 'count'));
    commit(stage, 'stage');
    expect(observed).toEqual([1, 2, 3]);
    expect(log.list()[0].overwrite).toEqual({ count: 3 });
    expect(log.list()[0].trace.every((row) => row.path === 'count')).toBe(true);
  });

  it('never has a committed entity for a staged write that is later reverted', () => {
    const { frame, log } = setup({ count: 1 });
    const stage = frame();
    stage.write(['count'], 2, 'set');
    expect(stage.read([], 'count')).toBe(2);
    stage.write(['count'], 1, 'set');
    expect(stage.read([], 'count')).toBe(1);
    commit(stage, 'stage');
    expect(log.list()[0].trace).toEqual([]);
    expect(log.list()[0].overwrite).toEqual({});
  });

  it('does not create a committed entity for a no-op write either', () => {
    const { frame, log } = setup({ count: 1 });
    const stage = frame();
    stage.write(['count'], 1, 'set');
    expect(stage.read([], 'count')).toBe(1);
    commit(stage, 'stage');
    expect(log.list()[0].trace).toEqual([]);
  });

  it('composes a parent value from untouched base portions and a staged child', () => {
    const { frame } = setup({ settings: { first: 1, second: 2 } });
    const stage = frame();
    stage.write(['settings', 'first'], 3, 'set');
    expect(stage.read([], 'settings')).toEqual({ first: 3, second: 2 });
    expect(stage.read(['settings'], 'second')).toBe(2);
  });

  it('composes arrays and object merges without making each element a separately observed read', () => {
    const { frame } = setup({ list: [1], settings: { first: 1 } });
    const stage = frame();
    stage.write(['list'], [2], 'merge');
    stage.write(['settings'], { second: 2 }, 'merge');
    expect(stage.read([], 'list')).toEqual([1, 2]);
    expect(stage.read([], 'settings')).toEqual({ first: 1, second: 2 });
  });

  it('falls from an undefined namespaced value back to the global root', () => {
    const { state, log } = setup({ count: 7, runs: { branch: { count: undefined } } });
    const stage = new RecordFrame(state, log, ['runs', 'branch']);
    expect(stage.read([], 'count')).toBe(7);
    expect(stage.read([], 'absent')).toBeUndefined();
  });

  it.each(['full', 'delta'] as const)(
    '#124: an unset/delete in %s mode reads undefined before commit and retains that read',
    (mode) => {
      const { frame, state, log } = setup({ count: 7 });
      const stage = frame();
      stage.useEncoding({ commitValues: mode, writeProvenance: 'off' });
      stage.write(['count'], undefined, mode === 'delta' ? 'delete' : 'set');
      // Native result, before commit/delivery: neither the live heap nor the log changed yet.
      expect(stage.read([], 'count')).toBeUndefined();
      expect(state.getState()).toEqual({ count: 7 });
      expect(log.list()).toEqual([]);

      // The engine's retained read must agree with its own real native return.
      const tracked = new StageContext('', 'DeletedRead', 'deleted-read', state, '', log);
      tracked.usePolicy(runPolicy({ commitValues: mode, readTracking: 'full' }));
      tracked.setObject([], 'count', undefined, false, undefined, mode === 'delta' ? 'delete' : 'set');
      expect(tracked.getValue([], 'count')).toBeUndefined();
      const reads = tracked.getSnapshot()[0].stageReads;
      expect(Object.prototype.hasOwnProperty.call(reads, 'count')).toBe(true);
      expect(reads?.count).toBeUndefined();
      expect(JSON.parse(pinnedText(reads))).toEqual({ count: '«undefined»' });
      expect(state.getState()).toEqual({ count: 7 });
      expect(log.list()).toEqual([]);
    },
  );

  it('does not use dotted display names as canonical paths', () => {
    const { frame, log } = setup({ 'a.b': 1, a: { b: 2 } });
    const stage = frame();
    stage.useEncoding({ commitValues: 'full', writeProvenance: 'reads-prefix' });
    expect(stage.read([], 'a.b')).toBe(1);
    stage.noteRead([], 'a.b');
    expect(stage.read(['a'], 'b')).toBe(2);
    stage.noteRead(['a'], 'b');
    stage.write(['out'], true, 'set');
    commit(stage, 'stage');
    // Today's display-prefix registry collapses both to one name; it cannot
    // be reused as #113's occurrence/path channel.
    expect(log.list()[0].trace[0].readKeys).toEqual(['a.b']);
  });

  it('discard drops staged state and reanchors the next attempt on live state', () => {
    const { frame } = setup({ count: 1 });
    const stage = frame();
    expect(stage.read([], 'count')).toBe(1);
    stage.write(['count'], 9, 'set');
    expect(stage.read([], 'count')).toBe(9);
    const sibling = frame();
    sibling.write(['count'], 2, 'set');
    commit(sibling, 'sibling');
    stage.discard();
    expect(stage.read([], 'count')).toBe(2);
  });

  it('release reanchors the same frame after its commit', () => {
    const { frame } = setup({ count: 1 });
    const stage = frame();
    expect(stage.read([], 'count')).toBe(1);
    commit(stage, 'first');
    const sibling = frame();
    sibling.write(['count'], 2, 'set');
    commit(sibling, 'sibling');
    expect(stage.read([], 'count')).toBe(2);
  });

  it('retains the last read value in the engine view rather than an ordered list of reads', () => {
    const { state, log } = setup();
    const stage = new StageContext('leg', 'Stage', 'stage', state, '', log);
    stage.setObject([], 'count', 1);
    expect(stage.getValue([], 'count')).toBe(1);
    stage.setObject([], 'count', 2);
    expect(stage.getValue([], 'count')).toBe(2);
    expect(stage.getValue([], 'count')).toBe(2);
    expect(stage.getSnapshot()[0].stageReads).toEqual({ count: 2 });
  });
});
