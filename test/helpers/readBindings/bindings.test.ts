import { describe, expect, it } from 'vitest';

import type { NativeFact, OperationSpan, ValueFact } from '../readWitness.js';
import { bindRetainedPairs, pairObservedReads } from './index.js';
import type { ObservedKept } from './types.js';

/** Inert receipt constructor only; native engine behavior is proved separately by root. */
function fixture() {
  const stale: ValueFact = { kind: 'array', value: 0, entries: [] };
  const missing: ValueFact = { kind: 'undefined' };
  const coordinate = ['nested', 'run', 'stage', 0, 'op', 1];
  const span: OperationSpan = {
    coordinate,
    programPath: ['stages', 0, 'ops', 1],
    path: [],
    start: 2,
    end: 7,
    edits: [],
    outcome: 'returned',
  };
  const program = JSON.stringify({
    stages: [
      {
        ops: [
          { t: 'del', path: 0, k: 'x' },
          { t: 'read', path: 0, k: 'x' },
        ],
      },
    ],
  });
  const run = (build: boolean): ObservedKept => {
    const header = { stageId: 's0', runId: '', runtimeStageId: '' };
    const retained = {
      nativeId: 3,
      frame: 1,
      key: 'x',
      value: build ? missing : stale,
      eligibility: {
        layout: build ? ('build-own-policy' as const) : ('baseline-own-readTracking' as const),
        mode: 'full' as const,
      },
    };
    const events: NativeFact[] = [
      {
        id: 1,
        start: 1,
        end: 2,
        leg: 'run',
        tier: 'buffer-call',
        phase: 'write',
        method: 'delete',
        outcome: 'returned',
        frame: 1,
        header,
        buffer: 1,
        epoch: 0,
        address: ['x'],
      },
      {
        id: 3,
        start: 3,
        end: 6,
        leg: 'run',
        tier: 'stage-call',
        phase: 'read',
        method: 'getValue',
        outcome: 'returned',
        frame: 1,
        header,
        operation: coordinate,
        retention: retained,
        call: {
          args: [
            { kind: 'array', value: 0, entries: [] },
            { kind: 'string', value: 'x' },
          ],
          objects: [],
        },
        result: build ? missing : stale,
        gets: [4],
      },
      {
        id: 4,
        start: 4,
        end: 5,
        leg: 'run',
        tier: 'buffer-call',
        phase: 'read',
        method: 'get',
        outcome: 'returned',
        frame: 1,
        header,
        buffer: 1,
        epoch: 0,
        address: ['x'],
        result: missing,
        base: { found: true, value: stale },
      },
    ];
    return {
      program,
      operations: [span],
      native: { leg: 'run', events, issues: [] },
      commits: [{ bytes: 'same', foldsBack: true }],
      kept: {
        reads: build ? 'null' : '[]',
        state: '{}',
        snapshots: JSON.stringify({ id: 's0', stageReads: { x: build ? '«undefined»' : [] } }),
      },
    };
  };
  return { a: run(false), b: run(true) };
}
describe('actual operation/read/retention pairing — unrun inert controls', () => {
  it('constructs native IDs and occurrence from the actual receipt and binds explicit line + owned stage slot', () => {
    const { a, b } = fixture();
    const native = pairObservedReads(a, b);
    expect(native.kind).toBe('bindings');
    if (native.kind !== 'bindings') return;
    expect(native.reads[0].pair.baseline.nativeId).toBe(3);
    expect(native.reads[0].pair.baseline.occurrence).toBe(0);
    const retained = bindRetainedPairs(a, b, 'nested', native.reads);
    expect(retained.kind).toBe('retained-bindings');
    if (retained.kind !== 'retained-bindings') return;
    expect(retained.pairs[0].sites.map(({ kind }) => kind)).toEqual(['read-line', 'stage-read']);
    expect((retained.pairs[0].sites[1] as any).baseline).toBe(a.native.events[1].retention);
  });
  it.each(['method', 'arguments', 'frame', 'coordinate', 'missing-base'])(
    'refuses %s ambiguity without searching another matching value',
    (damage) => {
      const { a, b } = fixture();
      if (damage === 'method') (b.native.events[1] as any).method = 'getValueDirect';
      if (damage === 'arguments') (b.native.events[1] as any).call.args[1] = { kind: 'string', value: 'y' };
      if (damage === 'frame') (b.native.events[1] as any).frame = 2;
      if (damage === 'coordinate') (b.operations as OperationSpan[]).push(b.operations[0]);
      if (damage === 'missing-base') (b.native.events[2] as any).base = { found: false, value: { kind: 'undefined' } };
      expect(pairObservedReads(a, b).kind).toBe('unproven');
    },
  );
  it('keeps primary branch pairing but denies a final slot after a later/ambiguous retaining read', () => {
    const { a, b } = fixture();
    for (const run of [a, b])
      (run.native.events as NativeFact[]).push({
        ...run.native.events[1],
        id: 8,
        start: 8,
        end: 9,
        operation: undefined,
        retention: undefined,
      });
    const native = pairObservedReads(a, b);
    expect(native.kind).toBe('bindings');
    if (native.kind === 'bindings') expect(bindRetainedPairs(a, b, 'nested', native.reads).kind).toBe('unproven');
  });
  it('does not claim an earlier candidate read as final owner merely because a later return has the same value', () => {
    const { a, b } = fixture();
    const native = pairObservedReads(a, b);
    expect(native.kind).toBe('bindings');
    const later = {
      ...b.native.events[1],
      id: 8,
      start: 8,
      end: 9,
      operation: undefined,
      retention: { ...b.native.events[1].retention!, nativeId: 8 },
    };
    (b.native.events as NativeFact[]).push(later);
    if (native.kind !== 'bindings') throw new Error('Expected primary read binding.');
    expect(bindRetainedPairs(a, b, 'chart', native.reads).kind).toBe('unproven');
  });
  it('rejects a changed explicit delivery, missing line, and ambiguous actual stage identity', () => {
    for (const damage of ['delivery', 'line', 'owner']) {
      const { a, b } = fixture();
      if (damage === 'delivery') (b as any).kept = { ...b.kept, reads: '42' };
      if (damage === 'line') (b as any).kept = { ...b.kept, reads: '' };
      if (damage === 'owner')
        (b.native.events as NativeFact[]).push({ ...b.native.events[0], id: 10, start: 10, end: 11, frame: 2 });
      const native = pairObservedReads(a, b);
      expect(native.kind).toBe('bindings');
      if (native.kind === 'bindings') expect(bindRetainedPairs(a, b, 'nested', native.reads).kind).toBe('unproven');
    }
  });
});
