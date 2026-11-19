import { createRecordGraph } from 'foottrace/cause';
import { normaliseStateKey } from 'foottrace/paths';
import { describe, expect, it, vi } from 'vitest';

import { captureWitnessOf, explain } from '../../../src/explain.js';
import { type TypedScope, flowChart, FlowChartExecutor } from '../../../src/index.js';
import { type ReactiveTarget, createTypedScope } from '../../../src/lib/reactive/index.js';

type Line = { qty: number };
type Order = { line: Line; qty: number };
type State = { order: Order; items: Line[]; total: number };
type ReadQuantity = (scope: TypedScope<State>) => number;
const inspect = Symbol.for('nodejs.util.inspect.custom');

const rawReads: Array<[string, ReadQuantity]> = [
  ['object JSON', (scope) => JSON.parse(JSON.stringify(scope.order)).qty],
  ['array JSON', (scope) => JSON.parse(JSON.stringify(scope.items))[0].qty],
  ['array element JSON', (scope) => JSON.parse(JSON.stringify(scope.items[0])).qty],
  ['object primitive descriptor', (scope) => Object.getOwnPropertyDescriptor(scope.order, 'qty')?.value],
  ['object nested descriptor', (scope) => Object.getOwnPropertyDescriptor(scope.order, 'line')?.value.qty],
  ['array index descriptor', (scope) => Object.getOwnPropertyDescriptor(scope.items, '0')?.value.qty],
  [
    'array length descriptor',
    (scope) => Object.getOwnPropertyDescriptor(scope.items, 'length')?.value * scope.items[0].qty,
  ],
  ['array element descriptor', (scope) => Object.getOwnPropertyDescriptor(scope.items[0], 'qty')?.value],
  ['scope custom inspection', (scope) => (scope as unknown as Record<symbol, () => State>)[inspect]().order.qty],
  ['array custom inspection', (scope) => (scope.items as unknown as Record<symbol, () => Line[]>)[inspect]()[0].qty],
  ['find', (scope) => scope.items.find((item) => item.qty > 0)?.qty ?? -1],
  ['filter', (scope) => scope.items.filter((item) => item.qty > 0)[0].qty],
  [
    'forEach',
    (scope) => {
      let qty = -1;
      scope.items.forEach((item) => (qty = item.qty));
      return qty;
    },
  ],
  [
    'for of',
    (scope) => {
      let qty = 0;
      for (const item of scope.items) qty += item.qty;
      return qty;
    },
  ],
  [
    'array destructuring',
    (scope) => {
      const [line] = scope.items;
      return line.qty;
    },
  ],
  ['entries', (scope) => scope.items.entries().next().value?.[1].qty ?? -1],
  ['values', (scope) => scope.items.values().next().value?.qty ?? -1],
  ['array spread', (scope) => [...scope.items][0].qty],
  ['array pop', (scope) => scope.items.pop()?.qty ?? -1],
  ['$getValue', (scope) => (scope.$getValue('order') as Order).qty],
  ['$read root', (scope) => (scope.$read('order') as Order).qty],
  ['$read nested', (scope) => scope.$read('order.qty') as number],
  ['$toRaw', (scope) => (scope.$toRaw().getValue('order') as Order).qty],
  [
    '$batchArray',
    (scope) => {
      let qty = -1;
      scope.$batchArray<Line>('items', ([line]) => (qty = line.qty));
      return qty;
    },
  ],
];

async function serve(read: ReadQuantity) {
  const chart = flowChart<State>(
    'Seed',
    (scope) => {
      scope.order = { qty: 7, line: { qty: 7 } };
      scope.items = [{ qty: 7 }];
    },
    'seed',
  )
    .addFunction(
      'Read quantity',
      (scope) => {
        scope.total = read(scope);
      },
      'read',
    )
    .build();
  const executor = new FlowChartExecutor(chart, explain(true));
  await executor.run();
  const snapshot = executor.getSnapshot();
  const capture = snapshot.capture;
  const captureWitness = captureWitnessOf(snapshot);
  const address = snapshot.logAddress;
  if (capture?.version !== 3 || !address || !captureWitness) throw new Error('Expected native v3 coverage');

  const graph = createRecordGraph([
    { address, commitLog: snapshot.commitLog, complete: true, capture, captureWitness },
  ]);
  const reader = await graph.captureCoverage(
    address,
    { channel: 'nestedReads', mode: 'on', from: 0, to: snapshot.commitLog.length },
    { signal: new AbortController().signal },
  );
  expect(snapshot.sharedState.total).toBe(7);
  expect(captureWitness.boundary).toBe('completed');
  return {
    channel: capture.channels.nestedReads,
    reader,
    readKeys: snapshot.commitLog.at(-1)?.trace.find(({ path }) => path === 'total')?.readKeys,
  };
}

describe('nested read coverage for raw values', () => {
  it.each(rawReads)('marks %s as partial and preserves the value', async (_name, read) => {
    const { channel, reader } = await serve(read);
    expect(channel).toEqual({ mode: 'on', status: 'partial', reasons: ['unsupported-scope'] });
    expect(reader).toEqual({ state: 'partial', reasons: ['unsupported-scope'] });
  });

  const trackedReads: Array<[string, ReadQuantity, string[]]> = [
    ['direct object access', (scope) => scope.order.qty, ['order', 'qty']],
    ['direct object member access', (scope) => scope.order.line.qty, ['order', 'line', 'qty']],
    ['direct array access', (scope) => scope.items[0].qty, ['items', '0', 'qty']],
    [
      'object presence inspection',
      (scope) => (Reflect.has(scope.order, 'qty') ? scope.order.qty : -1),
      ['order', 'qty'],
    ],
    [
      'array keys iterator and indexed read',
      (scope) => scope.items[scope.items.keys().next().value ?? -1].qty,
      ['items', '0', 'qty'],
    ],
  ];

  it.each(trackedReads)('keeps %s collected', async (_name, read, path) => {
    const { channel, reader, readKeys } = await serve(read);
    expect(channel).toEqual({ mode: 'on', status: 'collected', reasons: [] });
    expect(reader).toEqual({ state: 'covered', reasons: [] });
    expect(readKeys).toEqual(path.map((_, index) => normaliseStateKey(path.slice(0, index + 1))));
  });
});

