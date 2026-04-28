/**
 * Narrative Query — Structured Entries
 *
 * `getNarrativeEntries()` returns a typed array of `CombinedNarrativeEntry`,
 * not just text. Each entry carries a discriminator (`type`), depth, stageId,
 * runtimeStageId, and (for reads/writes) the key + raw value. That's the
 * stable surface for programmatic analysis: counts, timing, key-touch maps,
 * tree views — anything you'd otherwise grep out of strings.
 *
 * Run: npx tsx examples/post-execution/narrative-query/02-entries.ts
 */

import { flowChart, FlowChartExecutor, decide } from 'footprintjs';

interface State { amount: number; tier?: string; status?: string; processedAt?: string }

const chart = flowChart<State>('Seed', async (scope) => {
  scope.amount = 250;
}, 'seed')
  .addDeciderFunction('Classify', (scope) => {
    return decide(scope, [
      { when: { amount: { gt: 100 } }, then: 'high', label: 'High value' },
    ], 'low');
  }, 'classify')
    .addFunctionBranch('high', 'HighValue', async (scope) => { scope.tier = 'high'; })
    .addFunctionBranch('low',  'LowValue',  async (scope) => { scope.tier = 'low'; })
    .setDefault('low')
    .end()
  .addFunction('Finalize', async (scope) => {
    scope.status = 'done';
    scope.processedAt = new Date().toISOString();
  }, 'finalize')
  .build();

(async () => {
  const executor = new FlowChartExecutor(chart);
  executor.enableNarrative();
  await executor.run();

  const entries = executor.getNarrativeEntries();

  // 1. Count by type — how much of the run is data ops vs control flow?
  const byType = entries.reduce<Record<string, number>>((acc, e) => {
    acc[e.type] = (acc[e.type] ?? 0) + 1;
    return acc;
  }, {});
  console.log('Entry counts by type:', byType);

  // 2. Find every write to a specific key — programmatic dependency search.
  const writesToTier = entries.filter(e => e.type === 'step' && e.key === 'tier');
  console.log('\nStages that wrote `tier`:');
  for (const e of writesToTier) console.log(`  ${e.stageName} (runtime=${e.runtimeStageId}) → ${JSON.stringify(e.rawValue)}`);

  // 3. Walk depth as a tree — depth 0 is the root chart, deeper = nested subflows.
  console.log('\nIndented narrative (depth-driven):');
  for (const e of entries) {
    const indent = '  '.repeat(e.depth);
    console.log(`${indent}[${e.type}] ${e.text}`);
  }

  // 4. Subflow boundaries — use `direction` rather than text scanning.
  const boundaries = entries.filter(e => e.type === 'subflow');
  console.log(`\nSubflow boundaries: ${boundaries.length}`);
  for (const b of boundaries) console.log(`  ${b.direction} → ${b.subflowId}`);
})().catch(console.error);
