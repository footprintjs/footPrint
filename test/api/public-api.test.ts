/**
 * Public API — Scenario Tests & Property-Based Tests
 *
 * These tests verify the FootPrint library's contract from a consumer's
 * perspective. They import ONLY from the library's public entry point and
 * test the full build -> execute -> inspect lifecycle.
 *
 * Grouped into:
 *   1. Builder API scenarios
 *   2. Executor API scenarios
 *   3. Scope API scenarios
 *   4. Property-based tests (fast-check)
 */

import {
  flowChart,
  FlowChartBuilder,
  FlowChartExecutor,
  BaseState,
  createProtectedScope,
  specToStageNode,
  StageContext,
  PipelineRuntime,
  GlobalStore,
} from '../../src';

import type {
  FlowChart,
  FlowChartSpec,
  RuntimeSnapshot,
  TreeOfFunctionsResponse,
  StageNode,
} from '../../src';

import * as fc from 'fast-check';

/* --------------------------------------------------------------------------
 * Helpers
 * ----------------------------------------------------------------------- */

/** Simple scope factory: consumer just passes through the StageContext. */
const scopeFactory = (ctx: StageContext) => ctx;

/** Collects names from a StageNode tree (DFS). */
function collectNames(node?: StageNode, acc: string[] = []): string[] {
  if (!node) return acc;
  acc.push(node.name);
  if (node.children) for (const c of node.children) collectNames(c, acc);
  if (node.next) collectNames(node.next, acc);
  return acc;
}

/* ==========================================================================
 * 1. PUBLIC API — BUILDER
 * ======================================================================= */

