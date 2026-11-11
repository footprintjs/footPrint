import { flowChart, FlowChartBuilder } from '../../../../src/lib/builder';

const noop = async () => {};

describe('Boundary: error conditions', () => {
  it('build without start throws', () => {
    expect(() => new FlowChartBuilder().build()).toThrow('empty tree');
  });

  it('toSpec without start throws', () => {
    expect(() => new FlowChartBuilder().toSpec()).toThrow('empty tree');
  });

  it('toMermaid without start throws', () => {
    expect(() => new FlowChartBuilder().toMermaid()).toThrow('empty tree');
  });

  it('double start throws', () => {
    expect(() => {
      new FlowChartBuilder().start('a', noop, 'a').start('b', noop, 'b');
    }).toThrow('root already defined');
  });

  it('addFunction without start throws', () => {
    expect(() => {
      new FlowChartBuilder().addFunction('a', noop, 'a');
    }).toThrow('cursor undefined');
  });

  describe("a stage after loopTo() is refused: the loop is the path's continuation", () => {
    const sub = () => flowChart('s', noop, 's').build();
    const looped = () => flowChart('a', noop, 'a').addFunction('b', noop, 'b').loopTo('a');
    const continuation = /after loopTo\('a'\) at 'b': the loop is this path's continuation/;
    const doors: Array<[string, () => unknown]> = [
      ['addFunction', () => looped().addFunction('c', noop, 'c')],
      ['addStreamingFunction', () => looped().addStreamingFunction('c', noop, 'c')],
      ['addPausableFunction', () => looped().addPausableFunction('c', { execute: noop, resume: noop }, 'c')],
      ['addDeciderFunction', () => looped().addDeciderFunction('c', () => 'x', 'c')],
      ['addSelectorFunction', () => looped().addSelectorFunction('c', () => ['x'], 'c')],
      [
        'addParallelForEach',
        () => looped().addParallelForEach('c', 'c', { items: () => [], branch: () => sub(), into: 'out' }),
      ],
      ['addSubFlowChartNext', () => looped().addSubFlowChartNext('c', sub())],
      ['addLazySubFlowChartNext', () => looped().addLazySubFlowChartNext('c', sub)],
    ];
    it.each(doors)('%s', (door, attach) => {
      expect(attach).toThrow(new RegExp(`${door}\\('c'\\) ` + continuation.source));
    });

    it("a fan-out after a looping mount (it would need a fork node at the mount's next)", () => {
      expect(() =>
        flowChart('a', noop, 'a')
          .addSubFlowChartNext('m', sub())
          .loopTo('a')
          .addListOfFunction([{ id: 'c', name: 'C', fn: noop }]),
      ).toThrow(/addListOfFunction\(\) after loopTo\('a'\) at 'm'/);
    });

    it('what attaches no continuation is unchanged: fork children, modifiers, a sibling branch, end(), build()', () => {
      const forked = looped()
        .tag('t')
        .addListOfFunction([{ id: 'c', name: 'C', fn: noop }])
        .build();
      expect(forked.root.next?.next?.isLoopRef).toBe(true);
      expect(forked.root.next?.children?.map((c) => c.id)).toEqual(['c']);

      const branched = flowChart('a', noop, 'a')
        .addDeciderFunction('D', () => 'x', 'd')
        .addFunctionBranch('x', 'X', noop)
        .loopTo('a')
        .addFunctionBranch('y', 'Y', noop)
        .end()
        .addFunction('after', noop, 'after')
        .build();
      expect(branched.root.next?.children?.[0].next?.isLoopRef).toBe(true);
      expect(branched.root.next?.next?.id).toBe('after');
    });
  });

  describe('build() seals the builder', () => {
    const sealed = /builder sealed by build\(\) — chart 'a' is already built/;
    const sub = () => flowChart('s', noop, 's').build();

    it('a door that would change the built chart refuses, and the chart is untouched', () => {
      const builder = flowChart('a', noop, 'a').addFunction('b', noop, 'b');
      const chart = builder.build();
      const doors: Array<() => unknown> = [
        () => builder.addFunction('late', noop, 'late'),
        () => builder.addStreamingFunction('late', noop, 'late'),
        () => builder.addPausableFunction('late', { execute: noop, resume: noop }, 'late'),
        () => builder.addDeciderFunction('late', () => 'x', 'late'),
        () => builder.addSelectorFunction('late', () => ['x'], 'late'),
        () => builder.addListOfFunction([{ id: 'late', name: 'Late', fn: noop }]),
        () => builder.addParallelForEach('late', 'late', { items: () => [], branch: () => sub(), into: 'out' }),
        () => builder.addSubFlowChart('late', sub()),
        () => builder.addSubFlowChartNext('late', sub()),
        () => builder.addLazySubFlowChart('late', sub),
        () => builder.addLazySubFlowChartNext('late', sub),
        () => builder.retry({ attempts: 2 }),
        () => builder.tag('t'),
        () => builder.touches('db', { idempotencyKey: 'k' }),
        () => builder.loopTo('a'),
        () => builder.start('late', noop, 'late'),
        () => builder.startSelector('late', () => ['x'], 'late'),
        () => builder.setLogger(console),
        () => builder.contract({ input: {} }),
        () => builder.setScopeFactory(() => ({})),
        () => builder.onStream(noop),
      ];
      for (const door of doors) expect(door).toThrow(sealed);
      expect(chart.root.next?.id).toBe('b');
      expect(chart.root.next?.next).toBeUndefined();
      expect(chart.root.next?.retry).toBeUndefined();
      expect(chart.stageMap.has('late')).toBe(false);
      expect(chart.buildTimeStructure.next?.next).toBeUndefined();
    });

    it('a branch list held past build() refuses too', () => {
      const list = flowChart('a', noop, 'a')
        .addDeciderFunction('D', () => 'x', 'd')
        .addFunctionBranch('x', 'X', noop);
      list.end().build();
      expect(() => list.addFunctionBranch('y', 'Y', noop)).toThrow(sealed);
      expect(() => list.setDefault('x')).toThrow(sealed);
    });

    it('build() again and the read-only doors keep working', () => {
      const builder = flowChart('a', noop, 'a').addFunction('b', noop, 'b');
      const first = builder.build();
      const second = builder.build();
      expect(second.root).toBe(first.root);
      expect(builder.toSpec<{ id: string }>().id).toBe('a');
      expect(builder.toMermaid()).toContain('b');
      expect(second.description).toBe(first.description);
    });
  });

  it('double loopTo throws', () => {
    expect(() => {
      flowChart('a', noop, 'a').addFunction('b', noop, 'b').loopTo('a').loopTo('a');
    }).toThrow();
  });

  it('parallel child without id throws', () => {
    expect(() => {
      flowChart('a', noop, 'a').addListOfFunction([{ id: '', name: 'X', fn: noop }]);
    }).toThrow('child id required');
  });

  it('empty decider branches throws', () => {
    expect(() => {
      flowChart('a', noop, 'a').addDeciderFunction('d', noop, 'd').end();
    }).toThrow('at least one branch');
  });

  it('empty selector branches throws', () => {
    expect(() => {
      flowChart('a', noop, 'a').addSelectorFunction('pick', noop, 'pick').end();
    }).toThrow('at least one branch');
  });
});

