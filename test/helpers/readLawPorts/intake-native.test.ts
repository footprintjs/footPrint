import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  type ChartProgram,
  type NestedProgram,
  type WriteBackProgram,
  BASELINE,
  BUILD,
  observing,
  observingSync,
  runChart,
  runNested,
  runWriteBack,
} from '../../lib/memory/property/copy-on-write-fixture.js';
import { type Entry, CORPUS_PATH, digestKept, keptOf } from '../../lib/memory/scenario/copy-on-write-corpus.js';
import { firstCommit124 } from '../firstCommit124.js';
import { type ObservedKept, bindRetainedPairs, causeAtFirstCommit, joinedRun, pairObservedReads } from '../readBindings.js';
import { nativeTraceComparison, readRetention124, rootArrayAuxiliaryProfile } from '../readLawWitness.js';
import { sameStageDeletedReadInputs } from '../readWitness.js';

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
  it.each([14, 45, 97, 119])('retains original FIRST-boundary facts for unproved corpus entry %s', async (index) => {
    const corpus = JSON.parse(readFileSync(CORPUS_PATH, 'utf8')) as { entries: Entry[] };
    const entry = corpus.entries[index];
    expect(entry.family).toBe('chart');
    const a = await observing(BASELINE, entry.program, 'run', (ops) => keptOf(BASELINE, 'chart', entry.program, ops));
    const b = await observing(BUILD, entry.program, 'run', (ops) => keptOf(BUILD, 'chart', entry.program, ops));
    expect(digestKept(a.value)).toEqual(entry.digests); // Before any named proof, just like the unchanged corpus gate.
    const old = joinedRun(a, a.value);
    const now = joinedRun(b, b.value);
    const first = old.commits.findIndex((row, i) => row.bytes !== now.commits[i]?.bytes);
    const bank = pairObservedReads(old, now);
    const candidates = bank.kind === 'bindings' ? bank.reads.map((read) => {
      const assembled = causeAtFirstCommit(old, now, read, first);
      return { coordinate: read.pair.baseline.coordinate, assembled,
        result: assembled.kind === 'candidate' ? firstCommit124(old, now, assembled.cause, 'chart') : assembled };
    }) : bank;
    receipt(`unproved-corpus-${index}`, old, now);
    const detail = JSON.stringify({ index, first, baselineDigestsMatched: true, candidates });
    if (new TextEncoder().encode(detail).byteLength > 1_048_576) throw new Error('FIRST candidate intake exceeds bound.');
    console.log(`FP124-CORPUS-FIRST-INTAKE ${detail}`);
    // Intake only: no cause is assumed and the original corpus/differential failure remains gating.
  });

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
    const old = joinedRun(a, a.value);
    const now = joinedRun(b, b.value);
    receipt('missing-container-object', old, now);
    const bindings = pairObservedReads(old, now);
    expect(bindings.kind).toBe('bindings');
    if (bindings.kind !== 'bindings') throw new Error(bindings.reason);
    expect(bindings.reads).toHaveLength(1);
    expect(bindings.reads[0].baselineRead.result?.kind).toBe('object');
    expect(bindings.reads[0].buildRead.result?.kind).toBe('undefined');
    const retained = bindRetainedPairs(old, now, 'nested', bindings.reads);
    expect(retained.kind).toBe('retained-bindings');
    if (retained.kind !== 'retained-bindings') throw new Error(retained.reason);
    expect(readRetention124(old, now, retained.pairs).kind).toBe('related');
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

  it('retains original delta fork/subflow encoder modes and bytes beside every actual outer commit', async () => {
    const program: ChartProgram = {
      seed: [],
      stages: [[]],
      sub: { at: 0, inner: [[]], seedObj: false, mergeObj: false, arrayReplace: false },
      fork: {
        at: 0,
        children: [
          [
            { t: 'del', k: 'a' },
            { t: 'elem', k: 'a', i: 0, p: 'x', v: null },
          ],
          [],
        ],
      },
      cfg: {
        commitValues: 'delta',
        readTracking: 'full',
        writeTracking: 'full',
        writeProvenance: 'off',
        policy: false,
        initial: true,
      },
    };
    const before = JSON.stringify(program);
    const a = await observing(BASELINE, program, 'run', (ops) => runChart(BASELINE, program, () => ops));
    const b = await observing(BUILD, program, 'run', (ops) => runChart(BUILD, program, () => ops));
    const old = joinedRun(a, a.value.out);
    const now = joinedRun(b, b.value.out);
    receipt('delta-fork-subflow-original-encoders', old, now);
    const origins = (run: ObservedKept) =>
      run.commits.map((outer, index) => {
        // Membership is by the saved actual receiver occurrence, never by equal payload or guessed actor.
        const actual = run.native.events.filter((event) => event.id === outer.nativeId);
        expect(actual).toHaveLength(1);
        const commit = actual[0];
        expect(commit.tier).toBe('buffer-call');
        expect(commit.method).toBe('commit');
        expect(commit.outcome).toBe('returned');
        expect(commit.encoder).toBeDefined();
        const inner = commit.encoder!;
        expect(inner.start).toBeGreaterThan(commit.start);
        expect(inner.end).toBeLessThan(commit.end);
        expect(inner.method).toBe(inner.mode === 'full' ? 'toChangeOnlyPayload' : 'toDeltaPayload');
        expect(inner.bytes).toBe(outer.bytes);
        return {
          index,
          nativeId: commit.id,
          frame: commit.frame,
          buffer: commit.buffer,
          epoch: commit.epoch,
          header: commit.header,
          start: commit.start,
          end: commit.end,
          encoderMethod: inner.method,
          encoderMode: inner.mode,
          encoderStart: inner.start,
          encoderEnd: inner.end,
          innerBytes: inner.bytes,
          outerBytes: outer.bytes,
          foldsBack: outer.foldsBack,
        };
      });
    const baseline = origins(old);
    const build = origins(now);
    const perIndex = Array.from({ length: Math.max(baseline.length, build.length) }, (_, index) => ({
      index,
      baselineNativeId: baseline[index]?.nativeId,
      buildNativeId: build[index]?.nativeId,
      bothPresent: baseline[index] !== undefined && build[index] !== undefined,
      sameInnerBytes: baseline[index]?.innerBytes === build[index]?.innerBytes,
      sameOuterBytes: baseline[index]?.outerBytes === build[index]?.outerBytes,
      sameMode: baseline[index]?.encoderMode === build[index]?.encoderMode,
      sameEncoderMethod: baseline[index]?.encoderMethod === build[index]?.encoderMethod,
    }));
    const evidence = JSON.stringify({
      program: before,
      projection: 'existing witnessPayloadBytes; no new normalization',
      baseline,
      build,
      perIndex,
      baselineSubflowRecordView: old.kept.subflowResults,
      buildSubflowRecordView: now.kept.subflowResults,
    });
    if (new TextEncoder().encode(evidence).byteLength > 262_144)
      throw new Error('Original encoder comparison intake exceeds its explicit bound.');
    console.log(`FP124-DELTA-ORIGIN-INTAKE ${evidence}`);
    expect(a.program).toBe(before);
    expect(b.program).toBe(before);
    expect(JSON.stringify(program)).toBe(before);
    // No cross-mode equality or named admission is asserted. Actual differences remain data for classification.
  });
  it('retains actual WB one-sided later read eligibility without assuming its first cause', () => {
    const program: WriteBackProgram = {
      initial: undefined, // Required TS field; JSON bytes match the supplied omitted/undefined initial exactly.
      stages: [
        {
          runId: '',
          ops: [
            { t: 'del', path: 1, k: 'deep' },
            { t: 'delReadBack', path: 2, k: 'x', n: 0, how: 'set' },
          ],
        },
        {
          runId: '',
          ops: [
            { t: 'set', path: 0, k: 'x', v: null },
            { t: 'delReadBack', path: 1, k: 'deep', n: 0, how: 'set' },
            { t: 'readBack', path: 1, k: 'deep', n: 0, how: 'set' },
          ],
        },
      ],
      commitValues: 'full',
      mutate: true,
    };
    const a = observingSync(BASELINE, program, 'run', (ops) => runWriteBack(BASELINE, program, undefined, ops));
    const b = observingSync(BUILD, program, 'run', (ops) => runWriteBack(BUILD, program, undefined, ops));
    const old = joinedRun(a, a.value);
    const now = joinedRun(b, b.value);
    receipt('writeback-later-one-sided-eligibility', old, now);
    console.log(
      `FP124-WB-ELIGIBILITY ${JSON.stringify({
        baseline: sameStageDeletedReadInputs(old.native).map(({ read }) => read.id),
        build: sameStageDeletedReadInputs(now.native).map(({ read }) => read.id),
        classification: pairObservedReads(old, now),
      })}`,
    );
    // Data intake only: it deliberately does not declare this exact failure's cause before root reads the actual receipt.
  });
});
