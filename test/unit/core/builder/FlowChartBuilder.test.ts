import {
  type BuiltFlow,
  type FlowChartSpec,
  DeciderList,
  FlowChartBuilder,
  specToStageNode,
} from '../../../../src/core/builder/FlowChartBuilder';
import type { StageNode } from '../../../../src/core/executor/Pipeline';

/* ----------------------------------------------------------------------------
 * Helpers: prune functions/deciders for JSON compare + name collector
 * -------------------------------------------------------------------------- */

function prune(node: StageNode<any, any> | undefined): any {
  if (!node) return undefined;
  const out: any = { name: node.name };
  if (node.id) out.id = node.id;
  if (node.isSubflowRoot) out.isSubflowRoot = node.isSubflowRoot;
  if (node.subflowId) out.subflowId = node.subflowId;
  if (node.subflowName) out.subflowName = node.subflowName;
  if (node.children?.length) out.children = node.children.map(prune);
  if (node.next) out.next = prune(node.next);
  return out;
}

function names(node?: StageNode<any, any>, acc: string[] = []): string[] {
  if (!node) return acc;
  acc.push(node.name);
  if (node.children) for (const c of node.children) names(c, acc);
  if (node.next) names(node.next, acc);
  return acc;
}

/* ----------------------------------------------------------------------------
 * Mock FlowChartExecutor to test execute() sugar without running the engine
 * -------------------------------------------------------------------------- */

const TPctor = jest.fn();
const TPexec = jest.fn(async () => 'EXEC_RESULT');

jest.mock('../../../../src/core/executor/FlowChartExecutor', () => {
  return {
    FlowChartExecutor: class {
      constructor(...args: any[]) {
        TPctor(...args);
      }

      async run() {
        return await TPexec();
      }
    },
  };
});

/* ----------------------------------------------------------------------------
 * Linear / Fork / Decider / Composition
 * -------------------------------------------------------------------------- */

