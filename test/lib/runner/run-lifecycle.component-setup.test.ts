import { describe, expect, it, vi } from 'vitest';

import type { ComponentRun, ComponentSetup, FlowChart, InlineComponentRecorder, RunSlot } from '../../../src/index.js';
import { createRunLifecycle, flowChart, FlowChartExecutor } from '../../../src/index.js';

const configure = (chart: FlowChart, setup: (component: ComponentRun) => ComponentSetup) =>
  createRunLifecycle(chart, { runnerId: 'component-setup-test', componentSetup: setup });

describe('captured native component setup and finalization', () => {
  it('sets component cells before stages and binds the actual protected scope', async () => {
    const bound: unknown[] = [];
    const observed: number[] = [];
    const chart = flowChart(
      'body',
      (scope) => {
        const found = owner.forScope(scope).read(slot);
        observed.push(found.present ? found.value : -1);
        expect(bound.includes(scope)).toBe(true);
      },
      'body',
    ).build();
    const owner = configure(chart, (component) => {
      component.set(slot, 7);
      return { bindScope: (scope) => bound.push(scope) };
    });
    const slot: RunSlot<number> = owner.slot<number>('component');
    await owner.withRun((run) => run.execute({ kind: 'run' }));
    expect(observed).toEqual([7]);
    expect(bound).toHaveLength(1);
  });

  it('joins owned-root cleanup after postprocessing, in reverse registration order', async () => {
    const order: string[] = [];
    const chart = flowChart(
      'body',
      () => {
        order.push('body');
        return 'answer';
      },
      'body',
    ).build();
    const owner = configure(chart, (component) => {
      component.onFinalize(async (end) => {
        await Promise.resolve();
        order.push('first:' + end.kind);
      });
      component.onFinalize((end) => {
        order.push('second:' + end.kind);
      });
      return {};
    });
    owner.slot('component');
    await owner.withRun(async (run) => {
      await run.execute({ kind: 'run' });
      await Promise.resolve();
      order.push('postprocess');
    });
    expect(order).toEqual(['body', 'postprocess', 'second:completed', 'first:completed']);
  });

  it('joins raw native root cleanup before run settles', async () => {
    const ends: string[] = [];
    const chart = flowChart('body', () => 'answer', 'body').build();
    const owner = configure(chart, (component) => {
      component.onFinalize(async (end) => {
        await Promise.resolve();
        ends.push(end.kind);
      });
      return {};
    });
    owner.slot('component');
    await new FlowChartExecutor(chart).run();
    expect(ends).toEqual(['completed']);
  });

  it('gives repeated sibling mounts distinct native entry ordinals and joins each terminal', async () => {
    const entries: Array<{ runId: string; ordinal: number }> = [];
    const ends: string[] = [];
    const child = flowChart(
      'child',
      async () => {
        await Promise.resolve();
        return 'child';
      },
      'child',
    ).build();
    const owner = configure(child, (component) => {
      entries.push(component.entry);
      component.onFinalize(async (end) => {
        await Promise.resolve();
        ends.push(end.kind);
      });
      return {};
    });
    owner.slot('component');
    const parent = flowChart('parent', () => undefined, 'parent')
      .addSubFlowChart('left', child, 'left')
      .addSubFlowChart('right', child, 'right')
      .build();
    await new FlowChartExecutor(parent).run();
    expect(entries).toHaveLength(2);
    expect(new Set(entries.map((entry) => entry.runId)).size).toBe(1);
    expect(new Set(entries.map((entry) => entry.ordinal)).size).toBe(2);
    expect(ends).toEqual(['completed', 'completed']);
  });

  it('serves every live lifecycle namespace on the same captured token', async () => {
    const seen: string[] = [];
    const chart = flowChart(
      'body',
      (scope) => {
        const a = first.forScope(scope).read(firstSlot);
        const b = second.forScope(scope).read(secondSlot);
        seen.push(a.present ? a.value : 'missing-A', b.present ? b.value : 'missing-B');
      },
      'body',
    ).build();
    const first = configure(chart, (component) => {
      component.set(firstSlot, 'A');
      return {};
    });
    const second = configure(chart, (component) => {
      component.set(secondSlot, 'B');
      return {};
    });
    const firstSlot: RunSlot<string> = first.slot('component');
    const secondSlot: RunSlot<string> = second.slot('component');
    await new FlowChartExecutor(chart).run();
    expect(seen).toEqual(['A', 'B']);
  });

  it('captures ports through clones built before lifecycle configuration', async () => {
    const setups = vi.fn();
    const child = flowChart('child', () => 'child', 'child').build();
    const parent = flowChart('parent', () => undefined, 'parent')
      .addSubFlowChartNext('early-copy', child, 'early-copy')
      .build();
    const owner = configure(child, () => {
      setups();
      return {};
    });
    owner.slot('component');
    await new FlowChartExecutor(parent).run();
    expect(setups).toHaveBeenCalledTimes(1);
  });

  it('delivers canonical decisions inline with zero global recorders', async () => {
    const decisions: string[] = [];
    const chart = flowChart('seed', () => undefined, 'seed')
      .addDeciderFunction('choose', () => 'yes', 'choose')
      .addFunctionBranch('yes', 'yes', () => 'answer')
      .end()
      .build();
    const owner = configure(chart, () => ({
      recorder: { id: 'component-only', onDecision: (event) => decisions.push(event.chosen) },
    }));
    owner.slot('component');
    await owner.withRun((run) => run.execute({ kind: 'run' }));
    expect(decisions).toEqual(['yes']);
  });

  it('refuses deferred component delivery before executing the body', async () => {
    const body = vi.fn(() => 'answer');
    const chart = flowChart('body', body, 'body').build();
    const owner = configure(chart, () => ({
      recorder: { id: 'late', delivery: 'deferred' } as unknown as InlineComponentRecorder,
    }));
    owner.slot('component');
    await expect(owner.withRun((run) => run.execute({ kind: 'run' }))).rejects.toMatchObject({
      code: 'ERR_COMPONENT_RECORDER_DELIVERY',
    });
    expect(body).not.toHaveBeenCalled();
  });

  it('refuses delivery accessors without invoking their getter', async () => {
    const get = vi.fn(() => 'inline');
    const recorder = Object.defineProperty({ id: 'accessor' }, 'delivery', { get });
    const chart = flowChart('body', () => 'answer', 'body').build();
    const owner = configure(chart, () => ({ recorder }));
    owner.slot('component');
    await expect(owner.withRun((run) => run.execute({ kind: 'run' }))).rejects.toMatchObject({
      code: 'ERR_COMPONENT_RECORDER_DELIVERY',
    });
    expect(get).not.toHaveBeenCalled();
  });

  it('closes a mounted component while the parent remains active', async () => {
    let retained: unknown;

    const child = flowChart(
      'child',
      (scope) => {
        retained = scope;
        return 'child';
      },
      'child',
    ).build();
    const owner = configure(child, (component) => {
      component.set(slot, 1);
      return {};
    });
    const slot: RunSlot<number> = owner.slot('component');
    const parent = flowChart('parent', () => undefined, 'parent')
      .addSubFlowChartNext('member', child, 'member')
      .addFunction(
        'after',
        () => {
          expect(() => owner.forScope(retained).set(slot, 2)).toThrow(TypeError);
        },
        'after',
      )
      .build();
    await new FlowChartExecutor(parent).run();
  });
});
