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
  witnessing,
  witnessingSync,
} from './copy-on-write-fixture.js';

/** These are SAME-engine transparency checks, never baseline/build admissions. */
describe('native observation preserves the existing family execution', () => {
  for (const engine of [BASELINE, BUILD])
    for (const commitValues of ['full', 'delta'] as const) {
      it(`${engine.label}/${commitValues}: chart fork and subflow retain every kept byte`, async () => {
        const program: ChartProgram = {
          seed: [
            { t: 'set', k: 'obj', v: { x: 1 } },
            { t: 'set', k: 'a', v: { n: 3 } },
          ],
          stages: [
            [
              { t: 'del', k: 'obj' },
              { t: 'same', k: 'obj' },
            ],
            [{ t: 'readAll' }],
          ],
          fork: { at: 0, children: [[{ t: 'readAll' }], [{ t: 'set', k: 'list', v: [1, 2] }]] },
          sub: {
            at: 1,
            inner: [[{ t: 'copy', k: 'a', k2: 'obj' }], [{ t: 'readAll' }]],
            seedObj: true,
            mergeObj: true,
            arrayReplace: false,
          },
          cfg: {
            commitValues,
            readTracking: 'full',
            writeTracking: 'full',
            writeProvenance: 'reads-prefix',
            policy: true,
            initial: true,
          },
        };
        const before = JSON.stringify(program);
        const [ordinary, commits] = await witnessing(engine, () => runChart(engine, program));
        const [observed, observedCommits, native] = await observing(engine, () => runChart(engine, program), 'chart:0');
        expect(observed).toEqual(ordinary);
        expect(observedCommits).toEqual(commits);
        expect(JSON.stringify(program)).toBe(before);
        expect(native.issues).toEqual([]);
      });

      it(`${engine.label}/${commitValues}: nested raw reads, including run addresses, stay exact`, () => {
        const program: NestedProgram = {
          initial: { obj: { x: 1 }, runs: { r1: { obj: { y: 2 } } } },
          commitValues,
          mutate: true,
          stages: [
            {
              runId: '',
              ops: [
                { t: 'del', path: 0, k: 'obj' },
                { t: 'read', path: 0, k: 'obj' },
              ],
            },
            {
              runId: 'r1',
              ops: [
                { t: 'set', path: 0, k: 'x', v: 1 },
                { t: 'read', path: 0, k: 'obj' },
              ],
            },
          ],
        };
        const before = JSON.stringify(program);
        const ordinaryLaws = { editedGenerations: 0 };
        const observedLaws = { editedGenerations: 0 };
        const [ordinary, commits] = witnessingSync(engine, () => runNested(engine, program, ordinaryLaws));
        const [observed, observedCommits, native] = observingSync(
          engine,
          () => runNested(engine, program, observedLaws),
          'nested:0',
        );
        expect(observed).toEqual(ordinary);
        expect(observedLaws).toEqual(ordinaryLaws);
        expect(observedCommits).toEqual(commits);
        expect(JSON.stringify(program)).toBe(before);
        expect(native.issues).toEqual([]);
      });

      it(`${engine.label}/${commitValues}: write-back executes the original edit exactly once`, () => {
        const program: WriteBackProgram = {
          initial: { x: { n: 1 }, list: [1, 2] },
          commitValues,
          mutate: true,
          stages: [
            {
              runId: '',
              ops: [
                { t: 'set', path: 0, k: 'cfg', v: { x: 2 } },
                { t: 'delReadBack', path: 0, k: 'x', n: 7, how: 'set' },
                { t: 'readBack', path: 0, k: 'cfg', n: 3, how: 'merge' },
              ],
            },
          ],
        };
        const before = JSON.stringify(program);
        const ordinaryLaws = { editedGenerations: 0 };
        const observedLaws = { editedGenerations: 0 };
        const [ordinary, commits] = witnessingSync(engine, () => runWriteBack(engine, program, ordinaryLaws));
        const [observed, observedCommits, native] = observingSync(
          engine,
          () => runWriteBack(engine, program, observedLaws),
          'writeback:0',
        );
        expect(observed).toEqual(ordinary);
        expect(observedLaws).toEqual(ordinaryLaws);
        expect(observedCommits).toEqual(commits);
        expect(JSON.stringify(program)).toBe(before);
        expect(native.issues).toEqual([]);
      });
    }
});
