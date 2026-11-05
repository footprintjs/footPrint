import { describe, expect, it } from 'vitest';

import {
  type NestedProgram,
  type WriteBackProgram,
  BASELINE,
  BUILD,
  firstDifference,
  judgeWitness,
  observingSync,
  rewriteCommits,
  runNested,
  runWriteBack,
} from '../../lib/memory/property/copy-on-write-fixture.js';
import { firstCommit124 } from '../firstCommit124.js';
import { joinedRun } from '../readBindings.js';
import { readLawPorts } from '../readLawPorts.js';

function nested(commitValues: 'full' | 'delta') {
  const program: NestedProgram = {
    initial: { x: [] },
    commitValues,
    mutate: false,
    stages: [
      {
        runId: '',
        ops: [
          { t: 'del', path: 0, k: 'x' },
          { t: 'read', path: 0, k: 'x' },
        ],
      },
    ],
  };
  const a = observingSync(BASELINE, program, 'run', (ops) => runNested(BASELINE, program, undefined, ops));
  const b = observingSync(BUILD, program, 'run', (ops) => runNested(BUILD, program, undefined, ops));
  return { program, a: joinedRun(a, a.value), b: joinedRun(b, b.value) };
}
function writeback(commitValues: 'full' | 'delta') {
  const program: WriteBackProgram = {
    initial: { x: [3] },
    commitValues,
    mutate: true,
    stages: [
      {
        runId: '',
        ops: [
          { t: 'set', path: 0, k: 'cfg', v: 1 },
          { t: 'delReadBack', path: 0, k: 'x', n: 9, how: 'set' },
        ],
      },
    ],
  };
  const a = observingSync(BASELINE, program, 'run', (ops) => runWriteBack(BASELINE, program, undefined, ops));
  const b = observingSync(BUILD, program, 'run', (ops) => runWriteBack(BUILD, program, undefined, ops));
  return { program, a: joinedRun(a, a.value), b: joinedRun(b, b.value) };
}
const decision = (f: ReturnType<typeof nested>, family: 'nested' | 'writeback') =>
  judgeWitness(
    f.a.commits,
    f.b.commits,
    firstDifference(f.a.kept, f.b.kept) !== '',
    false,
    readLawPorts(f.a, f.b, family, firstCommit124),
  );

describe('native #124 binding at the unchanged first comparison boundary', () => {
  it.each(['full', 'delta'] as const)('%s: only native-joined retained reads differ with identical commits', (mode) => {
    const f = nested(mode);
    expect(f.a.kept.reads).toBe('[]');
    expect(f.b.kept.reads).toBe('null');
    expect(f.a.commits.map((row) => row.bytes)).toEqual(f.b.commits.map((row) => row.bytes));
    expect(decision(f, 'nested')).toMatchObject({
      kind: 'cause',
      name: 'read-after-delete-124',
      shape: 'retained-only',
    });
  });

  it.each(['full', 'delta'] as const)(
    '%s: actual del/read/edit/write versus undefined/no-write explains FIRST commit',
    (mode) => {
      const f = writeback(mode);
      expect(f.a.kept.reads).toBe('[3]');
      expect(f.b.kept.reads).toBe('null');
      expect(f.a.commits[0].foldsBack).toBe(true);
      expect(f.b.commits[0].foldsBack).toBe(true);
      expect(decision(f, 'writeback')).toMatchObject({
        kind: 'cause',
        name: 'read-after-delete-124',
        shape: 'first-commit',
        commit: 0,
        coordinate: { kind: 'fixture-operation' },
      });
    },
  );

  it('a valid deleted read does not admit an independent live/checkpoint/error field', () => {
    for (const key of ['state', 'cp1', 'errors']) {
      const f = nested('full');
      f.b = { ...f.b, kept: { ...f.b.kept, [key]: 'independent corruption' } };
      expect(decision(f, 'nested').kind).toBe('broken');
    }
  });

  it('the actual inner encoder cannot be replaced by a coherent outer commit rewrite', () => {
    const restore = rewriteCommits(BUILD, (payload) => {
      const row = payload.trace.at(-1);
      if (row) payload.trace.push({ ...row });
    });
    try {
      const f = writeback('full');
      expect(f.b.commits[0].foldsBack).toBe(true);
      expect(decision(f, 'writeback').kind).toBe('broken');
    } finally {
      restore();
    }
  });
});