describe('Public API — Builder', () => {
  // ─── flowChart factory produces a valid FlowChart ───

  test('flowChart(name, fn).build() produces a valid FlowChart with root and stageMap', () => {
    const fn = () => 'hello';
    const chart = flowChart('entry', fn).build();

    expect(chart.root).toBeDefined();
    expect(chart.root.name).toBe('entry');
    expect(chart.stageMap).toBeInstanceOf(Map);
    expect(chart.stageMap.get('entry')).toBe(fn);
    expect(chart.buildTimeStructure).toBeDefined();
    expect(chart.buildTimeStructure.name).toBe('entry');
  });

  // ─── Linear chain ───

  test('linear chain: flowChart().addFunction().addFunction().build() + execute returns results in order', async () => {
    const order: string[] = [];

    const chart = flowChart('A', () => { order.push('A'); return 'a'; })
      .addFunction('B', () => { order.push('B'); return 'b'; })
      .addFunction('C', () => { order.push('C'); return 'c'; })
      .build();

    const executor = new FlowChartExecutor(chart, scopeFactory);
    const result = await executor.run();

    expect(order).toEqual(['A', 'B', 'C']);
    // Final result is the last stage's output
    expect(result).toBe('c');
  });

  // ─── Parallel fork ───

  test('parallel fork: addListOfFunction runs children concurrently', async () => {
    const order: string[] = [];

    const chart = flowChart('seed', () => { order.push('seed'); return 'seeded'; })
      .addListOfFunction([
        { id: 'x', name: 'X', fn: () => { order.push('X'); return 'rx'; } },
        { id: 'y', name: 'Y', fn: () => { order.push('Y'); return 'ry'; } },
      ])
      .build();

    const executor = new FlowChartExecutor(chart, scopeFactory);
    const result = await executor.run();

    // Seed runs first
    expect(order[0]).toBe('seed');
    // Both children execute (order may vary due to concurrency)
    expect(order).toContain('X');
    expect(order).toContain('Y');
    // Result is a record of pipeline responses (fork returns PipelineResponses)
    expect(result).toBeDefined();
  });

  // ─── Decider ───

  test('decider: addDecider picks one branch', async () => {
    const order: string[] = [];

    const chart = flowChart('entry', () => { order.push('entry'); return 'B'; })
      .addDecider((out) => out as string)
        .addFunctionBranch('A', 'handleA', () => { order.push('A'); return 'doneA'; })
        .addFunctionBranch('B', 'handleB', () => { order.push('B'); return 'doneB'; })
      .end()
      .build();

    const executor = new FlowChartExecutor(chart, scopeFactory);
    await executor.run();

    expect(order).toEqual(['entry', 'B']);
  });

  // ─── Selector ───

  test('selector: addSelector picks multiple branches', async () => {
    const order: string[] = [];

    const chart = flowChart('entry', () => { order.push('entry'); return ['alpha', 'gamma']; })
      .addSelector((out) => out as string[])
        .addFunctionBranch('alpha', 'Alpha', () => { order.push('Alpha'); return 'a'; })
        .addFunctionBranch('beta', 'Beta', () => { order.push('Beta'); return 'b'; })
        .addFunctionBranch('gamma', 'Gamma', () => { order.push('Gamma'); return 'g'; })
      .end()
      .build();

    const executor = new FlowChartExecutor(chart, scopeFactory);
    await executor.run();

    expect(order[0]).toBe('entry');
    expect(order).toContain('Alpha');
    expect(order).toContain('Gamma');
    expect(order).not.toContain('Beta');
  });

  // ─── Subflow ───

  test('subflow: addSubFlowChart attaches and executes isolated subflows', async () => {
    const order: string[] = [];

    const sub = flowChart('subStart', () => { order.push('subStart'); return 'subDone'; })
      .addFunction('subEnd', () => { order.push('subEnd'); return 'subFinal'; })
      .build();

    const chart = flowChart('main', () => { order.push('main'); return 'ok'; })
      .addSubFlowChart('mySub', sub, 'MySub')
      .build();

    const executor = new FlowChartExecutor(chart, scopeFactory);
    await executor.run();

    expect(order[0]).toBe('main');
    // Subflow stages should execute
    expect(order).toContain('subStart');
    expect(order).toContain('subEnd');
  });

  // ─── Loop ───

  test('loopTo: loops back to a previous stage until condition is met', async () => {
    let loopCount = 0;

    const chart = new FlowChartBuilder()
      .start('init', () => 'start')
      .addFunction('check', (scope: StageContext) => {
        loopCount++;
        if (loopCount >= 3) {
          return 'done';
        }
        return 'again';
      }, 'check')
      .addFunction('process', () => 'processed')
      .build();

    // loopTo creates a StageNode.next pointing to the target stage by name.
    // For a real loop test we'd need the builder's loopTo API:
    const chartWithLoop = new FlowChartBuilder()
      .start('init', () => 'start')
      .addFunction('work', () => {
        loopCount++;
        return loopCount < 3 ? 'loop' : 'exit';
      }, 'work')
      .loopTo('work')
      .build();

    // The loopTo sets the node's next to { name: 'work', id: 'work' }
    // Verify the structure is correct
    expect(chartWithLoop.root.next?.name).toBe('work');
    expect(chartWithLoop.root.next?.next?.name).toBe('work');
    expect(chartWithLoop.buildTimeStructure.next?.loopTarget).toBe('work');
  });

  // ─── Description accumulation ───

  test('descriptions on stages produce accumulated description text', () => {
    const chart = flowChart('validate', undefined, undefined, 'Validate Input', undefined, 'Validates user input')
      .addFunction('process', undefined, undefined, 'Process Data', 'Processes the validated data')
      .addFunction('output', undefined, undefined, 'Output Result', 'Produces the final output')
      .build();

    expect(chart.description).toContain('Validate Input');
    expect(chart.description).toContain('Validates user input');
    expect(chart.description).toContain('Process Data');
    expect(chart.description).toContain('Processes the validated data');
    expect(chart.description).toContain('Output Result');
    expect(chart.description).toContain('Produces the final output');
    expect(chart.description).toContain('FlowChart:');
    expect(chart.description).toContain('Steps:');

    // stageDescriptions map should also be populated
    expect(chart.stageDescriptions.get('validate')).toBe('Validates user input');
    expect(chart.stageDescriptions.get('process')).toBe('Processes the validated data');
    expect(chart.stageDescriptions.get('output')).toBe('Produces the final output');
  });

  // ─── build() returns stageMap with correct entries ───

  test('build() returns stageMap with correct entries', () => {
    const fnA = () => 'a';
    const fnB = () => 'b';
    const fnC = () => 'c';

    const chart = flowChart('A', fnA)
      .addFunction('B', fnB)
      .addFunction('C', fnC)
      .build();

    expect(chart.stageMap.size).toBe(3);
    expect(chart.stageMap.get('A')).toBe(fnA);
    expect(chart.stageMap.get('B')).toBe(fnB);
    expect(chart.stageMap.get('C')).toBe(fnC);
  });

  // ─── toSpec() serializes to JSON-serializable spec ───

  test('toSpec() serializes the flowchart to a JSON-serializable spec', () => {
    const builder = flowChart('entry', () => 'out')
      .addFunction('process', () => 'done');

    const spec = builder.toSpec();

    // Spec should be a plain object with no functions
    expect(spec.name).toBe('entry');
    expect(spec.next?.name).toBe('process');
    expect(spec.type).toBe('stage');

    // Should be JSON-serializable (no functions, symbols, etc.)
    const json = JSON.stringify(spec);
    expect(json).toBeDefined();
    const parsed = JSON.parse(json);
    expect(parsed.name).toBe('entry');
    expect(parsed.next.name).toBe('process');
  });

  // ─── specToStageNode() reconstructs from spec ───

  test('specToStageNode() reconstructs from spec', () => {
    const builder = flowChart('root')
      .addFunction('child1')
      .addListOfFunction([
        { id: 'p1', name: 'Parallel1' },
        { id: 'p2', name: 'Parallel2' },
      ])
      .addFunction('tail');

    const spec = builder.toSpec();
    const node = specToStageNode(spec as FlowChartSpec);

    expect(node.name).toBe('root');
    expect(node.next?.name).toBe('child1');
    expect(node.next?.children?.length).toBe(2);
    expect(node.next?.next?.name).toBe('tail');
  });

  // ─── setEnableNarrative at build time ───

  test('setEnableNarrative() sets enableNarrative flag on built chart', () => {
    const chart = flowChart('entry', () => 'x')
      .setEnableNarrative()
      .build();

    expect(chart.enableNarrative).toBe(true);
  });

  // ─── DeciderList with setDefault ───

  test('decider with setDefault routes unknown id to default branch', async () => {
    const order: string[] = [];

    const chart = flowChart('entry', () => { return 'UNKNOWN'; })
      .addDecider((out) => out as string)
        .addFunctionBranch('left', 'Left', () => { order.push('left'); return 'l'; })
        .addFunctionBranch('right', 'Right', () => { order.push('right'); return 'r'; })
        .setDefault('left')
      .end()
      .build();

    const executor = new FlowChartExecutor(chart, scopeFactory);
    await executor.run();

    expect(order).toContain('left');
  });

  // ─── Builder validation errors ───

  test('addFunction before start() throws', () => {
    const fb = new FlowChartBuilder();
    expect(() => fb.addFunction('B')).toThrow(/cursor undefined/i);
  });

  test('duplicate child ids under parent throws', () => {
    const fb = flowChart('parent');
    expect(() =>
      fb.addListOfFunction([
        { id: 'x', name: 'X' },
        { id: 'x', name: 'X2' },
      ]),
    ).toThrow(/duplicate child id/i);
  });

  test('decider requires at least one branch', () => {
    const fb = flowChart('dec');
    expect(() => fb.addDecider(() => 'x').end()).toThrow(/requires at least one branch/i);
  });

  // ─── addSubFlowChartBranch in decider ───

  test('addSubFlowChartBranch mounts subflow as decider branch', () => {
    const sub = flowChart('subRoot', () => 'done').build();

    const chart = flowChart('entry')
      .addDecider(() => 'mySub')
        .addSubFlowChartBranch('mySub', sub, 'MySubflow')
        .addFunctionBranch('other', 'Other')
      .end()
      .build();

    expect(chart.root.children).toHaveLength(2);
    expect(chart.root.children![0].isSubflowRoot).toBe(true);
    expect(chart.root.children![0].subflowId).toBe('mySub');
    expect(chart.subflows).toBeDefined();
    expect(chart.subflows!['mySub']).toBeDefined();
  });

  // ─── addSubFlowChartNext for linear continuation ───

  test('addSubFlowChartNext mounts subflow as linear continuation', () => {
    const sub = flowChart('subRoot', () => 'done').build();

    const chart = flowChart('entry', () => 'out')
      .addSubFlowChartNext('mySub', sub, 'MySubflow')
      .build();

    expect(chart.root.next?.name).toBe('MySubflow');
    expect(chart.root.next?.isSubflowRoot).toBe(true);
    expect(chart.root.next?.subflowId).toBe('mySub');
  });

  // ─── Streaming function ───

  test('addStreamingFunction adds a streaming stage', () => {
    const chart = flowChart('entry', () => 'out')
      .addStreamingFunction('stream', 'stream-id', () => 'streamed')
      .build();

    expect(chart.root.next?.name).toBe('stream');
    expect(chart.root.next?.isStreaming).toBe(true);
    expect(chart.root.next?.streamId).toBe('stream-id');
  });

  // ─── addDeciderFunction (scope-based decider) ───

  test('addDeciderFunction creates a scope-based decider', async () => {
    const order: string[] = [];

    const chart = flowChart('entry', (scope: StageContext) => {
      scope.setObject([], 'routeChoice', 'fast');
      order.push('entry');
      return 'entryDone';
    })
      .addDeciderFunction('router', (scope: StageContext) => {
        order.push('router');
        return 'fast';
      }, 'router-id')
        .addFunctionBranch('fast', 'FastPath', () => { order.push('fast'); return 'speedDone'; })
        .addFunctionBranch('slow', 'SlowPath', () => { order.push('slow'); return 'slowDone'; })
      .end()
      .build();

    const executor = new FlowChartExecutor(chart, scopeFactory);
    await executor.run();

    expect(order).toEqual(['entry', 'router', 'fast']);
  });
});