describe('FlowChartBuilder — build shapes', () => {
  test('linear: start → addFunction → addFunction', () => {
    const fb = new FlowChartBuilder().start('A').addFunction('B').addFunction('C');

    const { root } = fb.build();
    expect(prune(root)).toEqual({
      name: 'A',
      next: { name: 'B', next: { name: 'C' } },
    });
  });

  test('fork-only: (stage?) → children (parallel) → return bundle (at runtime)', () => {
    const fb = new FlowChartBuilder().start('gather').addListOfFunction([
      { id: 'x', name: 'X' },
      { id: 'y', name: 'Y' },
    ]);

    const { root } = fb.build();
    expect(prune(root)).toEqual({
      name: 'gather',
      children: [
        { id: 'x', name: 'X' },
        { id: 'y', name: 'Y' },
      ],
    });
  });

  test('fork + next: stage → children → next (aggregator as first addFunction after fork)', () => {
    const fb = new FlowChartBuilder()
      .start('seed')
      .addListOfFunction([
        { id: 'a', name: 'A' },
        { id: 'b', name: 'B' },
      ])
      .addFunction('aggregate')
      .addFunction('tail');

    const { root } = fb.build();
    expect(prune(root)).toEqual({
      name: 'seed',
      children: [
        { id: 'a', name: 'A' },
        { id: 'b', name: 'B' },
      ],
      next: { name: 'aggregate', next: { name: 'tail' } },
    });
  });

  test('decider: addDecider().addFunctionBranch().end() creates branches + decider fn', () => {
    const fb = new FlowChartBuilder()
      .start('chooser')
      .addDecider(() => 'B')
      .addFunctionBranch('A', 'A')
      .addFunctionBranch('B', 'B')
      .end();

    const { root } = fb.build();
    expect(prune(root)).toEqual({
      name: 'chooser',
      children: [
        { id: 'A', name: 'A' },
        { id: 'B', name: 'B' },
      ],
    });
    // decider exists
    expect(typeof (root as any).nextNodeDecider).toBe('function');
    // wrapper honors default if set; verify wrapper shape via invocation
    const dec = (root as any).nextNodeDecider as (x?: any) => any;
    return expect(dec({})).resolves.toBe('B');
  });

  test('decider .setDefault routes unknown id to default instead of engine throw', async () => {
    const fb = new FlowChartBuilder()
      .start('dec')
      .addDecider(() => 'UNKNOWN')
      .addFunctionBranch('left', 'LEFT')
      .addFunctionBranch('right', 'RIGHT')
      .setDefault('left')
      .end();
    const { root } = fb.build();
    const dec = (root as any).nextNodeDecider as (x?: any) => any;
    await expect(dec({})).resolves.toBe('left');
  });

  test('composition (decider branches): addSubFlowChartBranch mounts subflows as references', () => {
    const smalltalk = new FlowChartBuilder().start('Smalltalk_Start').addFunction('Smalltalk_Answer').build();

    const rag = new FlowChartBuilder().start('RAG_Start').addFunction('RAG_Answer').build();

    const chatbot = new FlowChartBuilder()
      .start('Entry')
      .addDecider(() => 'qa')
      .addSubFlowChartBranch('smalltalk', smalltalk, 'Smalltalk')
      .addSubFlowChartBranch('qa', rag, 'QA')
      .end()
      .addFunction('Tail');

    const { root, subflows } = chatbot.build();
    
    // Reference nodes should be in the tree
    expect(names(root)).toEqual(
      expect.arrayContaining(['Entry', 'Smalltalk', 'QA', 'Tail']),
    );
    
    // Reference nodes should have subflow metadata
    expect(prune(root)).toEqual({
      name: 'Entry',
      children: [
        { id: 'smalltalk', name: 'Smalltalk', isSubflowRoot: true, subflowId: 'smalltalk', subflowName: 'Smalltalk' },
        { id: 'qa', name: 'QA', isSubflowRoot: true, subflowId: 'qa', subflowName: 'QA' },
      ],
      next: { name: 'Tail' },
    });
    
    // Subflow definitions should be in the subflows dictionary
    expect(subflows).toBeDefined();
    // Subflows are now stored with the mount id as the key (not the root name)
    expect(subflows!['smalltalk']).toBeDefined();
    expect(subflows!['qa']).toBeDefined();
    expect(subflows!['smalltalk'].root.name).toBe('smalltalk/Smalltalk_Start');
    expect(subflows!['qa'].root.name).toBe('qa/RAG_Start');
  });

  test('composition (fork children): addSubFlowChart mounts subflows as references', () => {
    const faq = new FlowChartBuilder().start('FAQ_Start').addFunction('FAQ_Answer').build();
    const help = new FlowChartBuilder().start('Help_Start').addFunction('Help_Answer').build();

    const main = new FlowChartBuilder()
      .start('Prep')
      .addSubFlowChart('faq', faq, 'FAQ')
      .addSubFlowChart('help', help, 'Help')
      .addFunction('Aggregate')
      .addFunction('Tail');

    const { root, subflows } = main.build();
    
    // Reference nodes should be in the tree
    expect(names(root)).toEqual(
      expect.arrayContaining(['Prep', 'FAQ', 'Help', 'Aggregate', 'Tail']),
    );
    
    // Reference nodes should have subflow metadata
    expect(prune(root)).toEqual({
      name: 'Prep',
      children: [
        { id: 'faq', name: 'FAQ', isSubflowRoot: true, subflowId: 'faq', subflowName: 'FAQ' },
        { id: 'help', name: 'Help', isSubflowRoot: true, subflowId: 'help', subflowName: 'Help' },
      ],
      next: { name: 'Aggregate', next: { name: 'Tail' } },
    });
    
    // Subflow definitions should be in the subflows dictionary
    expect(subflows).toBeDefined();
    // Subflows are now stored with the mount id as the key (not the root name)
    expect(subflows!['faq']).toBeDefined();
    expect(subflows!['help']).toBeDefined();
    expect(subflows!['faq'].root.name).toBe('faq/FAQ_Start');
    expect(subflows!['help'].root.name).toBe('help/Help_Start');
  });
});

