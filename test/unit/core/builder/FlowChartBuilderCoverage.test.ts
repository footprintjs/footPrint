/**
 * FlowChartBuilderCoverage.test.ts
 *
 * Targeted tests to increase statement coverage of FlowChartBuilder.ts.
 * Each describe block maps to a set of previously uncovered lines.
 */

import fc from 'fast-check';
import { FlowChartBuilder, flowChart } from '../../../../src/core/builder/FlowChartBuilder';
import type {
  FlowChart,
  SerializedPipelineStructure,
  BuildTimeExtractor,
} from '../../../../src/core/builder/FlowChartBuilder';

/* --------------------------------------------------------------------------
 * Helpers
 * ----------------------------------------------------------------------- */

const noop = async () => {};

/** Build a minimal subflow FlowChart for mounting. */
function makeSubflow(rootName = 'SubRoot', nextName?: string): FlowChart {
  const b = new FlowChartBuilder().start(rootName, noop);
  if (nextName) b.addFunction(nextName, noop);
  return b.build();
}

/** Build a subflow that itself contains nested subflows. */
function makeNestedSubflow(): FlowChart {
  const inner = new FlowChartBuilder()
    .start('InnerRoot', noop)
    .addFunction('InnerStep', noop)
    .build();
  const outer = new FlowChartBuilder()
    .start('OuterRoot', noop)
    .addSubFlowChart('innerMount', inner, 'Inner')
    .build();
  return outer;
}

/* ==========================================================================
 * Lines 412-415: DeciderList.addSubFlowChartBranch — merging nested subflows
 * ========================================================================== */

describe('DeciderList.addSubFlowChartBranch — nested subflow merge (lines 412-415)', () => {
  test('merges nested subflow definitions from the branch subflow', () => {
    const nested = makeNestedSubflow();
    // nested.subflows should have "innerMount"
    expect(nested.subflows).toBeDefined();

    const main = new FlowChartBuilder()
      .start('entry', noop)
      .addDeciderFunction('Decider', () => 'branchA')
        .addSubFlowChartBranch('branchA', nested, 'BranchA')
        .addFunctionBranch('branchB', 'BranchB', noop)
      .end()
      .build();

    // The nested subflow's inner subflows should be merged with prefix "branchA/"
    expect(main.subflows).toBeDefined();
    expect(main.subflows!['branchA']).toBeDefined();
    expect(main.subflows!['branchA/innerMount']).toBeDefined();
  });
});

/* ==========================================================================
 * Lines 440-443: DeciderList.addBranchList
 * ========================================================================== */

describe('DeciderList.addBranchList (lines 440-443)', () => {
  test('adds multiple branches via addBranchList', () => {
    const { root } = new FlowChartBuilder()
      .start('chooser', noop)
      .addDeciderFunction('Decider', () => 'a')
        .addBranchList([
          { id: 'a', name: 'Alpha', fn: noop, displayName: 'Alpha Display' },
          { id: 'b', name: 'Beta', fn: noop },
        ])
      .end()
      .build();

    expect(root.next!.children).toHaveLength(2);
    expect(root.next!.children![0].id).toBe('a');
    expect(root.next!.children![1].id).toBe('b');
  });
});

/* ==========================================================================
 * DeciderList.end() scope-based decider — verifies deciderFn is set
 * ========================================================================== */

describe('DeciderList.end() sets deciderFn on the node', () => {
  test('sets deciderFn = true on the decider node', () => {
    const { root } = new FlowChartBuilder()
      .start('dec', noop)
      .addDeciderFunction('Decider', () => 'UNKNOWN')
        .addFunctionBranch('left', 'Left', noop)
      .end()
      .build();

    // addDeciderFunction creates a new node as root.next
    const deciderNode = root.next!;
    expect(deciderNode.deciderFn).toBe(true);
    expect(deciderNode.children).toHaveLength(1);
  });
});

/* ==========================================================================
 * Lines 506, 513, 517: DeciderList.end() description accumulation paths
 *   - 506: deciderDescription is truthy → store in stageDescriptions
 *   - 513: branch has description → append arrow line
 *   - 517: branch.description is truthy → store in stageDescriptions
 * ========================================================================== */

