import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  type CausalNode,
  type CommitBundle,
  type CommitPhase,
  type ExecutionTree,
  causalChain,
  flattenCausalDAG,
  isCommitBundle,
  keysReadFromExecutionTree,
  keysReadFromMap,
  sliceForKey,
  sliceToJSON,
} from '../../../src/trace.js';

const fixtureText = readFileSync(
  resolve(__dirname, '../../fixtures/causal-phases/interleaved-fork-10.0.0.json'),
  'utf8',
);
const fixture: {
  producer: string;
  recordLibrary: string;
  valueActuallyRead: number;
  valueWritten: number;
  commitLog: CommitBundle[];
  executionTree: ExecutionTree;
} = JSON.parse(fixtureText);

function ids(root: CausalNode): string[] {
  return flattenCausalDAG(root).map((node) => node.runtimeStageId);
}

function commit(id: string, writes: Record<string, string[] | undefined>, phase?: CommitPhase): CommitBundle {
  return {
    stage: id,
    stageId: id,
    runtimeStageId: id,
    trace: Object.entries(writes).map(([path, readKeys]) => ({ path, verb: 'set', ...(readKeys && { readKeys }) })),
    overwrite: Object.fromEntries(Object.keys(writes).map((key) => [key, `value:${id}:${key}`])),
    updates: {},
    redactedPaths: [],
    ...(phase && { phase }),
  };
}

// Unrelated complete bundles select the large-log strategy without changing any
// original bundle, read, identity, or relative position of the witness.
function padded(log: CommitBundle[], count: number): CommitBundle[] {
  return [...Array.from({ length: count }, (_, i) => commit(`pad#${i}`, {})), ...log];
}

describe('causal anchors in the real Footprint 10 interleaved-fork recording', () => {
  it('pins the untouched producer bytes and the read that actually occurred', () => {
    expect(createHash('sha256').update(fixtureText).digest('hex')).toBe(
      '45b01229a52eaf72b305577647c1e191c49025722614f1d610b6bfe251b4d07d',
    );
    expect(fixture.producer).toBe('footprintjs@10.0.0');
    expect(fixture.recordLibrary).toBe('foottrace@1.0.0');
    expect(fixture.valueActuallyRead).toBe(1);
    expect(fixture.valueWritten).toBe(2);
    expect(fixture.commitLog.every(isCommitBundle)).toBe(true);
    expect(fixture.commitLog.map((bundle) => [bundle.runtimeStageId, bundle.phase])).toEqual([
      ['seed#0', undefined],
      ['a#1', undefined],
      ['b#2', undefined],
      ['a#1', 'repeat'],
      ['b#2', 'repeat'],
      ['join#3', undefined],
    ]);
    expect(fixture.executionTree.children?.[0].stageReads).toEqual({ runs: { b: { x: 1 } } });
    const fullText = readFileSync(
      resolve(__dirname, '../../fixtures/causal-phases/runtime-snapshot-10.0.0.json'),
      'utf8',
    );
    expect(createHash('sha256').update(fullText).digest('hex')).toBe(
      '3a22244cf2f71465b5647a8639de1d0481c99f9342f0874c336c3d35f8613990',
    );
    const full = JSON.parse(fullText);
    expect(full.commitLog).toEqual(fixture.commitLog);
    expect(full.executionTree.children[0].stageReads).toEqual(fixture.executionTree.children?.[0].stageReads);
    expect(full.sharedState.runs.a.y).toBe(fixture.valueWritten);
  });

  for (const padding of [0, 257]) {
    for (const edgeAttribution of ['stage', 'per-write'] as const) {
      it(`keeps A's own write and prior Seed parent (${padding} padding, ${edgeAttribution})`, () => {
        const log = padded(fixture.commitLog, padding);
        const reads = keysReadFromExecutionTree(fixture.executionTree);
        const before = JSON.stringify(log);
        const slice = sliceForKey(log, ['runs', 'a', 'y'], reads, { edgeAttribution });
        expect(slice.writer).toBe(log[padding + 1]);
        expect(slice.root?.keysWritten).toEqual(['runs\u001fa\u001fy']);
        expect(ids(slice.root!)).toEqual(['a#1', 'seed#0']);
        const atOwnWrite = sliceForKey(log, ['runs', 'a', 'y'], reads, {
          edgeAttribution,
          before: padding + 2,
        });
        expect(sliceToJSON(atOwnWrite).nodes).toEqual(sliceToJSON(slice).nodes);
        expect(sliceToJSON(atOwnWrite).edges).toEqual(sliceToJSON(slice).edges);
        const direct = causalChain(log, 'a#1', reads.lookup, {
          edgeAttribution,
          rootLinkKeys: ['runs\u001fa\u001fy'],
        })!;
        expect(direct.keysWritten).toEqual(['runs\u001fa\u001fy']);
        expect(ids(direct)).toEqual(['a#1', 'seed#0']);
        expect(JSON.stringify(log)).toBe(before);
      });
    }
  }
});

