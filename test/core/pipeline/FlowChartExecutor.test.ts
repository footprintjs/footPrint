/**
 * FlowChartExecutor.test.ts
 *
 * Unit tests for FlowChartExecutor class, FlowChart type, and flowChart() factory.
 * These tests validate the public API surface of the flowchart-executor-rename feature.
 *
 * **Feature: flowchart-executor-rename**
 * _Requirements: 1.2, 1.3, 1.4, 2.1, 2.2, 3.1, 3.2, 4.1, 7.1, 7.3, 7.4_
 */

import { FlowChartExecutor, FlowChart } from '../../../src/core/pipeline/FlowChartExecutor';
import { FlowChartBuilder, flowChart, BuiltFlow } from '../../../src/builder/FlowChartBuilder';
import { StageContext } from '../../../src/core/context/StageContext';
import { ScopeFactory } from '../../../src/core/context/types';

// Simple scope factory for testing
const testScopeFactory: ScopeFactory<StageContext> = (context: StageContext) => context;

describe('FlowChart Type', () => {
  /**
   * Task 1.3: Write unit tests for FlowChart type
   * _Requirements: 1.2, 1.4_
   */
  describe('type exports and shape', () => {
    it('FlowChart type is exported from FlowChartExecutor module', () => {
      // Type assertion - if this compiles, the type is exported
      const chart: FlowChart = {
        root: { name: 'test' },
        stageMap: new Map(),
      };
      expect(chart).toBeDefined();
    });

    it('FlowChart has required root property', () => {
      const chart: FlowChart = {
        root: { name: 'entry', id: 'entry-id' },
        stageMap: new Map(),
      };
      expect(chart.root).toBeDefined();
      expect(chart.root.name).toBe('entry');
      expect(chart.root.id).toBe('entry-id');
    });

    it('FlowChart has required stageMap property', () => {
      const fn = () => 'output';
      const chart: FlowChart = {
        root: { name: 'entry', fn },
        stageMap: new Map([['entry', fn]]),
      };
      expect(chart.stageMap).toBeInstanceOf(Map);
      expect(chart.stageMap.size).toBe(1);
      expect(chart.stageMap.get('entry')).toBe(fn);
    });

    it('FlowChart has optional extractor property', () => {
      const extractor = (snapshot: any) => ({ name: snapshot.node.name });
      const chart: FlowChart = {
        root: { name: 'entry' },
        stageMap: new Map(),
        extractor,
      };
      expect(chart.extractor).toBe(extractor);
    });

    it('FlowChart without extractor is valid', () => {
      const chart: FlowChart = {
        root: { name: 'entry' },
        stageMap: new Map(),
      };
      expect(chart.extractor).toBeUndefined();
    });

    it('BuiltFlow alias is equivalent to FlowChart', () => {
      // BuiltFlow should be assignable to FlowChart and vice versa
      const builtFlow: BuiltFlow = {
        root: { name: 'test' },
        stageMap: new Map(),
      };
      const flowChart: FlowChart = builtFlow;
      expect(flowChart).toBe(builtFlow);
    });
  });

  describe('FlowChartBuilder.build() output', () => {
    it('build() returns object with FlowChart shape', () => {
      const chart = new FlowChartBuilder()
        .start('entry', () => 'output')
        .build();

      // Verify shape
      expect(chart).toHaveProperty('root');
      expect(chart).toHaveProperty('stageMap');
      expect(chart.root.name).toBe('entry');
      expect(chart.stageMap).toBeInstanceOf(Map);
    });

    it('build() includes extractor when addTraversalExtractor is called', () => {
      const extractor = (snapshot: any) => snapshot.node.name;
      const chart = new FlowChartBuilder()
        .start('entry', () => 'output')
        .addTraversalExtractor(extractor)
        .build();

      expect(chart.extractor).toBe(extractor);
    });

    it('build() stageMap contains all registered functions', () => {
      const fn1 = () => 'output1';
      const fn2 = () => 'output2';
      const fn3 = () => 'output3';

      const chart = new FlowChartBuilder()
        .start('entry', fn1)
        .addFunction('process', fn2)
        .addFunction('output', fn3)
        .build();

      expect(chart.stageMap.size).toBe(3);
      expect(chart.stageMap.get('entry')).toBe(fn1);
      expect(chart.stageMap.get('process')).toBe(fn2);
      expect(chart.stageMap.get('output')).toBe(fn3);
    });
  });
});

