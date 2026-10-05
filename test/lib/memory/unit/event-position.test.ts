import { describe, expect, it } from 'vitest';

import { EventLog } from '../../../../src/lib/memory/EventLog.js';

describe('EventLog source position', () => {
  it('stays unknown without an engine binding, even when history exists', () => {
    const log = new EventLog({});
    log.record({ stage: 'one', overwrite: {}, updates: {}, trace: [], redactedPaths: [] });
    expect(log.address).toBeUndefined();
    expect(log.capturePosition('leg')).toBeUndefined();
  });

  it('captures a frozen prefix from the log, not a second counter', () => {
    const log = new EventLog({});
    const path = ['mount#1'];
    log.bindAddress('original-leg', path);
    path.push('forged#9');
    const before = log.capturePosition('original-leg')!;
    expect(before).toEqual({
      runId: 'original-leg',
      logRunId: 'original-leg',
      drillPath: ['mount#1'],
      committedThroughIdx: -1,
    });
    log.record({ stage: 'one', overwrite: {}, updates: {}, trace: [], redactedPaths: [] });
    log.bindAddress('resumed-leg', []);
    const after = log.capturePosition('resumed-leg')!;
    expect(after).toEqual({ ...before, runId: 'resumed-leg', committedThroughIdx: 0 });
    expect(before.committedThroughIdx).toBe(-1);
    expect(Object.isFrozen(before)).toBe(true);
    expect(Object.isFrozen(before.drillPath)).toBe(true);
    expect(Object.isFrozen(log.address)).toBe(true);
    expect(() => (before.drillPath as string[]).push('forged#2')).toThrow(TypeError);
    expect(log.address).toEqual({ logRunId: 'original-leg', drillPath: ['mount#1'] });
  });

  it('permanently retires the address when a log is cleared', () => {
    const log = new EventLog({});
    log.bindAddress('first', []);
    const old = log.capturePosition('first');
    log.clear();
    expect(log.address).toBeUndefined();
    expect(log.capturePosition('first')).toBeUndefined();
    log.bindAddress('first', []);
    expect(log.capturePosition('first')).toBeUndefined();
    log.bindAddress('second', []);
    expect(log.capturePosition('second')).toBeUndefined();
    expect(old).toEqual({ logRunId: 'first', runId: 'first', drillPath: [], committedThroughIdx: -1 });
  });
});