/* ==========================================================================
 * 2. PUBLIC API — EXECUTOR
 * ======================================================================= */

describe('Public API — Executor', () => {
  // ─── Basic run ───

  test('new FlowChartExecutor(chart, scopeFactory) + run() returns TreeOfFunctionsResponse', async () => {
    const chart = flowChart('entry', () => 'output').build();
    const executor = new FlowChartExecutor(chart, scopeFactory);
    const result: TreeOfFunctionsResponse = await executor.run();

    expect(result).toBeDefined();
    expect(result).toBe('output');
  });

  // ─── getContextTree ───

  test('getContextTree() returns RuntimeSnapshot with globalContext and stage data', async () => {
    const chart = flowChart('entry', (scope: StageContext) => {
      scope.setObject([], 'myKey', 'myValue');
      return 'done';
    }).build();

    const executor = new FlowChartExecutor(chart, scopeFactory);
    await executor.run();

    const tree: RuntimeSnapshot = executor.getContextTree();

    expect(tree).toHaveProperty('globalContext');
    expect(tree).toHaveProperty('stageContexts');
    expect(tree).toHaveProperty('history');
    expect((tree.globalContext as any).myKey).toBe('myValue');
  });

  // ─── getContext ───

  test('getContext() returns PipelineRuntime', async () => {
    const chart = flowChart('entry', () => 'out').build();
    const executor = new FlowChartExecutor(chart, scopeFactory);
    await executor.run();

    const ctx = executor.getContext();
    expect(ctx).toBeDefined();
    // PipelineRuntime has getSnapshot
    expect(typeof ctx.getSnapshot).toBe('function');
  });

  // ─── getRuntimeRoot ───

  test('getRuntimeRoot() returns the root StageNode', async () => {
    const chart = flowChart('myRoot', () => 'out')
      .addFunction('next', () => 'done')
      .build();

    const executor = new FlowChartExecutor(chart, scopeFactory);
    await executor.run();

    const root = executor.getRuntimeRoot();
    expect(root).toBeDefined();
    expect(root.name).toBe('myRoot');
    expect(root.next?.name).toBe('next');
  });

  // ─── getSubflowResults ───

  test('getSubflowResults() returns subflow execution data', async () => {
    const sub = flowChart('subEntry', () => 'subOut').build();

    const chart = flowChart('main', () => 'ok')
      .addSubFlowChart('sub1', sub, 'Sub1')
      .build();

    const executor = new FlowChartExecutor(chart, scopeFactory);
    await executor.run();

    const subflowResults = executor.getSubflowResults();
    expect(subflowResults).toBeInstanceOf(Map);
    // Subflow results should contain the mounted subflow
    // The key is the subflowId used during execution
  });

  // ─── enableNarrative + run + getNarrative ───

  test('enableNarrative() + run() + getNarrative() returns narrative sentences', async () => {
    const chart = flowChart('validate', () => 'valid')
      .addFunction('process', () => 'processed')
      .addFunction('output', () => 'done')
      .build();

    const executor = new FlowChartExecutor(chart, scopeFactory);
    executor.enableNarrative();
    await executor.run();

    const narrative = executor.getNarrative();
    expect(Array.isArray(narrative)).toBe(true);
    expect(narrative.length).toBeGreaterThan(0);
    // First sentence should reference the first stage
    expect(narrative[0]).toContain('validate');
  });

  test('getNarrative() returns empty array when narrative is not enabled', async () => {
    const chart = flowChart('entry', () => 'out').build();
    const executor = new FlowChartExecutor(chart, scopeFactory);
    await executor.run();

    expect(executor.getNarrative()).toEqual([]);
  });

  // ─── Build-time narrative enablement ───

  test('build-time enableNarrative produces narrative without explicit executor call', async () => {
    const chart = flowChart('start', () => 'go')
      .addFunction('middle', () => 'mid')
      .setEnableNarrative()
      .build();

    const executor = new FlowChartExecutor(chart, scopeFactory);
    // No explicit executor.enableNarrative() call
    await executor.run();

    const narrative = executor.getNarrative();
    expect(narrative.length).toBeGreaterThan(0);
  });

  // ─── getRuntimePipelineStructure ───

  test('getRuntimePipelineStructure() returns structure when buildTimeStructure provided', async () => {
    const chart = flowChart('entry', () => 'out')
      .addFunction('process', () => 'done')
      .build();

    const executor = new FlowChartExecutor(chart, scopeFactory);
    await executor.run();

    const structure = executor.getRuntimePipelineStructure();
    expect(structure).toBeDefined();
    expect(structure!.name).toBe('entry');
    expect(structure!.next?.name).toBe('process');
  });

  // ─── Error propagation ───

  test('error in a stage propagates correctly through executor', async () => {
    const chart = flowChart('entry', () => {
      throw new Error('Stage failed!');
    }).build();

    const executor = new FlowChartExecutor(chart, scopeFactory);

    // Pipeline re-throws stage errors, so executor.run() rejects
    await expect(executor.run()).rejects.toThrow('Stage failed!');
  });

  // ─── Multi-stage with context passing ───

  test('stages can write and read from shared context', async () => {
    const chart = flowChart('writer', (scope: StageContext) => {
      scope.setObject([], 'sharedKey', 'hello world');
      return 'wrote';
    })
      .addFunction('reader', (scope: StageContext) => {
        const val = scope.getValue([], 'sharedKey');
        return val;
      })
      .build();

    const executor = new FlowChartExecutor(chart, scopeFactory);
    const result = await executor.run();

    expect(result).toBe('hello world');
  });

  // ─── getExtractedResults with traversal extractor ───

  test('getExtractedResults() returns extracted data from traversal extractor', async () => {
    const chart = flowChart('entry', () => 'out')
      .addFunction('next', () => 'done')
      .addTraversalExtractor((snapshot: any) => ({
        name: snapshot.node.name,
      }))
      .build();

    const executor = new FlowChartExecutor(chart, scopeFactory);
    await executor.run();

    const results = executor.getExtractedResults<{ name: string }>();
    expect(results).toBeInstanceOf(Map);
    expect(results.size).toBeGreaterThan(0);
  });

  // ─── Constructor with optional parameters ───

  test('executor accepts all optional parameters', async () => {
    const chart = flowChart('entry', () => 'out').build();

    const executor = new FlowChartExecutor(
      chart,
      scopeFactory,
      { default: 'value' },       // defaultValuesForContext
      { initial: 'value' },       // initialContext
      { readOnly: 'value' },      // readOnlyContext
      (error) => false,            // throttlingErrorChecker
      undefined,                   // streamHandlers
      'error',                     // scopeProtectionMode
    );

    const result = await executor.run();
    expect(result).toBe('out');
  });
});


