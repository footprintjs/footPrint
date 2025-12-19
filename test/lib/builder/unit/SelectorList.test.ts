import { flowChart } from '../../../../src/lib/builder';

const noop = async () => {};

describe('SelectorFnList (addSelectorFunction)', () => {
  it('creates scope-based selector with selectorFn flag', () => {
    const chart = flowChart('entry', noop)
      .addSelectorFunction('PickChannels', async () => ['email', 'sms'] as any)
        .addFunctionBranch('email', 'SendEmail', noop)
        .addFunctionBranch('sms', 'SendSMS', noop)
      .end()
      .build();

    const selector = chart.root.next!;
    expect(selector.selectorFn).toBe(true);
    expect(selector.children).toHaveLength(2);
  });

  it('sets hasSelector in spec', () => {
    const spec = flowChart('entry', noop)
      .addSelectorFunction('Pick', async () => 'a' as any)
        .addFunctionBranch('a', 'A', noop)
      .end()
      .toSpec();

    expect(spec.next!.hasSelector).toBe(true);
    expect(spec.next!.type).toBe('decider');
  });

  it('sets branchIds in spec', () => {
    const spec = flowChart('entry', noop)
      .addSelectorFunction('Pick', async () => ['x'] as any)
        .addFunctionBranch('x', 'X', noop)
        .addFunctionBranch('y', 'Y', noop)
      .end()
      .toSpec();

    expect(spec.next!.branchIds).toContain('x');
    expect(spec.next!.branchIds).toContain('y');
  });

  it('registers selector fn in stageMap', () => {
    const selectorFn = async () => ['a'] as any;
    const chart = flowChart('entry', noop)
      .addSelectorFunction('Pick', selectorFn)
        .addFunctionBranch('a', 'A', noop)
      .end()
      .build();

    expect(chart.stageMap.get('Pick')).toBe(selectorFn);
  });

  it('throws on duplicate branch id', () => {
    expect(() => {
      flowChart('entry', noop)
        .addSelectorFunction('Pick', async () => 'a' as any)
          .addFunctionBranch('a', 'A', noop)
          .addFunctionBranch('a', 'A2', noop);
    }).toThrow('duplicate selector branch');
  });

  it('throws on empty branches', () => {
    expect(() => {
      flowChart('entry', noop)
        .addSelectorFunction('Pick', async () => [] as any)
      .end();
    }).toThrow('requires at least one branch');
  });

  it('continues building after end()', () => {
    const chart = flowChart('entry', noop)
      .addSelectorFunction('Pick', async () => 'a' as any)
        .addFunctionBranch('a', 'A', noop)
      .end()
      .addFunction('finish', noop)
      .build();

    expect(chart.root.next!.next?.name).toBe('finish');
  });
});
