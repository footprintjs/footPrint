/** Inert delegation ports, not a clone of RecordFrame, TransactionBuffer or an engine. */
import { describe, expect, it } from 'vitest';

import {
  type Receipt,
  installReadLawObservation,
  requireDeletedReadInput,
  sameStageDeletedReadInputs,
  UnsupportedReadLawObservation,
} from './observation.js';

class BufferPort {
  baseSnapshot: Record<string, unknown> = { cfg: { n: 1 }, other: 7 };
  calls: unknown[][] = [];
  readResult: unknown;
  readError: unknown;
  writeError: unknown;
  commitResult = { ordinary: true };
  set(path: unknown, value: unknown) {
    this.calls.push(['set', path, value]);
    if (this.writeError) throw this.writeError;
  }

  merge(path: unknown, value: unknown) {
    this.calls.push(['merge', path, value]);
  }

  delete(path: unknown) {
    this.calls.push(['delete', path]);
    if (this.writeError) throw this.writeError;
  }

  get(path: unknown) {
    this.calls.push(['get', path]);
    if (this.readError) throw this.readError;
    return this.readResult;
  }

  commit() {
    this.calls.push(['commit']);
    return this.commitResult;
  }
}
class StagePort {
  stageId = 'stage';
  runId = '';
  runtimeStageId = 'stage#0';
  constructor(readonly storage: BufferPort, readonly address: string[] = []) {}
  setObject(path: string[], key: string, value: unknown, _redact?: boolean, _description?: string, verb?: 'delete') {
    const at = [...this.address, ...path, key];
    if (verb === 'delete') return this.storage.delete(at);
    return this.storage.set(at, value);
  }

  updateObject(path: string[], key: string, value: unknown) {
    return this.storage.merge([...this.address, ...path, key], value);
  }

  getValue(path: string[], key: string) {
    return this.storage.get([...this.address, ...path, key]);
  }

  getValueDirect(path: string[], key: string) {
    return this.storage.get([...this.address, ...path, key]);
  }

  commit() {
    return this.storage.commit();
  }
}
const hooks = { StageContext: StagePort, TransactionBuffer: BufferPort };
const reads = (receipt: Receipt) =>
  receipt.events.filter((event) => event.method === 'getValue' || event.method === 'getValueDirect');

it('forwards this, arguments, return identity and call count, and snapshots before later mutation', () => {
  const native = new BufferPort();
  const stage = new StagePort(native);
  native.readResult = native.baseSnapshot.cfg;
  const observer = installReadLawObservation(hooks, 'leg0');
  let receipt: Receipt;
  try {
    stage.setObject([], 'cfg', undefined);
    const result = stage.getValue([], 'cfg');
    expect(result).toBe(native.readResult);
    expect(native.calls.map((call) => call[0])).toEqual(['set', 'get']);
    (result as { n: number }).n = 99;
    receipt = observer.receipt();
    observer.assertUsable();
    const input = requireDeletedReadInput(receipt, reads(receipt)[0].id);
    expect(input.get.address).toEqual(['cfg']);
    expect(input.read.resultObject).toBe(input.get.base?.object);
    expect(JSON.stringify(input.read.result)).toContain('"1"');
    expect(JSON.stringify(input.read.result)).not.toContain('"99"');
    expect(input.deletedBy.value).toEqual({ kind: 'undefined' });
  } finally {
    observer.restore();
  }
});

it('preserves an actual native throw unchanged and restores all method descriptors in finally', () => {
  const stageBefore = Object.getOwnPropertyDescriptors(StagePort.prototype);
  const bufferBefore = Object.getOwnPropertyDescriptors(BufferPort.prototype);
  const native = new BufferPort();
  const stage = new StagePort(native);
  const error = new Error('inert throw');
  native.readError = error;
  const observer = installReadLawObservation(hooks, 'leg0');
  try {
    let caught: unknown;
    try {
      stage.getValue([], 'cfg');
    } catch (actual) {
      caught = actual;
    }
    expect(caught).toBe(error);
    expect(native.calls).toEqual([['get', ['cfg']]]);
    expect(reads(observer.receipt())[0].outcome).toBe('threw');
    expect(sameStageDeletedReadInputs(observer.receipt())).toEqual([]);
  } finally {
    observer.restore();
  }
  expect(Object.getOwnPropertyDescriptors(StagePort.prototype)).toEqual(stageBefore);
  expect(Object.getOwnPropertyDescriptors(BufferPort.prototype)).toEqual(bufferBefore);
});

it('keeps the complete ordinary delegation result and call sequence unchanged', () => {
  const program = () => {
    const native = new BufferPort();
    const stage = new StagePort(native);
    native.readResult = { public: 7 };
    stage.setObject([], 'x', 1);
    stage.updateObject([], 'x', { added: true });
    const value = stage.getValue([], 'x');
    const direct = stage.getValueDirect([], 'x');
    return { value, direct, committed: stage.commit(), calls: native.calls };
  };
  const plain = program();
  const observer = installReadLawObservation(hooks, 'leg0');
  try {
    expect(program()).toEqual(plain);
    observer.assertUsable();
  } finally {
    observer.restore();
  }
});

describe.each(['set-undefined', 'delete'] as const)('successful native tombstone %s', (kind) => {
  it('binds actual frame/buffer/address/leg and ignores an unrelated successful write', () => {
    const native = new BufferPort();
    const stage = new StagePort(native, ['runs', 'branch']);
    native.readResult = undefined;
    const observer = installReadLawObservation(hooks, 'leg0');
    try {
      stage.setObject([], 'cfg', undefined, false, undefined, kind === 'delete' ? 'delete' : undefined);
      stage.setObject([], 'other', 8);
      expect(stage.getValue([], 'cfg')).toBeUndefined();
      const receipt = observer.receipt();
      const input = requireDeletedReadInput(receipt, reads(receipt)[0].id);
      expect(input.get.address).toEqual(['runs', 'branch', 'cfg']);
      expect(input.read.leg).toBe('leg0');
      expect(input.read.frame).toBe(input.deletedBy.frame);
      expect(input.get.buffer).toBe(input.deletedBy.buffer);
    } finally {
      observer.restore();
    }
  });
});

