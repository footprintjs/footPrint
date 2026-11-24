import { isCommitBundle } from 'foottrace';
import { describe, expect, it } from 'vitest';

import type { StageNode } from '../../../../src/advanced.js';
import { type TypedScope, flowChart, FlowChartExecutor } from '../../../../src/index.js';
import { prefixNodeTree } from '../../../../src/lib/engine/graph/prefixNodeTree.js';

type State = Record<string, unknown>;

describe('native outside-input ownership', () => {
  it('retains only detached data names on dynamic nodes and their runtime structure', async () => {
    const names = ['clock'];
    let invoked = 0;
    const mustNotRun = () => {
      invoked += 1;
      throw new Error('outside-input accessor ran');
    };
    Object.defineProperty(names, Symbol.iterator, { get: mustNotRun });
    const valid: StageNode<unknown, TypedScope<State>> = {
      id: 'valid',
      name: 'Valid',
      outsideInputs: names,
      fn: (scope) => scope.$setValue('price', 11),
    };
    const malformed: StageNode<unknown, TypedScope<State>> = {
      id: 'malformed',
      name: 'Malformed',
      fn: (scope) => scope.$setValue('other', 12),
      get outsideInputs() {
        return mustNotRun();
      },
    };
    const chart = flowChart<State>('Driver', () => ({ name: 'continuation', next: valid }), 'driver').build();
    valid.next = malformed;
    const executor = new FlowChartExecutor(chart);
    await executor.run();
    names[0] = 'changed';

    expect(invoked).toBe(0);
    expect(executor.getSnapshot().sharedState).toEqual({ price: 11, other: 12 });
    const [, validBundle, malformedBundle] = executor.getSnapshot().commitLog;
    expect(validBundle.outsideInputs).toEqual({ declared: ['clock'] });
    expect(malformedBundle).not.toHaveProperty('outsideInputs');
    expect(executor.getRuntimeStructure()?.next?.outsideInputs).toEqual(['clock']);
    expect(executor.getRuntimeStructure()?.next?.next).not.toHaveProperty('outsideInputs');
  });

  it('skips a foreign node accessor when prefixing a lazy subflow', async () => {
    let invoked = 0;
    const child = flowChart<State>('Input', (scope) => scope.$setValue('price', 11), 'input').build();
    Object.defineProperty(child.root, 'outsideInputs', {
      enumerable: true,
      get() {
        invoked += 1;
        throw new Error('outside-input accessor ran');
      },
    });
    const chart = flowChart<State>('Driver', () => undefined, 'driver')
      .addLazySubFlowChartNext('mount', () => child, 'Mount', { outsideInputs: ['clock'] })
      .build();
    const executor = new FlowChartExecutor(chart);
    await executor.run();

    expect(invoked).toBe(0);
    const mounted = executor.getSubflowResults().get('mount');
    expect(mounted?.treeContext.globalContext).toMatchObject({ price: 11 });
    const childBundles = mounted?.treeContext.history.filter(isCommitBundle);
    expect(childBundles?.find((bundle) => bundle.stageId === 'mount/input')).toBeDefined();
    expect(childBundles?.some((bundle) => Object.hasOwn(bundle, 'outsideInputs'))).toBe(false);
    expect(executor.getSnapshot().commitLog.find((bundle) => bundle.stageId === 'mount')?.outsideInputs).toEqual({
      declared: ['clock'],
    });
  });

  it('clones only descriptor data when a proxy get can substitute outside-input names', () => {
    const target = { id: 'stage', name: 'Stage', outsideInputs: ['clock'] };
    let invoked = 0;
    const node = new Proxy(target, {
      get(object, key, receiver) {
        if (key === 'outsideInputs') {
          invoked += 1;
          return ['fabricated'];
        }
        return Reflect.get(object, key, receiver);
      },
    });
    expect(prefixNodeTree(node, 'mount')).toMatchObject({ id: 'mount/stage', outsideInputs: ['clock'] });
    expect(invoked).toBe(0);
  });

  it('retains an earlier retry attempt as evidence for the same execution', async () => {
    let stageAttempts = 0;
    const chart = flowChart<State>(
      'Quote',
      async (scope) => {
        stageAttempts += 1;
        if (stageAttempts === 1) {
          await scope.$call('quotes.price', () => 10);
          scope.$setValue('discarded', true);
          throw new Error('retry the stage');
        }
        scope.$setValue('price', 11);
      },
      'quote',
    )
      .outside('clock')
      .retry({ attempts: 2, backoffMs: 0 })
      .build();
    const executor = new FlowChartExecutor(chart);
    await executor.run();

    const snapshot = executor.getSnapshot();
    expect(stageAttempts).toBe(2);
    expect(snapshot.sharedState).toEqual({ price: 11 });
    expect(snapshot.commitLog).toHaveLength(1);
    expect(snapshot.commitLog[0].outsideInputs).toEqual({
      declared: ['clock'],
      call: { targets: ['quotes.price'] },
    });
    expect(snapshot.commitLog[0]).not.toHaveProperty('untrackedSources');
  });

  it('marks a started call whose completion does not reach the owning commit', async () => {
    const chart = flowChart<State>(
      'Quote',
      async (scope) => {
        let entered!: () => void;
        const started = new Promise<void>((resolve) => {
          entered = resolve;
        });
        scope
          .$call('quotes.pending', (attempt) => {
            entered();
            return new Promise<never>((_resolve, reject) => {
              attempt.signal.addEventListener('abort', () => reject(attempt.signal.reason), { once: true });
            });
          })
          .catch(() => undefined);
        await started;
        scope.$setValue('price', 11);
      },
      'quote',
    ).build();
    const executor = new FlowChartExecutor(chart);
    await executor.run();

    const snapshot = executor.getSnapshot();
    expect(snapshot.sharedState).toEqual({ price: 11 });
    expect(snapshot.commitLog[0].outsideInputs).toEqual({ call: { targets: [], incomplete: true } });
  });

  it('bounds target evidence by the existing retained-attempt cap', async () => {
    const chart = flowChart<State>(
      'Quote',
      async (scope) => {
        for (let i = 0; i < 1_000; i++) await scope.$call('quotes.first', () => i);
        scope.$setValue('price', await scope.$call('quotes.not-retained', () => 23));
      },
      'quote',
    ).build();
    const executor = new FlowChartExecutor(chart);
    await executor.run();

    const snapshot = executor.getSnapshot();
    expect(snapshot.sharedState).toEqual({ price: 23 });
    expect(snapshot.executionTree?.attempts).toHaveLength(1_000);
    expect(snapshot.executionTree?.attemptsDropped).toBe(1);
    expect(snapshot.commitLog[0].outsideInputs).toEqual({ call: { targets: ['quotes.first'], incomplete: true } });
  });
});