describe('DeciderList.end() description accumulation (lines 506, 513, 517)', () => {
  test('scope-based decider with description and branch descriptions', () => {
    const chart = new FlowChartBuilder()
      .start('entry', noop, 'entry-id', 'Entry')
      .addDeciderFunction(
        'Router',
        noop,
        'router-id',
        'Route Display',
        'Decides the routing path',
      )
        .addFunctionBranch('fast', 'FastPath', noop, 'Fast Display', 'Handles fast requests')
        .addFunctionBranch('slow', 'SlowPath', noop, 'Slow Display', 'Handles slow requests')
      .end()
      .build();

    // Line 506: deciderDescription stored in stageDescriptions for the decider name
    expect(chart.stageDescriptions.get('Router')).toBe('Decides the routing path');

    // Line 517: branch descriptions stored in stageDescriptions by branch id
    expect(chart.stageDescriptions.get('fast')).toBe('Handles fast requests');
    expect(chart.stageDescriptions.get('slow')).toBe('Handles slow requests');

    // Line 513: arrow lines in description
    expect(chart.description).toContain('fast: Handles fast requests');
    expect(chart.description).toContain('slow: Handles slow requests');
  });

  test('decider without deciderDescription uses auto-generated line', () => {
    const chart = new FlowChartBuilder()
      .start('entry', noop, 'entry-id', 'Entry')
      .addDeciderFunction('Decider', () => 'a')
        .addFunctionBranch('a', 'Alpha', noop, 'Alpha Display')
        .addFunctionBranch('b', 'Beta', noop)
      .end()
      .build();

    // Without deciderDescription, the line should say "Decides between: a, b"
    expect(chart.description).toContain('Decides between: a, b');
    // Branch with displayName but no description: branchText = displayName
    expect(chart.description).toContain('a: Alpha Display');
  });

  test('branch with displayName but no description uses displayName as arrow text', () => {
    const chart = new FlowChartBuilder()
      .start('entry', noop)
      .addDeciderFunction('Decider', noop, undefined, undefined, 'My decider')
        .addFunctionBranch('x', 'Xbranch', noop, 'XDisplay')
        .addFunctionBranch('y', 'Ybranch', noop)
      .end()
      .build();

    // 'x' has displayName 'XDisplay' → arrow line uses displayName
    expect(chart.description).toContain('x: XDisplay');
    // 'y' has no displayName and no description → no arrow line for it
    // Verify 'y' is NOT in the arrow lines
    const lines = chart.description.split('\n');
    const yArrowLines = lines.filter(l => l.includes('y:'));
    expect(yArrowLines).toHaveLength(0);
  });
});

/* ==========================================================================
 * Lines 685-688: SelectorList.addSubFlowChartBranch — merging nested subflows
 * ========================================================================== */

describe('SelectorList.addSubFlowChartBranch — nested subflow merge (lines 685-688)', () => {
  test('merges nested subflow definitions from the selector branch subflow', () => {
    const nested = makeNestedSubflow();

    const selectorFn = async () => ['branchA'];
    const main = new FlowChartBuilder()
      .start('entry', noop)
      .addSelector(selectorFn)
        .addSubFlowChartBranch('branchA', nested, 'BranchA')
        .addFunctionBranch('branchB', 'BranchB', noop)
      .end()
      .build();

    expect(main.subflows).toBeDefined();
    expect(main.subflows!['branchA']).toBeDefined();
    expect(main.subflows!['branchA/innerMount']).toBeDefined();
  });
});

/* ==========================================================================
 * Lines 749, 753: SelectorList.end() description arrow lines
 *   - 749: branch with description or displayName → push arrow line
 *   - 753: branch.description truthy → store in stageDescriptions
 * ========================================================================== */

describe('SelectorList.end() description accumulation (lines 749, 753)', () => {
  test('selector branches with description and displayName generate arrow lines', () => {
    const selectorFn = async () => ['a'];
    const chart = new FlowChartBuilder()
      .start('entry', noop, 'entry-id', 'Entry')
      .addSelector(selectorFn)
        .addFunctionBranch('a', 'Alpha', noop, 'Alpha Display', 'Handles alpha')
        .addFunctionBranch('b', 'Beta', noop, 'Beta Display')
        .addFunctionBranch('c', 'Gamma', noop)
      .end()
      .build();

    // Line 749: arrow lines for branches with description or displayName
    expect(chart.description).toContain('a: Handles alpha');
    expect(chart.description).toContain('b: Beta Display');
    // Branch 'c' has neither description nor displayName → no arrow line
    const lines = chart.description.split('\n');
    const cArrowLines = lines.filter(l => l.trim().startsWith('→ c:'));
    expect(cArrowLines).toHaveLength(0);

    // Line 753: branch descriptions stored by id
    expect(chart.stageDescriptions.get('a')).toBe('Handles alpha');
    // 'b' has displayName but no description → NOT stored
    expect(chart.stageDescriptions.has('b')).toBe(false);
  });

  test('selector description contains "Selects from:" with branch ids', () => {
    const selectorFn = async () => ['x'];
    const chart = new FlowChartBuilder()
      .start('root', noop, undefined, 'Root Display')
      .addSelector(selectorFn)
        .addFunctionBranch('x', 'X', noop)
        .addFunctionBranch('y', 'Y', noop)
      .end()
      .build();

    expect(chart.description).toContain('Selects from: x, y');
  });
});

/* ==========================================================================
 * Line 849: _appendDescriptionLine — storing description in _stageDescriptions
 * ========================================================================== */

describe('_appendDescriptionLine — description storage (line 849)', () => {
  test('stage descriptions are stored when description is provided', () => {
    const chart = flowChart('entry', noop, undefined, undefined, undefined, 'Entry desc')
      .addFunction('step1', noop, undefined, 'Step 1', 'Does step 1')
      .addFunction('step2', noop, undefined, 'Step 2')
      .build();

    expect(chart.stageDescriptions.get('entry')).toBe('Entry desc');
    expect(chart.stageDescriptions.get('step1')).toBe('Does step 1');
    // step2 has no description → not in stageDescriptions
    expect(chart.stageDescriptions.has('step2')).toBe(false);
  });
});

/* ==========================================================================
 * Line 903: start() called twice → error
 * ========================================================================== */

describe('start() called twice (line 903)', () => {
  test('throws when start is called on a builder that already has a root', () => {
    const b = new FlowChartBuilder();
    b.start('first', noop);
    expect(() => b.start('second', noop)).toThrow(/root already defined/i);
  });
});

