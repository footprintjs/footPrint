/**
 * FootPrint Performance Benchmarks
 *
 * Run: npx tsx bench/run.ts
 *
 * Measures real numbers for the critical paths:
 * 1. Write throughput (setValue calls)
 * 2. Read throughput (getValue calls, no buffer creation; a fork child's reads served from live state)
 * 3. Pipeline scale (end-to-end latency by stage count)
 * 4. Concurrent pipelines (parallel executor.run() calls)
 * 5. State size (structuredClone cost at different object sizes)
 * 6. Time-travel replay (EventLog.materialise cost)
 */

import { ExecutionRuntime } from '../src/lib/runner/ExecutionRuntime';
import { FlowchartTraverser } from '../src/lib/engine/traversal/FlowchartTraverser';
import { ScopeFacade } from '../src/lib/scope/ScopeFacade';
import { SharedMemory } from 'foottrace/write';
import { EventLog } from 'foottrace/write';
import { StageContext } from '../src/lib/memory/StageContext';
import type { StageNode } from '../src/lib/engine/graph/StageNode';
import type { StageFunction, ILogger } from '../src/lib/engine/types';
import {
  type BenchResult,
  formatBytes,
  formatMs,
  formatNum,
  makeObject,
  measure,
  measureAsync,
  median,
  printHeader,
  printTable,
} from './util';

// ─── Utilities ───

const silentLogger: ILogger = {
  info() {},
  log() {},
  debug() {},
  error() {},
  warn() {},
};

function simpleScopeFactory(context: StageContext, stageName: string) {
  return new ScopeFacade(context, stageName);
}

// ─── Benchmarks ───

