/**
 * chart.toMermaid() — the one walker (`RunnableChart.ts · chartToMermaid`), shared with `FlowChartBuilder · toMermaid`.
 *
 * Test types: Byte-identity (a chart with a decider, a fork, a mount and a loop draws as it always did) · Boundary
 * (a `"` in a name; two ids that sanitise alike) · Contract (the builder and the built chart draw the same text).
 */
import { describe, expect, it } from 'vitest';

import { flowChart } from '../../../../src/index';

const noop = () => {};

function builder() {
  const sub = flowChart('Sub A', noop, 'sub-a').addFunction('Sub B', noop, 'sub-b').build();
  return flowChart('Seed', noop, 'seed')
    .addDeciderFunction('Route', async () => 'x', 'route')
    .addFunctionBranch('x', 'Branch X', noop)
    .addFunctionBranch('y', 'Branch Y', noop)
    .end()
    .addListOfFunction([
      { id: 'p', name: 'P', fn: noop },
      { id: 'q', name: 'Q', fn: noop },
    ])
    .addSubFlowChartNext('mount', sub, 'Mount')
    .addFunction('Call Model', noop, 'call-model')
    .addFunction('again', noop, 'again')
    .loopTo('call-model');
}

describe('chart.toMermaid()', () => {
  it('draws a chart without a quote or an id collision exactly as before', () => {
    expect(builder().build().toMermaid()).toBe(
      [
        'flowchart TD',
        'seed["Seed"]',
        'seed --> route',
        'route["Route"]',
        'route --> x',
        'x["Branch X"]',
        'route --> y',
        'y["Branch Y"]',
        'route --> route_fork',
        'route_fork["route-fork"]',
        'route_fork --> p',
        'p["P"]',
        'route_fork --> q',
        'q["Q"]',
        'route_fork --> mount',
        'mount["Mount"]',
        'mount --> call_model',
        'call_model["Call Model"]',
        'call_model --> again',
        'again["again"]',
        'again --> call_model',
      ].join('\n'),
    );
  });

  it('escapes a double quote in a stage name', () => {
    const mermaid = flowChart('Say "hi"', noop, 'say').build().toMermaid();
    expect(mermaid).toBe('flowchart TD\nsay["Say #quot;hi#quot;"]');
  });

  it('keeps two ids that sanitise alike as two nodes', () => {
    const mermaid = flowChart('Dash', noop, 'a-b').addFunction('Under', noop, 'a_b').build().toMermaid();
    expect(mermaid).toBe('flowchart TD\na_b["Dash"]\na_b --> a_b_2\na_b_2["Under"]');
  });

  it('the builder draws the same text as the built chart, the loop target declared once by its name', () => {
    const b = builder();
    const fromBuilder = b.toMermaid();
    expect(fromBuilder).toBe(b.build().toMermaid());
    expect(fromBuilder.split('\n').filter((line) => line.startsWith('call_model['))).toEqual([
      'call_model["Call Model"]',
    ]);
  });
});
