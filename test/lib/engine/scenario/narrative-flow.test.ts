/**
 * Scenario test: Narrative generation across execution patterns.
 *
 * Tests that ControlFlowNarrativeGenerator captures the right sentences
 * during linear, fork, and decider execution flows.
 */

import { FlowchartTraverser } from '../../../../src/lib/engine/traversal/FlowchartTraverser';
import { ExecutionRuntime } from '../../../../src/lib/runner/ExecutionRuntime';
import type { StageNode } from '../../../../src/lib/engine/graph/StageNode';
import type { StageFunction, ILogger } from '../../../../src/lib/engine/types';

const silentLogger: ILogger = {
  info: jest.fn(), log: jest.fn(), debug: jest.fn(), error: jest.fn(), warn: jest.fn(),
};

function simpleScopeFactory(context: any) {
  return {
    get: (key: string) => context.getValue([], key),
    set: (key: string, value: unknown) => context.setObject([], key, value),
  };
}

describe('Scenario: Narrative Flow', () => {
  it('captures narrative for linear chain', async () => {
    const stageMap = new Map<string, StageFunction>();
    stageMap.set('A', () => 'a');
    stageMap.set('B', () => 'b');

    const nodeB: StageNode = { name: 'B', id: 'B', displayName: 'Step B' };
    const root: StageNode = { name: 'A', id: 'A', displayName: 'Step A', next: nodeB };

    const runtime = new ExecutionRuntime('A');
    const traverser = new FlowchartTraverser({
      root, stageMap,
      scopeFactory: simpleScopeFactory,
      executionRuntime: runtime,
      scopeProtectionMode: 'off',
      narrativeEnabled: true,
      logger: silentLogger,
    });

    await traverser.execute();

    const sentences = traverser.getNarrative();
    expect(sentences.length).toBeGreaterThanOrEqual(2);
    // Should mention both stage display names
    expect(sentences.some((s) => s.includes('Step A'))).toBe(true);
    expect(sentences.some((s) => s.includes('Step B'))).toBe(true);
  });

  it('returns empty narrative when disabled', async () => {
    const stageMap = new Map<string, StageFunction>();
    stageMap.set('A', () => 'a');

    const root: StageNode = { name: 'A', id: 'A' };
    const runtime = new ExecutionRuntime('A');
    const traverser = new FlowchartTraverser({
      root, stageMap,
      scopeFactory: simpleScopeFactory,
      executionRuntime: runtime,
      scopeProtectionMode: 'off',
      narrativeEnabled: false,
      logger: silentLogger,
    });

    await traverser.execute();
    expect(traverser.getNarrative()).toEqual([]);
  });

  it('captures narrative for decider decision', async () => {
    const stageMap = new Map<string, StageFunction>();
    stageMap.set('check', () => 'yes');
    stageMap.set('yes', () => 'approved');

    const root: StageNode = {
      name: 'check', id: 'check', displayName: 'Check Eligibility',
      deciderFn: true,
      children: [{ name: 'yes', id: 'yes', displayName: 'Approved' }],
    };

    const runtime = new ExecutionRuntime('check');
    const traverser = new FlowchartTraverser({
      root, stageMap,
      scopeFactory: simpleScopeFactory,
      executionRuntime: runtime,
      scopeProtectionMode: 'off',
      narrativeEnabled: true,
      logger: silentLogger,
    });

    await traverser.execute();

    const sentences = traverser.getNarrative();
    // Should capture the decision
    expect(sentences.some((s) => s.includes('Approved'))).toBe(true);
  });

  it('captures narrative for fork fan-out', async () => {
    const stageMap = new Map<string, StageFunction>();
    stageMap.set('taskA', () => 'a');
    stageMap.set('taskB', () => 'b');

    const root: StageNode = {
      name: 'dispatch', id: 'dispatch',
      children: [
        { name: 'taskA', id: 'taskA', displayName: 'Task A' },
        { name: 'taskB', id: 'taskB', displayName: 'Task B' },
      ],
    };

    const runtime = new ExecutionRuntime('dispatch');
    const traverser = new FlowchartTraverser({
      root, stageMap,
      scopeFactory: simpleScopeFactory,
      executionRuntime: runtime,
      scopeProtectionMode: 'off',
      narrativeEnabled: true,
      logger: silentLogger,
    });

    await traverser.execute();

    const sentences = traverser.getNarrative();
    // Should capture the fork
    expect(sentences.some((s) => s.includes('Task A'))).toBe(true);
    expect(sentences.some((s) => s.includes('Task B'))).toBe(true);
  });
});
