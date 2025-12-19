import { flowChart } from '../../../../src/lib/builder';

const noop = async () => {};

describe('Scenario: decider branching', () => {
  it('builds input → decider → {approve, reject} → output', () => {
    const deciderFn = async () => {};
    const chart = flowChart('input', noop)
      .addDeciderFunction('decide', deciderFn)
        .addFunctionBranch('approve', 'Approve', noop)
        .addFunctionBranch('reject', 'Reject', noop)
      .end()
      .addFunction('output', noop)
      .build();

    const decider = chart.root.next!;
    expect(decider.name).toBe('decide');
    expect(decider.deciderFn).toBe(true);
    expect(decider.children).toHaveLength(2);
    expect(decider.children![0].name).toBe('Approve');
    expect(decider.children![1].name).toBe('Reject');
    expect(decider.next!.name).toBe('output');
  });

  it('spec has hasDecider and branch types', () => {
    const spec = flowChart('input', noop)
      .addDeciderFunction('decide', noop)
        .addFunctionBranch('a', 'A', noop)
        .addFunctionBranch('b', 'B', noop)
      .end()
      .toSpec();

    expect(spec.next!.hasDecider).toBe(true);
    expect(spec.next!.type).toBe('decider');
    expect(spec.next!.branchIds).toContain('a');
    expect(spec.next!.branchIds).toContain('b');
  });

  it('default branch adds a "default" alias child', () => {
    const chart = flowChart('input', noop)
      .addDeciderFunction('decide', noop)
        .addFunctionBranch('yes', 'Yes', noop)
        .addFunctionBranch('no', 'No', noop)
        .setDefault('yes')
      .end()
      .build();

    const decider = chart.root.next!;
    // Original 2 branches + 1 default alias
    expect(decider.children).toHaveLength(3);
    expect(decider.children![2].id).toBe('default');
  });

  it('decider and selector are mutually exclusive', () => {
    expect(() => {
      flowChart('input', noop)
        .addDeciderFunction('decide', noop)
          .addFunctionBranch('a', 'A', noop)
        .end()
        .addSelectorFunction('pick', noop);
    }).toThrow('mutually exclusive');
  });

  it('stageMap contains decider + branch fns', () => {
    const decideFn = async () => {};
    const approveFn = async () => {};
    const chart = flowChart('input', noop)
      .addDeciderFunction('decide', decideFn)
        .addFunctionBranch('a', 'Approve', approveFn)
      .end()
      .build();

    expect(chart.stageMap.get('decide')).toBe(decideFn);
    expect(chart.stageMap.get('Approve')).toBe(approveFn);
  });
});
