import { describe, expect, it } from 'vitest';

import {
  type ChartProgram,
  type NestedProgram,
  BASELINE,
  BUILD,
  observing,
  observingSync,
  runChart,
  runNested,
} from '../../lib/memory/property/copy-on-write-fixture.js';
import { type ObservedKept, bindRetainedPairs, joinedRun, pairObservedReads } from '../readBindings.js';
import { nativeTraceComparison, readRetention124, rootArrayAuxiliaryProfile } from '../readLawWitness.js';

/** Fixed actual counterexamples, not a grant to admit their differences. */
function receipt(label: string, a: ObservedKept, b: ObservedKept) {
  expect(a.program).toBe(b.program);
  expect(a.native.issues).toEqual([]);
  expect(b.native.issues).toEqual([]);
  expect(b.commits.every((row) => row.foldsBack)).toBe(true);
  const data = JSON.stringify({ label, baseline: a, build: b });
  if (new TextEncoder().encode(data).byteLength > 1_048_576)
    throw new Error('Native intake exceeds its explicit bound.');
  // A bounded data receipt in the actual job log; no target value or source is rewritten.
  console.log(`FP124-NATIVE-INTAKE ${data}`);
}

describe('actual native intake for unproved observation shapes', () => {
  it('retains the exact logical namespaced fallback counterexample without inventing its base', () => {
    const program: NestedProgram = {
      initial: { x: 0 },
      commitValues: 'full',
      mutate: false,
      stages: [
        {
          runId: 'r1',
          ops: [
            { t: 'del', path: 0, k: 'x' },
            { t: 'read', path: 0, k: 'x' },
          ],
        },
      ],
    };
    const a = observingSync(BASELINE, program, 'run', (ops) => runNested(BASELINE, program, undefined, ops));
    const b = observingSync(BUILD, program, 'run', (ops) => runNested(BUILD, program, undefined, ops));
    receipt('namespaced-global-zero', joinedRun(a, a.value), joinedRun(b, b.value));
  });

  it('retains the actual missing-container object fallback before claiming its identity join', () => {
    const program: NestedProgram = {
      stages: [
        { runId: '', ops: [{ t: 'merge', path: 4, k: 'y', v: 0 }] },
        {
          runId: '',
          ops: [
            { t: 'del', path: 1, k: 'list' },
            { t: 'read', path: 4, k: 'x' },
            { t: 'read', path: 1, k: 'list' },
          ],
        },
        { runId: '', ops: [] },
      ],
      commitValues: 'full',
      mutate: false,
    };
    const a = observingSync(BASELINE, program, 'run', (ops) => runNested(BASELINE, program, undefined, ops));
    const b = observingSync(BUILD, program, 'run', (ops) => runNested(BUILD, program, undefined, ops));
    receipt('missing-container-object', joinedRun(a, a.value), joinedRun(b, b.value));
  });

  it('retains the unchanged typed-proxy read expression and all its actual auxiliary calls', async () => {
    const program: ChartProgram = {
      seed: [],
      stages: [
        [
          { t: 'del', k: 'list' },
          { t: 'read', k: 'list' },
        ],
        [],
      ],
      sub: { at: 0, inner: [[]], seedObj: false, mergeObj: false, arrayReplace: false },
      cfg: {
        commitValues: 'full',
        readTracking: 'full',
        writeTracking: 'full',
        writeProvenance: 'off',
        policy: false,
        initial: false,
      },
    };
    const a = await observing(BASELINE, program, 'run', (ops) => runChart(BASELINE, program, () => ops));
    const b = await observing(BUILD, program, 'run', (ops) => runChart(BUILD, program, () => ops));
    const old = joinedRun(a, a.value.out);
    const now = joinedRun(b, b.value.out);
    receipt('typed-proxy-read-expression', old, now);
    // Live ORIGINAL references only. The saved JSON is a data receipt and is never revived as native authority.
    const bindings = pairObservedReads(old, now);
    expect(bindings.kind).toBe('bindings');
    if (bindings.kind !== 'bindings') throw new Error(bindings.reason);
    expect(bindings.reads).toHaveLength(1);
    const paired = bindings.reads[0];
    const profile = rootArrayAuxiliaryProfile(old, now, paired.pair);
    expect(profile.kind).toBe('profile');
    if (profile.kind !== 'profile') throw new Error(profile.reason);
    expect(paired.pair.operationSpans?.baseline).toBe(paired.baselineSpan);
    expect(paired.pair.operationSpans?.build).toBe(paired.buildSpan);
    expect(old.operations.includes(paired.baselineSpan)).toBe(true);
    expect(now.operations.includes(paired.buildSpan)).toBe(true);
    const actualOld = old.native.events.filter(
      (event) =>
        event.tier === 'stage-call' &&
        event.phase === 'read' &&
        paired.baselineSpan.start < event.start &&
        event.end < paired.baselineSpan.end,
    );
    const actualNew = now.native.events.filter(
      (event) =>
        event.tier === 'stage-call' &&
        event.phase === 'read' &&
        paired.buildSpan.start < event.start &&
        event.end < paired.buildSpan.end,
    );
    expect(actualOld[0]).toBe(paired.baselineRead);
    expect(actualNew).toEqual([paired.buildRead]);
    expect(profile.reads).toEqual(actualOld.slice(1));
    expect(profile.evidence.auxiliaryReadCount).toBe(actualOld.length - 1);
    expect(profile.evidence.auxiliaryReadCount).toBeGreaterThan(0);
    expect(profile.evidence.receiverFacts.every((fact) => fact.object === paired.baselineRead.resultObject)).toBe(true);
    console.log(`FP124-AUXILIARY-PROFILE ${JSON.stringify(profile.evidence)}`);
    const retained = bindRetainedPairs(old, now, 'chart', bindings.reads);
    if (retained.kind !== 'retained-bindings') throw new Error(retained.reason);
    const relation = readRetention124(old, now, retained.pairs);
    expect(relation.kind).toBe('related');
    if (relation.kind !== 'related') throw new Error(relation.reason);
    expect(relation.name).toBe('read-after-delete-124');
    expect(relation.nativeTrace).toEqual(nativeTraceComparison(retained.pairs));
    expect(relation.auxiliary?.auxiliaryReadCount).toBe(profile.evidence.auxiliaryReadCount);
    expect(relation.auxiliary?.profiles[0]).toEqual(profile.evidence);
    console.log(`FP124-NATIVE-RELATION ${JSON.stringify(relation)}`);
  });
});
