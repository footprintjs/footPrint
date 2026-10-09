/**
 * Scenario — a redacted merge-back answers WITH the code (F4b, 9.33.0).
 *
 * F3 made `commitValueAt(cfg)` see the outputMapper's merge-back row `cfg␟b`, so a redacted field answers
 * `{ b: 'REDACTED' }` where it answered `undefined`. The placeholder is the log's honest bytes, but a caller
 * reading the value alone cannot tell it from data: `commitValueAtWithBasis` says `'redacted'` (asked of the
 * bundle's `redactedPaths`, never of the string), plus `'nested-rows'` / `'from-initial-state'` — the value
 * rests on a write inside the key and no whole write of it.
 *
 * The records are written through footprintjs/write (test/helpers/recordRun.ts), byte for byte the ones the
 * engine writes for these charts: a subflow mount whose outputMapper merges `{ cfg: { b } }` back is one
 * row at `cfg␟b` on the mount's bundle, then its `exit` and `repeat` bundles; a policy's verdict on it is
 * the frame's scrub (`{ whole: true }`) — the engine decides it, the record writes it.
 */
import { describe, expect, it } from 'vitest';

import { LOG_PLACEHOLDER } from '../../../../src/lib/memory/placeholders';
import { commitValueAt, commitValueAtWithBasis, findLastWriterWithBasis, HONESTY_CODES } from '../../../../src/trace';
import { recordRun } from '../../../helpers/recordRun';

/**
 * Start writes `other`; the `sub` mount merges back `cfg.b` (its inner stage wrote `token: 'secret'`, on the
 * subflow's own log, which these readers never read), under `fields: { cfg: ['b'] }` when `policy`; After
 * writes `done`. Ids as the engine numbers them: the inner stage is `inner#2`.
 */
function run(policy: boolean) {
  const rec = recordRun();
  rec.step('start', (s) => s.set('other', 1), { name: 'Start' });
  rec.step('sub', (s) => s.set('b', 'secret', policy ? { whole: true } : undefined, ['cfg']), { name: 'Sub' });
  rec.step('sub', undefined, { name: 'Sub', phase: 'exit' });
  rec.step('sub', undefined, { name: 'Sub', phase: 'repeat' });
  rec.step('after', (s) => s.set('done', true), { name: 'After', runtimeStageId: 'after#3' });
  return rec.snapshot();
}

describe('a redacted merge-back', () => {
  it("answers the log's placeholder WITH 'redacted' — and without a policy, the same shape without it", () => {
    const snap = run(true);
    const log = snap.commitLog as any[];
    const end = log.length - 1;
    expect(commitValueAt(log, end, 'cfg')).toEqual({ b: LOG_PLACEHOLDER });
    const { value, basis } = commitValueAtWithBasis(log, end, 'cfg');
    expect(value).toEqual({ b: LOG_PLACEHOLDER });
    expect(basis).toContain('redacted');
    expect(basis).toContain('nested-rows');
    for (const code of basis) expect(HONESTY_CODES[code]).toBeTruthy();

    const plain = run(false);
    const plainLog = plain.commitLog as any[];
    const answer = commitValueAtWithBasis(plainLog, plainLog.length - 1, 'cfg');
    expect(answer.value).toEqual({ b: 'secret' });
    expect(answer.basis).not.toContain('redacted');
  });
});

// Review findings 1 and 4 (F4b): two answers that said 'never-written' and were false.
describe('a removed base value and a hidden write', () => {
  /** One stage, `only`, over `seed` — its record under `commitValues`. */
  function snapOf(
    body: Parameters<ReturnType<typeof recordRun>['step']>[1],
    seed = {},
    commitValues: 'full' | 'delta' = 'full',
  ) {
    const rec = recordRun(seed, { commitValues });
    rec.step('only', body, { name: 'Only' });
    return rec.snapshot();
  }
  const K = 'a\u001Fb';

  for (const commitValues of ['full', 'delta'] as const) {
    it(`a run that removed a value the base held answers 'deleted' (${commitValues}: delete, and set of the container)`, () => {
      const shapes: Array<Parameters<typeof snapOf>[0]> = [
        (s) => {
          s.delete('a');
        },
        (s) => {
          s.set('a', { c: 2 });
        },
      ];
      for (const fn of shapes) {
        const snap = snapOf(fn, { a: { b: 1 } }, commitValues);
        const log = snap.commitLog as any[];
        const answer = commitValueAtWithBasis(log, log.length - 1, K, { initialState: snap.initialState as any });
        expect(answer.value).toBeUndefined();
        expect(answer.basis).toEqual(['deleted']);
      }
    });
  }

  it("a redaction that replaced the container hides the write: 'redacted' only, never 'never-written'", () => {
    // `keys: ['b']`: the verdict masks the whole value, so the frame's scrub is `{ whole: true }`.
    const snap = snapOf((s) => {
      s.set('b', { x: 1 }, { whole: true });
    });
    const log = snap.commitLog as any[];
    expect(commitValueAtWithBasis(log, log.length - 1, 'b\u001Fx')).toEqual({ value: undefined, basis: ['redacted'] });
    expect(findLastWriterWithBasis(log, 'b\u001Fx')).toEqual({ basis: ['redacted'] });
  });
});
