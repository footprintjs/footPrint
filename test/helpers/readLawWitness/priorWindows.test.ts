import { describe, expect, it } from 'vitest';

import type { NativeFact, OperationSpan, ValueFact } from '../readWitness.js';
import { priorRetainedWindows } from './priorWindows.js';
import type { JoinedRun, ReadPair, RetainedSite } from './types.js';

const U: ValueFact = { kind: 'undefined' };
const old: ValueFact = { kind: 'string', value: 's' };
/** Inert original-member data, not a native engine or an encoder implementation. */
function fixture() {
  const coordinate = ['chart', 0, 'child', 0, 'op', 1];
  const sides = [false, true].map((build) => {
    const header = { stageId: 'child-0', runtimeStageId: 'child-0#0', runId: '' };
    const base = { leg: 'run', frame: 1, header, outcome: 'returned' as const };
    const retention = {
      nativeId: 3,
      frame: 1,
      key: 'hist',
      value: build ? U : old,
      eligibility: {
        mode: 'full' as const,
        layout: build ? ('build-own-policy' as const) : ('baseline-own-readTracking' as const),
      },
    };
    const span: OperationSpan = {
      coordinate,
      programPath: ['stages', 0, 1],
      path: [],
      start: 2,
      end: 8,
      outcome: 'returned',
      edits: [],
    };
    const events: NativeFact[] = [
      {
        ...base,
        id: 1,
        start: 1,
        end: 2,
        tier: 'buffer-call',
        method: 'delete',
        phase: 'write',
        buffer: 1,
        epoch: 0,
        address: ['hist'],
      },
      {
        ...base,
        id: 3,
        start: 3,
        end: 7,
        tier: 'stage-call',
        method: 'getValue',
        phase: 'read',
        operation: coordinate,
        call: {
          args: [
            { kind: 'array', value: 0, entries: [] },
            { kind: 'string', value: 'hist' },
          ],
          objects: [10, undefined],
        },
        gets: [4],
        result: build ? U : old,
        retention,
      },
      {
        ...base,
        id: 4,
        start: 4,
        end: 5,
        tier: 'buffer-call',
        method: 'get',
        phase: 'read',
        operation: coordinate,
        buffer: 1,
        epoch: 0,
        address: ['hist'],
        result: U,
        base: { found: true, value: old },
      },
      {
        ...base,
        id: 11,
        start: 11,
        end: 15,
        tier: 'buffer-call',
        method: 'commit',
        phase: 'commit',
        buffer: 1,
        epoch: 0,
        encoder: { method: 'toChangeOnlyPayload', mode: 'full', start: 12, end: 13, bytes: '{}' },
      },
      {
        ...base,
        frame: 2,
        header: { stageId: 'child-2', runtimeStageId: 'child-2#0' },
        id: 21,
        start: 21,
        end: 25,
        tier: 'buffer-call',
        method: 'commit',
        phase: 'commit',
        buffer: 2,
        epoch: 0,
        encoder: { method: 'toChangeOnlyPayload', mode: 'full', start: 22, end: 23, bytes: build ? 'new' : 'old' },
      },
    ];
    const tree = {
      id: 'child-0',
      runtimeStageId: 'child-0#0',
      stageReads: { a: 1, hist: build ? '«undefined»' : 's' },
    };
    const run: JoinedRun = {
      program: '{"stages":[[{"t":"del","k":"hist"},{"t":"readAll"}]]}',
      native: { leg: 'run', events, issues: [] },
      operations: [span],
      kept: { executionTree: JSON.stringify(tree) },
      commits: [
        { nativeId: 11, bytes: '{}', foldsBack: true },
        { nativeId: 21, bytes: build ? 'new' : 'old', foldsBack: true },
      ],
    };
    return { run, retention, span };
  });
  const [a, b] = sides;
  const site: RetainedSite = {
    kind: 'stage-read',
    field: 'executionTree',
    nodePath: [],
    baseline: a.retention,
    build: b.retention,
  };
  const bound = { coordinate, frame: 1, start: 2, end: 8, nativeId: 3 };
  const pair: ReadPair = {
    baseline: bound,
    build: bound,
    sites: [site],
    operationSpans: { baseline: a.span, build: b.span },
  };
  return { a: a.run, b: b.run, pair };
}
describe('independent earlier retained-only windows, not FIRST causes or propagation', () => {
  it('keeps shape1 at its own stage beside a later changed commit', () => {
    const f = fixture();
    const before = JSON.stringify(f);
    expect(priorRetainedWindows(f.a, f.b, [f.pair], 1).facts).toMatchObject([
      { stage: { stageId: 'child-0', commit: 0 }, address: ['hist'], baselineReturn: old, buildReturn: U },
    ]);
    expect(JSON.stringify(f)).toBe(before);
  });
  it.each(['slot', 'commit', 'retention', 'span', 'late-stage', 'duplicate', 'write', 'shadowed'])(
    'refuses %s in an earlier window',
    (damage) => {
      const f = fixture();
      if (damage === 'slot')
        Object.assign(f.a, {
          kept: {
            executionTree: JSON.stringify({
              id: 'child-0',
              runtimeStageId: 'child-0#0',
              stageReads: { a: 99, hist: 's' },
            }),
          },
        });
      if (damage === 'commit') Object.assign(f.a.commits[0], { bytes: 'corrupt' });
      if (damage === 'retention')
        Object.assign(f.a.native.events[1].retention!, { value: { kind: 'string', value: 'wrong' } });
      if (damage === 'span')
        Object.assign(f.pair, { operationSpans: { baseline: { ...f.a.operations![0] }, build: f.b.operations![0] } });
      if (damage === 'late-stage') Object.assign(f.a.native.events[3], { frame: 9 });
      if (damage === 'write')
        (f.a.native.events as NativeFact[]).push({ ...f.a.native.events[0], id: 6, start: 6, end: 6.5 });
      if (damage === 'shadowed') {
        const read = f.a.native.events[1];
        (f.a.native.events as NativeFact[]).push({
          ...read,
          id: 8,
          start: 8,
          end: 9,
          retention: { ...read.retention!, nativeId: 8 },
        });
      }
      expect(() => priorRetainedWindows(f.a, f.b, damage === 'duplicate' ? [f.pair, f.pair] : [f.pair], 1)).toThrow();
    },
  );
});