function benchWriteThroughput(): BenchResult[] {
  const results: BenchResult[] = [];
  const counts = [1_000, 10_000, 100_000];

  for (const count of counts) {
    const mem = new SharedMemory();
    const log = new EventLog({});
    const ctx = new StageContext('', 'bench', 'bench', mem, '', log);

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
    const log = new EventLog({});
    const writeCtx = new StageContext('', 'setup', 'setup', mem, '', log);
    for (let i = 0; i < count; i++) {
      writeCtx.setObject([], `key_${i}`, `value_${i}`);
    }
    writeCtx.commit();

    // Measure reads (buffer is created lazily on the first getValue — see bench/baseline.ts
    // for the end-to-end cost of that construction over large state)
    const readCtx = new StageContext('', 'bench', 'bench', mem, '', log);
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

/**
 * A fork child reading its parent's ROOT keys: each read misses the child's own
 * namespace (`runs/c0`) and is served from live state — the frame's address
 * joined to the path on every read (`RecordFrame · read` and `at`; C2, C3).
 */
function benchLiveStateReads(): BenchResult[] {
  const count = 10_000;
  const mem = new SharedMemory();
  const log = new EventLog({});
  const writeCtx = new StageContext('', 'setup', 'setup', mem, '', log);
  for (let i = 0; i < count; i++) writeCtx.setObject([], `key_${i}`, `value_${i}`);
  writeCtx.commit();
  const child = new StageContext('c0', 'child', 'child', mem, '', log);
  const t = measure(() => {
    for (let i = 0; i < count; i++) child.getValue([], `key_${i}`);
  }, 5);
  return [
    {
      name: `Read ${formatNum(count)} root keys from a fork child`,
      value: formatMs(t.median),
      detail: `${formatNum(Math.round(count / (t.median / 1000)))} ops/s (served from live state)`,
    },
  ];
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
      const runtime = new ExecutionRuntime(nodes[0].name, nodes[0].id);
      const traverser = new FlowchartTraverser({
        root: nodes[0],
        stageMap,
        scopeFactory: simpleScopeFactory,
        executionRuntime: runtime,
        logger: silentLogger,
        runId: 'bench',
        maxDepth: count + 10,
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
  stageMap.set('A', (scope: ScopeFacade) => {
    scope.setValue('a', 1);
  });
  stageMap.set('B', (scope: ScopeFacade) => {
    scope.setValue('b', 2);
  });
  stageMap.set('C', (scope: ScopeFacade) => {
    scope.setValue('c', 3);
  });

  const nodeC: StageNode = { name: 'C', id: 'C' };
  const nodeB: StageNode = { name: 'B', id: 'B', next: nodeC };
  const root: StageNode = { name: 'A', id: 'A', next: nodeB };

  // The heap column needs a forced collection on both sides of the sample;
  // without `--expose-gc` it would be noise, so it is printed as n/a.
  const gc = typeof global.gc === 'function' ? global.gc : undefined;

  for (const n of concurrencies) {
    const t = await measureAsync(async () => {
      const promises: Promise<any>[] = [];
      for (let i = 0; i < n; i++) {
        const runtime = new ExecutionRuntime(root.name, root.id);
        const traverser = new FlowchartTraverser({
          root,
          stageMap,
          scopeFactory: simpleScopeFactory,
          executionRuntime: runtime,
          logger: silentLogger,
          runId: `bench-${i}`,
        });
        promises.push(traverser.execute());
      }
      await Promise.all(promises);
    }, 3);

    // Measure the heap held by one batch of n finished runs (all still referenced).
    gc?.();
    const memBefore = process.memoryUsage().heapUsed;
    const promises: Promise<any>[] = [];
    const runtimes: ExecutionRuntime[] = [];
    for (let i = 0; i < n; i++) {
      const runtime = new ExecutionRuntime(root.name, root.id);
      runtimes.push(runtime);
      const traverser = new FlowchartTraverser({
        root,
        stageMap,
        scopeFactory: simpleScopeFactory,
        executionRuntime: runtime,
        logger: silentLogger,
        runId: `bench-mem-${i}`,
      });
      promises.push(traverser.execute());
    }
    await Promise.all(promises);
    gc?.();
    const memAfter = process.memoryUsage().heapUsed;
    const memDelta = Math.max(0, memAfter - memBefore);
    void runtimes.length; // keep the runs referenced until after the sample

    results.push({
      name: `${formatNum(n)} concurrent pipelines`,
      value: formatMs(t.median),
      detail: gc ? `~${formatBytes(memDelta)} heap (after gc)` : 'heap: n/a (run with --expose-gc)',
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
    const log = new EventLog({});

    for (let i = 0; i < count; i++) {
      const ctx = new StageContext('', `stage_${i}`, `stage_${i}`, mem, '', log);
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

  // Only `commit()` is timed: the memory, log, context and the N writes are
  // set up fresh before each sample, outside the clock.
  const stage = (writes: number): StageContext => {
    const mem = new SharedMemory();
    const log = new EventLog({});
    const ctx = new StageContext('', 'bench', 'bench', mem, '', log);
    for (let i = 0; i < writes; i++) {
      ctx.setObject([], `key_${i}`, { data: `value_${i}`, nested: { a: i } });
    }
    return ctx;
  };

  for (const writes of writeCounts) {
    for (let i = 0; i < 3; i++) stage(writes).commit(); // warmup
    const times: number[] = [];
    for (let i = 0; i < 20; i++) {
      const ctx = stage(writes);
      const start = performance.now();
      ctx.commit();
      times.push(performance.now() - start);
    }

    results.push({
      name: `Commit with ${writes} writes`,
      value: formatMs(median(times)),
      detail: 'commit() only',
    });
  }

  return results;
}

// ─── Runner ───

async function main() {
  printHeader('FootPrint Performance Benchmarks (micro)');

  printTable('Write Throughput', benchWriteThroughput());
  printTable('Read Throughput', [...benchReadThroughput(), ...benchLiveStateReads()]);
  printTable('Pipeline Scale (end-to-end)', await benchPipelineScale());
  printTable('Concurrent Pipelines', await benchConcurrentPipelines());
  printTable('structuredClone Cost', benchStateSize());
  printTable('Time-Travel Replay', benchTimeTravelReplay());
  printTable('Commit Overhead', benchCommitOverhead());

  console.log('\n---\n');
}

main().catch(console.error);
