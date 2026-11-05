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
import { type ObservedKept, joinedRun } from '../readBindings.js';

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
    receipt('typed-proxy-read-expression', joinedRun(a, a.value.out), joinedRun(b, b.value.out));
  });
});
