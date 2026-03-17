import { vi } from 'vitest';

/**
 * Scenario test: FlowRecorder integration with real traversal.
 *
 * Tests that FlowRecorders receive the correct events when attached
 * to a FlowchartTraverser via the flowRecorders option.
 */
import type { StageNode } from '../../../../src/lib/engine/graph/StageNode';
import { NarrativeFlowRecorder } from '../../../../src/lib/engine/narrative/NarrativeFlowRecorder';
import { SilentNarrativeFlowRecorder } from '../../../../src/lib/engine/narrative/recorders/SilentNarrativeFlowRecorder';
import type {
  FlowDecisionEvent,
  FlowForkEvent,
  FlowNextEvent,
  FlowRecorder,
  FlowStageEvent,
} from '../../../../src/lib/engine/narrative/types';
import { FlowchartTraverser } from '../../../../src/lib/engine/traversal/FlowchartTraverser';
import type { ILogger, StageFunction } from '../../../../src/lib/engine/types';
import { ExecutionRuntime } from '../../../../src/lib/runner/ExecutionRuntime';

const silentLogger: ILogger = {
  info: vi.fn(),
  log: vi.fn(),
  debug: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
};

function simpleScopeFactory(context: any) {
  return {
    get: (key: string) => context.getValue([], key),
    set: (key: string, value: unknown) => context.setObject([], key, value),
  };
}

