/**
 * Shared bench harness utilities.
 *
 * Used by every script in bench/ — keep benches deterministic-ish:
 * fixed sizes, warmup rounds, multiple measured rounds, report median.
 */

import * as os from 'os';
import * as path from 'path';

import type { ResultFile, ResultRow, ResultUnit } from './compareCore';

// ─── Formatting ───

export function formatNum(n: number): string {
  return n.toLocaleString('en-US');
}

export function formatMs(ms: number): string {
  if (ms < 1) return `${(ms * 1000).toFixed(0)}µs`;
  if (ms < 1000) return `${ms.toFixed(2)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

// ─── Measurement ───

export function median(arr: number[]): number {
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export interface MeasureResult {
  median: number;
  min: number;
  max: number;
}

export function measure(fn: () => void, iterations = 10): MeasureResult {
  const times: number[] = [];
  // Warmup
  for (let i = 0; i < 3; i++) fn();
  // Measure
  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    fn();
    times.push(performance.now() - start);
  }
  return { median: median(times), min: Math.min(...times), max: Math.max(...times) };
}

export async function measureAsync(fn: () => Promise<void>, iterations = 10): Promise<MeasureResult> {
  const times: number[] = [];
  // Warmup
  for (let i = 0; i < 3; i++) await fn();
  // Measure
  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    await fn();
    times.push(performance.now() - start);
  }
  return { median: median(times), min: Math.min(...times), max: Math.max(...times) };
}

// ─── Fixtures ───

/** Create an object approximately `sizeBytes` large (~100-byte string fields). */
export function makeObject(sizeBytes: number): Record<string, unknown> {
  const obj: Record<string, unknown> = {};
  const fieldValue = 'x'.repeat(100); // ~100 bytes per field
  const fieldCount = Math.max(1, Math.floor(sizeBytes / 110));
  for (let i = 0; i < fieldCount; i++) {
    obj[`field_${i}`] = fieldValue;
  }
  return obj;
}

/** ~1KB agent-history-style message (fixed content — deterministic size). */
export function makeMessage(idx: number): Record<string, unknown> {
  return {
    role: idx % 2 === 0 ? 'user' : 'assistant',
    idx,
    content: 'm'.repeat(900),
  };
}

// ─── Reporting ───

/**
 * One human-readable table row. `num` + `unit` are the OPTIONAL machine
 * mirror: rows that carry them are also written to
 * `bench/results/latest.json` by {@link writeResultsJson} — the contract
 * `bench/compare.ts` diffs for regressions. Qualitative rows (e.g. the
 * depth-probe's "Depth wall: none (flat)") simply omit them.
 */
export type BenchResult = { name: string; value: string; detail?: string; num?: number; unit?: ResultUnit };

export function printTable(title: string, rows: BenchResult[]) {
  console.log(`\n### ${title}\n`);
  const nameWidth = Math.max(25, ...rows.map((r) => r.name.length));
  const valWidth = Math.max(10, ...rows.map((r) => r.value.length));

  console.log(`| ${'Benchmark'.padEnd(nameWidth)} | ${'Time'.padEnd(valWidth)} | Detail |`);
  console.log(`|${''.padEnd(nameWidth + 2, '-')}|${''.padEnd(valWidth + 2, '-')}|--------|`);
  for (const row of rows) {
    console.log(`| ${row.name.padEnd(nameWidth)} | ${row.value.padEnd(valWidth)} | ${row.detail ?? ''} |`);
  }
}

export function printHeader(title: string) {
  console.log(`# ${title}`);
  console.log(`\n${machineInfo()}`);
  console.log(`Date: ${new Date().toISOString().split('T')[0]}`);
}

export function machineInfo(): string {
  const cpu = os.cpus()[0]?.model ?? 'unknown CPU';
  const mem = formatBytes(os.totalmem());
  return `Node ${process.version} | ${process.platform} ${process.arch} | ${cpu} | ${mem} RAM`;
}

// ─── Machine-readable results (fp-bench/1) ───

// The fp-bench/1 types live in ./compareCore (kept import-free so the
// comparator's logic unit-tests under vitest); re-exported here for the
// bench scripts.
export type { ResultFile, ResultRow, ResultUnit };

export const RESULTS_DIR = path.join(__dirname, 'results');
export const LATEST_RESULTS_PATH = path.join(RESULTS_DIR, 'latest.json');
export const BASELINE_RESULTS_PATH = path.join(RESULTS_DIR, 'baseline.json');

function currentCommit(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const cp = require('child_process') as {
      execFileSync(file: string, args: string[], opts: { encoding: string }): string;
    };
    // execFileSync with a fixed argument array — no shell, no injection surface.
    return cp.execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

/**
 * Write `section`'s rows into `bench/results/latest.json` (`fp-bench/1`).
 *
 * MERGE semantics: the bench suite is several scripts (`bench:baseline` →
 * sections A/B/C, `bench:depth` → D, `bench:heap` → E) that each call this
 * for their own sections. Rows belonging to the written sections are
 * REPLACED; rows from other sections are kept, so `npm run bench`
 * accumulates one complete file. Header fields (date/node/commit) refresh
 * on every write.
 *
 * Derived from the SAME `BenchResult[]` the human table prints — rows that
 * carry `num`+`unit` are included; qualitative rows are skipped.
 */
export function writeResultsJson(sections: Array<{ section: string; rows: BenchResult[] }>): void {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fs = require('fs') as {
    existsSync(p: string): boolean;
    mkdirSync(p: string, opts?: { recursive?: boolean }): void;
    readFileSync(p: string, enc: string): string;
    writeFileSync(p: string, data: string): void;
  };

  const writtenSections = new Set(sections.map((s) => s.section));
  let keptRows: ResultRow[] = [];
  if (fs.existsSync(LATEST_RESULTS_PATH)) {
    try {
      const existing = JSON.parse(fs.readFileSync(LATEST_RESULTS_PATH, 'utf8')) as ResultFile;
      if (existing.schema === 'fp-bench/1' && Array.isArray(existing.rows)) {
        keptRows = existing.rows.filter((r) => !writtenSections.has(r.section));
      }
    } catch {
      // unreadable/corrupt latest.json — start fresh
    }
  }

  const newRows: ResultRow[] = [];
  for (const { section, rows } of sections) {
    for (const row of rows) {
      if (row.num === undefined || row.unit === undefined) continue;
      newRows.push({
        section,
        name: row.name,
        value: row.num,
        unit: row.unit,
        ...(row.detail !== undefined && { detail: row.detail }),
      });
    }
  }

  const file: ResultFile = {
    schema: 'fp-bench/1',
    date: new Date().toISOString(),
    node: process.version,
    platform: `${process.platform} ${process.arch}`,
    commit: currentCommit(),
    rows: [...keptRows, ...newRows],
  };

  if (!fs.existsSync(RESULTS_DIR)) fs.mkdirSync(RESULTS_DIR, { recursive: true });
  fs.writeFileSync(LATEST_RESULTS_PATH, `${JSON.stringify(file, null, 2)}\n`);
  console.log(
    `\n[fp-bench] wrote ${newRows.length} rows (${[...writtenSections].join(', ')}) → ${LATEST_RESULTS_PATH}`,
  );
}