describe.each([0, 257])('phase-aware causal expansion with %i unrelated bundles', (padding) => {
  for (const phase of ['repeat', 'exit', undefined] as const) {
    for (const edgeAttribution of ['stage', 'per-write'] as const) {
      it(`uses first execution position when expanding a data parent (${
        phase ?? 'legacy'
      }, ${edgeAttribution})`, () => {
        const log = padded(
          [
            commit('seed#0', { x: [] }),
            commit('parent#1', { y: ['x'] }),
            commit('later#2', { x: [] }),
            commit('parent#1', {}, phase),
            commit('target#3', { z: ['y'] }),
          ],
          padding,
        );
        const reads = keysReadFromMap({ 'parent#1': ['x'], 'target#3': ['y'] });
        expect(ids(sliceForKey(log, 'z', reads, { edgeAttribution }).root!)).toEqual([
          'target#3',
          'parent#1',
          'seed#0',
        ]);
      });

      it(`uses first execution position for a governing decider (${phase ?? 'legacy'}, ${edgeAttribution})`, () => {
        const own = commit('decider#1', { decision: ['x'] });
        own.untrackedSources = ['env'];
        const log = padded(
          [
            commit('seed#0', { x: [] }),
            own,
            commit('later#2', { x: [] }),
            commit('decider#1', {}, phase),
            commit('target#3', { z: [] }),
          ],
          padding,
        );
        const root = causalChain(log, 'target#3', (id) => (id === 'decider#1' ? ['x'] : []), {
          edgeAttribution,
          rootLinkKeys: ['z'],
          controlDeps: (id) => (id === 'target#3' ? { deciderId: 'decider#1', label: 'allowed' } : undefined),
        })!;
        expect(ids(root)).toEqual(['target#3', 'decider#1', 'seed#0']);
        expect(root.parentEdges[0]).toMatchObject({ kind: 'control', key: 'allowed' });
        expect(root.parents[0].keysWritten).toEqual(['decision']);
        expect(root.parents[0].incompleteSources).toEqual(['env']);
      });
    }
  }

  it('keeps the actual nonempty continuation as the sliced writer, not its first bundle', () => {
    const continuation = commit('mount#2', { output: ['y'] }, 'exit');
    continuation.untrackedSources = ['silent'];
    const log = padded(
      [
        commit('seedX#0', { x: [] }),
        commit('seedY#1', { y: [] }),
        commit('mount#2', { initial: ['x'] }),
        commit('later#3', { y: [] }),
        continuation,
        commit('mount#2', {}, 'exit'),
      ],
      padding,
    );
    const reads = keysReadFromMap({ 'mount#2': ['x', 'y'] });
    const perWrite = sliceForKey(log, 'output', reads);
    expect(perWrite.writer).toBe(continuation);
    expect(perWrite.root?.keysWritten).toEqual(['output']);
    expect(perWrite.root?.incompleteSources).toEqual(['silent']);
    expect(ids(perWrite.root!)).toEqual(['mount#2', 'seedY#1']);
    expect(ids(sliceForKey(log, 'output', reads, { edgeAttribution: 'stage' }).root!)).toEqual([
      'mount#2',
      'seedX#0',
      'seedY#1',
    ]);
    expect(causalChain(log, 'mount#2', reads.lookup)?.keysWritten).toEqual(['initial']);
  });

  it('retains continuation provenance when a shared parent is expanded through a second written key', () => {
    const continuation = commit('parent#2', { b: ['y'] }, 'repeat');
    const log = padded(
      [
        commit('seedX#0', { x: [] }),
        commit('seedY#1', { y: [] }),
        commit('parent#2', { a: ['x'] }),
        commit('later#3', { y: [] }),
        continuation,
        commit('target#4', { result: ['a', 'b'] }),
      ],
      padding,
    );
    const reads = keysReadFromMap({ 'parent#2': ['x', 'y'], 'target#4': ['a', 'b'] });
    const root = sliceForKey(log, 'result', reads).root!;
    expect(ids(root)).toEqual(['target#4', 'parent#2', 'seedX#0', 'seedY#1']);
    expect(root.parentEdges.map(({ key }) => key)).toEqual(['a', 'b']);
    expect(root.parents[0].parentEdges.map(({ key }) => key)).toEqual(['x', 'y']);
    const directContinuationParent = sliceForKey(log, 'b', reads).root!;
    expect(directContinuationParent.keysWritten).toEqual(['b']);
    expect(ids(directContinuationParent)).toEqual(['parent#2', 'seedY#1']);
  });

  it('keeps mixed/legacy missing per-write provenance at the stage-level ceiling', () => {
    const log = padded(
      [
        commit('seed#0', { x: undefined }),
        commit('parent#1', { y: undefined }),
        commit('later#2', { x: undefined }),
        commit('parent#1', {}),
        commit('target#3', { z: undefined }),
      ],
      padding,
    );
    const reads = keysReadFromMap({ 'parent#1': ['x'], 'target#3': ['y'] });
    const refined = sliceForKey(log, 'z', reads);
    const stage = sliceForKey(log, 'z', reads, { edgeAttribution: 'stage' });
    expect(sliceToJSON(refined)).toEqual(sliceToJSON(stage));
    expect(ids(refined.root!)).toEqual(['target#3', 'parent#1', 'seed#0']);
  });

  it('treats the first observed row as the anchor even when it is phase-labelled', () => {
    const log = padded(
      [
        commit('seed#0', { x: [] }),
        commit('first#1', { y: ['x'] }, 'exit'),
        commit('later#2', { x: [] }),
        commit('first#1', {}, 'exit'),
      ],
      padding,
    );
    const reads = keysReadFromMap({ 'first#1': ['x'] });
    expect(ids(sliceForKey(log, 'y', reads).root!)).toEqual(['first#1', 'seed#0']);
  });
});