/* ==========================================================================
 * Line 1326: addSubFlowChartNext when next is already defined
 * ========================================================================== */

describe('addSubFlowChartNext — next already defined (line 1326)', () => {
  test('throws when cursor already has next defined and addSubFlowChartNext is called', () => {
    const sub = makeSubflow();
    // Manually set cursor.next to simulate having a next already set
    const b = new FlowChartBuilder().start('entry', noop);
    b.addFunction('mid', noop);
    (b as any)._cursor.next = { name: 'existing' };
    expect(() => b.addSubFlowChartNext('sub', sub)).toThrow(
      /cannot add subflow as next when next is already defined/i,
    );
  });
});

/* ==========================================================================
 * Lines 1389-1392: addSubFlowChartNext — merging nested subflows
 * ========================================================================== */

describe('addSubFlowChartNext — nested subflow merge (lines 1389-1392)', () => {
  test('merges nested subflow definitions when mounting as next', () => {
    const nested = makeNestedSubflow();

    const main = new FlowChartBuilder()
      .start('entry', noop)
      .addSubFlowChartNext('mount', nested, 'Mount')
      .build();

    expect(main.subflows).toBeDefined();
    expect(main.subflows!['mount']).toBeDefined();
    expect(main.subflows!['mount/innerMount']).toBeDefined();
  });
});

/* ==========================================================================
 * Lines 1499-1505: onStreamStart, onStreamEnd stream lifecycle handlers
 * ========================================================================== */

describe('Streaming lifecycle handlers (lines 1499-1505)', () => {
  test('onStreamStart registers the onStart handler', () => {
    const handler = jest.fn();
    const b = new FlowChartBuilder()
      .start('entry', noop)
      .onStreamStart(handler);
    // The handler is stored internally; verify via build + mock executor
    // We can verify it was stored by checking the internal _streamHandlers
    expect((b as any)._streamHandlers.onStart).toBe(handler);
  });

  test('onStreamEnd registers the onEnd handler', () => {
    const handler = jest.fn();
    const b = new FlowChartBuilder()
      .start('entry', noop)
      .onStreamEnd(handler);
    expect((b as any)._streamHandlers.onEnd).toBe(handler);
  });

  test('onStream registers the onToken handler', () => {
    const handler = jest.fn();
    const b = new FlowChartBuilder()
      .start('entry', noop)
      .onStream(handler);
    expect((b as any)._streamHandlers.onToken).toBe(handler);
  });
});

/* ==========================================================================
 * Line 1581: execute() with enableNarrative option
 * ========================================================================== */

// Mock the executor to inspect narrative flag
const mockCtorArgs: any[][] = [];
const mockRunResult = 'MOCK_RUN_RESULT';

jest.mock('../../../../src/core/executor/FlowChartExecutor', () => ({
  FlowChartExecutor: class {
    constructor(...args: any[]) {
      mockCtorArgs.push(args);
    }
    async run() {
      return mockRunResult;
    }
  },
}));

describe('execute() with enableNarrative (line 1581)', () => {
  beforeEach(() => {
    mockCtorArgs.length = 0;
  });

  test('sets _enableNarrative when opts.enableNarrative is true', async () => {
    const scopeFactory = (() => ({})) as any;
    const b = new FlowChartBuilder().start('entry', noop);

    await b.execute(scopeFactory, { enableNarrative: true });

    // The FlowChart passed to executor should have enableNarrative: true
    expect(mockCtorArgs.length).toBe(1);
    const flowChartArg = mockCtorArgs[0][0];
    expect(flowChartArg.enableNarrative).toBe(true);
  });

  test('does not set enableNarrative when opts.enableNarrative is falsy', async () => {
    const scopeFactory = (() => ({})) as any;
    const b = new FlowChartBuilder().start('entry', noop);

    await b.execute(scopeFactory, {});

    expect(mockCtorArgs.length).toBe(1);
    const flowChartArg = mockCtorArgs[0][0];
    expect(flowChartArg.enableNarrative).toBeUndefined();
  });
});

/* ==========================================================================
 * Lines 1680-1681: _mergeStageMap collision with same key but different fn
 * ========================================================================== */

describe('_mergeStageMap collision (lines 1680-1681)', () => {
  test('throws when merging stage map with conflicting function for same prefixed key', () => {
    const fnA = async () => 'a';
    const fnB = async () => 'b';

    const b = new FlowChartBuilder().start('entry', noop);
    // Manually insert a prefixed key
    (b as any)._stageMap.set('prefix/stage', fnA);

    const other = new Map<string, any>([['stage', fnB]]);
    expect(() => b._mergeStageMap(other, 'prefix')).toThrow(
      /stageMap collision while mounting flowchart at 'prefix\/stage'/i,
    );
  });

  test('allows merging when same key maps to the same function reference', () => {
    const fn = async () => 'same';

    const b = new FlowChartBuilder().start('entry', noop);
    (b as any)._stageMap.set('prefix/stage', fn);

    const other = new Map<string, any>([['stage', fn]]);
    // Should NOT throw — same fn reference
    expect(() => b._mergeStageMap(other, 'prefix')).not.toThrow();
  });
});

/* ==========================================================================
 * Line 1745: _appendSubflowDescription — subflow without description
 * ========================================================================== */