describe('FlowChartExecutor', () => {
  /**
   * Task 2.1, 2.2, 2.3: FlowChartExecutor class tests
   * _Requirements: 2.1, 3.1, 3.2, 4.1, 4.2_
   */
  describe('constructor', () => {
    it('accepts FlowChart object', () => {
      const chart = new FlowChartBuilder()
        .start('entry', () => 'output')
        .build();

      const executor = new FlowChartExecutor(chart, testScopeFactory);
      expect(executor).toBeInstanceOf(FlowChartExecutor);
    });

    it('accepts FlowChart with all optional parameters', () => {
      const chart = new FlowChartBuilder()
        .start('entry', () => 'output')
        .build();

      const executor = new FlowChartExecutor(
        chart,
        testScopeFactory,
        { default: 'value' },  // defaultValuesForContext
        { initial: 'value' }, // initialContext
        { readOnly: 'value' }, // readOnlyContext
        (error) => error instanceof Error, // throttlingErrorChecker
        { onToken: () => {} }, // streamHandlers
      );

      expect(executor).toBeInstanceOf(FlowChartExecutor);
    });
  });

  describe('run() method', () => {
    it('executes the flowchart and returns result', async () => {
      const chart = new FlowChartBuilder()
        .start('entry', () => 'entry-output')
        .build();

      const executor = new FlowChartExecutor(chart, testScopeFactory);
      const result = await executor.run();

      expect(result).toBeDefined();
      // TreeOfFunctionsResponse can be PipelineResponses | string | Error
      // For a simple flowchart, it returns the output value
      expect(result).toBe('entry-output');
    });

    it('executes stages in correct order', async () => {
      const executionOrder: string[] = [];

      const chart = new FlowChartBuilder()
        .start('first', () => {
          executionOrder.push('first');
          return 'first-output';
        })
        .addFunction('second', () => {
          executionOrder.push('second');
          return 'second-output';
        })
        .addFunction('third', () => {
          executionOrder.push('third');
          return 'third-output';
        })
        .build();

      const executor = new FlowChartExecutor(chart, testScopeFactory);
      await executor.run();

      expect(executionOrder).toEqual(['first', 'second', 'third']);
    });

    it('provides access to context tree after execution', async () => {
      const chart = new FlowChartBuilder()
        .start('entry', (scope: StageContext) => {
          scope.setObject([], 'testKey', 'testValue');
          return 'output';
        })
        .build();

      const executor = new FlowChartExecutor(chart, testScopeFactory);
      await executor.run();

      const contextTree = executor.getContextTree();
      expect(contextTree).toBeDefined();
      expect(contextTree.globalContext).toBeDefined();
      expect((contextTree.globalContext as any).testKey).toBe('testValue');
    });
  });

  describe('execute() method (deprecated alias)', () => {
    it('works as alias for run()', async () => {
      const chart = new FlowChartBuilder()
        .start('entry', () => 'output')
        .build();

      const executor = new FlowChartExecutor(chart, testScopeFactory);
      const result = await executor.execute();

      expect(result).toBeDefined();
      expect(result).toBe('output');
    });
  });

  describe('introspection methods', () => {
    it('getContextTree() returns context tree', async () => {
      const chart = new FlowChartBuilder()
        .start('entry', () => 'output')
        .build();

      const executor = new FlowChartExecutor(chart, testScopeFactory);
      await executor.run();

      const tree = executor.getContextTree();
      expect(tree).toHaveProperty('globalContext');
      expect(tree).toHaveProperty('stageContexts');
      expect(tree).toHaveProperty('history');
    });

    it('getContext() returns PipelineRuntime', async () => {
      const chart = new FlowChartBuilder()
        .start('entry', () => 'output')
        .build();

      const executor = new FlowChartExecutor(chart, testScopeFactory);
      await executor.run();

      const context = executor.getContext();
      expect(context).toBeDefined();
    });

    it('getRuntimeRoot() returns root node', async () => {
      const chart = new FlowChartBuilder()
        .start('entry', () => 'output')
        .build();

      const executor = new FlowChartExecutor(chart, testScopeFactory);
      await executor.run();

      const root = executor.getRuntimeRoot();
      expect(root).toBeDefined();
      expect(root.name).toBe('entry');
    });

    it('getExtractedResults() returns extracted data', async () => {
      const chart = new FlowChartBuilder()
        .start('entry', () => 'output')
        .addTraversalExtractor((snapshot) => ({ name: snapshot.node.name }))
        .build();

      const executor = new FlowChartExecutor(chart, testScopeFactory);
      await executor.run();

      const results = executor.getExtractedResults();
      expect(results).toBeInstanceOf(Map);
      expect(results.size).toBeGreaterThan(0);
    });

    it('getSubflowResults() returns subflow data', async () => {
      const subflow = new FlowChartBuilder()
        .start('subEntry', () => 'sub-output')
        .build();

      const chart = new FlowChartBuilder()
        .start('entry', () => 'output')
        .addSubFlowChart('sub', subflow, 'Subflow')
        .build();

      const executor = new FlowChartExecutor(chart, testScopeFactory);
      await executor.run();

      const subflowResults = executor.getSubflowResults();
      expect(subflowResults).toBeInstanceOf(Map);
    });
  });
});

