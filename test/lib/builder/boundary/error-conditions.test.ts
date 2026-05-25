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