describe('_appendSubflowDescription — subflow without description (line 1745)', () => {
  test('generates simple label when subflow has empty description (line 1745)', () => {
    // Build a subflow, then manually set its description to empty string
    // to trigger the else branch at line 1745
    const sub = new FlowChartBuilder().start('SubRoot', noop).build();
    // Override the description to be falsy (empty string)
    (sub as any).description = '';

    const chart = new FlowChartBuilder()
      .start('entry', noop)
      .addSubFlowChartNext('mount', sub, 'MyMount')
      .build();

    // Should hit line 1745: simple label without " — "
    expect(chart.description).toContain('[Sub-Execution: MyMount]');
    const descLines = chart.description.split('\n');
    const subLine = descLines.find(l => l.includes('[Sub-Execution: MyMount]'));
    expect(subLine).toBeDefined();
    // Should NOT contain " — " after the sub-execution label
    expect(subLine).not.toContain(' — ');
  });

  test('generates simple label for addSubFlowChart with empty description (line 1745)', () => {
    const sub = new FlowChartBuilder().start('SubRoot', noop).build();
    (sub as any).description = '';

    const chart = new FlowChartBuilder()
      .start('entry', noop)
      .addSubFlowChart('mount', sub, 'MyMount')
      .build();

    expect(chart.description).toContain('[Sub-Execution: MyMount]');
    const descLines = chart.description.split('\n');
    const subLine = descLines.find(l => l.includes('[Sub-Execution: MyMount]'));
    expect(subLine).not.toContain(' — ');
  });

  test('generates detailed label with indented steps when subflow has description', () => {
    const sub = new FlowChartBuilder()
      .start('SubRoot', noop, undefined, 'Sub Root', 'Initialize sub')
      .addFunction('SubStep', noop, undefined, 'Sub Step', 'Process sub')
      .build();

    // sub.description should contain "Steps:" with indented lines
    expect(sub.description).toContain('Steps:');

    const chart = new FlowChartBuilder()
      .start('entry', noop)
      .addSubFlowChartNext('mount', sub, 'MyMount')
      .build();

    expect(chart.description).toContain('[Sub-Execution: MyMount]');
    // The sub-steps should be indented
    expect(chart.description).toContain('Sub Root');
  });
});

/* ==========================================================================
 * _applyExtractorToNode — error handling (lines 1643-1650)
 * ========================================================================== */

describe('_applyExtractorToNode — extractor error handling', () => {
  test('catches extractor errors and stores them in buildTimeExtractorErrors', () => {
    const errorExtractor: BuildTimeExtractor<any> = () => {
      throw new Error('Extractor boom');
    };

    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const b = new FlowChartBuilder(errorExtractor);
    b.start('entry', noop);

    const errors = b.getBuildTimeExtractorErrors();
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].message).toBe('Extractor boom');

    consoleSpy.mockRestore();
  });

  test('returns original spec when extractor throws', () => {
    const errorExtractor: BuildTimeExtractor<any> = () => {
      throw new Error('Extractor failed');
    };

    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const chart = new FlowChartBuilder(errorExtractor)
      .start('entry', noop)
      .addFunction('step', noop)
      .build();

    // Despite errors, the chart should still be built
    expect(chart.root.name).toBe('entry');
    expect(chart.root.next?.name).toBe('step');

    consoleSpy.mockRestore();
  });
});

/* ==========================================================================
 * SelectorList.addBranchList (lines 704-716 in SelectorList)
 * ========================================================================== */

describe('SelectorList.addBranchList', () => {
  test('adds multiple branches to a selector via addBranchList', () => {
    const selectorFn = async () => ['a'];
    const { root } = new FlowChartBuilder()
      .start('entry', noop)
      .addSelector(selectorFn)
        .addBranchList([
          { id: 'a', name: 'Alpha', fn: noop, displayName: 'Alpha Display' },
          { id: 'b', name: 'Beta', fn: noop },
        ])
      .end()
      .build();

    expect(root.children).toHaveLength(2);
    expect(root.children![0].id).toBe('a');
    expect(root.children![1].id).toBe('b');
  });
});

/* ==========================================================================
 * SelectorList.end() — no branches throws
 * ========================================================================== */

describe('SelectorList.end() — requires at least one branch', () => {
  test('throws when selector has no branches', () => {
    const selectorFn = async () => ['a'];
    const b = new FlowChartBuilder().start('entry', noop);
    const sl = b.addSelector(selectorFn);
    expect(() => sl.end()).toThrow(/requires at least one branch/i);
  });
});

/* ==========================================================================
 * addDeciderFunction validation edge cases
 * ========================================================================== */

describe('addDeciderFunction — validation edge cases', () => {
  test('throws when decider already defined via addDeciderFunction', () => {
    const b = new FlowChartBuilder().start('entry', noop);
    // Actually, addDeciderFunction sets hasDecider on spec and returns DeciderList.
    // The check is on cur.deciderFn.
    // We need to set up a scenario where cursor already has these.

    // Use addDeciderFunction, then try addDeciderFunction again:
    // After addDeciderFunction, cursor moves to the NEW decider node, which has fn set.
    // We need to end() first, then the cursor is back on the builder's main chain.
    // But after end(), cursor stays at the decider node.

    // Actually the simplest test: manually set the cursor's properties
    const b2 = new FlowChartBuilder().start('entry', noop);
    (b2 as any)._cursor.deciderFn = true;
    expect(() => b2.addDeciderFunction('Dec', noop)).toThrow(/decider already defined/i);
  });

  test('throws when selector already defined and trying to add decider', () => {
    const b = new FlowChartBuilder().start('entry', noop);
    (b as any)._cursor.nextNodeSelector = async () => ['a'];
    expect(() => b.addDeciderFunction('Dec', noop)).toThrow(
      /decider and selector are mutually exclusive/i,
    );
  });
});