/* ----------------------------------------------------------------------------
 * Validations
 * -------------------------------------------------------------------------- */

describe('FlowChartBuilder — validations & errors', () => {
  test('duplicate child ids under parent throws', () => {
    const fb = new FlowChartBuilder().start('parent');
    expect(() =>
      fb.addListOfFunction([
        { id: 'x', name: 'X' },
        { id: 'x', name: 'X2' },
      ]),
    ).toThrow(/duplicate child id 'x' under 'parent'/i);
  });

  test('decider requires at least one branch', () => {
    const fb = new FlowChartBuilder().start('dec');
    expect(() => fb.addDecider(() => 'x').end()).toThrow(/requires at least one branch/i);
  });

  test('stageMap collision when mounting subtree throws', () => {
    // With internal namespacing, different mount ids ('a', 'b') namespace their
    // stages ('a/shared', 'b/shared') so they no longer collide.
    // A collision now only occurs when the same mount id is reused (duplicate child).
    const subA = new FlowChartBuilder().start('shared', (() => {}) as any).build();
    const subB = new FlowChartBuilder().start('shared', (() => 'other') as any).build();
    const main = new FlowChartBuilder().start('root');

    // Different mount ids → namespaced stages → no collision
    expect(() => main.addSubFlowChart('a', subA, 'A').addSubFlowChart('b', subB, 'B')).not.toThrow();

    // Same mount id → duplicate child id → throws
    const main2 = new FlowChartBuilder().start('root');
    expect(() => main2.addSubFlowChart('a', subA, 'A').addSubFlowChart('a', subB, 'A2')).toThrow(/duplicate child id/i);
  });

  test('stageMap collision within single builder when embedding fn with same name throws', () => {
    // Test that adding a child with the same stage name but different fn throws
    expect(() => {
      new FlowChartBuilder()
        .start('clash', (() => 'one') as any)
        // attempt to add a child with same stage name but different fn:
        .addListOfFunction([{ id: 'c', name: 'clash', fn: (() => 'two') as any }]);
    }).toThrow(/stageMap collision/i);
    
    // Also test the direct _addToMap collision:
    const fb2 = new FlowChartBuilder().start('root', (() => {}) as any);
    fb2._addToMap('dup', (() => 'a') as any); // set first
    expect(() => fb2._addToMap('dup', (() => 'b') as any)).toThrow(/stageMap collision/i);
  });

  // NOTE: into() method was removed in the simplified builder
  // test('into() unknown child throws', () => {
  //   const fb = new FlowChartBuilder().start('A');
  //   expect(() => fb.into('nope')).toThrow(/child 'nope' not found under 'A'/i);
  // });

  // NOTE: end() method on FlowChartBuilder was removed in the simplified builder
  // Only DeciderList.end() and SelectorList.end() remain
  // test('end() at root throws', () => {
  //   const fb = new FlowChartBuilder().start('A');
  //   expect(() => fb.end()).toThrow(/'end\(\)' at root is invalid/i);
  // });

  test('calling addFunction before start throws (cursor undefined)', () => {
    const fb = new FlowChartBuilder();
    expect(() => fb.addFunction('B')).toThrow(/cursor undefined; call start\(\) first/i);
  });
});

/* ----------------------------------------------------------------------------
 * JSON spec + BE reconstruction
 * -------------------------------------------------------------------------- */