describe('flowChart() Factory Function', () => {
  /**
   * Task 5.3: Write unit tests for flowChart() factory
   * _Requirements: 7.1, 7.3_
   */
  describe('basic usage', () => {
    it('returns a FlowChartBuilder instance', () => {
      const builder = flowChart('entry');
      expect(builder).toBeInstanceOf(FlowChartBuilder);
    });

    it('creates builder with root already set', () => {
      const chart = flowChart('entry').build();
      expect(chart.root.name).toBe('entry');
    });

    it('allows chaining addFunction after factory call', () => {
      const chart = flowChart('entry')
        .addFunction('process')
        .addFunction('output')
        .build();

      expect(chart.root.name).toBe('entry');
      expect(chart.root.next?.name).toBe('process');
      expect(chart.root.next?.next?.name).toBe('output');
    });
  });

  describe('parameter combinations', () => {
    it('works with name only', () => {
      const chart = flowChart('entry').build();
      expect(chart.root.name).toBe('entry');
      expect(chart.root.fn).toBeUndefined();
      expect(chart.root.id).toBeUndefined();
    });

    it('works with name and fn', () => {
      const fn = () => 'output';
      const chart = flowChart('entry', fn).build();
      expect(chart.root.name).toBe('entry');
      expect(chart.root.fn).toBe(fn);
      expect(chart.stageMap.get('entry')).toBe(fn);
    });

    it('works with name, fn, and id', () => {
      const fn = () => 'output';
      const chart = flowChart('entry', fn, 'entry-id').build();
      expect(chart.root.name).toBe('entry');
      expect(chart.root.id).toBe('entry-id');
      expect(chart.root.fn).toBe(fn);
    });

    it('works with all parameters', () => {
      const fn = () => 'output';
      const chart = flowChart('entry', fn, 'entry-id', 'Entry Stage').build();
      expect(chart.root.name).toBe('entry');
      expect(chart.root.id).toBe('entry-id');
      expect(chart.root.displayName).toBe('Entry Stage');
      expect(chart.root.fn).toBe(fn);
    });

    it('works with undefined fn but defined id', () => {
      const chart = flowChart('entry', undefined, 'entry-id').build();
      expect(chart.root.name).toBe('entry');
      expect(chart.root.id).toBe('entry-id');
      expect(chart.root.fn).toBeUndefined();
    });
  });

  describe('chaining', () => {
    it('supports addFunction chaining', () => {
      const executionOrder: string[] = [];

      const chart = flowChart('entry', () => {
        executionOrder.push('entry');
        return 'entry-output';
      })
        .addFunction('process', () => {
          executionOrder.push('process');
          return 'process-output';
        })
        .build();

      const executor = new FlowChartExecutor(chart, testScopeFactory);
      return executor.run().then(() => {
        expect(executionOrder).toEqual(['entry', 'process']);
      });
    });

    it('supports addDecider chaining', () => {
      const chart = flowChart('entry', () => 'typeA')
        .addDecider((out) => out as string)
          .addFunctionBranch('typeA', 'handleA', () => 'A')
          .addFunctionBranch('typeB', 'handleB', () => 'B')
          .end()
        .build();

      expect(chart.root.name).toBe('entry');
      expect(chart.root.children?.length).toBe(2);
    });

    it('supports addListOfFunction chaining', () => {
      const chart = flowChart('entry', () => 'output')
        .addListOfFunction([
          { id: 'child1', name: 'child1', fn: () => 'c1' },
          { id: 'child2', name: 'child2', fn: () => 'c2' },
        ])
        .build();

      expect(chart.root.children?.length).toBe(2);
    });

    it('supports addSubFlowChart chaining', () => {
      const subflow = flowChart('subEntry', () => 'sub-output').build();

      const chart = flowChart('entry', () => 'output')
        .addSubFlowChart('sub', subflow, 'Subflow')
        .build();

      expect(chart.root.children?.length).toBe(1);
      expect(chart.root.children?.[0].isSubflowRoot).toBe(true);
    });

    it('supports addStreamingFunction chaining', () => {
      const chart = flowChart('entry', () => 'output')
        .addStreamingFunction('stream', 'stream-id', () => 'streamed')
        .build();

      expect(chart.root.next?.name).toBe('stream');
      expect(chart.root.next?.isStreaming).toBe(true);
      expect(chart.root.next?.streamId).toBe('stream-id');
    });

    it('supports addTraversalExtractor chaining', () => {
      const extractor = (snapshot: any) => snapshot.node.name;
      const chart = flowChart('entry', () => 'output')
        .addTraversalExtractor(extractor)
        .build();

      expect(chart.extractor).toBe(extractor);
    });
  });

  describe('equivalence to FlowChartBuilder', () => {
    it('produces same result as new FlowChartBuilder().start()', async () => {
      const fn = () => 'output';

      const factoryChart = flowChart('entry', fn).build();
      const constructorChart = new FlowChartBuilder().start('entry', fn).build();

      expect(factoryChart.root.name).toBe(constructorChart.root.name);
      expect(factoryChart.stageMap.size).toBe(constructorChart.stageMap.size);
    });

    it('executes identically to FlowChartBuilder-built chart', async () => {
      const factoryOutputs: string[] = [];
      const constructorOutputs: string[] = [];

      const factoryChart = flowChart('entry', () => {
        factoryOutputs.push('entry');
        return 'output';
      })
        .addFunction('process', () => {
          factoryOutputs.push('process');
          return 'processed';
        })
        .build();

      const constructorChart = new FlowChartBuilder()
        .start('entry', () => {
          constructorOutputs.push('entry');
          return 'output';
        })
        .addFunction('process', () => {
          constructorOutputs.push('process');
          return 'processed';
        })
        .build();

      await new FlowChartExecutor(factoryChart, testScopeFactory).run();
      await new FlowChartExecutor(constructorChart, testScopeFactory).run();

      expect(factoryOutputs).toEqual(constructorOutputs);
    });
  });
});