/* ==========================================================================
 * addSelector validation edge cases
 * ========================================================================== */

describe('addSelector — validation edge cases', () => {
  test('throws when selector already defined', () => {
    const b = new FlowChartBuilder().start('entry', noop);
    (b as any)._cursor.nextNodeSelector = async () => ['a'];
    expect(() => b.addSelector(async () => ['x'])).toThrow(/selector already defined/i);
  });

  test('throws when decider already defined (mutually exclusive)', () => {
    const b = new FlowChartBuilder().start('entry', noop);
    (b as any)._cursor.deciderFn = true;
    expect(() => b.addSelector(async () => ['x'])).toThrow(
      /decider and selector are mutually exclusive/i,
    );
  });
});

/* ==========================================================================
 * addStreamingFunction edge cases
 * ========================================================================== */

describe('addStreamingFunction edge cases', () => {
  test('creates streaming node with all optional parameters', () => {
    const chart = new FlowChartBuilder()
      .start('entry', noop)
      .addStreamingFunction('stream1', 'customStreamId', noop, 'stream-id', 'Stream Display', 'Streams data')
      .build();

    const streamNode = chart.root.next;
    expect(streamNode).toBeDefined();
    expect(streamNode!.name).toBe('stream1');
    expect(streamNode!.isStreaming).toBe(true);
    expect(streamNode!.streamId).toBe('customStreamId');
    expect(streamNode!.id).toBe('stream-id');
    expect(streamNode!.displayName).toBe('Stream Display');

    // buildTimeStructure should reflect streaming type
    expect(chart.buildTimeStructure.next?.type).toBe('streaming');
    expect(chart.buildTimeStructure.next?.isStreaming).toBe(true);
  });

  test('defaults streamId to name when streamId is not provided', () => {
    const chart = new FlowChartBuilder()
      .start('entry', noop)
      .addStreamingFunction('stream1', undefined, noop)
      .build();

    expect(chart.root.next!.streamId).toBe('stream1');
  });
});

/* ==========================================================================
 * addSubFlowChart — nested subflow merging (lines 1281-1293)
 * ========================================================================== */

describe('addSubFlowChart — nested subflow merging', () => {
  test('merges nested subflow definitions when mounting as child', () => {
    const nested = makeNestedSubflow();

    const main = new FlowChartBuilder()
      .start('entry', noop)
      .addSubFlowChart('outer', nested, 'Outer')
      .build();

    expect(main.subflows).toBeDefined();
    expect(main.subflows!['outer']).toBeDefined();
    expect(main.subflows!['outer/innerMount']).toBeDefined();
  });
});

/* ==========================================================================
 * loopTo edge cases
 * ========================================================================== */

describe('loopTo edge cases', () => {
  test('loopTo throws when loopTarget already defined', () => {
    const b = new FlowChartBuilder()
      .start('entry', noop)
      .addFunction('step', noop)
      .loopTo('entry');

    // cursor is now at 'step' which already has loopTarget set
    // But cursor.next is also set by loopTo. So we can't call loopTo again.
    // The error should have been captured. Let's test this properly:
    const b2 = new FlowChartBuilder()
      .start('entry', noop)
      .addFunction('step', noop);
    b2.loopTo('entry');
    // Now cursor is still at 'step' (loopTo doesn't move cursor).
    // Calling loopTo again on the same cursor should throw
    expect(() => b2.loopTo('entry')).toThrow(/loopTo already defined/i);
  });

  test('loopTo description includes step number when target was registered', () => {
    const chart = new FlowChartBuilder()
      .start('entry', noop)
      .addFunction('process', noop)
      .addFunction('check', noop)
      .loopTo('entry')
      .build();

    expect(chart.description).toContain('loops back to step 1');
  });

  test('loopTo description uses stageId when target step number is not found', () => {
    const b = new FlowChartBuilder()
      .start('entry', noop)
      .addFunction('process', noop);
    // loopTo a stageId that was never registered via addFunction/start
    b.loopTo('nonexistent');
    const chart = b.build();
    expect(chart.description).toContain('loops back to nonexistent');
  });
});

/* ==========================================================================
 * toSpec edge case — empty tree
 * ========================================================================== */

describe('toSpec — empty tree', () => {
  test('throws when toSpec is called without start', () => {
    const b = new FlowChartBuilder();
    expect(() => b.toSpec()).toThrow(/empty tree; call start\(\) first/i);
  });
});

/* ==========================================================================
 * build() edge case — empty tree
 * ========================================================================== */

describe('build — empty tree', () => {
  test('throws when build is called without start', () => {
    const b = new FlowChartBuilder();
    expect(() => b.build()).toThrow(/empty tree; call start\(\) first/i);
  });
});

