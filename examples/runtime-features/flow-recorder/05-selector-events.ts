/**
 * Flow Recorder — Selector (onSelected) Events
 *
 * A custom FlowRecorder observing onSelected events from a selector.
 * The event includes which branches were selected and how many total.
 *
 * Pipeline: Seed → Triage(select) → [diabetes + hypertension branches]
 *
 * Run: npx tsx examples/runtime-features/flow-recorder/05-selector-events.ts
 */

import { flowChart, FlowChartExecutor, select } from 'footprintjs';
import type { FlowRecorder, FlowSelectedEvent } from 'footprintjs';

interface State { glucose: number; bp: number; results: string[] }

const chart = flowChart<State>('LoadVitals', async (scope) => {
  scope.glucose = 130;
  scope.bp = 150;
  scope.results = [];
}, 'load-vitals')
  .addSelectorFunction('Triage', (scope) => {
    return select(scope, [
      { when: { glucose: { gt: 100 } }, then: 'diabetes', label: 'High glucose' },
      { when: { bp: { gt: 140 } }, then: 'hypertension', label: 'High BP' },
    ]);
  }, 'triage')
    .addFunctionBranch('diabetes', 'DiabetesScreen', async (scope) => {
      scope.results = [...scope.results, 'glucose:' + scope.glucose];
    })
    .addFunctionBranch('hypertension', 'BPCheck', async (scope) => {
      scope.results = [...scope.results, 'bp:' + scope.bp];
    })
    .end()
  .build();

(async () => {
  const selections: string[] = [];

  const observer: FlowRecorder = {
    id: 'selector-observer',
    onSelected(event: FlowSelectedEvent) {
      selections.push(`Selected ${event.selected.join(', ')} (${event.selected.length}/${event.total})`);
    },
  };

  const executor = new FlowChartExecutor(chart);
  executor.attachFlowRecorder(observer);
  await executor.run();

  console.log('Selector events:');
  selections.forEach((s) => console.log(`  ${s}`));
})().catch(console.error);
