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
