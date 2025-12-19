import { flowChart } from '../../../../src/lib/builder';
import type { FlowChartBuilder, StageNode } from '../../../../src/lib/builder';

const noop = async () => {};

describe('Boundary: large graph', () => {
  it('handles 200-stage linear chain', () => {
    let builder: FlowChartBuilder = flowChart('s0', noop);
    for (let i = 1; i < 200; i++) {
      builder = builder.addFunction(`s${i}`, noop);
    }
    const chart = builder.build();

    // Walk and count
    let count = 0;
    let node: StageNode | undefined = chart.root;
    while (node) { count++; node = node.next; }

    expect(count).toBe(200);
    expect(chart.stageMap.size).toBe(200);
  });

  it('handles 100 parallel children', () => {
    const children = Array.from({ length: 100 }, (_, i) => ({
      id: `p${i}`,
      name: `Worker${i}`,
      fn: noop,
    }));

    const chart = flowChart('hub', noop)
      .addListOfFunction(children)
      .build();

    expect(chart.root.children).toHaveLength(100);
    expect(chart.stageMap.size).toBe(101); // hub + 100 children
  });

  it('handles decider with 50 branches', () => {
    let decider = flowChart('input', noop)
      .addDeciderFunction('decide', noop);

    for (let i = 0; i < 50; i++) {
      decider = decider.addFunctionBranch(`b${i}`, `Branch${i}`, noop);
    }

    const chart = decider.end().build();
    expect(chart.root.next!.children).toHaveLength(50);
    expect(chart.stageMap.size).toBe(52); // input + decide + 50 branches
  });

  it('spec serializes correctly for large chain', () => {
    let builder: FlowChartBuilder = flowChart('s0', noop);
    for (let i = 1; i < 50; i++) {
      builder = builder.addFunction(`s${i}`, noop);
    }
    const spec = builder.toSpec();

    // Walk spec chain
    let count = 0;
    let s = spec;
    while (s) { count++; s = s.next as any; }
    expect(count).toBe(50);
  });

  it('mermaid output works for large chain', () => {
    let builder: FlowChartBuilder = flowChart('s0', noop);
    for (let i = 1; i < 30; i++) {
      builder = builder.addFunction(`s${i}`, noop);
    }
    const mermaid = builder.toMermaid();

    expect(mermaid).toContain('flowchart TD');
    expect(mermaid).toContain('s0 --> s1');
    expect(mermaid).toContain('s28 --> s29');
  });

  it('handles 10 mounted subflows', () => {
    const sub = flowChart('subStep', noop).build();

    let builder = flowChart('main', noop);
    for (let i = 0; i < 10; i++) {
      builder = builder.addSubFlowChart(`sf${i}`, sub, `Sub${i}`);
    }
    const chart = builder.build();

    expect(chart.root.children).toHaveLength(10);
    expect(Object.keys(chart.subflows!)).toHaveLength(10);
  });
});
