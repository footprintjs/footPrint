/**
 * Narrative Query — Flow-Only Narrative
 *
 * Filter `getNarrativeEntries()` down to control-flow types — `step`
 * is a data op (read/write), so excluding it leaves the skeleton: which
 * stages ran, what conditions fired, where forks happened, where loops
 * iterated. Useful for high-level audit trails, dashboards, and Mermaid
 * generation when you don't want every read/write line.
 *
 * Run: npx tsx examples/post-execution/narrative-query/03-flow-narrative.ts
 */

import { flowChart, FlowChartExecutor, decide } from 'footprintjs';
import type { CombinedNarrativeEntry } from 'footprintjs/advanced';

interface State { creditScore: number; dti: number; risk?: string }

const chart = flowChart<State>('Load', async (scope) => {
  scope.creditScore = 740;
  scope.dti = 0.32;
}, 'load')
  .addDeciderFunction('Classify', (scope) => {
    return decide(scope, [
      { when: { creditScore: { gt: 700 }, dti: { lt: 0.4 } }, then: 'low',  label: 'Strong profile' },
      { when: { creditScore: { gt: 600 } },                   then: 'med',  label: 'Marginal' },
    ], 'high');
  }, 'classify')
    .addFunctionBranch('low',  'LowRisk',  async (s) => { s.risk = 'low'; })
    .addFunctionBranch('med',  'MedRisk',  async (s) => { s.risk = 'medium'; })
    .addFunctionBranch('high', 'HighRisk', async (s) => { s.risk = 'high'; })
    .setDefault('high')
    .end()
  .build();

const FLOW_TYPES: ReadonlySet<CombinedNarrativeEntry['type']> = new Set([
  'stage', 'condition', 'fork', 'selector', 'subflow', 'loop', 'break',
]);

(async () => {
  const executor = new FlowChartExecutor(chart);
  executor.enableNarrative();
  await executor.run();

  const all = executor.getNarrativeEntries();
  const flowOnly = all.filter(e => FLOW_TYPES.has(e.type));

  console.log(`Full narrative: ${all.length} entries`);
  console.log(`Flow-only:      ${flowOnly.length} entries (${all.length - flowOnly.length} data ops elided)\n`);

  console.log('Flow narrative:');
  for (const e of flowOnly) {
    const indent = '  '.repeat(e.depth);
    console.log(`${indent}${e.text}`);
  }
})().catch(console.error);