describe('Public API Exports', () => {
  /**
   * Task 6.1: Verify exports
   * _Requirements: 1.2, 2.2, 6.1, 6.2, 7.4_
   */
  it('FlowChartExecutor is exported from index', async () => {
    const { FlowChartExecutor: Exported } = await import('../../../src/index');
    expect(Exported).toBeDefined();
    expect(Exported).toBe(FlowChartExecutor);
  });

  it('FlowChart type is usable from index exports', async () => {
    const { FlowChartBuilder: Builder } = await import('../../../src/index');
    const chart = new Builder().start('test').build();
    // If this compiles and runs, FlowChart type is properly exported
    expect(chart.root).toBeDefined();
    expect(chart.stageMap).toBeDefined();
  });

  it('flowChart factory is exported from index', async () => {
    const { flowChart: exported } = await import('../../../src/index');
    expect(exported).toBeDefined();
    expect(typeof exported).toBe('function');
    expect(exported).toBe(flowChart);
  });

  it('Pipeline is still exported for backward compatibility', async () => {
    const { Pipeline } = await import('../../../src/index');
    expect(Pipeline).toBeDefined();
  });

  it('FlowChartBuilder is still exported', async () => {
    const { FlowChartBuilder: Exported } = await import('../../../src/index');
    expect(Exported).toBeDefined();
    expect(Exported).toBe(FlowChartBuilder);
  });
});
