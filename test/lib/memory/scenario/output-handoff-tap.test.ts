import type { CommitBundle } from 'foottrace';
import { type RecordSink, EventLog } from 'foottrace/write';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createCommitTap } from '../../../../src/lib/memory/commitTap';
import { runPolicy } from '../../../../src/lib/memory/runPolicy';
import { ExecutionRuntime } from '../../../../src/lib/runner/ExecutionRuntime';

afterEach(() => vi.restoreAllMocks());

const address = { logRunId: 'run-1', drillPath: [] };

function runtime(readSources = false, captureOutputHandoff = true, sink?: RecordSink) {
  return new ExecutionRuntime(
    'Root',
    'root',
    undefined,
    undefined,
    runPolicy({ readSources, captureOutputHandoff }, undefined, false),
    sink ? { address, sink, meta: { owner: 'application' } } : undefined,
    { runId: address.logRunId },
  );
}

function commit(root: ExecutionRuntime, value: number): void {
  root.rootStageContext.runtimeStageId = `root#${value}`;
  root.rootStageContext.setGlobal('value', value);
  root.rootStageContext.commit();
}

describe('output handoff commit tap', () => {
  it.each([false, true])('reads the actual last commit without listing history (readSources=%s)', (readSources) => {
    const root = runtime(readSources);
    expect(root.lastHandoffCommit()).toBeUndefined();
    const list = vi.spyOn(root.executionHistory, 'list').mockImplementation(() => {
      throw new Error('handoff must not list history');
    });
    const recorded = vi.spyOn(root.executionHistory, 'recorded').mockImplementation(() => {
      throw new Error('handoff must not copy history');
    });
    commit(root, 1);
    const first = root.lastHandoffCommit();
    expect(first).toMatchObject({ idx: 0, runtimeStageId: 'root#1', overwrite: { value: 1 } });
    expect(Object.isFrozen(first)).toBe(true);
    commit(root, 2);
    expect(root.lastHandoffCommit()).toMatchObject({ idx: 1, runtimeStageId: 'root#2', overwrite: { value: 2 } });
    expect(root.lastHandoffCommit()).not.toBe(first);
    expect(first!.overwrite).toEqual({ value: 1 });
    expect(list).not.toHaveBeenCalled();
    expect(recorded).not.toHaveBeenCalled();
    expect(root.recordFor('child#3')).toBeUndefined(); // No storage authority was invented.
  });

  it.each([false, true])('leaves capture-off logs without the new tap (readSources=%s)', (readSources) => {
    const root = runtime(readSources, false);
    commit(root, 1);
    expect(root.lastHandoffCommit()).toBeUndefined();
    expect(Object.hasOwn(root, 'handoffCommitTap')).toBe(false);
    expect(root.recordFor('child#3')).toBeUndefined();
  });

  it.each([false, true])(
    'preserves unsupported sink bases without claiming a tapped commit (readSources=%s)',
    (readSources) => {
      // This advanced root is accepted by the ordinary native log, but a sink's
      // opened entry requires an object rather than an array. Capture cannot
      // change that business behavior or manufacture a commit observation.
      const root = new ExecutionRuntime(
        'Root',
        'root',
        [],
        [1],
        runPolicy({ readSources, captureOutputHandoff: true }, undefined, false),
        undefined,
        { runId: address.logRunId },
      );
      expect(root.executionHistory.getInitialState()).toEqual([1]);
      expect(() => root.rootStageContext.commit()).not.toThrow();
      expect(root.executionHistory.length).toBe(1);
      expect(root.lastHandoffCommit()).toBeUndefined();
      expect(Object.hasOwn(root, 'handoffCommitTap')).toBe(false);
    },
  );

  it('forwards exact arguments, receiver and promises on every app sink method', async () => {
    const pending = Promise.resolve();
    const calls: Array<[string, unknown]> = [];
    const delegate: RecordSink = {
      opened(entry) {
        expect(this).toBe(delegate);
        calls.push(['opened', entry]);
        return pending;
      },
      commit(entry) {
        expect(this).toBe(delegate);
        calls.push(['commit', entry]);
        return pending;
      },
      note(entry) {
        expect(this).toBe(delegate);
        calls.push(['note', entry]);
        return pending;
      },
      closed(entry) {
        expect(this).toBe(delegate);
        calls.push(['closed', entry]);
        return pending;
      },
      flush() {
        expect(this).toBe(delegate);
        calls.push(['flush', undefined]);
        return pending;
      },
      onFailure(entry) {
        expect(this).toBe(delegate);
        calls.push(['onFailure', entry]);
        return pending;
      },
    };
    const tap = createCommitTap(delegate);
    const bundle = { idx: 0, runtimeStageId: 'root#0' } as CommitBundle;
    const opened = { address, at: 1, initialState: {} };
    const landed = { address, at: 2, bundle };
    const note = { address, at: 3, kind: 'test', data: {} };
    const closed = { address, at: 4, outcome: 'ok' as const, commits: 1 };
    const failure = { entry: { ...landed, kind: 'commit' as const }, error: new Error('sink failed') };
    expect(tap.sink.opened(opened)).toBe(pending);
    expect(tap.sink.commit(landed)).toBe(pending);
    expect(tap.sink.note(note)).toBe(pending);
    expect(tap.sink.closed(closed)).toBe(pending);
    expect(tap.sink.flush!()).toBe(pending);
    expect(tap.sink.onFailure!(failure)).toBe(pending);
    expect(calls).toEqual([
      ['opened', opened],
      ['commit', landed],
      ['note', note],
      ['closed', closed],
      ['flush', undefined],
      ['onFailure', failure],
    ]);
    expect(tap.last()).toBe(bundle);
    await pending;
  });

  it.each([false, true])('keeps the actual application sink and metadata (readSources=%s)', (readSources) => {
    const failure = new Error('application sink refused commit');
    const sink: RecordSink = {
      opened: vi.fn(),
      commit: vi.fn(() => {
        throw failure;
      }),
      note: vi.fn(),
      closed: vi.fn(),
      onFailure: vi.fn(),
    };
    const root = runtime(readSources, true, sink);
    expect(sink.opened).toHaveBeenCalledWith(expect.objectContaining({ meta: { owner: 'application' } }));
    expect(() => commit(root, 1)).not.toThrow();
    expect(root.lastHandoffCommit()).toMatchObject({ idx: 0, runtimeStageId: 'root#1' });
    expect(sink.commit).toHaveBeenCalledTimes(1);
    expect(sink.onFailure).toHaveBeenCalledTimes(1);
    expect(sink.onFailure).toHaveBeenCalledWith(expect.objectContaining({ error: failure }));
    expect(root.recordFor('child#3')?.sink).toBe(sink);
    root.closeRecord('ok');
    expect(sink.closed).toHaveBeenCalledTimes(1);
  });

  it('uses the public native landing boundary, without altering EventLog methods', () => {
    const original = EventLog.prototype.record;
    const root = runtime();
    commit(root, 1);
    expect(root.executionHistory.record).toBe(original);
    expect(Object.hasOwn(root.executionHistory, 'record')).toBe(false);
    expect(root.lastHandoffCommit()!.trace).toEqual([{ path: 'value', verb: 'set' }]);
  });
});
