/**
 * FootPrint Performance Benchmarks
 *
 * Run: npx tsx bench/run.ts
 *
 * Measures real numbers for the critical paths:
 * 1. Write throughput (setValue calls)
 * 2. Read throughput (getValue calls, no buffer creation)
 * 3. Pipeline scale (end-to-end latency by stage count)
 * 4. Concurrent pipelines (parallel executor.run() calls)
 * 5. State size (structuredClone cost at different object sizes)
 * 6. Time-travel replay (EventLog.materialise cost)
 */

import { FlowChartExecutor } from '../src/lib/runner/FlowChartExecutor';
import { ExecutionRuntime } from '../src/lib/runner/ExecutionRuntime';
import { FlowchartTraverser } from '../src/lib/engine/traversal/FlowchartTraverser';
import { ScopeFacade } from '../src/lib/scope/ScopeFacade';
import { SharedMemory } from '../src/lib/memory/SharedMemory';
import { EventLog } from '../src/lib/memory/EventLog';
import { StageContext } from '../src/lib/memory/StageContext';
import type { StageNode } from '../src/lib/engine/graph/StageNode';
import type { StageFunction, ILogger } from '../src/lib/engine/types';

// ─── Utilities ───

const silentLogger: ILogger = {
  info() {}, log() {}, debug() {}, error() {}, warn() {},
};

function simpleScopeFactory(context: any, stageName: string) {
  return new ScopeFacade(context, stageName);
}

function formatNum(n: number): string {
  return n.toLocaleString('en-US');
}

