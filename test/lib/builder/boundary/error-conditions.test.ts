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
      new FlowChartBuilder().start('a', noop).start('b', noop);
    }).toThrow('root already defined');
  });

  it('addFunction without start throws', () => {
    expect(() => {
      new FlowChartBuilder().addFunction('a', noop);
    }).toThrow('cursor undefined');
  });

  it('double loopTo throws', () => {
    expect(() => {
      flowChart('a', noop).addFunction('b', noop).loopTo('a').loopTo('a');
    }).toThrow();
  });

  it('parallel child without id throws', () => {
    expect(() => {
      flowChart('a', noop).addListOfFunction([{ id: '', name: 'X', fn: noop }]);
    }).toThrow('child id required');
  });

  it('empty decider branches throws', () => {
    expect(() => {
      flowChart('a', noop).addDeciderFunction('d', noop).end();
    }).toThrow('at least one branch');
  });

  it('empty selector branches throws', () => {
    expect(() => {
      flowChart('a', noop).addSelectorFunction('pick', noop).end();
    }).toThrow('at least one branch');
  });

  it('buildTimeExtractor errors are captured, not thrown', () => {
    const badExtractor = () => {
      throw new Error('extractor boom');
    };
    const builder = flowChart('a', noop, undefined, undefined, badExtractor).addFunction('b', noop);

    // Should not throw during build
    const chart = builder.build();
    expect(chart.root).toBeDefined();

    const errors = builder.getBuildTimeExtractorErrors();
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].message).toBe('extractor boom');
  });
});