function observedScope<T extends object>(state: T) {
  const onNestedReadGap = vi.fn();
  const target = { getValue: (key?: string) => (key === undefined ? state : state[key as keyof T]) } as ReactiveTarget;
  const scope = createTypedScope<T>(target, { onNestedReadGap });
  return { scope, onNestedReadGap };
}

it('preserves accessor descriptor values and marks the raw read in the trap', () => {
  const line = { qty: 7 };
  const order = {
    qty: 7,
    get line() {
      return line;
    },
  };
  const { scope, onNestedReadGap } = observedScope({ order });
  const descriptor = Object.getOwnPropertyDescriptor(scope.order, 'line');
  expect(descriptor?.get?.()).toBe(line);
  expect(onNestedReadGap).toHaveBeenCalledTimes(1);
});

it('marks symbol-based raw object members without replacing their identity', () => {
  const key = Symbol('line');
  const line = { qty: 7 };
  const { scope, onNestedReadGap } = observedScope({ order: { [key]: line } });
  expect(scope.order[key]).toBe(line);
  expect(onNestedReadGap).toHaveBeenCalledTimes(1);
});

it('marks symbol-based raw array members without replacing their identity', () => {
  const key = Symbol('line');
  const line = { qty: 7 };
  const { scope, onNestedReadGap } = observedScope({ items: Object.assign([], { [key]: line }) });
  expect(scope.items[key]).toBe(line);
  expect(onNestedReadGap).toHaveBeenCalledTimes(1);
});

it('keeps unwrappable state values and marks their escape', () => {
  const date = new Date(Date.UTC(2026, 0, 7));
  const { scope, onNestedReadGap } = observedScope({ date });
  expect(scope.date).toBe(date);
  expect(onNestedReadGap).toHaveBeenCalledTimes(1);
});

type MappingState = { order: Order; qty: number; inherited: number; total: number };

it.each([
  ['parent input', true, false, true, 7],
  ['parent output', true, false, true, 7],
  ['child output', false, true, true, 8],
  ['child output without handoff capture', false, true, false, 8],
  ['scalar mapper control', false, false, true, 7],
] as const)(
  'assigns raw %s evidence to the log that supplied the value',
  async (door, parentGap, childGap, handoff, qty) => {
    const child = flowChart<MappingState>(
      'Child seed',
      (scope) => {
        scope.order = { qty: 8, line: { qty: 8 } };
        scope.total = scope.inherited;
      },
      'child-seed',
    ).build();
    const parent = flowChart<MappingState>(
      'Parent seed',
      (scope) => {
        scope.order = { qty: 7, line: { qty: 7 } };
        scope.qty = 7;
      },
      'parent-seed',
    )
      .addSubFlowChartNext('mount', child, 'Mount', {
        inputMapper: (scope) => ({ inherited: door === 'parent input' ? scope.order.qty : scope.qty }),
        outputMapper: (result: MappingState, scope: MappingState) => ({
          total:
            door === 'parent output'
              ? scope.order.qty
              : door.startsWith('child output')
              ? result.order.qty
              : result.total,
        }),
      })
      .build();
    const executor = new FlowChartExecutor(parent, explain(true, { captureOutputHandoff: handoff }));
    await executor.run();
    const snapshot = executor.getSnapshot();
    const rootCapture = snapshot.capture;
    const childCapture = snapshot.subflowResults?.mount.treeContext.capture;
    if (rootCapture?.version !== 3 || !childCapture) throw new Error('Expected both log notes');

    expect(snapshot.sharedState.total).toBe(qty);
    const channel = (gap: boolean) => ({
      mode: 'on',
      status: gap ? 'partial' : 'collected',
      reasons: gap ? ['unsupported-scope'] : [],
    });
    expect(rootCapture.channels.nestedReads).toEqual(channel(parentGap));
    expect(childCapture.channels.nestedReads).toEqual(channel(childGap));
  },
);

it.each([
  ['object', { qty: 7 }],
  ['scalar', 7],
] as const)('accounts for the %s item handed to the fan-out branch factory', async (kind, item) => {
  let observed = 0;
  const chart = flowChart<{ items: Array<Line | number> }>(
    'Seed',
    (scope) => {
      scope.items = [item];
    },
    'seed',
  )
    .addParallelForEach<Line | number>('Fan out', 'fan-out', {
      items: (scope) => scope.items,
      branch: (value) => {
        observed = typeof value === 'number' ? value : value.qty;
        return flowChart('Branch', () => undefined, 'branch').build();
      },
      into: 'results',
      maxBranches: 1,
    })
    .build();
  const executor = new FlowChartExecutor(chart, explain(true));
  await executor.run();
  const capture = executor.getSnapshot().capture;
  if (capture?.version !== 3) throw new Error('Expected native v3 coverage');
  expect(observed).toBe(7);
  expect(capture.channels.nestedReads).toEqual(
    kind === 'object'
      ? { mode: 'on', status: 'partial', reasons: ['unsupported-scope'] }
      : { mode: 'on', status: 'collected', reasons: [] },
  );
});
