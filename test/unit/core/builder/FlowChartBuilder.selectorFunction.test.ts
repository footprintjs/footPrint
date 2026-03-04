/**
 * FlowChartBuilder.selectorFunction.test.ts
 *
 * Unit tests for the addSelectorFunction builder method and SelectorFnList class.
 * Tests builder API, node construction, validation, and spec generation.
 */

import {
  FlowChartBuilder,
  SelectorFnList,
} from '../../../../src/core/builder/FlowChartBuilder';
import type { StageNode } from '../../../../src/core/executor/Pipeline';

/* ── Mock FlowChartExecutor ── */
jest.mock('../../../../src/core/executor/FlowChartExecutor', () => ({
  FlowChartExecutor: class {
    async run() { return 'EXEC_RESULT'; }
  },
}));

/* ── Helpers ── */
function prune(node: StageNode<any, any> | undefined): any {
  if (!node) return undefined;
  const out: any = { name: node.name };
  if (node.id) out.id = node.id;
  if (node.selectorFn) out.selectorFn = true;
  if (node.deciderFn) out.deciderFn = true;
  if (node.children?.length) out.children = node.children.map(prune);
  if (node.next) out.next = prune(node.next);
  return out;
}

describe('FlowChartBuilder — addSelectorFunction', () => {
  test('builds a selector node with selectorFn=true and children', () => {
    const selectorFn = async () => ['email', 'sms'];

    const fb = new FlowChartBuilder()
      .start('Analyze', async () => {})
      .addSelectorFunction('PickChannels', selectorFn, 'pick-channels')
        .addFunctionBranch('email', 'SendEmail', async () => {})
        .addFunctionBranch('sms', 'SendSMS', async () => {})
        .addFunctionBranch('push', 'SendPush', async () => {})
      .end();

    const { root } = fb.build();

    expect(prune(root)).toEqual({
      name: 'Analyze',
      next: {
        name: 'PickChannels',
        id: 'pick-channels',
        selectorFn: true,
        children: [
          { name: 'SendEmail', id: 'email' },
          { name: 'SendSMS', id: 'sms' },
          { name: 'SendPush', id: 'push' },
        ],
      },
    });
  });

  test('sets selectorFn=true on the node (not deciderFn)', () => {
    const fb = new FlowChartBuilder()
      .start('Start')
      .addSelectorFunction('Selector', async () => ['a'])
        .addFunctionBranch('a', 'A')
      .end();

    const { root } = fb.build();
    const selectorNode = root.next!;
    expect(selectorNode.selectorFn).toBe(true);
    expect(selectorNode.deciderFn).toBeUndefined();
  });

  test('registers fn in stageMap', () => {
    const myFn = async () => ['a'];
    const fb = new FlowChartBuilder()
      .start('Start')
      .addSelectorFunction('Selector', myFn)
        .addFunctionBranch('a', 'A')
      .end();

    const { stageMap } = fb.build();
    expect(stageMap.get('Selector')).toBe(myFn);
  });

  test('supports displayName and description', () => {
    const fb = new FlowChartBuilder()
      .start('Start')
      .addSelectorFunction('Selector', async () => ['a'], 'sel-id', 'Channel Picker', 'Picks notification channels')
        .addFunctionBranch('a', 'A')
      .end();

    const { root } = fb.build();
    const selectorNode = root.next!;
    expect(selectorNode.displayName).toBe('Channel Picker');
    expect(selectorNode.description).toBe('Picks notification channels');
    expect(selectorNode.id).toBe('sel-id');
  });

  test('can chain addFunction after end()', () => {
    const fb = new FlowChartBuilder()
      .start('Start')
      .addSelectorFunction('Selector', async () => ['a'])
        .addFunctionBranch('a', 'A')
      .end()
      .addFunction('Confirm');

    const { root } = fb.build();
    const selectorNode = root.next!;
    expect(selectorNode.next?.name).toBe('Confirm');
  });

  test('spec has correct type and branchIds', () => {
    const fb = new FlowChartBuilder()
      .start('Start')
      .addSelectorFunction('Selector', async () => ['a', 'b'])
        .addFunctionBranch('a', 'BranchA')
        .addFunctionBranch('b', 'BranchB')
      .end();

    const { buildTimeStructure } = fb.build();
    const selectorSpec = buildTimeStructure?.next;
    expect(selectorSpec?.type).toBe('decider');
    expect(selectorSpec?.hasSelector).toBe(true);
    expect(selectorSpec?.branchIds).toEqual(['a', 'b']);
    expect(selectorSpec?.children).toHaveLength(2);
  });

  test('addBranchList adds multiple branches', () => {
    const fb = new FlowChartBuilder()
      .start('Start')
      .addSelectorFunction('Selector', async () => ['x', 'y'])
        .addBranchList([
          { id: 'x', name: 'X' },
          { id: 'y', name: 'Y' },
        ])
      .end();

    const { root } = fb.build();
    const selectorNode = root.next!;
    expect(selectorNode.children).toHaveLength(2);
    expect(selectorNode.children![0].id).toBe('x');
    expect(selectorNode.children![1].id).toBe('y');
  });

  test('addSubFlowChartBranch mounts a subflow as a branch', () => {
    const subflow = new FlowChartBuilder()
      .start('SubStart', async () => {})
      .build();

    const fb = new FlowChartBuilder()
      .start('Start')
      .addSelectorFunction('Selector', async () => ['sub'])
        .addSubFlowChartBranch('sub', subflow, 'Sub Flow')
      .end();

    const { root } = fb.build();
    const selectorNode = root.next!;
    expect(selectorNode.children).toHaveLength(1);
    expect(selectorNode.children![0].isSubflowRoot).toBe(true);
    expect(selectorNode.children![0].subflowId).toBe('sub');
    expect(selectorNode.children![0].subflowName).toBe('Sub Flow');
  });

  /* ── Validation ── */

  test('throws on duplicate branch id', () => {
    expect(() => {
      new FlowChartBuilder()
        .start('Start')
        .addSelectorFunction('Selector', async () => ['a'])
          .addFunctionBranch('a', 'A')
          .addFunctionBranch('a', 'A2') // duplicate
        .end();
    }).toThrow(/duplicate selector branch id 'a'/);
  });

  test('throws on duplicate subflow branch id', () => {
    const subflow = new FlowChartBuilder().start('Sub').build();
    expect(() => {
      new FlowChartBuilder()
        .start('Start')
        .addSelectorFunction('Selector', async () => ['x'])
          .addSubFlowChartBranch('x', subflow)
          .addSubFlowChartBranch('x', subflow) // duplicate
        .end();
    }).toThrow(/duplicate selector branch id 'x'/);
  });

  test('end() throws when no branches defined', () => {
    expect(() => {
      new FlowChartBuilder()
        .start('Start')
        .addSelectorFunction('Selector', async () => [])
        .end();
    }).toThrow(/requires at least one branch/);
  });

  test('throws when selector already defined on same cursor node', () => {
    // After end(), cursor stays at the selectorFn node.
    // Trying to add another selectorFunction should throw.
    expect(() => {
      new FlowChartBuilder()
        .start('Start')
        .addSelectorFunction('Sel1', async () => ['a'])
          .addFunctionBranch('a', 'A')
        .end()
        .addSelectorFunction('Sel2', async () => ['b'])
          .addFunctionBranch('b', 'B')
        .end();
    }).toThrow(/selector already defined/);
  });

  test('can chain selector after addFunction (separate nodes)', () => {
    const fb = new FlowChartBuilder()
      .start('Start')
      .addSelectorFunction('Sel1', async () => ['a'])
        .addFunctionBranch('a', 'A')
      .end()
      .addFunction('Middle')
      .addSelectorFunction('Sel2', async () => ['b'])
        .addFunctionBranch('b', 'B')
      .end();

    const { root } = fb.build();
    expect(root.next?.selectorFn).toBe(true);
    expect(root.next?.next?.name).toBe('Middle');
    expect(root.next?.next?.next?.selectorFn).toBe(true);
  });

  test('can chain decider then selector with intermediate stage', () => {
    const fb = new FlowChartBuilder()
      .start('Start')
      .addDeciderFunction('Decider', async () => 'a')
        .addFunctionBranch('a', 'A')
      .end()
      .addFunction('Bridge')
      .addSelectorFunction('Selector', async () => ['b'])
        .addFunctionBranch('b', 'B')
      .end();

    const { root } = fb.build();
    expect(root.next?.deciderFn).toBe(true);
    expect(root.next?.next?.name).toBe('Bridge');
    expect(root.next?.next?.next?.selectorFn).toBe(true);
  });

  /* ── Description accumulation ── */

  test('description includes selector info with branch IDs', () => {
    const fb = new FlowChartBuilder()
      .start('Start', undefined, undefined, undefined, 'Start stage')
      .addSelectorFunction('Selector', async () => ['a', 'b'], undefined, undefined, 'Pick channels')
        .addFunctionBranch('a', 'A', undefined, 'Branch A', 'Handles A')
        .addFunctionBranch('b', 'B', undefined, 'Branch B', 'Handles B')
      .end();

    const { description } = fb.build();
    expect(description).toContain('Selector');
    expect(description).toContain('Pick channels');
  });

  test('description works without selector description', () => {
    const fb = new FlowChartBuilder()
      .start('Start')
      .addSelectorFunction('Selector', async () => ['a'])
        .addFunctionBranch('a', 'A')
      .end();

    const { description } = fb.build();
    expect(description).toContain('Selects from: a');
  });
});
