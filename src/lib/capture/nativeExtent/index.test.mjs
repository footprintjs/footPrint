import { describe, expect, it } from 'vitest';

import { NativeExtent } from './collector.js';
import { copyNativeCaptureExtent } from './format.js';

const address = { logRunId: 'run', drillPath: [] };
const binding = { runId: 'run', logAddress: address, commits: { from: 0, to: 1 } };
const settled = () => {
  const book = new NativeExtent('run', address, 0);
  book.begin().settle();
  book.seal(1);
  return structuredClone(book.snapshot(1));
};

describe('native extent collector and data boundary', () => {
  it('retains an abandoned wait as pending and never calls it closed', () => {
    const book = new NativeExtent('run', address, 0);
    const invocation = book.begin();
    invocation.abandon();
    const running = book.snapshot(1);
    expect(running.status).toBe('running');
    expect(running.invocations).toEqual({ started: 1, settled: 0, pending: 1, abandoned: 1 });
    expect(copyNativeCaptureExtent(running, binding, true)).toBeUndefined();
    book.seal(1);
    const terminal = book.snapshot(1);
    invocation.settle();
    expect(book.snapshot(99)).toBe(terminal);
    expect(terminal.status).toBe('unverified');
    expect(copyNativeCaptureExtent(terminal, binding, true)).toEqual(terminal);
  });

  it('counts duplicate observed settlement only once', () => {
    const book = new NativeExtent('run', address, 0);
    const invocation = book.begin();
    invocation.settle();
    invocation.settle();
    expect(book.snapshot(1).invocations).toEqual({ started: 1, settled: 1, pending: 0, abandoned: 0 });
  });

  it('refuses a forged closed status without promoting version1', () => {
    expect(copyNativeCaptureExtent({ ...settled(), status: 'closed' }, binding, true)).toBeUndefined();
  });

  it('refuses inconsistent counts and a foreign owner', () => {
    const note = settled();
    expect(
      copyNativeCaptureExtent({ ...note, invocations: { ...note.invocations, started: 7 } }, binding, true),
    ).toBeUndefined();
    expect(copyNativeCaptureExtent({ ...note, runId: 'other' }, binding, true)).toBeUndefined();
  });

  it('does not execute a stored accessor', () => {
    let calls = 0;
    const note = settled();
    Object.defineProperty(note, 'version', {
      enumerable: true,
      get() {
        calls++;
        return 1;
      },
    });
    expect(copyNativeCaptureExtent(note, binding, true)).toBeUndefined();
    expect(calls).toBe(0);
  });
});
