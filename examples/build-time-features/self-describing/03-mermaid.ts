/**
 * Self-Describing — Mermaid Diagram Generation
 *
 * chart.toMermaid() (via toSpec()) generates a Mermaid flowchart
 * diagram string from the graph structure.
 *
 * Run: npx tsx examples/build-time-features/self-describing/03-mermaid.ts
 */

import { flowChart, decide } from 'footprintjs';

interface State { amount: number; status?: string }

const chart = flowChart<State>('Receive', async (scope) => {
  scope.amount = 100;
}, 'receive')
  .addDeciderFunction('Route', (scope) => {
    return decide(scope, [
      { when: { amount: { gt: 50 } }, then: 'express', label: 'High value' },
    ], 'standard');
  }, 'route')
    .addFunctionBranch('express', 'ExpressShip', async (scope) => { scope.status = 'express'; })
    .addFunctionBranch('standard', 'StandardShip', async (scope) => { scope.status = 'standard'; })
    .setDefault('standard')
    .end()
  .build();

const mermaid = chart.toMermaid();
console.log('Mermaid diagram:');
console.log(mermaid);
console.log('\nPaste into https://mermaid.live to visualize');