function formatMs(ms: number): string {
  if (ms < 1) return `${(ms * 1000).toFixed(0)}µs`;
  if (ms < 1000) return `${ms.toFixed(2)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function median(arr: number[]): number {
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function measure(fn: () => void, iterations = 10): { median: number; min: number; max: number } {
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

async function measureAsync(fn: () => Promise<void>, iterations = 10): Promise<{ median: number; min: number; max: number }> {
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

function makeObject(sizeBytes: number): Record<string, unknown> {
  // Create an object approximately `sizeBytes` large
  const obj: Record<string, unknown> = {};
  const fieldValue = 'x'.repeat(100); // ~100 bytes per field
  const fieldCount = Math.max(1, Math.floor(sizeBytes / 110));
  for (let i = 0; i < fieldCount; i++) {
    obj[`field_${i}`] = fieldValue;
  }
  return obj;
}

type BenchResult = { name: string; value: string; detail?: string };

// ─── Benchmarks ───

function benchWriteThroughput(): BenchResult[] {
  const results: BenchResult[] = [];
  const counts = [1_000, 10_000, 100_000];

  for (const count of counts) {
    const mem = new SharedMemory();
    const log = new EventLog();
    const ctx = new StageContext('', 'bench', mem, '', log);

    const t = measure(() => {
      for (let i = 0; i < count; i++) {
        ctx.setObject([], `key_${i}`, `value_${i}`);
      }
    }, 5);

    const opsPerSec = Math.round(count / (t.median / 1000));
    results.push({
      name: `Write ${formatNum(count)} keys`,
      value: formatMs(t.median),
      detail: `${formatNum(opsPerSec)} ops/s`,
    });
  }

  return results;
}

function benchReadThroughput(): BenchResult[] {
  const results: BenchResult[] = [];
  const counts = [1_000, 10_000, 100_000];

  for (const count of counts) {
    // Pre-populate state
    const mem = new SharedMemory();
    const log = new EventLog();
    const writeCtx = new StageContext('', 'setup', mem, '', log);
    for (let i = 0; i < count; i++) {
      writeCtx.setObject([], `key_${i}`, `value_${i}`);
    }
    writeCtx.commit();

    // Measure reads (no buffer creation — read-only path)
    const readCtx = new StageContext('', 'bench', mem, '', log);
    const t = measure(() => {
      for (let i = 0; i < count; i++) {
        readCtx.getValue([], `key_${i}`);
      }
    }, 5);

    const opsPerSec = Math.round(count / (t.median / 1000));
    results.push({
      name: `Read ${formatNum(count)} keys`,
      value: formatMs(t.median),
      detail: `${formatNum(opsPerSec)} ops/s`,
    });
  }

  return results;
}

async function benchPipelineScale(): Promise<BenchResult[]> {
  const results: BenchResult[] = [];
  const stageCounts = [10, 50, 200, 500];

  for (const count of stageCounts) {
    const stageMap = new Map<string, StageFunction>();

    // Build a linear chain of N stages
    const nodes: StageNode[] = [];
    for (let i = 0; i < count; i++) {
      const name = `stage_${i}`;
      stageMap.set(name, (scope: ScopeFacade) => {
        scope.setValue(`out_${i}`, i);
      });
      nodes.push({ name, id: name });
    }
    // Link nodes
    for (let i = 0; i < nodes.length - 1; i++) {
      nodes[i].next = nodes[i + 1];
    }

    const t = await measureAsync(async () => {
      const runtime = new ExecutionRuntime(nodes[0].name);
      const traverser = new FlowchartTraverser({
        root: nodes[0],
        stageMap,
        scopeFactory: simpleScopeFactory,
        executionRuntime: runtime,
        logger: silentLogger,
      });
      await traverser.execute();
    }, 5);

    results.push({
      name: `${count} stages (linear)`,
      value: formatMs(t.median),
      detail: `${(t.median / count).toFixed(3)}ms/stage`,
    });
  }

  return results;
}

async function benchConcurrentPipelines(): Promise<BenchResult[]> {
  const results: BenchResult[] = [];
  const concurrencies = [10, 100, 1_000];

  // Simple 3-stage pipeline
  const stageMap = new Map<string, StageFunction>();
  stageMap.set('A', (scope: ScopeFacade) => { scope.setValue('a', 1); });
  stageMap.set('B', (scope: ScopeFacade) => { scope.setValue('b', 2); });
  stageMap.set('C', (scope: ScopeFacade) => { scope.setValue('c', 3); });

  const nodeC: StageNode = { name: 'C', id: 'C' };
  const nodeB: StageNode = { name: 'B', id: 'B', next: nodeC };
  const root: StageNode = { name: 'A', id: 'A', next: nodeB };

  for (const n of concurrencies) {
    const memBefore = process.memoryUsage().heapUsed;

    const t = await measureAsync(async () => {
      const promises: Promise<any>[] = [];
      for (let i = 0; i < n; i++) {
        const runtime = new ExecutionRuntime(root.name);
        const traverser = new FlowchartTraverser({
          root, stageMap,
          scopeFactory: simpleScopeFactory,
          executionRuntime: runtime,
          logger: silentLogger,
        });
        promises.push(traverser.execute());
      }
      await Promise.all(promises);
    }, 3);

    // Measure memory after one run
    const promises: Promise<any>[] = [];
    for (let i = 0; i < n; i++) {
      const runtime = new ExecutionRuntime(root.name);
      const traverser = new FlowchartTraverser({
        root, stageMap,
        scopeFactory: simpleScopeFactory,
        executionRuntime: runtime,
        logger: silentLogger,
      });
      promises.push(traverser.execute());
    }
    await Promise.all(promises);
    global.gc?.();
    const memAfter = process.memoryUsage().heapUsed;
    const memDelta = Math.max(0, memAfter - memBefore);

    results.push({
      name: `${formatNum(n)} concurrent pipelines`,
      value: formatMs(t.median),
      detail: `~${formatBytes(memDelta)} heap`,
    });
  }

  return results;
}

function benchStateSize(): BenchResult[] {
  const results: BenchResult[] = [];
  const sizes = [
    { label: '1KB', bytes: 1_024 },
    { label: '10KB', bytes: 10_240 },
    { label: '100KB', bytes: 102_400 },
    { label: '1MB', bytes: 1_048_576 },
  ];

  for (const { label, bytes } of sizes) {
    const obj = makeObject(bytes);
    const actualSize = JSON.stringify(obj).length;

    // Measure structuredClone cost
    const t = measure(() => {
      structuredClone(obj);
    }, 20);

    results.push({
      name: `structuredClone ${label}`,
      value: formatMs(t.median),
      detail: `actual: ${formatBytes(actualSize)}`,
    });
  }

  return results;
}

function benchTimeTravelReplay(): BenchResult[] {
  const results: BenchResult[] = [];
  const commitCounts = [10, 50, 100, 500];

  for (const count of commitCounts) {
    // Build up commit history
    const mem = new SharedMemory();
    const log = new EventLog();

    for (let i = 0; i < count; i++) {
      const ctx = new StageContext('', `stage_${i}`, mem, '', log);
      ctx.setObject([], `key_${i}`, `value_${i}`);
      ctx.commit();
    }

    // Measure materialise to the last step
    const t = measure(() => {
      log.materialise(count - 1);
    }, 10);

    results.push({
      name: `Replay ${count} commits`,
      value: formatMs(t.median),
      detail: `${(t.median / count).toFixed(3)}ms/commit`,
    });
  }

  return results;
}

function benchCommitOverhead(): BenchResult[] {
  const results: BenchResult[] = [];

  // Measure commit cost with varying write counts per stage
  const writeCounts = [1, 10, 50, 100];

  for (const writes of writeCounts) {
    const t = measure(() => {
      const mem = new SharedMemory();
      const log = new EventLog();
      const ctx = new StageContext('', 'bench', mem, '', log);
      for (let i = 0; i < writes; i++) {
        ctx.setObject([], `key_${i}`, { data: `value_${i}`, nested: { a: i } });
      }
      ctx.commit();
    }, 20);

    results.push({
      name: `Commit with ${writes} writes`,
      value: formatMs(t.median),
    });
  }

  return results;
}

// ─── Runner ───

function printTable(title: string, rows: BenchResult[]) {
  console.log(`\n### ${title}\n`);
  const nameWidth = Math.max(25, ...rows.map((r) => r.name.length));
  const valWidth = Math.max(10, ...rows.map((r) => r.value.length));

  console.log(`| ${'Benchmark'.padEnd(nameWidth)} | ${'Time'.padEnd(valWidth)} | Detail |`);
  console.log(`|${''.padEnd(nameWidth + 2, '-')}|${''.padEnd(valWidth + 2, '-')}|--------|`);
  for (const row of rows) {
    console.log(`| ${row.name.padEnd(nameWidth)} | ${row.value.padEnd(valWidth)} | ${row.detail ?? ''} |`);
  }
}

async function main() {
  console.log('# FootPrint Performance Benchmarks');
  console.log(`\nNode ${process.version} | ${process.platform} ${process.arch}`);
  console.log(`Date: ${new Date().toISOString().split('T')[0]}`);

  printTable('Write Throughput', benchWriteThroughput());
  printTable('Read Throughput', benchReadThroughput());
  printTable('Pipeline Scale (end-to-end)', await benchPipelineScale());
  printTable('Concurrent Pipelines', await benchConcurrentPipelines());
  printTable('structuredClone Cost', benchStateSize());
  printTable('Time-Travel Replay', benchTimeTravelReplay());
  printTable('Commit Overhead', benchCommitOverhead());

  console.log('\n---\n');
}

main().catch(console.error);
