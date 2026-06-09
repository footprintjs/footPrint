/**
 * Shared bench harness utilities.
 *
 * Used by every script in bench/ — keep benches deterministic-ish:
 * fixed sizes, warmup rounds, multiple measured rounds, report median.
 */

import * as os from 'os';

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

export type BenchResult = { name: string; value: string; detail?: string };

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