/* ==========================================================================
 * flowChart factory function
 * ========================================================================== */

describe('flowChart factory function', () => {
  test('creates a builder with start already called', () => {
    const chart = flowChart('entry', noop, 'entry-id', 'Entry Display')
      .addFunction('step', noop)
      .build();

    expect(chart.root.name).toBe('entry');
    expect(chart.root.id).toBe('entry-id');
    expect(chart.root.displayName).toBe('Entry Display');
    expect(chart.root.next?.name).toBe('step');
  });

  test('passes build time extractor to builder', () => {
    const extractor: BuildTimeExtractor<any> = (node) => ({
      ...node,
      custom: true,
    });

    const chart = flowChart('entry', noop, 'id', 'display', extractor)
      .addFunction('step', noop)
      .build();

    expect((chart.buildTimeStructure as any).custom).toBe(true);
    expect((chart.buildTimeStructure.next as any).custom).toBe(true);
  });

  test('passes description to start', () => {
    const chart = flowChart('entry', noop, undefined, undefined, undefined, 'My entry desc')
      .build();

    expect(chart.stageDescriptions.get('entry')).toBe('My entry desc');
    expect(chart.description).toContain('My entry desc');
  });
});

/* ==========================================================================
 * DeciderList.end() — scope-based decider sets deciderFn = true
 * ========================================================================== */

describe('DeciderList.end() — scope-based decider (line 473)', () => {
  test('scope-based decider sets deciderFn = true and does not set nextNodeDecider', () => {
    const { root } = new FlowChartBuilder()
      .start('entry', noop)
      .addDeciderFunction('Router', noop)
        .addFunctionBranch('a', 'Alpha', noop)
      .end()
      .build();

    const deciderNode = root.next;
    expect(deciderNode).toBeDefined();
    expect(deciderNode!.name).toBe('Router');
    expect(deciderNode!.deciderFn).toBe(true);
    expect(deciderNode!.nextNodeDecider).toBeUndefined();
  });
});

/* ==========================================================================
 * Scope-based decider with async function
 * ========================================================================== */

describe('DeciderList.end() — scope-based decider with async decider function', () => {
  test('sets deciderFn = true and preserves async fn', () => {
    const { root } = new FlowChartBuilder()
      .start('entry', noop)
      .addDeciderFunction('Decider', async () => 'branchA')
        .addFunctionBranch('branchA', 'A', noop)
        .addFunctionBranch('branchB', 'B', noop)
      .end()
      .build();

    // addDeciderFunction creates a new node as root.next
    const deciderNode = root.next!;
    expect(deciderNode.deciderFn).toBe(true);
    expect(deciderNode.fn).toBeDefined();
    expect(deciderNode.children).toHaveLength(2);
  });
});

/* ==========================================================================
 * Duplicate branch IDs in DeciderList and SelectorList
 * ========================================================================== */

describe('Duplicate branch IDs', () => {
  test('DeciderList throws on duplicate branch id', () => {
    expect(() => {
      new FlowChartBuilder()
        .start('entry', noop)
        .addDeciderFunction('Decider', () => 'a')
          .addFunctionBranch('a', 'Alpha', noop)
          .addFunctionBranch('a', 'Alpha2', noop);
    }).toThrow(/duplicate decider branch id 'a'/i);
  });

  test('SelectorList throws on duplicate branch id', () => {
    expect(() => {
      new FlowChartBuilder()
        .start('entry', noop)
        .addSelector(async () => ['a'])
          .addFunctionBranch('a', 'Alpha', noop)
          .addFunctionBranch('a', 'Alpha2', noop);
    }).toThrow(/duplicate selector branch id 'a'/i);
  });

  test('DeciderList.addSubFlowChartBranch throws on duplicate branch id', () => {
    const sub = makeSubflow();
    expect(() => {
      new FlowChartBuilder()
        .start('entry', noop)
        .addDeciderFunction('Decider', () => 'a')
          .addSubFlowChartBranch('a', sub, 'A')
          .addSubFlowChartBranch('a', sub, 'A2');
    }).toThrow(/duplicate decider branch id 'a'/i);
  });

  test('SelectorList.addSubFlowChartBranch throws on duplicate branch id', () => {
    const sub = makeSubflow();
    expect(() => {
      new FlowChartBuilder()
        .start('entry', noop)
        .addSelector(async () => ['a'])
          .addSubFlowChartBranch('a', sub, 'A')
          .addSubFlowChartBranch('a', sub, 'A2');
    }).toThrow(/duplicate selector branch id 'a'/i);
  });
});

/* ==========================================================================
 * setEnableNarrative
 * ========================================================================== */

describe('setEnableNarrative', () => {
  test('sets enableNarrative on built FlowChart', () => {
    const chart = new FlowChartBuilder()
      .start('entry', noop)
      .setEnableNarrative()
      .build();

    expect(chart.enableNarrative).toBe(true);
  });

  test('enableNarrative is not set when setEnableNarrative is not called', () => {
    const chart = new FlowChartBuilder()
      .start('entry', noop)
      .build();

    expect(chart.enableNarrative).toBeUndefined();
  });
});

/* ==========================================================================
 * addSubFlowChart with subflowMountOptions
 * ========================================================================== */

