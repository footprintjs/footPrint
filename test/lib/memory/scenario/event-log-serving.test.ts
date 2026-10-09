/**
 * EventLog's served and internal views, including deep records and nested-key reader memos.
 * served-record-doors.test.ts keeps the executor, subtree, checkpoint and dev-mode witnesses.
 */
import { describe, expect, it } from 'vitest';

import type { CommitBundle } from '../../../../src/trace';
import { commitValueAt } from '../../../../src/trace';
import { EventLog } from '../../../../src/write';

describe('EventLog serving and reader isolation', () => {
  it('EventLog.list() on footprintjs/write serves its bundles the same way', () => {
    const log = new EventLog({});
    log.record({
      stage: 'S',
      stageId: 's',
      runtimeStageId: 's#0',
      trace: [{ path: 'when', verb: 'set' }],
      overwrite: { when: new Date(5), m: new Map([['k', 1]]) },
      updates: {},
      redactedPaths: [],
    });
    const served = log.list()[0];
    (served.overwrite.when as Date).setTime(0);
    (served.overwrite.m as Map<string, number>).set('k', 2);
    const again = log.list()[0];
    expect((again.overwrite.when as Date).getTime()).toBe(5);
    expect((again.overwrite.m as Map<string, number>).get('k')).toBe(1);
    expect(log.materialise().when.getTime()).toBe(5);
  });

  it('the engine’s own read is not served: recorded() holds the log’s own bundles, so the run path copies nothing', () => {
    const log = new EventLog({});
    const bundle: CommitBundle = {
      stage: 'S',
      stageId: 's',
      runtimeStageId: 's#0',
      trace: [{ path: 'when', verb: 'set' }],
      overwrite: { when: new Date(5) },
      updates: {},
      redactedPaths: [],
    } as CommitBundle;
    log.record(bundle);
    expect(log.recorded()[0]).toBe(bundle); // the engine's (ExecutionRuntime · getSnapshot, per subflow mount)
    expect(log.list()[0]).not.toBe(bundle); // a reader's: a copy of its open paths
    const held = log.recorded();
    held.splice(0); // a new array per call: a holder's splice reaches only its own
    expect(log.recorded()).toHaveLength(1);
    expect(log.length).toBe(1);
  });

  it('EventLog.list() seals and serves it without a recursion; an edit of the served copy reaches nothing', () => {
    let deep: Record<string, unknown> = { at: new Date(5) };
    for (let i = 0; i < 20_000; i++) deep = { next: deep };
    const log = new EventLog({});
    log.record({
      stage: 'S',
      stageId: 's',
      runtimeStageId: 's#0',
      trace: [{ path: 'deep', verb: 'set' }],
      overwrite: { deep },
      updates: {},
      redactedPaths: [],
    });
    const bottom = (bundle: CommitBundle) => {
      let at = bundle.overwrite.deep as Record<string, unknown>;
      while (at.next !== undefined) at = at.next as Record<string, unknown>;
      return at.at as Date;
    };
    bottom(log.list()[0]).setTime(0); // the reader's copy, 20,000 down
    expect(bottom(log.list()[0]).getTime()).toBe(5);
  });

  it('commitValueAt on an engine log (memoised) — a nested key folded from a kept generation', () => {
    // `cfg` is set whole, then `cfg␟a` is set: the memo keeps the generation after commit 0, and
    // `cfg␟a` at commit 0 is folded from it. Until 9.44.2 the answer WAS the memo.
    const log = new EventLog({});
    const bundle = (i: number, path: string, overwrite: Record<string, unknown>): CommitBundle => ({
      stage: `S${i}`,
      stageId: `s${i}`,
      runtimeStageId: `s${i}#${i}`,
      trace: [{ path, verb: 'set' }],
      overwrite,
      updates: {},
      redactedPaths: [],
    });
    log.record(bundle(0, 'cfg', { cfg: { a: { x: 1 } } }));
    log.record(bundle(1, 'cfg\u001fa', { cfg: { a: { x: 2 } } }));
    const frozenLog = Object.freeze(log.list());
    const first = commitValueAt(frozenLog, 0, 'cfg\u001fa') as { x: number };
    first.x = 99;
    expect(commitValueAt(frozenLog, 0, 'cfg\u001fa')).toEqual({ x: 1 });
  });
});