it.each(['replacement', 'overlap', 'commit', 'other-key', 'other-frame', 'failed-write'] as const)(
  '%s cannot supply a same-stage deleted-read input',
  (change) => {
    const native = new BufferPort();
    const stage = new StagePort(native);
    const observer = installReadLawObservation(hooks, 'leg0');
    try {
      if (change === 'failed-write') native.writeError = new Error('inert write failed');
      try {
        stage.setObject([], 'cfg', undefined);
      } catch {
        /* preserve the deliberate native failure */
      }
      native.writeError = undefined;
      if (change === 'replacement') stage.setObject([], 'cfg', { n: 2 });
      if (change === 'overlap') stage.setObject(['cfg'], 'child', 2);
      if (change === 'commit') expect(stage.commit()).toBe(native.commitResult);
      const reader = change === 'other-frame' ? new StagePort(new BufferPort()) : stage;
      reader.getValue([], change === 'other-key' ? 'other' : 'cfg');
      const receipt = observer.receipt();
      expect(sameStageDeletedReadInputs(receipt)).toEqual([]);
      expect(() => requireDeletedReadInput(receipt, reads(receipt).at(-1)!.id)).toThrow(UnsupportedReadLawObservation);
    } finally {
      observer.restore();
    }
  },
);

it('a read before a tombstone and a read from a different namespace are not inputs', () => {
  const native = new BufferPort();
  const stage = new StagePort(native, ['runs', 'left']);
  const observer = installReadLawObservation(hooks, 'leg0');
  try {
    stage.getValue([], 'cfg');
    stage.setObject([], 'cfg', undefined);
    stage.getValue(['runs', 'right'], 'cfg');
    expect(sameStageDeletedReadInputs(observer.receipt())).toEqual([]);
  } finally {
    observer.restore();
  }
});

it('unsupported value capture invokes no getter, changes no native return, and refuses proof', () => {
  let invoked = 0;
  const result = {
    get hidden() {
      invoked++;
      return 1;
    },
  };
  const native = new BufferPort();
  const stage = new StagePort(native);
  native.readResult = result;
  const observer = installReadLawObservation(hooks, 'leg0');
  try {
    stage.setObject([], 'cfg', undefined);
    expect(stage.getValue([], 'cfg')).toBe(result);
    expect(invoked).toBe(0);
    expect(observer.receipt().issues.length).toBeGreaterThan(0);
    expect(() => observer.assertUsable()).toThrow(UnsupportedReadLawObservation);
    expect(() => sameStageDeletedReadInputs(observer.receipt())).toThrow(UnsupportedReadLawObservation);
  } finally {
    observer.restore();
  }
});

it('unjoined and cross-leg evidence never default to a fabricated buffer/address or leg', () => {
  class DirectStage extends StagePort {
    getValue() {
      return undefined;
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
  const observer = installReadLawObservation({ StageContext: DirectStage, TransactionBuffer: BufferPort }, 'leg0');
  try {
    const stage = new DirectStage(new BufferPort());
    stage.setObject([], 'cfg', undefined);
    stage.getValue();
    const receipt = observer.receipt();
    expect(reads(receipt)[0].gets).toEqual([]);
    expect(() => requireDeletedReadInput(receipt, reads(receipt)[0].id)).toThrow(UnsupportedReadLawObservation);
    expect(sameStageDeletedReadInputs({ ...receipt, leg: 'different-leg' })).toEqual([]);
  } finally {
    observer.restore();
  }
});

it('overlapping installations refuse without replacing the active native wrappers', () => {
  const observer = installReadLawObservation(hooks, 'leg0');
  const installed = StagePort.prototype.getValue;
  try {
    expect(() => installReadLawObservation(hooks, 'leg1')).toThrow(UnsupportedReadLawObservation);
    expect(StagePort.prototype.getValue).toBe(installed);
  } finally {
    observer.restore();
  }
});

it('one native buffer cannot silently acquire two frame owners in the same epoch', () => {
  const native = new BufferPort();
  const first = new StagePort(native);
  const second = new StagePort(native);
  const observer = installReadLawObservation(hooks, 'leg0');
  try {
    first.setObject([], 'cfg', undefined);
    second.getValue([], 'cfg');
    expect(() => observer.assertUsable()).toThrow(UnsupportedReadLawObservation);
    expect(() => sameStageDeletedReadInputs(observer.receipt())).toThrow(UnsupportedReadLawObservation);
  } finally {
    observer.restore();
  }
});

it('validates every native descriptor before patching and never invokes a method getter', () => {
  let reads = 0;
  const badBuffer = Object.defineProperties({}, Object.getOwnPropertyDescriptors(BufferPort.prototype));
  Object.defineProperty(badBuffer, 'get', {
    configurable: true,
    get() {
      reads++;
      return () => undefined;
    },
  });
  const before = Object.getOwnPropertyDescriptors(StagePort.prototype);
  expect(() =>
    installReadLawObservation({ StageContext: StagePort, TransactionBuffer: { prototype: badBuffer } }, 'leg0'),
  ).toThrow(UnsupportedReadLawObservation);
  expect(reads).toBe(0);
  expect(Object.getOwnPropertyDescriptors(StagePort.prototype)).toEqual(before);
});
