import { describe, expect, it } from 'vitest';

import { equalNativeTrace, readRetention124 } from '../readLawWitness.js';
import type { NativeFact, OperationSpan, ValueFact } from '../readWitness.js';
import { sameStageDeletedReadInputs } from '../readWitness.js';
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
  it('both native undefined returns need no #124 pair, stay in the exact trace, and do not invoke missing-base proof', () => {
    const { a, b } = fixture();
    const missing: ValueFact = { kind: 'undefined' };
    for (const run of [a, b]) {
      Object.assign(run.native.events[1], { result: missing });
      Object.assign(run.native.events[2], { base: { found: false, value: missing } });
    }
    const before = JSON.stringify({ a, b });
    const ordinary = a.native.events[1];
    expect(pairObservedReads(a, b)).toEqual({ kind: 'bindings', reads: [] });
    expect(a.native.events.includes(ordinary)).toBe(true);
    expect(JSON.stringify({ a, b })).toBe(before);
    expect(equalNativeTrace(a.native, b.native, [])).toBe(true);
    // The row was NOT removed or normalized: a later wrong native return still breaks the full trace/proof.
    Object.assign(b.native.events[1], { result: { kind: 'number', value: '99' } });
    expect(equalNativeTrace(a.native, b.native, [])).toBe(false);
    expect(pairObservedReads(a, b).kind).toBe('unproven');
  });

  it.each<{ label: string; value: ValueFact }>([
    { label: 'null', value: { kind: 'null' } },
    { label: 'array', value: { kind: 'array', value: 0, entries: [] } },
    { label: 'object', value: { kind: 'object', entries: [] } },
  ])(
    'equal stale $label after the tombstone is still refused, never skipped as an unchanged semantic return',
    ({ value }) => {
      const { a, b } = fixture();
      for (const run of [a, b]) {
        Object.assign(run.native.events[1], { result: value });
        Object.assign(run.native.events[2], { base: { found: true, value } });
      }
      expect(pairObservedReads(a, b).kind).toBe('unproven');
    },
  );

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
  it.each(['method', 'arguments', 'coordinate', 'missing-base'])(
    'refuses %s ambiguity without searching another matching value',
    (damage) => {
      const { a, b } = fixture();
      if (damage === 'method') (b.native.events[1] as any).method = 'getValueDirect';
      if (damage === 'arguments') (b.native.events[1] as any).call.args[1] = { kind: 'string', value: 'y' };
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

  it('an incomplete frame witness is not a direct pair or an admission; its raw difference remains exact', () => {
    const { a, b } = fixture();
    Object.assign(b.native.events[1], { frame: 2 });
    const before = JSON.stringify({ a, b });
    expect(pairObservedReads(a, b)).toEqual({ kind: 'bindings', reads: [] });
    expect(readRetention124(a, b, []).kind).toBe('unproven');
    expect(equalNativeTrace(a.native, b.native, [])).toBe(false);
    expect(JSON.stringify({ a, b })).toBe(before);
  });

  it('preserves an earlier direct candidate when a later read is re-established on only one side', () => {
    const f = fixture();
    const after: ValueFact = { kind: 'array', value: 1, entries: [['0', true, { kind: 'number', value: '0' }]] };
    const coordinate = ['nested', 'run', 'stage', 0, 'op', 2];
    const program = JSON.stringify({
      stages: [
        {
          ops: [
            { t: 'del', path: 0, k: 'x' },
            { t: 'read', path: 0, k: 'x' },
            { t: 'read', path: 0, k: 'x' },
          ],
        },
      ],
    });
    for (const [run, build] of [
      [f.a, false],
      [f.b, true],
    ] as const) {
      Object.assign(run, {
        program,
        operations: [
          ...run.operations,
          {
            coordinate,
            programPath: ['stages', 0, 'ops', 2],
            path: [],
            start: 8,
            end: 13,
            edits: [],
            outcome: 'returned',
          },
        ],
      });
      if (!build)
        (run.native.events as NativeFact[]).push({
          ...run.native.events[0],
          id: 7,
          start: 7,
          end: 7.5,
          method: 'set',
          value: after,
        });
      (run.native.events as NativeFact[]).push(
        {
          ...run.native.events[1],
          id: 9,
          start: 9,
          end: 12,
          operation: coordinate,
          gets: [10],
          retention: undefined,
          result: build ? { kind: 'undefined' } : after,
        },
        { ...run.native.events[2], id: 10, start: 10, end: 11, result: build ? { kind: 'undefined' } : after },
      );
    }
    // Inert classification evidence only: this does NOT claim the earlier candidate proves a full FIRST cause.
    expect(sameStageDeletedReadInputs(f.a.native).map(({ read }) => read.id)).toEqual([3]);
    expect(sameStageDeletedReadInputs(f.b.native).map(({ read }) => read.id)).toEqual([3, 9]);
    const before = JSON.stringify(f);
    const paired = pairObservedReads(f.a, f.b);
    expect(paired.kind).toBe('bindings');
    if (paired.kind !== 'bindings') throw new Error(paired.reason);
    expect(paired.reads.map(({ pair }) => [pair.baseline.nativeId, pair.build.nativeId])).toEqual([[3, 3]]);
    // The later one-sided read/write rows still differ: retained-only comparison cannot use the classifier as a filter.
    expect(
      equalNativeTrace(
        f.a.native,
        f.b.native,
        paired.reads.map(({ pair }) => pair),
      ),
    ).toBe(false);
    expect(JSON.stringify(f)).toBe(before);
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
    const bound = bindRetainedPairs(a, b, 'chart', native.reads);
    expect(bound.kind).toBe('retained-bindings');
    if (bound.kind !== 'retained-bindings') throw new Error(bound.reason);
    expect(bound.pairs[0].sites).toEqual([]); // No earlier final-slot claim; an empty binding is not an admission.
    for (const run of [a, b]) {
      (run.native.events as NativeFact[]).push({
        id: 20,
        start: 20,
        end: 25,
        leg: 'run',
        tier: 'buffer-call',
        method: 'commit',
        phase: 'commit',
        outcome: 'returned',
        frame: 1,
        header: run.native.events[1].header,
        buffer: 1,
        epoch: 0,
        encoder: { method: 'toChangeOnlyPayload', start: 21, end: 23, mode: 'full', bytes: 'same' },
      });
      Object.assign(run, { commits: [{ bytes: 'same', foldsBack: true, nativeId: 20 }] });
    }
    expect(equalNativeTrace(a.native, b.native, bound.pairs)).toBe(false);
    expect(readRetention124(a, b, bound.pairs).kind).toBe('unproven');
  });

  it('keeps both native/delivered pairs but gives the final same-key stage slot only to its last actual native owner', () => {
    const { a, b } = fixture();
    const coordinate = ['nested', 'run', 'stage', 0, 'op', 2];
    const program = JSON.stringify({
      stages: [
        {
          ops: [
            { t: 'del', path: 0, k: 'x' },
            { t: 'read', path: 0, k: 'x' },
            { t: 'read', path: 0, k: 'x' },
          ],
        },
      ],
    });
    for (const [run, build] of [
      [a, false],
      [b, true],
    ] as const) {
      const original = run.native.events[1];
      const retained = { ...original.retention!, nativeId: 8 };
      (run.native.events as NativeFact[]).push(
        { ...original, id: 8, start: 8, end: 11, operation: coordinate, gets: [9], retention: retained },
        { ...run.native.events[2], id: 9, start: 9, end: 10 },
        {
          id: 20,
          start: 20,
          end: 25,
          leg: 'run',
          tier: 'buffer-call',
          method: 'commit',
          phase: 'commit',
          outcome: 'returned',
          frame: 1,
          header: original.header,
          buffer: 1,
          epoch: 0,
          encoder: { method: 'toChangeOnlyPayload', start: 21, end: 23, mode: 'full', bytes: 'same' },
        },
      );
      Object.assign(run, {
        program,
        commits: [{ bytes: 'same', foldsBack: true, nativeId: 20 }],
        operations: [
          ...run.operations,
          {
            coordinate,
            programPath: ['stages', 0, 'ops', 2],
            path: [],
            start: 7,
            end: 12,
            edits: [],
            outcome: 'returned',
          },
        ],
        kept: { ...run.kept, reads: build ? 'null\nnull' : '[]\n[]' },
      });
    }
    const before = JSON.stringify({ a, b });
    const native = pairObservedReads(a, b);
    expect(native.kind).toBe('bindings');
    if (native.kind !== 'bindings') throw new Error(native.reason);
    expect(native.reads.map(({ pair }) => pair.baseline.nativeId)).toEqual([3, 8]);
    const bound = bindRetainedPairs(a, b, 'nested', native.reads);
    expect(bound.kind).toBe('retained-bindings');
    if (bound.kind !== 'retained-bindings') throw new Error(bound.reason);
    expect(bound.pairs[0].sites.map(({ kind }) => kind)).toEqual(['read-line']);
    expect(bound.pairs[1].sites.map(({ kind }) => kind)).toEqual(['read-line', 'stage-read']);
    const stage = bound.pairs[1].sites.find((site) => site.kind === 'stage-read');
    if (!stage || stage.kind !== 'stage-read') throw new Error('Expected exactly the final actual stage owner.');
    expect(stage.baseline).toBe(a.native.events.find(({ id }) => id === 8)!.retention);
    expect(stage.build).toBe(b.native.events.find(({ id }) => id === 8)!.retention);
    expect(readRetention124(a, b, bound.pairs).kind).toBe('related');
    expect(JSON.stringify({ a, b })).toBe(before);
  });

  it.each(['nativeId', 'leg', 'mode', 'overlap'] as const)(
    'still refuses ambiguous later retained %s provenance, even when another later owner was valid',
    (damage) => {
      const { a, b } = fixture();
      for (const run of [a, b]) {
        const original = run.native.events[1];
        const valid: NativeFact = {
          ...original,
          id: 8,
          start: 8,
          end: 9,
          operation: undefined,
          retention: { ...original.retention!, nativeId: 8 },
        };
        const unknown: NativeFact = {
          ...original,
          id: 10,
          start: 10,
          end: 11,
          operation: undefined,
          retention: { ...original.retention!, nativeId: 10 },
        };
        if (damage === 'nativeId') Object.assign(unknown, { retention: { ...unknown.retention, nativeId: 999 } });
        if (damage === 'leg') Object.assign(unknown, { leg: 'other-actual-leg' });
        if (damage === 'mode')
          Object.assign(unknown, {
            retention: { ...unknown.retention, eligibility: { ...unknown.retention!.eligibility, mode: 'off' } },
          });
        if (damage === 'overlap') Object.assign(unknown, { start: 5 });
        (run.native.events as NativeFact[]).push(valid, unknown);
      }
      const native = pairObservedReads(a, b);
      expect(native.kind).toBe('bindings');
      if (native.kind !== 'bindings') throw new Error(native.reason);
      expect(bindRetainedPairs(a, b, 'chart', native.reads).kind).toBe('unproven');
    },
  );
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
