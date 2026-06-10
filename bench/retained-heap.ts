/**
 * Retained-Heap Probe — replication of the #18 measurement (backlog #13b).
 *
 * Run: npm run bench:heap   (sets NODE_OPTIONS=--expose-gc; global.gc required)
 *
 * THE #18 FINDING this probe guards: the execution tree retains every
 * StageContext for the lifetime of the run, and before #13b each context
 * pinned (a) its `stateView` — a DISTINCT full-state generation, because
 * `SharedMemory.applyPatch` clones + swaps the whole state per commit — and
 * (b) its TransactionBuffer (2× full-state clones), never released after
 * commit. On an agent-style loop with a growing history key that made
 * retained heap grow O(N²): 563.8MB at N=200 in the original agentfootprint
 * measurement; a 500-iteration agent OOMed a default Node heap.
 *
 * #13b releases `buffer` + `stateView` at the END of `StageContext.commit()`
 * — commit is the stage's lifecycle end; both references are only needed
 * DURING execution. This probe measures what the executor (and its execution
 * tree) actually pins after a run:
 *
 *   1. heapUsed after gc, BEFORE the run            (baseline)
 *   2. heapUsed after gc, AFTER the run,
 *      executor still referenced                    (tree retained → the #13b number)
 *   3. heapUsed after gc, executor dropped          (floor — everything releasable)
 *
 * The retained delta (2−1) post-#13b consists of the commit log + narrative
 * + per-stage `stageWrites`/`stageReads` tracking — NOT state generations or
 * buffers. The commit log itself still grows O(N²) for a growing tracked
 * array (each commit records the full changed array) — that is the audit
 * trail by design; see BASELINE.md finding 4 / #13c.
 *
 * NOTE vs the original #18 probe: that one ran a full agentfootprint agent
 * (MockProvider, chunkDelayMs: 0). This is the footprintjs-only reduction —
 * same loop shape (Context → sf-tools subflow → Decide → loopTo), same
 * growing ~1KB-per-iteration history key, no LLM layer.
 */

import { flowChart, FlowChartExecutor } from '../src/index';
import type { FlowChart } from '../src/index';
import { type BenchResult, formatBytes, formatNum, makeMessage, printHeader, printTable } from './util';

type LooseState = Record<string, unknown>;

const ITERATIONS = 200;

/** Agent-style loop with a growing history key (~1KB append per iteration). */
function buildHistoryLoopChart(target: number): FlowChart<any, any> {
  const toolsSub = flowChart<LooseState>(
    'PrepareTool',
    async (scope) => {
      scope.$setValue('toolPrepared', true);
    },
    'prepare-tool',
  )
    .addFunction(
      'ExecuteTool',
      async (scope) => {
        scope.$setValue('toolResult', `result-${scope.$getValue('i')}`);
      },
      'execute-tool',
    )
    .build();

  return flowChart<LooseState>(
    'Seed',
    async (scope) => {
      scope.$setValue('i', 0);
      scope.$setValue('history', []);
    },
    'seed',
  )
    .addFunction(
      'Context',
      async (scope) => {
        const i = scope.$getValue('i') as number;
        scope.$batchArray('history', (arr) => {
          arr.push(makeMessage(i)); // ~1KB — agent-history-style growth
        });
      },
      'context',
    )
    .addSubFlowChartNext('sf-tools', toolsSub, 'Tools')
    .addFunction(
      'Decide',
      async (scope) => {
        const i = (scope.$getValue('i') as number) + 1;
        scope.$setValue('i', i);
        if (i >= target) scope.$break();
      },
      'decide',
    )
    .loopTo('context')
    .build();
}

function gcNow(): void {
  // Two passes — the first can promote, the second collects.
  global.gc!();
  global.gc!();
}

function heapAfterGc(): number {
  gcNow();
  return process.memoryUsage().heapUsed;
}

export interface RetainedHeapResult {
  iterations: number;
  baselineBytes: number;
  retainedWithExecutorBytes: number;
  retainedAfterDropBytes: number;
}

/** Run the probe at `iterations`; returns gc-stable retained-heap deltas. */
export async function probeRetainedHeap(iterations: number): Promise<RetainedHeapResult> {
  const chart = buildHistoryLoopChart(iterations);
  const baseline = heapAfterGc();

  let executor: FlowChartExecutor | undefined = new FlowChartExecutor(chart);
  await executor.run({ maxIterations: iterations + 1 });

  const withExecutor = heapAfterGc();
  executor = undefined; // release the tree
  const afterDrop = heapAfterGc();

  return {
    iterations,
    baselineBytes: baseline,
    retainedWithExecutorBytes: Math.max(0, withExecutor - baseline),
    retainedAfterDropBytes: Math.max(0, afterDrop - baseline),
  };
}

async function main() {
  if (typeof global.gc !== 'function') {
    console.error('retained-heap probe needs --expose-gc (use `npm run bench:heap`).');
    process.exitCode = 1;
    return;
  }

  printHeader('FootPrint Retained-Heap Probe (backlog #13b / #18 replication)');

  const r = await probeRetainedHeap(ITERATIONS);

  const rows: BenchResult[] = [
    {
      name: `Retained heap after ${formatNum(r.iterations)}-iteration run`,
      value: formatBytes(r.retainedWithExecutorBytes),
      detail: 'heapUsed after gc, executor (execution tree) still referenced — the #13b number',
    },
    {
      name: 'Retained after dropping executor',
      value: formatBytes(r.retainedAfterDropBytes),
      detail: 'floor — everything the executor pinned was releasable',
    },
    {
      name: 'Per iteration (tree retained)',
      value: formatBytes(Math.round(r.retainedWithExecutorBytes / r.iterations)),
      detail: 'commit log + narrative + stageWrites tracking remain; state generations/buffers must NOT (#13b)',
    },
  ];

  printTable(`Agent-style loop, growing ~1KB history key, N=${ITERATIONS}`, rows);
  console.log('\n---\n');
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
