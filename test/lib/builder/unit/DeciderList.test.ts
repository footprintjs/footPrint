import { flowChart } from '../../../../src/lib/builder';

const noop = async () => {};

describe('DeciderList (addDeciderFunction)', () => {
  it('creates decider node with branches', () => {
    const chart = flowChart('entry', noop, 'entry')
      .addDeciderFunction('Router', async () => 'a', 'router')
      .addFunctionBranch('a', 'BranchA', noop)
      .addFunctionBranch('b', 'BranchB', noop)
      .end()
      .build();

    const decider = chart.root.next!;
    expect(decider.name).toBe('Router');
    expect(decider.deciderFn).toBe(true);
    expect(decider.children).toHaveLength(2);
    expect(decider.children![0].id).toBe('a');
    expect(decider.children![1].id).toBe('b');
  });

  it('sets spec type to decider after end()', () => {
    const spec = flowChart('entry', noop, 'entry')
      .addDeciderFunction('Router', async () => 'a', 'router')
      .addFunctionBranch('a', 'A', noop)
      .end()
      .toSpec();

    expect(spec.next!.type).toBe('decider');
    expect(spec.next!.hasDecider).toBe(true);
    expect(spec.next!.branchIds).toContain('a');
  });

  it('registers branch fns in stageMap', () => {
    const branchFn = async () => {};
    const chart = flowChart('entry', noop, 'entry')
      .addDeciderFunction('Router', async () => 'a', 'router')
      .addFunctionBranch('a', 'BranchA', branchFn)
      .end()
      .build();

    expect(chart.stageMap.get('a')).toBe(branchFn);
  });

  it('throws on duplicate branch id', () => {
    expect(() => {
      flowChart('entry', noop, 'entry')
        .addDeciderFunction('Router', async () => 'a', 'router')
        .addFunctionBranch('a', 'A', noop)
        .addFunctionBranch('a', 'A2', noop);
    }).toThrow('duplicate decider branch');
  });

  it('throws if end() called with no branches', () => {
    expect(() => {
      flowChart('entry', noop, 'entry')
        .addDeciderFunction('Router', async () => 'a', 'router')
        .end();
    }).toThrow('requires at least one branch');
  });

  it('setDefault adds default alias', () => {
    const chart = flowChart('entry', noop, 'entry')
      .addDeciderFunction('Router', async () => 'a', 'router')
      .addFunctionBranch('a', 'A', noop)
      .addFunctionBranch('b', 'B', noop)
      .setDefault('b')
      .end()
      .build();

    const decider = chart.root.next!;
    const defaultChild = decider.children!.find((c) => c.id === 'default');
    expect(defaultChild).toBeDefined();
    expect(defaultChild!.name).toBe('B');
  });

  it('addBranchList adds multiple branches', () => {
    const chart = flowChart('entry', noop, 'entry')
      .addDeciderFunction('Router', async () => 'a', 'router')
      .addBranchList([
        { id: 'a', name: 'A', fn: noop },
        { id: 'b', name: 'B', fn: noop },
        { id: 'c', name: 'C', fn: noop },
      ])
      .end()
      .build();

    // 3 branches + no default = 3 children
    expect(chart.root.next!.children).toHaveLength(3);
  });

  it('continues building after end()', () => {
    const chart = flowChart('entry', noop, 'entry')
      .addDeciderFunction('Router', async () => 'a', 'router')
      .addFunctionBranch('a', 'A', noop)
      .end()
      .addFunction('cleanup', noop, 'cleanup')
      .build();

    expect(chart.root.next!.next?.name).toBe('cleanup');
  });

  it('includes branch descriptions', () => {
    const chart = flowChart('entry', noop, 'entry')
      .addDeciderFunction('Router', async () => 'fast', 'router', 'routes traffic')
      .addFunctionBranch('fast', 'FastPath', noop, 'handles express requests')
      .addFunctionBranch('slow', 'SlowPath', noop, 'handles standard requests')
      .end()
      .build();

    expect(chart.description).toContain('routes traffic');
    expect(chart.description).toContain('handles express requests');
    expect(chart.stageDescriptions.get('Router')).toBe('routes traffic');
    expect(chart.stageDescriptions.get('fast')).toBe('handles express requests');
  });
});
