import { flowChart } from '../../../../src/lib/builder';

const noop = async () => {};

describe('Scenario: linear chain', () => {
  it('builds A → B → C with correct next pointers', () => {
    const chart = flowChart('A', noop).addFunction('B', noop).addFunction('C', noop).build();

    expect(chart.root.name).toBe('A');
    expect(chart.root.next!.name).toBe('B');
    expect(chart.root.next!.next!.name).toBe('C');
    expect(chart.root.next!.next!.next).toBeUndefined();
  });

  it('spec mirrors the node chain', () => {
    const spec = flowChart('A', noop).addFunction('B', noop).addFunction('C', noop).toSpec();

    expect(spec.name).toBe('A');
    expect(spec.next!.name).toBe('B');
    expect(spec.next!.next!.name).toBe('C');
  });

  it('stageMap contains all three stages', () => {
    const fnA = async () => {};
    const fnB = async () => {};
    const fnC = async () => {};
    const chart = flowChart('A', fnA).addFunction('B', fnB).addFunction('C', fnC).build();

    expect(chart.stageMap.get('A')).toBe(fnA);
    expect(chart.stageMap.get('B')).toBe(fnB);
    expect(chart.stageMap.get('C')).toBe(fnC);
    expect(chart.stageMap.size).toBe(3);
  });

  it('description lists steps in order', () => {
    const chart = flowChart('A', noop).addFunction('B', noop).addFunction('C', noop).build();

    expect(chart.description).toContain('1. A');
    expect(chart.description).toContain('2. B');
    expect(chart.description).toContain('3. C');
  });

  it('mermaid output includes all edges', () => {
    const mermaid = flowChart('A', noop).addFunction('B', noop).addFunction('C', noop).toMermaid();

    expect(mermaid).toContain('A --> B');
    expect(mermaid).toContain('B --> C');
  });
});
