import { describe, expect, it } from 'vitest';

import { installReadLawObservation } from './observation.js';

/** Scripted delegation only: no heap/staging/encoding algorithm in these ports. */
function ports() {
  class BufferPort {
    baseSnapshot = { x: [3] };
    commitValues = 'full';
    writes: unknown[] = [];
    set(_path: unknown, value: unknown) {
      this.writes.push(value);
    }

    merge(_path: unknown, value: unknown) {
      this.writes.push(value);
    }

    delete(_path: unknown) {
      this.writes.push(undefined);
    }

    get(_path: unknown) {
      return undefined;
    }

    toChangeOnlyPayload() {
      return { overwrite: {}, updates: {}, redactedPaths: [], trace: [] };
    }

    toDeltaPayload() {
      return { overwrite: {}, updates: {}, redactedPaths: [], trace: [] };
    }

    commit() {
      return this.toChangeOnlyPayload();
    }
  }
  class StagePort {
    stageId = 's';
    runId = '';
    runtimeStageId = '';
    _stageReads: Record<string, unknown> = {};
    readTracking: 'full' | 'off' = 'full';
    answer: unknown = [3];
    reads = 0;
    constructor(readonly buffer: BufferPort) {}
    getValue(path: string[], key: string) {
      this.reads++;
      this.buffer.get([...path, key]);
      if (this.readTracking !== 'off') this._stageReads[key] = this.answer;
      return this.answer;
    }

    setObject(
      path: string[],
      key: string,
      value: unknown,
      _redact?: boolean,
      _description?: string,
      override?: string,
    ) {
      if (override === 'delete') this.buffer.delete([...path, key]);
      else this.buffer.set([...path, key], value);
    }

    updateObject(path: string[], key: string, value: unknown) {
      this.buffer.merge([...path, key], value);
    }

    commit() {
      return this.buffer.commit();
    }
  }
  return { BufferPort, StagePort };
}
describe('native collector ports — unrun inert author controls', () => {
  it('joins actual call arguments, returned object, edit/write identity and immediate retained value', () => {
    const { BufferPort, StagePort } = ports();
    const buffer = new BufferPort();
    const stage = new StagePort(buffer);
    const observed = installReadLawObservation({ StageContext: StagePort, TransactionBuffer: BufferPort }, 'run', {
      profile: 'baseline-full-payload',
      snapshotRows: (value) => JSON.stringify(value),
      snapshotPaths: (value) => JSON.stringify(value),
    });
    try {
      const got = observed.operations.within(
        { coordinate: ['writeback', 0, 0], programPath: ['stages', 0, 'ops', 0], path: [] },
        () => {
          stage.setObject([], 'x', undefined, false, undefined, 'delete');
          const value = stage.getValue([], 'x');
          observed.operations.edit(value, 9, (input, n) => (input as number[]).push(n));
          stage.setObject([], 'x', value);
          return value;
        },
      );
      stage.commit();
      observed.assertUsable();
      const rows = observed.receipt().events;
      const read = rows.find((e) => e.tier === 'stage-call' && e.method === 'getValue')!;
      const write = rows.filter((e) => e.tier === 'stage-call' && e.method === 'setObject')[1];
      const nativeWrite = rows.find((e) => e.tier === 'buffer-call' && e.method === 'set')!;
      expect(stage.reads).toBe(1);
      expect(got).toBe(stage.answer);
      expect(write.call!.objects[2]).toBe(read.resultObject);
      expect(nativeWrite.valueObject).toBe(read.resultObject);
      expect(read.retention!.key).toBe('x');
      expect(read.retention!.value).toEqual({
        kind: 'array',
        value: 1,
        entries: [['0', true, { kind: 'number', value: '3' }]],
      });
      expect(observed.commitOf(buffer)?.encoder?.bytes).toBe(
        '{"overwrite":{},"updates":{},"redactedPaths":[],"trace":[]}',
      );
      expect(observed.operations.receipt().spans[0].edits[0].object).toBe(read.resultObject);
    } finally {
      observed.restore();
    }
  });
  it('retains a caller escaping value and restores all added method descriptors', () => {
    const { BufferPort, StagePort } = ports();
    const before = Object.getOwnPropertyDescriptor(StagePort.prototype, 'getValue');
    const observed = installReadLawObservation({ StageContext: StagePort, TransactionBuffer: BufferPort }, 'run');
    const escaped = {};
    try {
      observed.operations.within({ coordinate: ['chart', 0], programPath: ['seed', 0], path: [] }, () => {
        throw escaped;
      });
    } catch (error) {
      expect(error).toBe(escaped);
    } finally {
      observed.restore();
    }
    expect(Object.getOwnPropertyDescriptor(StagePort.prototype, 'getValue')).toEqual(before);
  });
  it('does not attach an old retained slot to a current readTracking OFF call', () => {
    const { BufferPort, StagePort } = ports();
    const stage = new StagePort(new BufferPort());
    stage._stageReads.x = 'prior-retained';
    stage.readTracking = 'off';
    const observed = installReadLawObservation({ StageContext: StagePort, TransactionBuffer: BufferPort }, 'run');
    try {
      stage.getValue([], 'x');
      expect(
        observed.receipt().events.find((e) => e.tier === 'stage-call' && e.method === 'getValue')!.retention,
      ).toBeUndefined();
      expect(stage._stageReads.x).toBe('prior-retained');
    } finally {
      observed.restore();
    }
  });
  it('records eligible same-value full reads under the explicit native policy layout', () => {
    const { BufferPort, StagePort } = ports();
    const stage = new StagePort(new BufferPort());
    stage.answer = 7;
    stage._stageReads.x = 7;
    delete (stage as Partial<StagePort>).readTracking;
    Object.defineProperty(stage, 'policy', { value: Object.freeze({ readTracking: 'full' }) });
    const original = stage.getValue;
    // This scripted native port has the same explicit modern eligibility contract, with no heap algorithm.
    StagePort.prototype.getValue = function (path, key) {
      this.buffer.get([...path, key]);
      this._stageReads[key] = this.answer;
      return this.answer;
    };
    const observed = installReadLawObservation({ StageContext: StagePort, TransactionBuffer: BufferPort }, 'run');
    try {
      stage.getValue([], 'x');
      const retained = observed.receipt().events.find((e) => e.tier === 'stage-call' && e.method === 'getValue')!
        .retention!;
      expect(retained.eligibility).toEqual({ layout: 'build-own-policy', mode: 'full' });
      expect(retained.value).toEqual({ kind: 'number', value: '7' });
    } finally {
      observed.restore();
      StagePort.prototype.getValue = original;
    }
  });
});
