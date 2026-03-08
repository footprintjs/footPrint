/**
 * Additional coverage tests for FlowChartBuilder.ts
 *
 * Targets uncovered lines: 299-351, 377, 453, 778, 838, 869-870, 920-922, 972-973
 */
import { flowChart, FlowChartBuilder, SelectorFnList, specToStageNode } from '../../../../src/lib/builder';

const noop = async () => {};

// ─────────────────────────────────────────────────────────────────────────────
// specToStageNode — deeper spec shapes
// ─────────────────────────────────────────────────────────────────────────────

describe('specToStageNode (extended)', () => {
  it('handles nested children recursively', () => {
    const spec = {
      name: 'root',
      children: [
        {
          name: 'child1',
          id: 'c1',
          children: [{ name: 'grandchild', id: 'gc' }],
        },
        { name: 'child2', id: 'c2' },
      ],
    };
    const node = specToStageNode(spec);
    expect(node.children).toHaveLength(2);
    expect(node.children![0].children).toHaveLength(1);
    expect(node.children![0].children![0].name).toBe('grandchild');
    expect(node.children![0].children![0].id).toBe('gc');
  });

  it('handles deeply chained next nodes', () => {
    const spec = {
      name: 'a',
      next: { name: 'b', next: { name: 'c', next: { name: 'd' } } },
    };
    const node = specToStageNode(spec);
    expect(node.next!.next!.next!.name).toBe('d');
  });

  it('handles mixed children and next', () => {
    const spec = {
      name: 'root',
      id: 'r',
      children: [{ name: 'branch1', id: 'b1' }],
      next: {
        name: 'continuation',
        children: [{ name: 'sub', id: 's' }],
      },
    };
    const node = specToStageNode(spec);
    expect(node.id).toBe('r');
    expect(node.children![0].name).toBe('branch1');
    expect(node.next!.name).toBe('continuation');
    expect(node.next!.children![0].name).toBe('sub');
  });

  it('handles empty children array as undefined', () => {
    const spec = { name: 'solo', children: [] };
    const node = specToStageNode(spec);
    expect(node.children).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SelectorFnList.addSubFlowChartBranch (lines 299-337)
// ─────────────────────────────────────────────────────────────────────────────

describe('SelectorFnList.addSubFlowChartBranch', () => {
  const buildSubflow = () => flowChart('sub-start', noop).addFunction('sub-end', noop).build();

  it('mounts a subflow as a selector branch', () => {
    const sub = buildSubflow();
    const chart = flowChart('entry', noop)
      .addSelectorFunction('Pick', async () => 'sf' as any)
      .addSubFlowChartBranch('sf', sub, 'SubFlow')
      .end()
      .build();

    const selector = chart.root.next!;
    expect(selector.selectorFn).toBe(true);
    expect(selector.children).toHaveLength(1);
    expect(selector.children![0].isSubflowRoot).toBe(true);
    expect(selector.children![0].subflowId).toBe('sf');
    expect(selector.children![0].subflowName).toBe('SubFlow');
  });

  it('defaults subflowName to id when mountName is not provided', () => {
    const sub = buildSubflow();
    const chart = flowChart('entry', noop)
      .addSelectorFunction('Pick', async () => 'sf' as any)
      .addSubFlowChartBranch('sf', sub)
      .end()
      .build();

    expect(chart.root.next!.children![0].subflowName).toBe('sf');
  });

  it('registers subflow definitions', () => {
    const sub = buildSubflow();
    const chart = flowChart('entry', noop)
      .addSelectorFunction('Pick', async () => 'sf' as any)
      .addSubFlowChartBranch('sf', sub)
      .end()
      .build();

    expect(chart.subflows).toBeDefined();
    expect(chart.subflows!.sf).toBeDefined();
  });

  it('merges subflow stageMap with prefix', () => {
    const sub = buildSubflow();
    const chart = flowChart('entry', noop)
      .addSelectorFunction('Pick', async () => 'sf' as any)
      .addSubFlowChartBranch('sf', sub)
      .end()
      .build();

    expect(chart.stageMap.has('sf/sub-start')).toBe(true);
    expect(chart.stageMap.has('sf/sub-end')).toBe(true);
  });

  it('preserves mount options on subflow branch', () => {
    const sub = buildSubflow();
    const opts = { isolateScope: true };
    const chart = flowChart('entry', noop)
      .addSelectorFunction('Pick', async () => 'sf' as any)
      .addSubFlowChartBranch('sf', sub, 'SubFlow', opts)
      .end()
      .build();

    expect(chart.root.next!.children![0].subflowMountOptions).toEqual(opts);
  });

  it('throws on duplicate selector subflow branch id', () => {
    const sub = buildSubflow();
    expect(() => {
      flowChart('entry', noop)
        .addSelectorFunction('Pick', async () => 'sf' as any)
        .addSubFlowChartBranch('sf', sub)
        .addSubFlowChartBranch('sf', sub);
    }).toThrow('duplicate selector branch');
  });

  it('spec includes subflowStructure for selector subflow branch', () => {
    const sub = buildSubflow();
    const spec = flowChart('entry', noop)
      .addSelectorFunction('Pick', async () => 'sf' as any)
      .addSubFlowChartBranch('sf', sub, 'SubFlow')
      .end()
      .toSpec();

    const selectorSpec = spec.next!;
    expect(selectorSpec.children![0].subflowStructure).toBeDefined();
    expect(selectorSpec.children![0].isSubflowRoot).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SelectorFnList.addBranchList (lines 340-352)
// ─────────────────────────────────────────────────────────────────────────────

describe('SelectorFnList.addBranchList', () => {
  it('adds multiple branches via addBranchList', () => {
    const chart = flowChart('entry', noop)
      .addSelectorFunction('Pick', async () => ['a', 'b'] as any)
      .addBranchList([
        { id: 'a', name: 'A', fn: noop },
        { id: 'b', name: 'B', fn: noop },
        { id: 'c', name: 'C', fn: noop },
      ])
      .end()
      .build();

    const selector = chart.root.next!;
    expect(selector.children).toHaveLength(3);
    expect(selector.children![0].id).toBe('a');
    expect(selector.children![1].id).toBe('b');
    expect(selector.children![2].id).toBe('c');
  });

  it('registers all branch fns in stageMap via addBranchList', () => {
    const fnA = async () => {};
    const fnB = async () => {};
    const chart = flowChart('entry', noop)
      .addSelectorFunction('Pick', async () => 'a' as any)
      .addBranchList([
        { id: 'a', name: 'BranchA', fn: fnA },
        { id: 'b', name: 'BranchB', fn: fnB },
      ])
      .end()
      .build();

    expect(chart.stageMap.get('BranchA')).toBe(fnA);
    expect(chart.stageMap.get('BranchB')).toBe(fnB);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SelectorFnList.end() with description (line 377)
// ─────────────────────────────────────────────────────────────────────────────

describe('SelectorFnList description generation', () => {
  it('includes selector description in output when provided', () => {
    const chart = flowChart('entry', noop)
      .addSelectorFunction('PickChannels', async () => ['email'] as any, undefined, 'selects notification channels')
      .addFunctionBranch('email', 'SendEmail', noop, 'sends via email')
      .addFunctionBranch('sms', 'SendSMS', noop, 'sends via sms')
      .end()
      .build();

    expect(chart.description).toContain('selects notification channels');
    expect(chart.description).toContain('sends via email');
    expect(chart.stageDescriptions.get('PickChannels')).toBe('selects notification channels');
    expect(chart.stageDescriptions.get('email')).toBe('sends via email');
  });

  it('generates default selector description when no description provided', () => {
    const chart = flowChart('entry', noop)
      .addSelectorFunction('PickChannels', async () => ['email'] as any)
      .addFunctionBranch('email', 'SendEmail', noop)
      .addFunctionBranch('sms', 'SendSMS', noop)
      .end()
      .build();

    expect(chart.description).toContain('Selects from: email, sms');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// _appendSubflowDescription — subflow without description (line 453)
// ─────────────────────────────────────────────────────────────────────────────

describe('subflow description', () => {
  it('generates description for subflow without its own description (line 453)', () => {
    // Build a subflow with empty description by overriding it
    const sub = new FlowChartBuilder().start('sub-a').build();
    // Force description to be empty to hit line 453
    (sub as any).description = '';

    const chart = flowChart('main', noop).addSubFlowChart('sf', sub, 'SubName').build();

    expect(chart.description).toContain('[Sub-Execution: SubName]');
    // Line 453: no description means no " — " suffix
    expect(chart.description).not.toContain('[Sub-Execution: SubName] —');
  });

  it('includes subflow steps in parent description when subflow has description', () => {
    const sub = flowChart('SubStart', noop, undefined, undefined, 'initializes sub')
      .addFunction('SubEnd', noop, undefined, 'finishes sub')
      .build();

    const chart = flowChart('main', noop).addSubFlowChart('sf', sub, 'MySub').build();

    expect(chart.description).toContain('[Sub-Execution: MySub]');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// addSubFlowChartNext — error when next already defined (line 778)
// ─────────────────────────────────────────────────────────────────────────────

describe('addSubFlowChartNext edge cases', () => {
  it('throws when next is already defined', () => {
    const sub = flowChart('sub', noop).build();
    expect(() => {
      flowChart('main', noop)
        .addFunction('middle', noop)
        .addFunction('another', noop) // sets next on 'middle'
        // cursor is now at 'another', which has no next, so we chain more
        .addSubFlowChartNext('sf', sub);
      // Actually the above won't error. Let me trigger it properly.
    }).not.toThrow();

    // To trigger line 778, we need cursor.next to already be defined
    // This happens if we try addSubFlowChartNext after addFunction on the same cursor
    // But addFunction moves the cursor. Let's use loopTo which sets next.
    expect(() => {
      flowChart('main', noop, 'main').addFunction('step', noop, 'step').loopTo('main').addSubFlowChartNext('sf', sub);
    }).toThrow('cannot add subflow as next when next is already defined');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// loopTo — target stage not found in step map (line 838)
// ─────────────────────────────────────────────────────────────────────────────

describe('loopTo with unknown target', () => {
  it('uses stage id as fallback when target not in step map', () => {
    // loopTo a stageId that was never registered (not added via start/addFunction)
    const chart = flowChart('main', noop, 'main').addFunction('step', noop, 'step').loopTo('unknown-stage').build();

    expect(chart.description).toContain('loops back to unknown-stage');
    expect(chart.description).not.toContain('loops back to step');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// addBuildTimeExtractor (lines 869-870)
// ─────────────────────────────────────────────────────────────────────────────

describe('addBuildTimeExtractor', () => {
  it('sets build-time extractor via fluent method', () => {
    const extractor = (node: any) => ({ ...node, enriched: true });
    const chart = new FlowChartBuilder()
      .addBuildTimeExtractor(extractor)
      .start('a', noop)
      .addFunction('b', noop)
      .build();

    expect((chart.buildTimeStructure as any).enriched).toBe(true);
    expect((chart.buildTimeStructure.next as any).enriched).toBe(true);
  });

  it('overrides previously set build-time extractor', () => {
    const ext1 = (node: any) => ({ ...node, first: true });
    const ext2 = (node: any) => ({ ...node, second: true });
    const chart = new FlowChartBuilder()
      .addBuildTimeExtractor(ext1)
      .addBuildTimeExtractor(ext2)
      .start('a', noop)
      .build();

    expect((chart.buildTimeStructure as any).second).toBe(true);
    expect((chart.buildTimeStructure as any).first).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// addListOfFunction (lines 665-707)
// ─────────────────────────────────────────────────────────────────────────────

describe('addListOfFunction', () => {
  it('creates parallel children on current node', () => {
    const chart = flowChart('fork', noop, 'fork')
      .addListOfFunction([
        { id: 'a', name: 'TaskA', fn: noop },
        { id: 'b', name: 'TaskB', fn: noop },
      ])
      .build();

    expect(chart.root.children).toHaveLength(2);
    expect(chart.root.children![0].id).toBe('a');
    expect(chart.root.children![0].name).toBe('TaskA');
    expect(chart.root.children![1].id).toBe('b');
  });

  it('sets spec type to fork', () => {
    const spec = flowChart('fork', noop, 'fork')
      .addListOfFunction([{ id: 'a', name: 'TaskA', fn: noop }])
      .toSpec();

    expect(spec.type).toBe('fork');
    expect(spec.children).toHaveLength(1);
    expect(spec.children![0].isParallelChild).toBe(true);
    expect(spec.children![0].parallelGroupId).toBe('fork');
  });

  it('registers fns in stageMap', () => {
    const fnA = async () => {};
    const fnB = async () => {};
    const chart = flowChart('fork', noop)
      .addListOfFunction([
        { id: 'a', name: 'TaskA', fn: fnA },
        { id: 'b', name: 'TaskB', fn: fnB },
      ])
      .build();

    expect(chart.stageMap.get('TaskA')).toBe(fnA);
    expect(chart.stageMap.get('TaskB')).toBe(fnB);
  });

  it('throws on missing child id', () => {
    expect(() => {
      flowChart('fork', noop).addListOfFunction([{ id: '', name: 'TaskA', fn: noop }]);
    }).toThrow('child id required');
  });

  it('throws on duplicate child id', () => {
    expect(() => {
      flowChart('fork', noop).addListOfFunction([
        { id: 'a', name: 'TaskA', fn: noop },
        { id: 'a', name: 'TaskB', fn: noop },
      ]);
    }).toThrow('duplicate child id');
  });

  it('includes parallel children in description', () => {
    const chart = flowChart('fork', noop)
      .addListOfFunction([
        { id: 'a', name: 'Task A', fn: noop },
        { id: 'b', name: 'TaskB', fn: noop },
      ])
      .build();

    expect(chart.description).toContain('Runs in parallel');
    expect(chart.description).toContain('Task A');
    expect(chart.description).toContain('TaskB');
  });

  it('works without fn on children', () => {
    const chart = flowChart('fork', noop)
      .addListOfFunction([
        { id: 'a', name: 'TaskA' },
        { id: 'b', name: 'TaskB' },
      ])
      .build();

    expect(chart.root.children).toHaveLength(2);
    expect(chart.root.children![0].fn).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// toMermaid with children (lines 920-922)
// ─────────────────────────────────────────────────────────────────────────────

describe('toMermaid with children', () => {
  it('renders children edges in mermaid output', () => {
    const mermaid = flowChart('entry', noop)
      .addDeciderFunction('Router', async () => 'a', 'router')
      .addFunctionBranch('a', 'BranchA', noop)
      .addFunctionBranch('b', 'BranchB', noop)
      .end()
      .toMermaid();

    expect(mermaid).toContain('flowchart TD');
    expect(mermaid).toContain('router --> a');
    expect(mermaid).toContain('router --> b');
    expect(mermaid).toContain('a["BranchA"]');
    expect(mermaid).toContain('b["BranchB"]');
  });

  it('renders parallel children in mermaid', () => {
    const mermaid = flowChart('fork', noop, 'fork')
      .addListOfFunction([
        { id: 'x', name: 'X', fn: noop },
        { id: 'y', name: 'Y', fn: noop },
      ])
      .toMermaid();

    expect(mermaid).toContain('fork --> x');
    expect(mermaid).toContain('fork --> y');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// _mergeStageMap collision (lines 972-973)
// ─────────────────────────────────────────────────────────────────────────────

describe('stageMap collision during subflow merge', () => {
  it('merges fine with different prefixes', () => {
    const fn1 = async () => 'one';
    const fn2 = async () => 'two';
    const subA = flowChart('step', fn1).build();
    const subB = flowChart('step', fn2).build();

    const chart = flowChart('main', noop)
      .addDeciderFunction('Router', async () => 'a')
      .addSubFlowChartBranch('branchA', subA, 'SubA')
      .addSubFlowChartBranch('branchB', subB, 'SubB')
      .end()
      .build();

    expect(chart.stageMap.has('branchA/step')).toBe(true);
    expect(chart.stageMap.has('branchB/step')).toBe(true);
  });

  it('throws on conflicting fn during subflow merge (lines 972-973)', () => {
    const fn1 = async () => 'one';
    const fn2 = async () => 'two';
    const sub1 = flowChart('step', fn1).build();
    const sub2 = flowChart('step', fn2).build();

    // Use the internal _mergeStageMap directly to trigger the collision
    const builder = new FlowChartBuilder();
    builder.start('main', noop);
    // First merge registers "pfx/step" -> fn1
    builder._mergeStageMap(sub1.stageMap, 'pfx');
    // Second merge with same prefix but different fn -> collision
    expect(() => {
      builder._mergeStageMap(sub2.stageMap, 'pfx');
    }).toThrow('stageMap collision while mounting flowchart');
  });
});
