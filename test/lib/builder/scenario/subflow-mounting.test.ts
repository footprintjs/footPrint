import { flowChart } from '../../../../src/lib/builder';

const noop = async () => {};

describe('Scenario: subflow mounting', () => {
  const buildSubflow = () =>
    flowChart('sub-start', noop)
      .addFunction('sub-end', noop)
      .build();

  it('mounts subflow as parallel child via addSubFlowChart', () => {
    const sub = buildSubflow();
    const chart = flowChart('main', noop)
      .addSubFlowChart('child1', sub, 'ChildFlow')
      .build();

    expect(chart.root.children).toHaveLength(1);
    expect(chart.root.children![0].isSubflowRoot).toBe(true);
    expect(chart.root.children![0].subflowId).toBe('child1');
    expect(chart.root.children![0].subflowName).toBe('ChildFlow');
  });

  it('mounts subflow as next via addSubFlowChartNext', () => {
    const sub = buildSubflow();
    const chart = flowChart('main', noop)
      .addSubFlowChartNext('child1', sub, 'ChildFlow')
      .build();

    expect(chart.root.next!.isSubflowRoot).toBe(true);
    expect(chart.root.next!.subflowId).toBe('child1');
  });

  it('prefixes subflow stage names with subflow id', () => {
    const sub = buildSubflow();
    const chart = flowChart('main', noop)
      .addSubFlowChart('sf', sub)
      .build();

    expect(chart.stageMap.has('sf/sub-start')).toBe(true);
    expect(chart.stageMap.has('sf/sub-end')).toBe(true);
  });

  it('records subflow definitions', () => {
    const sub = buildSubflow();
    const chart = flowChart('main', noop)
      .addSubFlowChart('sf', sub)
      .build();

    expect(chart.subflows).toBeDefined();
    expect(chart.subflows!['sf']).toBeDefined();
    expect(chart.subflows!['sf'].root.name).toContain('sf/');
  });

  it('spec includes subflowStructure', () => {
    const sub = buildSubflow();
    const spec = flowChart('main', noop)
      .addSubFlowChart('sf', sub, 'Sub')
      .toSpec();

    expect(spec.children![0].subflowStructure).toBeDefined();
    expect(spec.children![0].subflowStructure!.name).toBe('sub-start');
  });

  it('throws on duplicate subflow child id', () => {
    const sub = buildSubflow();
    expect(() => {
      flowChart('main', noop)
        .addSubFlowChart('sf', sub)
        .addSubFlowChart('sf', sub);
    }).toThrow('duplicate child id');
  });

  it('nested subflows get doubly prefixed', () => {
    const inner = flowChart('inner', noop).build();
    const outer = flowChart('outer', noop)
      .addSubFlowChart('inn', inner)
      .build();
    const top = flowChart('top', noop)
      .addSubFlowChart('out', outer)
      .build();

    expect(top.stageMap.has('out/outer')).toBe(true);
    expect(top.subflows!['out']).toBeDefined();
  });

  it('subflow mount options are preserved', () => {
    const sub = buildSubflow();
    const opts = { isolateScope: true };
    const chart = flowChart('main', noop)
      .addSubFlowChart('sf', sub, 'Sub', opts)
      .build();

    expect(chart.root.children![0].subflowMountOptions).toEqual(opts);
  });
});
