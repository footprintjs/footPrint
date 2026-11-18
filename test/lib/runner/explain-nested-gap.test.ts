import { normaliseStateKey } from 'foottrace/paths';
import { expect, it } from 'vitest';

import { ScopeFacade } from '../../../src/advanced.js';
import { explain } from '../../../src/explain.js';
import { type RuntimeSnapshot, flowChart, FlowChartExecutor } from '../../../src/index.js';

function nestedCoverage(snapshot: RuntimeSnapshot) {
  const note = snapshot.capture;
  if (note?.version !== 3) throw new Error('Missing the explain capture note');
  return note.channels.nestedReads;
}

const partial = { mode: 'on', status: 'partial', reasons: ['unsupported-scope'] };
const collected = { mode: 'on', status: 'collected', reasons: [] };

it('marks a stale member read incomplete without replacing the working fallback value', async () => {
  const chart = flowChart<{ data: { amount: number } | null; total: number }>(
    'Seed',
    (scope) => {
      scope.data = { amount: 35 };
    },
    'seed',
  )
    .addFunction(
      'Read held object',
      (scope) => {
        const held = scope.data;
        scope.data = null;
        scope.total = held?.amount ?? -1;
      },
      'read',
    )
    .build();
  const executor = new FlowChartExecutor(chart, explain(true));
  await executor.run();
  const snapshot = executor.getSnapshot();
  expect(snapshot.sharedState.total).toBe(35);
  expect(snapshot.commitLog.at(-1)?.trace.find(({ path }) => path === 'total')?.readKeys).toEqual(['data']);
  expect(nestedCoverage(snapshot)).toEqual(partial);
});

it.each([
  [
    'tracked index',
    (items: Array<{ amount: number }>) => items[0]?.amount ?? -1,
    collected,
    ['items', normaliseStateKey(['items', '0']), normaliseStateKey(['items', '0', 'amount'])],
  ],
  ['raw array method', (items: Array<{ amount: number }>) => items.find(() => true)?.amount ?? -1, partial, ['items']],
])('distinguishes %s from missing nested evidence', async (_name, getAmount, coverage, prefix) => {
  const chart = flowChart<{ items: Array<{ amount: number }>; total: number }>(
    'Seed',
    (scope) => {
      scope.items = [{ amount: 35 }];
    },
    'seed',
  )
    .addFunction(
      'Read element',
      (scope) => {
        scope.total = getAmount(scope.items);
      },
      'read',
    )
    .build();
  const executor = new FlowChartExecutor(chart, explain(true));
  await executor.run();
  const snapshot = executor.getSnapshot();
  expect(snapshot.sharedState.total).toBe(35);
  expect(snapshot.commitLog.at(-1)?.trace.find(({ path }) => path === 'total')?.readKeys).toEqual(prefix);
  expect(nestedCoverage(snapshot)).toEqual(coverage);
});

it('cannot certify automatic member tracking for a facade without the native proxy', async () => {
  const chart = flowChart<void, ScopeFacade>(
    'Write and read',
    (scope) => {
      scope.setValue('data', { amount: 35 });
      scope.setValue('total', (scope.getValue('data') as { amount: number }).amount);
    },
    'read',
  ).build();
  const executor = new FlowChartExecutor(
    chart,
    explain(true, { scopeFactory: (context, name, input, env) => new ScopeFacade(context, name, input, env) }),
  );
  await executor.run();
  const snapshot = executor.getSnapshot();
  expect(snapshot.sharedState.total).toBe(35);
  expect(nestedCoverage(snapshot)).toEqual({ mode: 'on', status: 'unknown', reasons: ['unsupported-scope'] });
});