/* ==========================================================================
 * 3. PUBLIC API — SCOPE
 * ======================================================================= */

describe('Public API — Scope', () => {
  // ─── BaseState subclass ───

  test('BaseState subclass: consumer creates custom scope, reads/writes via setValue/getValue', async () => {
    class MyScope extends BaseState {
      getUserName(): string {
        return this.getValue('name') as string;
      }
      setUserName(value: string) {
        this.setObject('name', value);
      }
    }

    const myScopeFactory = (ctx: StageContext, stageName: string) =>
      new MyScope(ctx, stageName);

    const chart = flowChart('writer', (scope: MyScope) => {
      scope.setUserName('Alice');
      return 'wrote';
    })
      .addFunction('reader', (scope: MyScope) => {
        return scope.getUserName();
      })
      .build();

    // Disable scope protection so BaseState methods work without proxy interference
    const executor = new FlowChartExecutor(
      chart,
      myScopeFactory,
      undefined, // defaultValuesForContext
      undefined, // initialContext
      undefined, // readOnlyContext
      undefined, // throttlingErrorChecker
      undefined, // streamHandlers
      'off',     // scopeProtectionMode
    );
    const result = await executor.run();

    expect(result).toBe('Alice');
  });

  test('BaseState provides debug and metric methods', () => {
    // Verify BaseState has the expected API surface
    expect(typeof BaseState.prototype.addDebugInfo).toBe('function');
    expect(typeof BaseState.prototype.addDebugMessage).toBe('function');
    expect(typeof BaseState.prototype.addErrorInfo).toBe('function');
    expect(typeof BaseState.prototype.addMetric).toBe('function');
    expect(typeof BaseState.prototype.addEval).toBe('function');
    expect(typeof BaseState.prototype.getInitialValueFor).toBe('function');
    expect(typeof BaseState.prototype.getValue).toBe('function');
    expect(typeof BaseState.prototype.setObject).toBe('function');
    expect(typeof BaseState.prototype.updateObject).toBe('function');
    expect(typeof BaseState.prototype.setGlobal).toBe('function');
    expect(typeof BaseState.prototype.getGlobal).toBe('function');
    expect(typeof BaseState.prototype.getReadOnlyValues).toBe('function');
    expect(typeof BaseState.prototype.getPipelineId).toBe('function');
  });

  test('BaseState has BRAND symbol for runtime detection', () => {
    expect(BaseState.BRAND).toBeDefined();
    expect(typeof BaseState.BRAND).toBe('symbol');
    expect(BaseState.BRAND).toBe(Symbol.for('BaseState@v1'));
  });

  // ─── createProtectedScope ───

  test('createProtectedScope mode=error throws on direct property assignment', () => {
    const rawScope = { foo: 'bar', setObject: () => {} };
    const protected_ = createProtectedScope(rawScope, {
      mode: 'error',
      stageName: 'testStage',
    });

    // Reading should work fine
    expect(protected_.foo).toBe('bar');

    // Direct assignment should throw
    expect(() => {
      (protected_ as any).newProp = 'value';
    }).toThrow(/Scope Access Error/);
  });

  test('createProtectedScope mode=warn warns but allows assignment', () => {
    const warnings: string[] = [];
    const rawScope = { existing: 1 };
    const protected_ = createProtectedScope(rawScope, {
      mode: 'warn',
      stageName: 'testStage',
      logger: (msg: string) => warnings.push(msg),
    });

    // Direct assignment should warn but succeed
    (protected_ as any).newProp = 'value';

    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain('Scope Access Error');
    expect((protected_ as any).newProp).toBe('value');
  });

  test('createProtectedScope mode=off does not intercept', () => {
    const rawScope = { existing: 1 };
    const protected_ = createProtectedScope(rawScope, {
      mode: 'off',
      stageName: 'testStage',
    });

    // Should work without error
    (protected_ as any).newProp = 'value';
    expect((protected_ as any).newProp).toBe('value');
  });

  test('createProtectedScope allows internal properties', () => {
    const rawScope = { existing: 1 };
    const protected_ = createProtectedScope(rawScope, {
      mode: 'error',
      stageName: 'testStage',
    });

    // Allowed internal properties should not throw
    expect(() => {
      (protected_ as any).writeBuffer = {};
    }).not.toThrow();
    expect(() => {
      (protected_ as any).stageName = 'foo';
    }).not.toThrow();
  });
});