describe('Scenario: FlowRecorder Integration', () => {
  it('custom FlowRecorder receives stage and next events during linear chain', async () => {
    const stageMap = new Map<string, StageFunction>();
    stageMap.set('Step A', () => 'a');
    stageMap.set('Step B', () => 'b');

    const nodeB: StageNode = { name: 'Step B', id: 'B' };
    const root: StageNode = { name: 'Step A', id: 'A', next: nodeB };

    const events: string[] = [];
    const customRecorder: FlowRecorder = {
      id: 'test-observer',
      onStageExecuted: (e: FlowStageEvent) => events.push(`stage:${e.stageName}`),
      onNext: (e: FlowNextEvent) => events.push(`next:${e.from}->${e.to}`),
    };

    const runtime = new ExecutionRuntime('Step A', 'Step A');
    const traverser = new FlowchartTraverser({
      root,
      stageMap,
      scopeFactory: simpleScopeFactory,
      executionRuntime: runtime,
      scopeProtectionMode: 'off',
      narrativeEnabled: true,
      logger: silentLogger,
      flowRecorders: [customRecorder],
    });

    await traverser.execute();

    expect(events).toContain('stage:Step A');
    expect(events).toContain('next:Step A->Step B');
    expect(events).toContain('stage:Step B');
  });

  it('multiple FlowRecorders all receive events', async () => {
    const stageMap = new Map<string, StageFunction>();
    stageMap.set('Init', () => 'init');

    const root: StageNode = { name: 'Init', id: 'init' };

    const recorder1Events: string[] = [];
    const recorder2Events: string[] = [];

    const runtime = new ExecutionRuntime('Init', 'Init');
    const traverser = new FlowchartTraverser({
      root,
      stageMap,
      scopeFactory: simpleScopeFactory,
      executionRuntime: runtime,
      scopeProtectionMode: 'off',
      narrativeEnabled: true,
      logger: silentLogger,
      flowRecorders: [
        { id: 'r1', onStageExecuted: (e) => recorder1Events.push(e.stageName) },
        { id: 'r2', onStageExecuted: (e) => recorder2Events.push(e.stageName) },
      ],
    });

    await traverser.execute();

    expect(recorder1Events).toEqual(['Init']);
    expect(recorder2Events).toEqual(['Init']);
  });

  it('NarrativeFlowRecorder produces same output as default traversal narrative', async () => {
    const stageMap = new Map<string, StageFunction>();
    stageMap.set('Step A', () => 'a');
    stageMap.set('Step B', () => 'b');

    const nodeB: StageNode = { name: 'Step B', id: 'B' };
    const root: StageNode = { name: 'Step A', id: 'A', next: nodeB };

    // Run with default narrative (auto-attached NarrativeFlowRecorder)
    const runtime1 = new ExecutionRuntime('Step A', 'Step A');
    const traverser1 = new FlowchartTraverser({
      root,
      stageMap,
      scopeFactory: simpleScopeFactory,
      executionRuntime: runtime1,
      scopeProtectionMode: 'off',
      narrativeEnabled: true,
      logger: silentLogger,
    });
    await traverser1.execute();
    const defaultNarrative = traverser1.getNarrative();

    // Run with explicit NarrativeFlowRecorder
    const narrator = new NarrativeFlowRecorder();
    const runtime2 = new ExecutionRuntime('Step A', 'Step A');
    const traverser2 = new FlowchartTraverser({
      root,
      stageMap,
      scopeFactory: simpleScopeFactory,
      executionRuntime: runtime2,
      scopeProtectionMode: 'off',
      narrativeEnabled: true,
      logger: silentLogger,
      flowRecorders: [narrator],
    });
    await traverser2.execute();
    const explicitNarrative = traverser2.getNarrative();

    expect(explicitNarrative).toEqual(defaultNarrative);
  });

  it('FlowRecorder receives decision events from decider node', async () => {
    const stageMap = new Map<string, StageFunction>();
    stageMap.set('Check', () => 'yes');
    stageMap.set('Approved', () => 'ok');

    const root: StageNode = {
      name: 'Check',
      id: 'check',
      deciderFn: true,
      children: [{ name: 'Approved', id: 'yes' }],
    };

    const decisions: FlowDecisionEvent[] = [];
    const recorder: FlowRecorder = {
      id: 'decision-tracker',
      onDecision: (e) => decisions.push(e),
    };

    const runtime = new ExecutionRuntime('Check', 'Check');
    const traverser = new FlowchartTraverser({
      root,
      stageMap,
      scopeFactory: simpleScopeFactory,
      executionRuntime: runtime,
      scopeProtectionMode: 'off',
      narrativeEnabled: true,
      logger: silentLogger,
      flowRecorders: [recorder],
    });

    await traverser.execute();

    expect(decisions).toHaveLength(1);
    expect(decisions[0].chosen).toBe('Approved');
  });

  it('FlowRecorder receives fork events from parallel children', async () => {
    const stageMap = new Map<string, StageFunction>();
    stageMap.set('Task A', () => 'a');
    stageMap.set('Task B', () => 'b');

    const root: StageNode = {
      name: 'dispatch',
      id: 'dispatch',
      children: [
        { name: 'Task A', id: 'taskA' },
        { name: 'Task B', id: 'taskB' },
      ],
    };

    const forks: FlowForkEvent[] = [];
    const recorder: FlowRecorder = {
      id: 'fork-tracker',
      onFork: (e) => forks.push(e),
    };

    const runtime = new ExecutionRuntime('dispatch', 'dispatch');
    const traverser = new FlowchartTraverser({
      root,
      stageMap,
      scopeFactory: simpleScopeFactory,
      executionRuntime: runtime,
      scopeProtectionMode: 'off',
      narrativeEnabled: true,
      logger: silentLogger,
      flowRecorders: [recorder],
    });

    await traverser.execute();

    expect(forks).toHaveLength(1);
    expect(forks[0].children).toContain('Task A');
    expect(forks[0].children).toContain('Task B');
  });

  it('getFlowRecorderDispatcher provides access to attached recorders', async () => {
    const stageMap = new Map<string, StageFunction>();
    stageMap.set('Init', () => 'init');
    const root: StageNode = { name: 'Init', id: 'init' };

    const narrator = new NarrativeFlowRecorder('my-narrator');
    const runtime = new ExecutionRuntime('Init', 'Init');
    const traverser = new FlowchartTraverser({
      root,
      stageMap,
      scopeFactory: simpleScopeFactory,
      executionRuntime: runtime,
      scopeProtectionMode: 'off',
      narrativeEnabled: true,
      logger: silentLogger,
      flowRecorders: [narrator],
    });

    const dispatcher = traverser.getFlowRecorderDispatcher();
    expect(dispatcher).toBeDefined();
    expect(dispatcher!.getRecorderById('my-narrator')).toBe(narrator);
  });

  it('strategy recorders work through real traversal', async () => {
    const stageMap = new Map<string, StageFunction>();
    stageMap.set('Init', () => 'init');

    const root: StageNode = { name: 'Init', id: 'init' };

    const silent = new SilentNarrativeFlowRecorder();
    const runtime = new ExecutionRuntime('Init', 'Init');
    const traverser = new FlowchartTraverser({
      root,
      stageMap,
      scopeFactory: simpleScopeFactory,
      executionRuntime: runtime,
      scopeProtectionMode: 'off',
      narrativeEnabled: true,
      logger: silentLogger,
      flowRecorders: [silent],
    });

    await traverser.execute();

    // SilentNarrativeFlowRecorder still gets stage events (it extends NarrativeFlowRecorder)
    const sentences = silent.getSentences();
    expect(sentences.some((s) => s.includes('Init'))).toBe(true);
  });
});
