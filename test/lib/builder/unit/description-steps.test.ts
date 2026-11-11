/**
 * The chart's description — step numbers, loop references and dispatcher branch lists.
 *
 * Test types: Unit (a root selector is step 1, listed once; `loopTo` names the target's step when the stage's
 * name differs from its id; subflow and lazy-subflow branches are listed among a dispatcher's branches).
 */
import { describe, expect, it } from 'vitest';

import { flowChart, flowChartSelector } from '../../../../src/index';

const noop = () => {};

describe('chart description', () => {
  it('a root selector is step 1, listed once', () => {
    const chart = flowChartSelector('Ctx', () => ['a'], 'ctx')
      .addFunctionBranch('a', 'A', noop)
      .end()
      .addFunction('Next', noop, 'next')
      .build();
    expect(chart.description.split('\n').slice(1)).toEqual(['Steps:', '1. Ctx — Selects from: a', '2. Next']);
  });

  it('loopTo names the target step when the stage name differs from its id', () => {
    const chart = flowChart('Seed', noop, 'seed')
      .addFunction('Call Model', noop, 'call-model')
      .addFunction('Check', noop, 'check')
      .loopTo('call-model')
      .build();
    expect(chart.description).toContain('→ loops back to step 2');
  });

  it('loopTo names the step of a decider and of a selector by id', () => {
    const decider = flowChart('Seed', noop, 'seed')
      .addDeciderFunction('Route Name', () => 'x', 'route')
      .addFunctionBranch('x', 'X', noop)
      .end()
      .addFunction('Check', noop, 'check')
      .loopTo('route')
      .build();
    expect(decider.description).toContain('→ loops back to step 2');

    const selector = flowChart('Seed', noop, 'seed')
      .addSelectorFunction('Pick Name', () => ['x'], 'pick')
      .addFunctionBranch('x', 'X', noop)
      .end()
      .addFunction('Check', noop, 'check')
      .loopTo('pick')
      .build();
    expect(selector.description).toContain('→ loops back to step 2');
  });

  it('a decider lists its subflow and lazy-subflow branches', () => {
    const sub = flowChart('S', noop, 's').build();
    const chart = flowChart('Seed', noop, 'seed')
      .addDeciderFunction('Route', () => 'x', 'route')
      .addFunctionBranch('x', 'X', noop)
      .addSubFlowChartBranch('sf', sub, 'SF')
      .addLazySubFlowChartBranch('lazy', () => sub, 'Lazy')
      .end()
      .build();
    expect(chart.description).toContain('2. Route — Decides between: x, sf, lazy');
  });

  it('a selector lists its subflow branches', () => {
    const sub = flowChart('S', noop, 's').build();
    const chart = flowChart('Seed', noop, 'seed')
      .addSelectorFunction('Pick', () => ['x'], 'pick')
      .addFunctionBranch('x', 'X', noop)
      .addSubFlowChartBranch('sf', sub, 'SF')
      .end()
      .build();
    expect(chart.description).toContain('2. Pick — Selects from: x, sf');
  });
});