/**
 * A dispatcher is defined once (`BranchCursor · assertOpen`). A list held past
 * `.end()` used to re-open its node: a second `end()` appended a second
 * `'default'` clone, fired `onDeciderComplete` twice and wrote the description
 * line twice; a late branch was attached but missing from `branchIds`.
 */
describe('Boundary: a closed dispatcher cannot be re-opened', () => {
  const openDecider = () =>
    flowChart('a', noop, 'a')
      .addDeciderFunction('D', noop, 'd')
      .addFunctionBranch('y', 'Y', noop)
      .addFunctionBranch('n', 'N', noop)
      .setDefault('n');
  const openSelector = () =>
    flowChart('a', noop, 'a').addSelectorFunction('S', noop, 's').addFunctionBranch('y', 'Y', noop);

  it('a second end() on a decider is refused, and the chart keeps one default clone and one completion', () => {
    const completions: string[] = [];
    const list = flowChart('a', noop, 'a')
      .attachStructureRecorder({ id: 'spy', onDeciderComplete: (e) => completions.push(e.decider) })
      .addDeciderFunction('D', noop, 'd')
      .addFunctionBranch('y', 'Y', noop)
      .setDefault('y');
    const builder = list.end();

    expect(() => list.end()).toThrow("cannot call end() again: decider 'D' was already closed by end()");
    const chart = builder.build();
    expect(chart.root.next!.children!.map((c) => c.id)).toEqual(['y', 'default']);
    expect(completions).toEqual(['d']);
    expect(chart.description.match(/D — /g)).toHaveLength(1);
  });

  it('a second end() on a selector is refused', () => {
    const list = openSelector();
    list.end();
    expect(() => list.end()).toThrow("cannot call end() again: selector 'S' was already closed by end()");
  });

  it.each([
    ['addFunctionBranch', (l: ReturnType<typeof openDecider>) => l.addFunctionBranch('late', 'Late', noop)],
    [
      'addPausableFunctionBranch',
      (l: ReturnType<typeof openDecider>) =>
        l.addPausableFunctionBranch('late', 'Late', { execute: noop, resume: noop }),
    ],
    ['addSubFlowChartBranch', (l: ReturnType<typeof openDecider>) => l.addSubFlowChartBranch('late', subflow())],
    [
      'addLazySubFlowChartBranch',
      (l: ReturnType<typeof openDecider>) => l.addLazySubFlowChartBranch('late', () => subflow()),
    ],
    ['addBranchList', (l: ReturnType<typeof openDecider>) => l.addBranchList([{ id: 'late', name: 'Late', fn: noop }])],
  ])('a decider branch added after end() through %s is refused', (_door, add) => {
    const list = openDecider();
    const chart = list.end();
    expect(() => add(list)).toThrow("cannot add branch 'late': decider 'D' was already closed by end()");
    expect(chart.build().buildTimeStructure.next!.branchIds).toEqual(['y', 'n']);
  });

  it('a selector branch added after end() is refused', () => {
    const list = openSelector();
    list.end();
    expect(() => list.addFunctionBranch('late', 'Late', noop)).toThrow(
      "cannot add branch 'late': selector 'S' was already closed by end()",
    );
  });

  it('setDefault and loopTo after end() are refused', () => {
    const list = openDecider();
    list.end();
    expect(() => list.setDefault('y')).toThrow("cannot setDefault('y'): decider 'D' was already closed by end()");
    expect(() => list.loopTo('a')).toThrow("cannot loopTo('a'): decider 'D' was already closed by end()");
  });
});

const subflow = () => flowChart('Inner', noop, 'inner').build();
