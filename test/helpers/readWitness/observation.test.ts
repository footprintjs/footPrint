/** Passive native delegation, restoration and fail-closed capture; no engine implementation. */
import { expect, it } from 'vitest';

import { installReadLawObservation, sameStageDeletedReadInputs, UnsupportedReadLawObservation } from './observation.js';
import { BufferPort, hooks, StagePort } from './portsFixture.js';

it('forwards this, arguments, return identity and exactly one original get', () => {
  const b = new BufferPort();
  const s = new StagePort(b);
  const value = {};
  b.readResult = value;
  const observer = installReadLawObservation(hooks, 'run');
  try {
    s.setObject([], 'cfg', undefined);
    expect(s.getValue([], 'cfg')).toBe(value);
    expect(b.calls).toEqual([
      ['set', ['cfg'], undefined],
      ['get', ['cfg']],
    ]);
    expect(sameStageDeletedReadInputs(observer.receipt())[0].read.result).toEqual({ kind: 'defined' });
  } finally {
    observer.restore();
  }
});
it('preserves the native thrown identity and restores both descriptor sets', () => {
  const stage = Object.getOwnPropertyDescriptors(StagePort.prototype);
  const buffer = Object.getOwnPropertyDescriptors(BufferPort.prototype);
  const b = new BufferPort();
  const s = new StagePort(b);
  const error = new Error('inert');
  b.readError = error;
  const observer = installReadLawObservation(hooks, 'run');
  try {
    let caught: unknown;
    try {
      s.getValue([], 'cfg');
    } catch (actual) {
      caught = actual;
    }
    expect(caught).toBe(error);
    expect(b.calls).toEqual([['get', ['cfg']]]);
    expect(sameStageDeletedReadInputs(observer.receipt())).toEqual([]);
  } finally {
    observer.restore();
    observer.restore();
  }
  expect(Object.getOwnPropertyDescriptors(StagePort.prototype)).toEqual(stage);
  expect(Object.getOwnPropertyDescriptors(BufferPort.prototype)).toEqual(buffer);
});
it('does not admit a failed tombstone', () => {
  const b = new BufferPort();
  const s = new StagePort(b);
  const error = new Error('failed set');
  b.writeError = error;
  const observer = installReadLawObservation(hooks, 'run');
  try {
    expect(() => s.setObject([], 'cfg', undefined)).toThrow(error);
    b.writeError = undefined;
    s.getValue([], 'cfg');
    expect(sameStageDeletedReadInputs(observer.receipt())).toEqual([]);
  } finally {
    observer.restore();
  }
});
it('does not invent a buffer/address for a native read which made no canonical get', () => {
  class Direct extends StagePort {
    getValue() {
      return 7;
    }

    setObject(...args: Parameters<StagePort['setObject']>) {
      return super.setObject(...args);
    }

    updateObject(...args: Parameters<StagePort['updateObject']>) {
      return super.updateObject(...args);
    }

    commit() {
      return super.commit();
    }
  }
  const observer = installReadLawObservation({ StageContext: Direct, TransactionBuffer: BufferPort }, 'run');
  try {
    const s = new Direct(new BufferPort());
    s.setObject([], 'cfg', undefined);
    s.getValue();
    expect(sameStageDeletedReadInputs(observer.receipt())).toEqual([]);
  } finally {
    observer.restore();
  }
});
it('overlapping installations refuse without replacing the active wrappers', () => {
  const observer = installReadLawObservation(hooks, 'run');
  const installed = StagePort.prototype.getValue;
  try {
    expect(() => installReadLawObservation(hooks, 'other')).toThrow(UnsupportedReadLawObservation);
    expect(StagePort.prototype.getValue).toBe(installed);
  } finally {
    observer.restore();
  }
});
it('shared buffer owner ambiguity poisons classification', () => {
  const observer = installReadLawObservation(hooks, 'run');
  try {
    const b = new BufferPort();
    new StagePort(b).setObject([], 'cfg', undefined);
    new StagePort(b).getValue([], 'cfg');
    expect(() => observer.assertUsable()).toThrow(UnsupportedReadLawObservation);
    expect(() => sameStageDeletedReadInputs(observer.receipt())).toThrow(UnsupportedReadLawObservation);
  } finally {
    observer.restore();
  }
});
it('validates all method descriptors before mutation and never invokes a method getter', () => {
  let invoked = 0;
  const buffer = Object.defineProperties({}, Object.getOwnPropertyDescriptors(BufferPort.prototype));
  Object.defineProperty(buffer, 'get', {
    configurable: true,
    get() {
      invoked++;
      return () => undefined;
    },
  });
  const before = Object.getOwnPropertyDescriptors(StagePort.prototype);
  expect(() =>
    installReadLawObservation({ StageContext: StagePort, TransactionBuffer: { prototype: buffer } }, 'run'),
  ).toThrow(UnsupportedReadLawObservation);
  expect(invoked).toBe(0);
  expect(Object.getOwnPropertyDescriptors(StagePort.prototype)).toEqual(before);
});
