/**
 * Native run-evidence cost instrument. Run against current source with:
 * npx tsx bench/run-evidence.ts
 *
 * Reports actual JSON-line bytes and median construction/run time over three
 * rounds of 20 runs, after one warm-up. Uses memorySink: timing excludes JSON
 * encoding, disk I/O and fsync. This is a local observation, not a performance
 * guarantee or a replacement for the full benchmarks.
 */
import { memorySink } from 'foottrace/write';

import { decide, flowChart, FlowChartExecutor } from '../src/index.js';

interface BenchState {
  [key: string]: unknown;
  score?: number;
  outcome?: string;
  value?: number;
  a?: number;
  b?: number;
}

const loan = flowChart<BenchState>(
  'Score',
  (s) => {
    s.score = 640;
  },
  'score',
)
  .addDeciderFunction(
    'Route',
    (s) => decide(s, [{ when: { score: { gte: 700 } }, then: 'approve', label: 'High score' }], 'review'),
    'route',
  )
  .addFunctionBranch('approve', 'Approve', (s) => {
    s.outcome = 'approved';
  })
  .addFunctionBranch('review', 'Review', (s) => {
    s.outcome = 'review';
  })
  .end()
  .build();

const nested = flowChart<BenchState>(
  'Start',
  (s) => {
    s.value = 1;
  },
  'start',
)
  .addSubFlowChartNext('loan', loan, 'Loan', { outputMapper: (state) => ({ outcome: state.outcome }) })
  .addListOfFunction([
    {
      id: 'a',
      name: 'A',
      fn: (s) => {
        s.a = 1;
      },
    },
    {
      id: 'b',
      name: 'B',
      fn: (s) => {
        s.b = 2;
      },
    },
  ])
  .build();

async function main() {
  const rows = [];
  for (const [name, chart] of [
    ['loan', loan],
    ['nested-fork', nested],
  ] as const) {
    for (const mode of ['sinkless', 'off', 'on'] as const) {
      const rounds = [];
      let bytes = 0;
      let entries = 0;
      for (let round = -1; round < 3; round++) {
        let elapsed = 0;
        for (let run = 0; run < 20; run++) {
          const sink = memorySink();
          const start = performance.now();
          const ex = new FlowChartExecutor(
            chart,
            mode === 'sinkless'
              ? undefined
              : {
                  sink: mode === 'off' ? { adapter: sink, evidence: 'off' } : sink,
                },
          );
          await ex.run();
          elapsed += performance.now() - start;
          bytes = sink.entries.reduce(
            (total, entry) => total + new TextEncoder().encode(JSON.stringify(entry) + '\n').byteLength,
            0,
          );
          entries = sink.entries.length;
        }
        if (round >= 0) rounds.push(elapsed / 20);
      }
      rows.push({ name, mode, bytes, entries, medianMs: rounds.sort((a, b) => a - b)[1] });
    }
  }
  console.log(
    JSON.stringify({ node: process.version, adapter: 'memorySink', rounds: 3, runsPerRound: 20, rows }, null, 2),
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
