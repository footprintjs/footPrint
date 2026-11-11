import { flowChart } from '../../../../src/lib/builder';

const noop = async () => {};

describe('Scenario: subflow mounting', () => {
  const buildSubflow = () => flowChart('sub-start', noop, 'sub-start').addFunction('sub-end', noop, 'sub-end').build();

  it('mounts subflow as parallel child via addSubFlowChart', () => {
    const sub = buildSubflow();
    const chart = flowChart('main', noop, 'main').addSubFlowChart('child1', sub, 'ChildFlow').build();

    expect(chart.root.children).toHaveLength(1);
    expect(chart.root.children![0].isSubflowRoot).toBe(true);
    expect(chart.root.children![0].subflowId).toBe('child1');
    expect(chart.root.children![0].subflowName).toBe('ChildFlow');
  });

  it('mounts subflow as next via addSubFlowChartNext', () => {
    const sub = buildSubflow();
    const chart = flowChart('main', noop, 'main').addSubFlowChartNext('child1', sub, 'ChildFlow').build();

    expect(chart.root.next!.isSubflowRoot).toBe(true);
    expect(chart.root.next!.subflowId).toBe('child1');
  });

  it('prefixes subflow stage names with subflow id', () => {
    const sub = buildSubflow();
    const chart = flowChart('main', noop, 'main').addSubFlowChart('sf', sub).build();

    expect(chart.stageMap.has('sf/sub-start')).toBe(true);
    expect(chart.stageMap.has('sf/sub-end')).toBe(true);
  });

  it('records subflow definitions', () => {
    const sub = buildSubflow();
    const chart = flowChart('main', noop, 'main').addSubFlowChart('sf', sub).build();

    expect(chart.subflows).toBeDefined();
    expect(chart.subflows!.sf).toBeDefined();
    expect(chart.subflows!.sf.root.name).toContain('sf/');
  });

  it('spec includes subflowStructure', () => {
    const sub = buildSubflow();
    const spec = flowChart('main', noop, 'main').addSubFlowChart('sf', sub, 'Sub').toSpec();

    expect(spec.children![0].subflowStructure).toBeDefined();
    expect(spec.children![0].subflowStructure!.name).toBe('sub-start');
  });

  it('throws on duplicate subflow child id', () => {
    const sub = buildSubflow();
    expect(() => {
      flowChart('main', noop, 'main').addSubFlowChart('sf', sub).addSubFlowChart('sf', sub);
    }).toThrow('duplicate child id');
  });

  it('nested subflows get doubly prefixed', () => {
    const inner = flowChart('inner', noop, 'inner').build();
    const outer = flowChart('outer', noop, 'outer').addSubFlowChart('inn', inner).build();
    const top = flowChart('top', noop, 'top').addSubFlowChart('out', outer).build();

    expect(top.stageMap.has('out/outer')).toBe(true);
    expect(top.subflows!.out).toBeDefined();
  });

  it('subflow mount options are preserved', () => {
    const sub = buildSubflow();
    const opts = { isolateScope: true };
    const chart = flowChart('main', noop, 'main').addSubFlowChart('sf', sub, 'Sub', opts).build();

    expect(chart.root.children![0].subflowMountOptions).toEqual(opts);
  });

  describe('an eager mount may not take an id another stage holds', () => {
    const taken = /id 'dup' is already used by another stage or mount in this chart/;

    it('addSubFlowChartNext after a function stage with that id', () => {
      expect(() =>
        flowChart('main', noop, 'main').addFunction('A', noop, 'dup').addSubFlowChartNext('dup', buildSubflow()),
      ).toThrow(taken);
    });

    it('addSubFlowChart after a function stage with that id', () => {
      expect(() =>
        flowChart('main', noop, 'main').addFunction('A', noop, 'dup').addSubFlowChart('dup', buildSubflow()),
      ).toThrow(taken);
    });

    it('a decider subflow branch after a function stage with that id', () => {
      expect(() =>
        flowChart('main', noop, 'main')
          .addFunction('A', noop, 'dup')
          .addDeciderFunction('Route', () => 'dup', 'route')
          .addSubFlowChartBranch('dup', buildSubflow()),
      ).toThrow(taken);
    });

    it('after a functionless stage or a lazy mount with that id', () => {
      expect(() =>
        flowChart('main', noop, 'main')
          .addListOfFunction([{ id: 'dup', name: 'Dup' }])
          .addFunction('B', noop, 'b')
          .addSubFlowChartNext('dup', buildSubflow()),
      ).toThrow(taken);
      expect(() =>
        flowChart('main', noop, 'main')
          .addLazySubFlowChartNext('dup', () => buildSubflow())
          .addSubFlowChartNext('dup', buildSubflow()),
      ).toThrow(/id 'dup' is already used by/);
    });

    it('mounting a sub-flowchart again under its own id is still allowed', () => {
      const sub = buildSubflow();
      const chart = flowChart('main', noop, 'main')
        .addSubFlowChartNext('sf', sub, 'First')
        .addFunction('B', noop, 'b')
        .addSubFlowChartNext('sf', sub, 'Second')
        .build();
      expect(chart.root.next?.id).toBe('sf');
    });
  });
});
