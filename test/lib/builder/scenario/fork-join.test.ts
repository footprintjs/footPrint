import { flowChart } from '../../../../src/lib/builder';

const noop = async () => {};

describe('Scenario: fork (parallel children)', () => {
  it('adds parallel children under a fork node', () => {
    const chart = flowChart('start', noop, 'start')
      .addListOfFunction([
        { id: 'p1', name: 'Worker1', fn: noop },
        { id: 'p2', name: 'Worker2', fn: noop },
        { id: 'p3', name: 'Worker3', fn: noop },
      ])
      .build();

    expect(chart.root.children).toHaveLength(3);
    expect(chart.root.children![0].name).toBe('Worker1');
    expect(chart.root.children![1].name).toBe('Worker2');
    expect(chart.root.children![2].name).toBe('Worker3');
  });

  it('spec marks type as fork with parallelGroupId', () => {
    const spec = flowChart('hub', noop, 'hub')
      .addListOfFunction([
        { id: 'a', name: 'A', fn: noop },
        { id: 'b', name: 'B', fn: noop },
      ])
      .toSpec();

    expect(spec.type).toBe('fork');
    expect(spec.children).toHaveLength(2);
    expect(spec.children![0].isParallelChild).toBe(true);
    expect(spec.children![0].parallelGroupId).toBe('hub');
  });

  it('registers all children in stageMap', () => {
    const fn1 = async () => {};
    const fn2 = async () => {};
    const chart = flowChart('hub', noop, 'hub')
      .addListOfFunction([
        { id: 'a', name: 'A', fn: fn1 },
        { id: 'b', name: 'B', fn: fn2 },
      ])
      .build();

    expect(chart.stageMap.get('A')).toBe(fn1);
    expect(chart.stageMap.get('B')).toBe(fn2);
  });

  it('throws on duplicate child id', () => {
    expect(() => {
      flowChart('hub', noop, 'hub').addListOfFunction([
        { id: 'dup', name: 'A', fn: noop },
        { id: 'dup', name: 'B', fn: noop },
      ]);
    }).toThrow('duplicate child id');
  });

  it('can chain after fork', () => {
    const chart = flowChart('start', noop, 'start')
      .addListOfFunction([{ id: 'p1', name: 'W1', fn: noop }])
      .addFunction('finish', noop, 'finish')
      .build();

    expect(chart.root.next!.name).toBe('finish');
  });
});