describe('FlowChartBuilder — toSpec() & specToStageNode()', () => {
  test('toSpec emits pure JSON; specToStageNode reconstructs shape', () => {
    // Simplified builder uses subgraph composition instead of build callbacks
    // Build subflows first
    const intentBranch = new FlowChartBuilder()
      .start('identifyIntent')
      .addFunction('buildPrompt')
      .addFunction('askLlm')
      .build();
    
    const altBranch = new FlowChartBuilder()
      .start('askLlm')
      .build();
    
    // Build conversation subflow with decider
    const conversationFlow = new FlowChartBuilder()
      .start('retriever')
      .addDecider(() => 'intent')
        .addSubFlowChartBranch('intent', intentBranch)
        .addSubFlowChartBranch('alt', altBranch)
      .end()
      .build();
    
    // Build kb subflow
    const kbFlow = new FlowChartBuilder()
      .start('buildPrompt')
      .addFunction('askLlm')
      .build();
    
    // Main flow with fork children
    const fb = new FlowChartBuilder()
      .start('init')
      .addSubFlowChart('conversation', conversationFlow, 'retriever')
      .addSubFlowChart('kb', kbFlow, 'buildPrompt');

    const spec = fb.toSpec();
    
    // Verify basic structure
    expect(spec.name).toBe('init');
    expect(spec.children).toHaveLength(2);
    expect(spec.children![0].id).toBe('conversation');
    expect(spec.children![0].isSubflowRoot).toBe(true);
    expect(spec.children![1].id).toBe('kb');
    expect(spec.children![1].isSubflowRoot).toBe(true);

    const stageNode = specToStageNode(spec);
    expect(stageNode.name).toBe('init');
    expect(stageNode.children).toHaveLength(2);
  });
});

/* ----------------------------------------------------------------------------
 * toMermaid
 * -------------------------------------------------------------------------- */

describe('FlowChartBuilder — toMermaid() contains nodes', () => {
  test('toMermaid lists node names', () => {
    const fb = new FlowChartBuilder()
      .start('A')
      .addFunction('B')
      .addListOfFunction([
        { id: 'x', name: 'X' },
        { id: 'y', name: 'Y' },
      ])
      .addFunction('C');

    const mermaid = fb.toMermaid();
    expect(mermaid).toMatch(/A/);
    expect(mermaid).toMatch(/B/);
    expect(mermaid).toMatch(/X/);
    expect(mermaid).toMatch(/Y/);
    expect(mermaid).toMatch(/C/);
  });
});

/* ----------------------------------------------------------------------------
 * execute() sugar (Pipeline mocked)
 * -------------------------------------------------------------------------- */

describe('FlowChartBuilder — execute() sugar builds & calls FlowChartExecutor', () => {
  beforeEach(() => {
    TPctor.mockClear();
    TPexec.mockClear();
  });

  test('execute passes {root, stageMap} and options to FlowChartExecutor ctor', async () => {
    const fb = new FlowChartBuilder().start('prep').addFunction('tail');

    // fake scopeFactory to satisfy types & constructor
    const scopeFactory = ((_ctx: any, _stage: string, _ro?: unknown) => ({})) as any;

    const result = await fb.execute(scopeFactory, {
      defaults: { d: 1 },
      initial: { i: 2 },
      readOnly: { r: 3 },
      throttlingErrorChecker: (e) => (e as any)?.code === 'THROTTLE',
    });

    expect(TPctor).toHaveBeenCalledTimes(1);
    const args = TPctor.mock.calls[0];
    // FlowChartExecutor receives: [flowChart, scopeFactory, defaults, initial, readOnly, checker, streamHandlers, scopeProtectionMode]
    // flowChart = { root, stageMap, extractor?, subflows? }
    const flowChart = args[0];
    expect(flowChart.root).toMatchObject({ name: 'prep', next: { name: 'tail' } });
    expect(flowChart.stageMap).toBeInstanceOf(Map);
    expect(args[1]).toBe(scopeFactory);
    expect(args[2]).toEqual({ d: 1 });
    expect(args[3]).toEqual({ i: 2 });
    expect(args[4]).toEqual({ r: 3 });
    expect(typeof args[5]).toBe('function');

    expect(TPexec).toHaveBeenCalledTimes(1);
    expect(result).toBe('EXEC_RESULT');
  });
});
