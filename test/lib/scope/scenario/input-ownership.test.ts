/**
 * Run input ownership (handoff F).
 *
 * Ordinary mutable records and arrays become frozen, run-owned copies: ONE snapshot per
 * run()/resume() (and per subflow mount, whose input is its own), shared by every scope of
 * that leg; each scope pays only O(root keys). Not a cross-run cache. Opaque values and
 * explicitly frozen boundaries stay borrowed, and readonly-key checks keep their source.
 * These scenarios exercise TypedScope, the factory door, mounts and resume without changing
 * the separate rules for committed state or the resume handler's second argument.
 */
import { describe, expect, it } from 'vitest';

import type { ScopeFactory } from '../../../../src';
import { flowChart, FlowChartExecutor } from '../../../../src';
import { attachScopeMethods } from '../../../../src/lib/scope/providers/baseStateCompatible';

interface Input {
  order: { lines: { amount: number }[] };
}

function inputWith(amount: number): Input {
  return { order: { lines: [{ amount }] } };
}

describe('run input ownership', () => {
  it('multiple stages read the same values from detached frozen copies without freezing the caller', async () => {
    const input = inputWith(4);
    const seen: Input[] = [];
    const chart = flowChart<{ total: number }>(
      'Read',
      (scope) => {
        const args = scope.$getArgs<Input>();
        seen.push(args);
        expect(scope.$getArgs()).toBe(args);
        scope.total = args.order.lines[0].amount;
      },
      'read',
    )
      .addFunction(
        'ReadAgain',
        (scope) => {
          const args = scope.$getArgs<Input>();
          seen.push(args);
          scope.total += args.order.lines[0].amount;
        },
        'read-again',
      )
      .build();
    const executor = new FlowChartExecutor(chart);

    await executor.run({ input });

    expect(executor.getSnapshot().sharedState.total).toBe(8);
    expect(seen).toHaveLength(2);
    for (const args of seen) {
      expect(args).toEqual(input);
      expect(args).not.toBe(input);
      expect(args.order).not.toBe(input.order);
      expect(args.order.lines).not.toBe(input.order.lines);
      expect(args.order.lines[0]).not.toBe(input.order.lines[0]);
      expect(Object.isFrozen(args)).toBe(true);
      expect(Object.isFrozen(args.order)).toBe(true);
      expect(Object.isFrozen(args.order.lines)).toBe(true);
      expect(Object.isFrozen(args.order.lines[0])).toBe(true);
      expect(() => {
        args.order.lines[0].amount = 99;
      }).toThrow(TypeError);
    }
    expect(seen[0].order).toBe(seen[1].order);
    expect(Object.isFrozen(input)).toBe(false);
    expect(Object.isFrozen(input.order)).toBe(false);
    expect(Object.isFrozen(input.order.lines)).toBe(false);
    expect(Object.isFrozen(input.order.lines[0])).toBe(false);
    input.order.lines[0].amount = 9;
    input.order.lines.push({ amount: 2 });
    expect(seen.map((args) => args.order.lines)).toEqual([[{ amount: 4 }], [{ amount: 4 }]]);
  });

  it('snapshots once per run: a caller edit mid-run reaches no later scope', async () => {
    const input = inputWith(1);
    const seen: Input[] = [];
    const chart = flowChart(
      'BeforeEdit',
      (scope) => {
        const args = scope.$getArgs<Input>();
        seen.push(args);
        input.order.lines[0].amount = 2;
        expect(scope.$getArgs()).toBe(args);
        expect(args.order.lines[0].amount).toBe(1);
      },
      'before-edit',
    )
      .addFunction('AfterEdit', (scope) => seen.push(scope.$getArgs<Input>()), 'after-edit')
      .build();

    await new FlowChartExecutor(chart).run({ input });

    expect(seen.map((args) => args.order.lines[0].amount)).toEqual([1, 1]);
    expect(input.order.lines[0].amount).toBe(2);
  });

  it('constructor input, run overrides and reruns all see fresh caller values without a stale cache', async () => {
    const constructorInput = inputWith(1);
    const override = inputWith(7);
    const seen: Input[] = [];
    const chart = flowChart('Read', (scope) => seen.push(scope.$getArgs<Input>()), 'read').build();
    const executor = new FlowChartExecutor(chart, { readOnlyContext: constructorInput });

    await executor.run();
    constructorInput.order.lines[0].amount = 2;
    await executor.run({ input: override });
    override.order.lines[0].amount = 8;
    await executor.run({ input: override });
    await executor.run();

    expect(seen.map((args) => args.order.lines[0].amount)).toEqual([1, 7, 8, 2]);
    expect(Object.isFrozen(constructorInput.order)).toBe(false);
    expect(Object.isFrozen(override.order)).toBe(false);
  });

  it('factory scopes use the same owned args and keep readonly-key enforcement', async () => {
    type FactoryScope = ReturnType<typeof attachScopeMethods>;
    const factory: ScopeFactory<FactoryScope> = (context, name, readOnly) =>
      attachScopeMethods({}, context, name, readOnly);
    const input = inputWith(3);
    const seen: Input[] = [];
    const chart = flowChart<void, FactoryScope>(
      'Read',
      (scope: FactoryScope) => {
        const args = scope.getArgs<Input>();
        seen.push(args);
        expect(scope.getArgs()).toBe(args);
        expect(() => scope.setValue('order', {})).toThrow('Cannot write to readonly input key "order"');
      },
      'read',
    ).build();

    await new FlowChartExecutor(chart, factory).run({ input });

    expect(seen[0]).toEqual(input);
    expect(seen[0].order).not.toBe(input.order);
    expect(Object.isFrozen(seen[0].order.lines[0])).toBe(true);
    expect(Object.isFrozen(input.order.lines[0])).toBe(false);
    input.order.lines[0].amount = 5;
    expect(seen[0].order.lines[0].amount).toBe(3);
  });

  it('subflow args stay frozen while later parent-state writes remain possible', async () => {
    const innerArgs: Input[] = [];
    const inner = flowChart(
      'ReadMapped',
      (scope) => {
        const args = scope.$getArgs<Input>();
        innerArgs.push(args);
        expect(Object.isFrozen(args.order.lines[0])).toBe(true);
        expect(() => {
          args.order.lines[0].amount = 99;
        }).toThrow(TypeError);
      },
      'read-mapped',
    ).build();
    const chart = flowChart<Input>(
      'Seed',
      (scope) => {
        scope.order = inputWith(1).order;
      },
      'seed',
    )
      .addSubFlowChartNext('inner', inner, 'Inner', { inputMapper: (parent) => ({ order: parent.order }) })
      .addFunction(
        'EditParent',
        (scope) => {
          scope.order.lines[0].amount = 2;
        },
        'edit-parent',
      )
      .build();
    const executor = new FlowChartExecutor(chart);

    await executor.run();

    expect(executor.getSnapshot().sharedState.order).toEqual(inputWith(2).order);
    expect(innerArgs[0].order).toEqual(inputWith(1).order);
  });

  it.each(['same', 'fresh'] as const)(
    '%s-executor resume takes a new scope snapshot of constructor input',
    async (mode) => {
      const input = inputWith(1);
      const seen: Input[] = [];
      const chart = flowChart<{ initial: number; resumed: number; done: boolean }>(
        'Seed',
        (scope) => {
          const args = scope.$getArgs<Input>();
          seen.push(args);
          scope.initial = args.order.lines[0].amount;
        },
        'seed',
      )
        .addPausableFunction(
          'Gate',
          {
            execute: () => ({ question: 'Continue?' }),
            resume: (scope) => {
              const args = scope.$getArgs<Input>();
              seen.push(args);
              scope.resumed = args.order.lines[0].amount;
            },
          },
          'gate',
        )
        .addFunction(
          'Finish',
          (scope) => {
            scope.done = true;
          },
          'finish',
        )
        .build();
      const first = new FlowChartExecutor(chart, { readOnlyContext: input });
      await first.run();
      expect(first.isPaused()).toBe(true);
      const checkpoint = JSON.parse(JSON.stringify(first.getCheckpoint()));
      input.order.lines[0].amount = 2;
      const resumed = mode === 'same' ? first : new FlowChartExecutor(chart, { readOnlyContext: input });

      await resumed.resume(checkpoint);

      expect(resumed.isPaused()).toBe(false);
      expect(resumed.getSnapshot().sharedState).toMatchObject({ initial: 1, resumed: 2, done: true });
      expect(seen.map((args) => args.order.lines[0].amount)).toEqual([1, 2]);
      expect(Object.isFrozen(input.order.lines[0])).toBe(false);
    },
  );

  it('an AbortSignal passed as an input capability retains identity and can still be aborted', async () => {
    const controller = new AbortController();
    let abortEvents = 0;
    controller.signal.addEventListener('abort', () => abortEvents++);
    const chart = flowChart<{ aborted: boolean }>(
      'AbortCapability',
      (scope) => {
        const args = scope.$getArgs<{ signal: AbortSignal }>();
        expect(args.signal).toBe(controller.signal);
        controller.abort('requested');
        scope.aborted = args.signal.aborted;
      },
      'abort-capability',
    ).build();
    const executor = new FlowChartExecutor(chart);

    await executor.run({ input: { signal: controller.signal } });

    expect(executor.getSnapshot().sharedState.aborted).toBe(true);
    expect(controller.signal.reason).toBe('requested');
    expect(abortEvents).toBe(1);
    expect(Object.isFrozen(controller.signal)).toBe(false);
  });

  it('opaque services, callbacks and explicitly frozen boundaries remain borrowed capabilities', async () => {
    class Counter {
      count = 0;
      increment() {
        this.count++;
      }
    }
    const service = new Counter();
    const live = { count: 0 };
    const boundary = Object.freeze({ live });
    const callback = () => service.increment();
    const chart = flowChart(
      'UseCapabilities',
      (scope) => {
        const args = scope.$getArgs<{ service: Counter; callback: () => void; boundary: typeof boundary }>();
        expect(args.service).toBe(service);
        expect(args.callback).toBe(callback);
        expect(args.boundary).toBe(boundary);
        args.callback();
        args.service.increment();
        args.boundary.live.count++;
      },
      'use-capabilities',
    ).build();

    await new FlowChartExecutor(chart).run({ input: { service, callback, boundary } });

    expect(service.count).toBe(2);
    expect(live.count).toBe(1);
    expect(Object.isFrozen(service)).toBe(false);
    expect(Object.isFrozen(live)).toBe(false);
  });
});

describe('run input ownership — work count', () => {
  /** Counts element reads of a nested input array: each read is copy work. */
  function countedInput(size: number) {
    const reads = { count: 0 };
    const rows = new Proxy(
      Array.from({ length: size }, (_, id) => ({ id })),
      {
        get(target, key, receiver) {
          if (typeof key === 'string' && /^\d+$/.test(key)) reads.count++;
          return Reflect.get(target, key, receiver);
        },
      },
    );
    return { input: { rows }, reads };
  }

  async function readsFor(stages: number): Promise<number> {
    const { input, reads } = countedInput(500);
    let chart = flowChart<{ n: number }>(
      'S0',
      (scope) => {
        scope.$getArgs();
      },
      's0',
    );
    for (let i = 1; i < stages; i++)
      chart = chart.addFunction(
        `S${i}`,
        (scope) => {
          scope.$getArgs();
        },
        `s${i}`,
      );
    await new FlowChartExecutor(chart.build()).run({ input });
    return reads.count;
  }

  it('copies the input once per run, not once per stage', async () => {
    const one = await readsFor(1);
    expect(one).toBe(500);
    expect(await readsFor(40)).toBe(one);
  });
});
