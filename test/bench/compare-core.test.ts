/**
 * Unit tests for bench/compareCore.ts — the pure diff logic behind
 * `npm run bench:compare` (fp-bench/1).
 *
 * The two-gate model under test: a row regresses/improves only when its
 * delta clears BOTH the relative threshold (default 25%) AND the unit's
 * absolute noise floor (0.5ms / 1MiB / 0.25 count). µs-scale rows jitter by
 * integer factors run-to-run; without the absolute gate the comparator
 * would exit 1 on noise and get ignored.
 */
import { describe, expect, it } from 'vitest';

import {
  type ResultFile,
  type ResultRow,
  assertResultFile,
  compareResults,
  DEFAULT_NOISE_FLOORS,
  DEFAULT_THRESHOLD_PCT,
} from '../../bench/compareCore';

function file(rows: ResultRow[]): ResultFile {
  return {
    schema: 'fp-bench/1',
    date: '2026-06-10T00:00:00.000Z',
    node: 'v22.16.0',
    platform: 'darwin arm64',
    commit: 'abc1234',
    rows,
  };
}

const row = (name: string, value: number, unit: ResultRow['unit'] = 'ms', section = 'A-test'): ResultRow => ({
  section,
  name,
  value,
  unit,
});

describe('compareCore (fp-bench/1)', () => {
  it('defaults: 25% threshold; floors 0.5ms / 1MiB / 0.25 count', () => {
    expect(DEFAULT_THRESHOLD_PCT).toBe(25);
    expect(DEFAULT_NOISE_FLOORS).toEqual({ ms: 0.5, bytes: 1024 * 1024, count: 0.25 });
  });

  it('flags a regression when BOTH gates pass (relative + absolute)', () => {
    const report = compareResults(file([row('wall', 100)]), file([row('wall', 140)]));
    expect(report.regressions).toBe(1);
    expect(report.rows[0]).toMatchObject({ verdict: 'regression', baseline: 100, latest: 140 });
    expect(report.rows[0].deltaPct).toBeCloseTo(40);
  });

  it('flags an improvement symmetrically', () => {
    const report = compareResults(file([row('wall', 100)]), file([row('wall', 60)]));
    expect(report.improvements).toBe(1);
    expect(report.rows[0].verdict).toBe('improvement');
    expect(report.rows[0].deltaPct).toBeCloseTo(-40);
  });

  it('large RELATIVE jitter below the absolute floor is unchanged (µs noise)', () => {
    // 3µs → 7µs = +133% but only 4µs absolute — classic run-to-run noise.
    const report = compareResults(file([row('first read', 0.003)]), file([row('first read', 0.007)]));
    expect(report.rows[0].verdict).toBe('unchanged');
    expect(report.regressions).toBe(0);
  });

  it('large ABSOLUTE delta below the relative threshold is unchanged', () => {
    // +10ms on a 100ms row = +10% < 25% — real but within the agreed envelope.
    const report = compareResults(file([row('wall', 100)]), file([row('wall', 110)]));
    expect(report.rows[0].verdict).toBe('unchanged');
  });

  it('respects a custom threshold', () => {
    const report = compareResults(file([row('wall', 100)]), file([row('wall', 110)]), { thresholdPct: 5 });
    expect(report.rows[0].verdict).toBe('regression');
  });

  it('bytes rows use the 1MiB floor', () => {
    const halfMiB = 512 * 1024;
    const noise = compareResults(file([row('heap', halfMiB, 'bytes')]), file([row('heap', halfMiB * 1.9, 'bytes')]));
    expect(noise.rows[0].verdict).toBe('unchanged'); // +90% but only ~0.44MiB

    const real = compareResults(
      file([row('heap', 100 * 1024 * 1024, 'bytes')]),
      file([row('heap', 140 * 1024 * 1024, 'bytes')]),
    );
    expect(real.rows[0].verdict).toBe('regression');
  });

  it('zero baseline: percent is undefined, absolute gate alone decides', () => {
    // A flat depth slope (0.0) regressing to 2.0/iter MUST flag without a
    // divide-by-zero percent.
    const report = compareResults(file([row('guard slope', 0, 'count')]), file([row('guard slope', 2, 'count')]));
    expect(report.rows[0].verdict).toBe('regression');
    expect(report.rows[0].deltaPct).toBeUndefined();
  });

  it('negative baseline (a Δ row): absolute gate alone decides', () => {
    const better = compareResults(file([row('Δ one-read', -0.2)]), file([row('Δ one-read', -0.3)]));
    expect(better.rows[0].verdict).toBe('unchanged'); // 0.1ms < 0.5ms floor

    const worse = compareResults(file([row('Δ one-read', -0.2)]), file([row('Δ one-read', 2)]));
    expect(worse.rows[0].verdict).toBe('regression');
  });

  it('added and removed rows are reported, never failed on', () => {
    const report = compareResults(file([row('old', 5)]), file([row('new', 7)]));
    expect(report.regressions).toBe(0);
    expect(report.added).toBe(1);
    expect(report.removed).toBe(1);
    const verdicts = Object.fromEntries(report.rows.map((r) => [r.name, r.verdict]));
    expect(verdicts).toEqual({ new: 'added', old: 'removed' });
  });

  it('matches rows by section AND name (same name in two sections is two rows)', () => {
    const report = compareResults(
      file([row('wall', 10, 'ms', 'A-x'), row('wall', 10, 'ms', 'B-y')]),
      file([row('wall', 10, 'ms', 'A-x'), row('wall', 20, 'ms', 'B-y')]),
    );
    const bRow = report.rows.find((r) => r.section === 'B-y')!;
    const aRow = report.rows.find((r) => r.section === 'A-x')!;
    expect(bRow.verdict).toBe('regression');
    expect(aRow.verdict).toBe('unchanged');
  });

  it('assertResultFile rejects wrong schema and malformed rows', () => {
    expect(() => assertResultFile({ schema: 'nope', rows: [] }, 'f')).toThrow(/fp-bench\/1/);
    expect(() => assertResultFile(undefined, 'f')).toThrow(/fp-bench\/1/);
    expect(() =>
      assertResultFile({ ...file([]), rows: [{ section: 'A', name: 'x', value: 'fast', unit: 'ms' }] }, 'f'),
    ).toThrow(/malformed row/);
    expect(() =>
      assertResultFile({ ...file([]), rows: [{ section: 'A', name: 'x', value: 1, unit: 'parsecs' }] }, 'f'),
    ).toThrow(/malformed row/);
    expect(() => assertResultFile(file([row('ok', 1)]), 'f')).not.toThrow();
  });
});
