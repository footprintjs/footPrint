/**
 * Break — Loop Exit
 *
 * $break() stops the loop — the current stage commits its writes,
 * then execution continues past the loopTo() target (or ends if
 * there's nothing after).
 *
 * Pipeline: Init → FetchPage (loop, $break when no more pages)
 *
 * Run: npx tsx examples/runtime-features/break/01-loop.ts
 */

import { flowChart, FlowChartExecutor } from 'footprintjs';

interface PaginationState {
  page: number;
  allItems: string[];
}

const FAKE_PAGES = [['a', 'b', 'c'], ['d', 'e'], []]; // empty = last page

const chart = flowChart<PaginationState>('Init', async (scope) => {
  scope.page = 0;
  scope.allItems = [];
}, 'init')
  .addFunction('FetchPage', async (scope) => {
    const items = FAKE_PAGES[scope.page] ?? [];
    scope.allItems = [...scope.allItems, ...items];
    scope.page += 1;

    if (items.length === 0) scope.$break();
  }, 'fetch-page')
  .loopTo('fetch-page')
  .build();

(async () => {
  const executor = new FlowChartExecutor(chart);
  executor.enableNarrative();
  await executor.run();

  const snap = executor.getSnapshot();
  console.log(`Pages fetched: ${snap.sharedState?.page}`);
  console.log(`Items: ${(snap.sharedState?.allItems as string[]).join(', ')}`);
  executor.getNarrativeEntries().map(e => e.text).forEach((line) => console.log(`  ${line}`));
})().catch(console.error);