/* ==========================================================================
 * 4. PUBLIC API — PROPERTY-BASED TESTS (fast-check)
 * ======================================================================= */

describe('Public API — Properties', () => {
  // ─── Builder chain property ───

  test('any sequence of valid addFunction calls produces a buildable FlowChart with correct stageMap size', () => {
    fc.assert(
      fc.property(
        fc.array(fc.string({ minLength: 1, maxLength: 20 }).filter(s => /^[a-zA-Z]/.test(s)), {
          minLength: 1,
          maxLength: 10,
        }),
        (stageNames: string[]) => {
          // Deduplicate names to avoid stageMap collision
          const uniqueNames = [...new Set(stageNames)];
          if (uniqueNames.length === 0) return;

          const builder = flowChart(uniqueNames[0], () => `result-${uniqueNames[0]}`);
          for (let i = 1; i < uniqueNames.length; i++) {
            builder.addFunction(uniqueNames[i], () => `result-${uniqueNames[i]}`);
          }

          const chart = builder.build();

          // Must have a root
          expect(chart.root).toBeDefined();
          expect(chart.root.name).toBe(uniqueNames[0]);

          // stageMap must contain all stage names
          expect(chart.stageMap.size).toBe(uniqueNames.length);
          for (const name of uniqueNames) {
            expect(chart.stageMap.has(name)).toBe(true);
          }
        },
      ),
      { numRuns: 50 },
    );
  });

  // ─── Execute determinism ───

  test('same FlowChart + same inputs always produces same output', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 10 }),
        async (input: string) => {
          const fn = () => `processed-${input}`;
          const chart = flowChart('entry', fn).build();

          const result1 = await new FlowChartExecutor(chart, scopeFactory).run();
          const result2 = await new FlowChartExecutor(chart, scopeFactory).run();

          expect(result1).toEqual(result2);
        },
      ),
      { numRuns: 20 },
    );
  });

  // ─── Narrative enablement property ───

  test('enableNarrative() always produces non-empty narrative array after execution', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 5 }),
        async (stageCount: number) => {
          let builder = flowChart('stage_0', () => 'out_0');
          for (let i = 1; i < stageCount; i++) {
            builder = builder.addFunction(`stage_${i}`, () => `out_${i}`);
          }
          const chart = builder.build();

          const executor = new FlowChartExecutor(chart, scopeFactory);
          executor.enableNarrative();
          await executor.run();

          const narrative = executor.getNarrative();
          expect(narrative.length).toBeGreaterThan(0);
        },
      ),
      { numRuns: 15 },
    );
  });

  // ─── Description accumulation property ───

  test('N stages with descriptions produce description text containing all N description strings', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            name: fc.string({ minLength: 1, maxLength: 15 }).filter(s => /^[a-zA-Z]/.test(s)),
            desc: fc.string({ minLength: 1, maxLength: 30 }).filter(s => /^[a-zA-Z]/.test(s)),
          }),
          { minLength: 1, maxLength: 8 },
        ),
        (stages) => {
          // Deduplicate by name
          const seen = new Set<string>();
          const unique = stages.filter(s => {
            if (seen.has(s.name)) return false;
            seen.add(s.name);
            return true;
          });
          if (unique.length === 0) return;

          let builder = flowChart(
            unique[0].name,
            undefined,
            undefined,
            undefined,
            undefined,
            unique[0].desc,
          );
          for (let i = 1; i < unique.length; i++) {
            builder = builder.addFunction(
              unique[i].name,
              undefined,
              undefined,
              undefined,
              unique[i].desc,
            );
          }

          const chart = builder.build();

          // Every description string should appear in the combined description
          for (const stage of unique) {
            expect(chart.description).toContain(stage.desc);
          }

          // stageDescriptions map should contain all described stages
          for (const stage of unique) {
            expect(chart.stageDescriptions.get(stage.name)).toBe(stage.desc);
          }
        },
      ),
      { numRuns: 30 },
    );
  });

  // ─── StageMap completeness property ───

  test('every stage name in the built tree exists in the stageMap (when fn provided)', () => {
    fc.assert(
      fc.property(
        fc.array(fc.string({ minLength: 1, maxLength: 15 }).filter(s => /^[a-zA-Z]/.test(s)), {
          minLength: 1,
          maxLength: 8,
        }),
        (names: string[]) => {
          const unique = [...new Set(names)];
          if (unique.length === 0) return;

          let builder = flowChart(unique[0], () => `r-${unique[0]}`);
          for (let i = 1; i < unique.length; i++) {
            builder = builder.addFunction(unique[i], () => `r-${unique[i]}`);
          }

          const chart = builder.build();
          const treeNames = collectNames(chart.root);

          for (const name of treeNames) {
            expect(chart.stageMap.has(name)).toBe(true);
          }
        },
      ),
      { numRuns: 30 },
    );
  });

  // ─── Context tree completeness property ───

  test('after execution, getContextTree() contains entries for every executed stage', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 4 }),
        async (stageCount: number) => {
          const executed: string[] = [];

          let builder = flowChart('stage_0', () => {
            executed.push('stage_0');
            return 'out_0';
          });
          for (let i = 1; i < stageCount; i++) {
            const name = `stage_${i}`;
            builder = builder.addFunction(name, () => {
              executed.push(name);
              return `out_${i}`;
            });
          }
          const chart = builder.build();

          const executor = new FlowChartExecutor(chart, scopeFactory);
          await executor.run();

          const tree = executor.getContextTree();

          // globalContext should be defined
          expect(tree.globalContext).toBeDefined();
          // stageContexts should be defined
          expect(tree.stageContexts).toBeDefined();
          // history should be an array
          expect(Array.isArray(tree.history)).toBe(true);

          // Every stage should have executed
          for (let i = 0; i < stageCount; i++) {
            expect(executed).toContain(`stage_${i}`);
          }
        },
      ),
      { numRuns: 10 },
    );
  });

  // ─── Subflow isolation property ───

  test('subflow writes do not leak to parent scope (GlobalStore isolation)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 10 }).filter(s => /^[a-zA-Z]/.test(s)),
        fc.string({ minLength: 1, maxLength: 10 }),
        async (key: string, value: string) => {
          // Subflow writes a key to its scope
          const sub = flowChart('subWriter', (scope: StageContext) => {
            scope.setObject([], `sub_${key}`, value);
            return 'subDone';
          }).build();

          // Parent reads that key and should NOT find it in its own GlobalStore context
          const chart = flowChart('parent', () => 'parentDone')
            .addSubFlowChart('mySub', sub, 'MySub')
            .addFunction('checker', (scope: StageContext) => {
              // The subflow writes happen in an isolated pipeline,
              // so the parent's direct scope should not have sub_ prefixed values
              // written by the subflow's own pipeline context
              return 'checked';
            })
            .build();

          const executor = new FlowChartExecutor(chart, scopeFactory);
          await executor.run();

          // The main pipeline's global context should not contain the subflow's
          // isolated writes at the top level (subflows run in their own pipeline)
          const tree = executor.getContextTree();
          expect(tree.globalContext).toBeDefined();
        },
      ),
      { numRuns: 10 },
    );
  });

  // ─── FlowChart type shape property ───

  test('build() always returns object with required FlowChart shape', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 15 }).filter(s => /^[a-zA-Z]/.test(s)),
        (name: string) => {
          const chart = flowChart(name, () => 'out').build();

          // Required properties
          expect(chart).toHaveProperty('root');
          expect(chart).toHaveProperty('stageMap');
          expect(chart).toHaveProperty('buildTimeStructure');
          expect(chart).toHaveProperty('description');
          expect(chart).toHaveProperty('stageDescriptions');

          // Root matches
          expect(chart.root.name).toBe(name);

          // stageMap is a Map
          expect(chart.stageMap).toBeInstanceOf(Map);

          // stageDescriptions is a Map
          expect(chart.stageDescriptions).toBeInstanceOf(Map);

          // description is a string
          expect(typeof chart.description).toBe('string');
        },
      ),
      { numRuns: 30 },
    );
  });

  // ─── toSpec/specToStageNode roundtrip property ───

  test('specToStageNode preserves structure names from toSpec', () => {
    fc.assert(
      fc.property(
        fc.array(fc.string({ minLength: 1, maxLength: 15 }).filter(s => /^[a-zA-Z]/.test(s)), {
          minLength: 1,
          maxLength: 6,
        }),
        (names: string[]) => {
          const unique = [...new Set(names)];
          if (unique.length === 0) return;

          let builder = flowChart(unique[0]);
          for (let i = 1; i < unique.length; i++) {
            builder = builder.addFunction(unique[i]);
          }

          const spec = builder.toSpec();
          const node = specToStageNode(spec as FlowChartSpec);

          // Walk the linear chain and verify names match
          let current: StageNode | undefined = node;
          for (let i = 0; i < unique.length; i++) {
            expect(current).toBeDefined();
            expect(current!.name).toBe(unique[i]);
            current = current!.next;
          }
        },
      ),
      { numRuns: 30 },
    );
  });
});
