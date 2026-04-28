/**
 * Self-Describing — chart.toSpec()
 *
 * `toSpec()` returns the raw graph structure: a tree of stage nodes with
 * type, id, name, description, and child relationships (next, branches,
 * forkChildren, subflows). Every higher-level export — toMermaid, toOpenAPI,
 * toMCPTool — projects from this shape.
 *
 * Use it directly to build custom visualizations, validators, or to round-trip
 * a chart definition to JSON.
 *
 * Run: npx tsx examples/build-time-features/self-describing/04-spec.ts
 */

import { flowChart, decide } from 'footprintjs';

interface State { score: number; tier?: string }

const chart = flowChart<State>('Receive', async (scope) => {
  scope.score = 85;
}, 'receive')
  .addDeciderFunction('Classify', (scope) => {
    return decide(scope, [
      { when: { score: { gte: 90 } }, then: 'gold',   label: 'Top tier' },
      { when: { score: { gte: 70 } }, then: 'silver', label: 'Mid tier' },
    ], 'bronze');
  }, 'classify', 'Tier the request')
    .addFunctionBranch('gold',   'GoldTier',   async (s) => { s.tier = 'gold'; })
    .addFunctionBranch('silver', 'SilverTier', async (s) => { s.tier = 'silver'; })
    .addFunctionBranch('bronze', 'BronzeTier', async (s) => { s.tier = 'bronze'; })
    .setDefault('bronze')
    .end()
  .build();

// `buildTimeStructure` is the captured spec on a built chart.
// (The builder also exposes `.toSpec()` if you need it before `.build()`.)
const spec = chart.buildTimeStructure;

console.log('Raw spec (full graph as JSON):');
console.log(JSON.stringify(spec, null, 2));

// Spec drives every higher-level export — same source, different projections.
console.log('\nProjections from the same spec:');
console.log('  toMermaid()  →', chart.toMermaid().split('\n')[0], '...');
console.log('  toOpenAPI()  → has paths/components for the contract');
console.log('  toMCPTool()  → an MCP tool definition');

// Custom analysis: count nodes by type via a recursive walk.
function countByType(node: any, counts: Record<string, number> = {}): Record<string, number> {
  const t = node.type ?? 'stage';
  counts[t] = (counts[t] ?? 0) + 1;
  if (node.next)            countByType(node.next, counts);
  if (node.branches)        for (const b of Object.values(node.branches)) countByType(b, counts);
  return counts;
}
console.log('\nNode counts:', countByType(spec));