describe('addSubFlowChart/addSubFlowChartNext with mount options', () => {
  test('addSubFlowChart stores subflowMountOptions on node', () => {
    const sub = makeSubflow();
    const options = { inputMapping: { key: 'value' } } as any;
    const chart = new FlowChartBuilder()
      .start('entry', noop)
      .addSubFlowChart('mount', sub, 'Mount', options)
      .build();

    const child = chart.root.children?.[0];
    expect(child?.subflowMountOptions).toEqual(options);
  });

  test('addSubFlowChartNext stores subflowMountOptions on node', () => {
    const sub = makeSubflow();
    const options = { outputMapping: { key: 'value' } } as any;
    const chart = new FlowChartBuilder()
      .start('entry', noop)
      .addSubFlowChartNext('mount', sub, 'Mount', options)
      .build();

    const nextNode = chart.root.next;
    expect(nextNode?.subflowMountOptions).toEqual(options);
  });
});

/* ==========================================================================
 * DeciderList.addSubFlowChartBranch with mount options
 * ========================================================================== */

describe('DeciderList.addSubFlowChartBranch with mount options', () => {
  test('stores subflowMountOptions on branch node', () => {
    const sub = makeSubflow();
    const options = { inputMapping: { key: 'val' } } as any;
    const { root } = new FlowChartBuilder()
      .start('entry', noop)
      .addDeciderFunction('Decider', () => 'a')
        .addSubFlowChartBranch('a', sub, 'A', options)
      .end()
      .build();

    expect(root.next!.children?.[0]?.subflowMountOptions).toEqual(options);
  });
});

/* ==========================================================================
 * SelectorList.addSubFlowChartBranch with mount options
 * ========================================================================== */

describe('SelectorList.addSubFlowChartBranch with mount options', () => {
  test('stores subflowMountOptions on branch node', () => {
    const sub = makeSubflow();
    const options = { outputMapping: { key: 'val' } } as any;
    const { root } = new FlowChartBuilder()
      .start('entry', noop)
      .addSelector(async () => ['a'])
        .addSubFlowChartBranch('a', sub, 'A', options)
      .end()
      .build();

    expect(root.children?.[0]?.subflowMountOptions).toEqual(options);
  });
});

/* ==========================================================================
 * Property-based tests with fast-check
 * ========================================================================== */

describe('Property-based tests (fast-check)', () => {
  // Arbitrary that generates a valid builder chain configuration
  const stageName = fc.string({ minLength: 1, maxLength: 20 })
    .filter(s => /^[a-zA-Z]/.test(s) && !s.includes('\n'));

  const uniqueStageNames = (count: number) =>
    fc.uniqueArray(stageName, { minLength: count, maxLength: count });

  test('any valid linear builder chain produces a valid FlowChart', () => {
    fc.assert(
      fc.property(
        uniqueStageNames(5),
        (names) => {
          const [root, ...rest] = names;
          const b = new FlowChartBuilder().start(root, noop);
          for (const name of rest) {
            b.addFunction(name, noop);
          }
          const chart = b.build();

          // Validate structure
          expect(chart.root).toBeDefined();
          expect(chart.root.name).toBe(root);
          expect(chart.stageMap).toBeInstanceOf(Map);
          expect(chart.buildTimeStructure).toBeDefined();
          expect(chart.buildTimeStructure.name).toBe(root);
          expect(typeof chart.description).toBe('string');
          expect(chart.stageDescriptions).toBeInstanceOf(Map);
        },
      ),
      { numRuns: 50 },
    );
  });

  test('stageMap always contains all registered functions', () => {
    fc.assert(
      fc.property(
        uniqueStageNames(6),
        (names) => {
          const [root, ...rest] = names;
          const b = new FlowChartBuilder().start(root, noop);
          for (const name of rest) {
            b.addFunction(name, noop);
          }
          const chart = b.build();

          // All names with functions should be in stageMap
          for (const name of names) {
            expect(chart.stageMap.has(name)).toBe(true);
          }
          expect(chart.stageMap.size).toBe(names.length);
        },
      ),
      { numRuns: 50 },
    );
  });

  test('description is always a string (never undefined) when stages have descriptions', () => {
    fc.assert(
      fc.property(
        uniqueStageNames(4),
        fc.array(fc.string({ minLength: 1, maxLength: 40 }), { minLength: 4, maxLength: 4 }),
        (names, descriptions) => {
          const [root, ...rest] = names;
          const b = new FlowChartBuilder().start(root, noop, undefined, undefined, descriptions[0]);
          rest.forEach((name, i) => {
            b.addFunction(name, noop, undefined, undefined, descriptions[i + 1]);
          });
          const chart = b.build();

          expect(typeof chart.description).toBe('string');
          expect(chart.description.length).toBeGreaterThan(0);
          expect(chart.description).toContain('Steps:');

          // All descriptions should be in stageDescriptions
          for (let i = 0; i < names.length; i++) {
            expect(chart.stageDescriptions.get(names[i])).toBe(descriptions[i]);
          }
        },
      ),
      { numRuns: 50 },
    );
  });

  test('any valid decider chain produces a FlowChart with branches', () => {
    fc.assert(
      fc.property(
        uniqueStageNames(5),
        (names) => {
          const [entry, deciderName, ...branchNames] = names;
          // Ensure at least 1 branch
          if (branchNames.length === 0) return;

          const b = new FlowChartBuilder().start(entry, noop);
          const dl = b.addDeciderFunction(deciderName, noop);
          for (const bn of branchNames) {
            dl.addFunctionBranch(bn, bn, noop);
          }
          dl.end();
          const chart = b.build();

          expect(chart.root).toBeDefined();
          expect(chart.stageMap).toBeInstanceOf(Map);
          expect(typeof chart.description).toBe('string');

          // Decider node should have children
          const deciderNode = chart.root.next;
          expect(deciderNode).toBeDefined();
          expect(deciderNode!.children?.length).toBe(branchNames.length);
        },
      ),
      { numRuns: 50 },
    );
  });

  test('building with flowChart factory always produces valid FlowChart', () => {
    fc.assert(
      fc.property(
        uniqueStageNames(3),
        (names) => {
          const [root, ...rest] = names;
          let b = flowChart(root, noop);
          for (const name of rest) {
            b = b.addFunction(name, noop);
          }
          const chart = b.build();

          expect(chart.root).toBeDefined();
          expect(chart.root.name).toBe(root);
          expect(chart.stageMap.size).toBe(names.length);
          expect(typeof chart.description).toBe('string');
          expect(chart.stageDescriptions).toBeInstanceOf(Map);
        },
      ),
      { numRuns: 50 },
    );
  });
});

