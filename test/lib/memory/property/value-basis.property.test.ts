/**
 * Property — the basis twins say why (F4b, 9.33.0). The packet's review question, asked as a test: "find a
 * reader that returns `undefined` for a key without a code saying why".
 *
 *   SAME ANSWER   `commitValueAtWithBasis(log, i, K).value` IS `commitValueAt(log, i, K)`, and
 *                 `findLastWriterWithBasis(log, K, i + 1).writer` IS `findLastWriter(log, K, i + 1)` — at every
 *                 key and index. With `initialState` the value IS `stateAt({ commitLog, initialState }, i)` read
 *                 at K (the fold WITH the base — F3's one named gap, closed here).
 *   A REASON      an `undefined` value always carries `'never-written'`, `'deleted'` or `'redacted'`.
 *   THE BASE      `'from-initial-state'` is there exactly when no `set` / `delete` ON K or AROUND it is in range
 *                 (and a passed `initialState` holds K's top-level key) — the independent oracle below; and
 *                 whenever the log-only answer differs from the base fold, the code is there.
 *   NESTED        `'nested-rows'` only with no such `set` / `delete` and a row INSIDE K in range.
 *   NEVER WRITTEN with `initialState`, `'never-written'` means the run never moved K: the base fold's value
 *                 at K equals the base's at EVERY index up to the one asked (review finding 1: a run that
 *                 removed a value the base held answered 'never-written').
 *
 * Logs: real runs of the copy-on-write fixture's programs (subflow seed and merge-back, fork children, a
 * redaction policy, initial context, every dial; the run's log AND each subflow's history).
 */
import fc from 'fast-check';

import {
  commitValueAt,
  commitValueAtWithBasis,
  findLastWriter,
  findLastWriterWithBasis,
} from '../../../../src/lib/memory/commitLogUtils';
import { relation } from '../../../../src/lib/memory/keyPaths';
import { nativeGet } from '../../../../src/lib/memory/pathOps';
import { DELIM } from '../../../../src/lib/memory/paths';
import type { CommitBundle } from '../../../../src/lib/memory/types';
import { stateAt } from '../../../../src/trace';
import { BUILD, bytes, chartLogs, chartProgramArb, isObj } from './copy-on-write-fixture';

/** Every key worth asking at commit `i`: top-level keys, every row path and its ancestors, one level of children. */
function keysAt(log: CommitBundle[], i: number, state: Record<string, unknown>): Set<string> {
  const keys = new Set<string>(Object.keys(state));
  for (let c = 0; c <= i; c++) {
    for (const t of log[c].trace) {
      const segs = t.path.split(DELIM);
      for (let k = 1; k <= segs.length; k++) keys.add(segs.slice(0, k).join(DELIM));
    }
  }
  for (const [top, v] of Object.entries(state))
    if (isObj(v)) for (const child of Object.keys(v)) keys.add(top + DELIM + child);
  keys.add('never-a-key');
  return keys;
}

/** No `set` / `delete` ON the key or AROUND it in log[0..i] — the value rests on the pre-run base. */
function noTotal(log: CommitBundle[], key: string, i: number): boolean {
  for (let c = 0; c <= i; c++) {
    for (const t of log[c].trace) {
      const r = relation(t.path, key);
      if ((r === 'exact' || r === 'around') && (t.verb === 'set' || t.verb === 'delete')) return false;
    }
  }
  return true;
}

function insideRow(log: CommitBundle[], key: string, i: number): boolean {
  for (let c = 0; c <= i; c++) for (const t of log[c].trace) if (relation(t.path, key) === 'inside') return true;
  return false;
}

const seen = new Map<string, number>();

function checkLog(log: CommitBundle[], base: Record<string, unknown> | undefined): void {
  const baseFolds =
    base === undefined ? [] : log.map((_, j) => stateAt({ commitLog: log, initialState: base }, j).state as object);
  for (let i = 0; i < log.length; i++) {
    const state = stateAt({ commitLog: log }, i).state as Record<string, unknown>;
    const withBase =
      base === undefined ? undefined : (stateAt({ commitLog: log, initialState: base }, i).state as object);
    for (const key of keysAt(log, i, state)) {
      const at = `${key.split(DELIM).join('.')} @${i}`;
      const segs = key.split(DELIM);
      const plain = commitValueAtWithBasis(log, i, key);
      expect(bytes(plain.value), `same value ${at}`).toBe(bytes(commitValueAt(log, i, key)));
      for (const code of plain.basis) seen.set(code, (seen.get(code) ?? 0) + 1);
      if (plain.value === undefined) {
        expect(
          plain.basis.some((c) => c === 'never-written' || c === 'deleted' || c === 'redacted'),
          `reason ${at}`,
        ).toBe(true);
      }
      expect(plain.basis.includes('from-initial-state'), `base code ${at}`).toBe(noTotal(log, key, i));
      if (plain.basis.includes('nested-rows'))
        expect(noTotal(log, key, i) && insideRow(log, key, i), `nested ${at}`).toBe(true);

      const w = findLastWriterWithBasis(log, key, i + 1);
      expect(w.writer, `same writer ${at}`).toBe(findLastWriter(log, key, i + 1));
      expect(
        w.basis.some((c) => c === 'never-written' || c === 'redacted'),
        `writer reason ${at}`,
      ).toBe(w.writer === undefined);

      if (base !== undefined && withBase !== undefined) {
        const folded = commitValueAtWithBasis(log, i, key, { initialState: base });
        expect(bytes(folded.value), `base fold ${at}`).toBe(bytes(nativeGet(withBase, segs)));
        const holdsRoot = Object.prototype.hasOwnProperty.call(base, segs[0]);
        expect(folded.basis.includes('from-initial-state'), `base code with base ${at}`).toBe(
          noTotal(log, key, i) && holdsRoot,
        );
        if (bytes(plain.value) !== bytes(folded.value))
          expect(plain.basis, `log-only differs ${at}`).toContain('from-initial-state');
        if (folded.basis.includes('never-written')) {
          const atBase = bytes(nativeGet(base, segs));
          for (let j = 0; j <= i; j++) {
            expect(bytes(nativeGet(baseFolds[j], segs)), `never moved ${at} (index ${j})`).toBe(atBase);
          }
        }
        if (folded.value === undefined) {
          const reason = folded.basis.some((c) => c === 'never-written' || c === 'deleted' || c === 'redacted');
          expect(reason, `reason with base ${at}`).toBe(true);
        }
      }
    }
  }
}

describe('the basis twins — real logs (subflow seed and merge-back, fork children, redaction, every dial)', () => {
  it('same answers as the plain readers; with initialState the stateAt fold; every undefined has a reason', async () => {
    await fc.assert(
      fc.asyncProperty(chartProgramArb, async (p) => {
        for (const { log, base } of await chartLogs(BUILD, p)) checkLog(log, base);
      }),
      { numRuns: 60 },
    );
    // The run exercised every code it claims to check.
    for (const code of ['never-written', 'deleted', 'nested-rows', 'from-initial-state', 'redacted']) {
      expect(seen.get(code) ?? 0, code).toBeGreaterThan(0);
    }
  }, 120_000);
});