/* ==========================================================================
 * Additional edge-case coverage: addTraversalExtractor and addBuildTimeExtractor
 * ========================================================================== */

describe('addTraversalExtractor and addBuildTimeExtractor', () => {
  test('addTraversalExtractor stores extractor in built FlowChart', () => {
    const extractor = jest.fn();
    const chart = new FlowChartBuilder()
      .start('entry', noop)
      .addTraversalExtractor(extractor)
      .build();

    expect(chart.extractor).toBe(extractor);
  });

  test('addBuildTimeExtractor applies to subsequently added nodes', () => {
    const extractor: BuildTimeExtractor<any> = (node) => ({
      ...node,
      enriched: true,
    });

    const b = new FlowChartBuilder().start('entry', noop);
    b.addBuildTimeExtractor(extractor);
    b.addFunction('step', noop);
    const chart = b.build();

    // The extractor was set AFTER start, so 'entry' won't be enriched
    // but 'step' will be
    expect((chart.buildTimeStructure.next as any)?.enriched).toBe(true);
  });
});

/* ==========================================================================
 * addDeciderFunction validation — mutually exclusive checks
 * ========================================================================== */

describe('addDeciderFunction — mutually exclusive validation', () => {
  test('throws when decider already defined (deciderFn)', () => {
    const b = new FlowChartBuilder().start('entry', noop);
    (b as any)._cursor.deciderFn = true;
    expect(() => b.addDeciderFunction('Decider', () => 'a')).toThrow(/decider already defined/i);
  });

  test('throws when selector already defined', () => {
    const b = new FlowChartBuilder().start('entry', noop);
    (b as any)._cursor.nextNodeSelector = async () => ['x'];
    expect(() => b.addDeciderFunction('Decider', () => 'a')).toThrow(
      /decider and selector are mutually exclusive/i,
    );
  });
});

/* ==========================================================================
 * _appendSubflowDescription with multi-line description
 * ========================================================================== */

describe('_appendSubflowDescription — multi-line Steps indentation', () => {
  test('indents sub-steps from subflow description', () => {
    // Manually craft a subflow with a description that has Steps:
    const sub = new FlowChartBuilder()
      .start('SubRoot', noop, undefined, 'Sub Root', 'Initialize')
      .addFunction('SubProcess', noop, undefined, 'Process', 'Do processing')
      .addFunction('SubFinish', noop, undefined, 'Finish', 'Finalize')
      .build();

    // The sub.description should contain "Steps:" with numbered lines
    expect(sub.description).toContain('Steps:');

    const chart = new FlowChartBuilder()
      .start('main', noop)
      .addSubFlowChart('sub', sub, 'SubMount')
      .build();

    const desc = chart.description;
    // Should contain indented sub-steps
    expect(desc).toContain('[Sub-Execution: SubMount]');
    // The sub-steps should be indented (3 spaces)
    const lines = desc.split('\n');
    const indentedLines = lines.filter(l => l.startsWith('   ') && l.includes('.'));
    expect(indentedLines.length).toBeGreaterThan(0);
  });
});

/* ==========================================================================
 * build() — empty description when no stages have descriptions
 * ========================================================================== */

describe('build — description generation', () => {
  test('generates Steps: header with numbered stages in description', () => {
    const chart = new FlowChartBuilder()
      .start('entry', noop)
      .addFunction('step1', noop)
      .addFunction('step2', noop)
      .build();

    expect(chart.description).toContain('FlowChart: entry');
    expect(chart.description).toContain('Steps:');
    expect(chart.description).toContain('1. entry');
    expect(chart.description).toContain('2. step1');
    expect(chart.description).toContain('3. step2');
  });

  test('uses displayName in description when available', () => {
    const chart = new FlowChartBuilder()
      .start('entry', noop, undefined, 'Entry Display')
      .addFunction('step', noop, undefined, 'Step Display')
      .build();

    expect(chart.description).toContain('FlowChart: Entry Display');
    expect(chart.description).toContain('1. Entry Display');
    expect(chart.description).toContain('2. Step Display');
  });
});
