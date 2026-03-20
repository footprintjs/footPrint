/**
 * Unit tests for CombinedNarrativeRecorder per-subflow stage numbering.
 *
 * Validates that stage counters reset when entering a subflow,
 * so subflow stages start at "Stage 1" instead of continuing
 * the parent's counter.
 */

import { describe, expect, it } from 'vitest';

import { CombinedNarrativeRecorder } from '../../../../src/lib/engine/narrative/CombinedNarrativeRecorder.js';

function makeStageEvent(stageName: string, subflowId?: string, description?: string, stageId?: string) {
  return {
    stageName,
    description,
    traversalContext: {
      stageId: stageId ?? stageName,
      stageName,
      subflowId,
      depth: subflowId ? 1 : 0,
      parentStageId: undefined,
    },
  };
}

function makeDecisionEvent(decider: string, chosen: string, subflowId?: string, stageId?: string) {
  return {
    decider,
    chosen,
    traversalContext: {
      stageId: stageId ?? decider,
      stageName: decider,
      subflowId,
      depth: subflowId ? 1 : 0,
      parentStageId: undefined,
    },
  };
}

function makeForkEvent(parent: string, children: string[], stageId?: string) {
  return {
    parent,
    children,
    traversalContext: { stageId: stageId ?? parent, stageName: parent, depth: 0, parentStageId: undefined },
  };
}

function makeLoopEvent(target: string, iteration: number, stageId?: string) {
  return {
    target,
    iteration,
    traversalContext: { stageId: stageId ?? target, stageName: target, depth: 0, parentStageId: undefined },
  };
}

function makeBreakEvent(stageName: string, stageId?: string) {
  return {
    stageName,
    traversalContext: { stageId: stageId ?? stageName, stageName, depth: 0, parentStageId: undefined },
  };
}

function makeErrorEvent(stageName: string, message: string, stageId?: string) {
  return {
    stageName,
    message,
    structuredError: { type: 'Error', message, issues: [] },
    traversalContext: { stageId: stageId ?? stageName, stageName, depth: 0, parentStageId: undefined },
  };
}

function makeSubflowEvent(name: string, subflowId: string, description?: string, stageId?: string) {
  return {
    name,
    subflowId,
    description,
    traversalContext: { stageId: stageId ?? name, stageName: name, subflowId, depth: 1, parentStageId: undefined },
  };
}

describe('CombinedNarrativeRecorder: per-subflow stage numbering', () => {
  it('root stages number sequentially', () => {
    const recorder = new CombinedNarrativeRecorder();

    recorder.onStageExecuted(makeStageEvent('A'));
    recorder.onStageExecuted(makeStageEvent('B'));
    recorder.onStageExecuted(makeStageEvent('C'));

    const entries = recorder.getEntries();
    expect(entries[0].text).toContain('Stage 1:');
    expect(entries[1].text).toContain('Stage 2:');
    expect(entries[2].text).toContain('Stage 3:');
  });

  it('subflow stages reset numbering to Stage 1', () => {
    const recorder = new CombinedNarrativeRecorder();

    // Root stages
    recorder.onStageExecuted(makeStageEvent('Root1'));
    recorder.onStageExecuted(makeStageEvent('Root2'));

    // Subflow stages — should reset to 1
    recorder.onStageExecuted(makeStageEvent('Sub1', 'sf-payment'));
    recorder.onStageExecuted(makeStageEvent('Sub2', 'sf-payment'));

    const entries = recorder.getEntries();
    expect(entries[0].text).toContain('Stage 1:'); // Root1
    expect(entries[1].text).toContain('Stage 2:'); // Root2
    expect(entries[2].text).toContain('Stage 1:'); // Sub1 — reset!
    expect(entries[3].text).toContain('Stage 2:'); // Sub2
  });

  it('first subflow stage uses "began" wording', () => {
    const recorder = new CombinedNarrativeRecorder();

    recorder.onStageExecuted(makeStageEvent('Root1'));
    recorder.onStageExecuted(makeStageEvent('Sub1', 'sf-x'));

    const entries = recorder.getEntries();
    expect(entries[0].text).toContain('began');
    expect(entries[1].text).toContain('began'); // first in its subflow
  });

  it('resuming root after subflow continues root counter', () => {
    const recorder = new CombinedNarrativeRecorder();

    recorder.onStageExecuted(makeStageEvent('Root1')); // Stage 1
    recorder.onStageExecuted(makeStageEvent('Root2')); // Stage 2
    recorder.onStageExecuted(makeStageEvent('Sub1', 'sf-a')); // Stage 1 (subflow)
    recorder.onStageExecuted(makeStageEvent('Root3')); // Stage 3 (root resumes)

    const entries = recorder.getEntries();
    expect(entries[0].text).toContain('Stage 1:');
    expect(entries[1].text).toContain('Stage 2:');
    expect(entries[2].text).toContain('Stage 1:'); // subflow reset
    expect(entries[3].text).toContain('Stage 3:'); // root continues
  });

  it('multiple subflows each reset independently', () => {
    const recorder = new CombinedNarrativeRecorder();

    recorder.onStageExecuted(makeStageEvent('Root1'));

    // First subflow
    recorder.onStageExecuted(makeStageEvent('PayA', 'sf-payment'));
    recorder.onStageExecuted(makeStageEvent('PayB', 'sf-payment'));

    // Second subflow
    recorder.onStageExecuted(makeStageEvent('ShipA', 'sf-shipping'));
    recorder.onStageExecuted(makeStageEvent('ShipB', 'sf-shipping'));
    recorder.onStageExecuted(makeStageEvent('ShipC', 'sf-shipping'));

    const entries = recorder.getEntries();
    expect(entries[0].text).toContain('Stage 1:'); // Root1
    expect(entries[1].text).toContain('Stage 1:'); // PayA
    expect(entries[2].text).toContain('Stage 2:'); // PayB
    expect(entries[3].text).toContain('Stage 1:'); // ShipA
    expect(entries[4].text).toContain('Stage 2:'); // ShipB
    expect(entries[5].text).toContain('Stage 3:'); // ShipC
  });

  it('decider stages also reset per subflow', () => {
    const recorder = new CombinedNarrativeRecorder();

    recorder.onStageExecuted(makeStageEvent('Root1'));
    recorder.onDecision(makeDecisionEvent('SubDecider', 'high', 'sf-risk'));

    const entries = recorder.getEntries().filter((e) => e.type === 'stage');
    expect(entries[0].text).toContain('Stage 1:'); // Root1
    expect(entries[1].text).toContain('Stage 1:'); // SubDecider — reset for sf-risk
  });

  it('clear() resets all per-subflow state', () => {
    const recorder = new CombinedNarrativeRecorder();

    recorder.onStageExecuted(makeStageEvent('A'));
    recorder.onStageExecuted(makeStageEvent('B', 'sf-x'));
    recorder.clear();

    recorder.onStageExecuted(makeStageEvent('C'));
    recorder.onStageExecuted(makeStageEvent('D', 'sf-x'));

    const entries = recorder.getEntries();
    expect(entries[0].text).toContain('Stage 1:');
    expect(entries[0].text).toContain('began');
    expect(entries[1].text).toContain('Stage 1:');
    expect(entries[1].text).toContain('began');
  });
});

describe('CombinedNarrativeRecorder: stageId propagation', () => {
  it('stage entries carry stageId from traversalContext', () => {
    const recorder = new CombinedNarrativeRecorder();

    recorder.onStageExecuted(makeStageEvent('Parse Request', undefined, undefined, 'parse-request'));
    recorder.onStageExecuted(makeStageEvent('Transform', undefined, undefined, 'transform'));

    const entries = recorder.getEntries();
    expect(entries[0].stageId).toBe('parse-request');
    expect(entries[1].stageId).toBe('transform');
  });

  it('step entries inherit stageId from their parent stage', () => {
    const recorder = new CombinedNarrativeRecorder();

    recorder.onWrite({
      stageName: 'Fetch',
      key: 'data',
      value: [1, 2],
      operation: 'set',
      pipelineId: '',
      timestamp: 0,
    });
    recorder.onStageExecuted(makeStageEvent('Fetch', undefined, undefined, 'fetch-id'));

    const entries = recorder.getEntries();
    const stepEntry = entries.find((e) => e.type === 'step');
    expect(stepEntry).toBeDefined();
    expect(stepEntry!.stageId).toBe('fetch-id');
  });

  it('decision entries carry stageId', () => {
    const recorder = new CombinedNarrativeRecorder();

    recorder.onDecision(makeDecisionEvent('RiskCheck', 'low', undefined, 'risk-check-id'));

    const entries = recorder.getEntries();
    const stageEntry = entries.find((e) => e.type === 'stage');
    const condEntry = entries.find((e) => e.type === 'condition');
    expect(stageEntry!.stageId).toBe('risk-check-id');
    expect(condEntry!.stageId).toBe('risk-check-id');
  });

  it('fork entries carry stageId', () => {
    const recorder = new CombinedNarrativeRecorder();

    recorder.onFork(makeForkEvent('Router', ['a', 'b'], 'router-id'));

    const entries = recorder.getEntries();
    expect(entries[0].stageId).toBe('router-id');
  });

  it('subflow entry/exit carry stageId', () => {
    const recorder = new CombinedNarrativeRecorder();

    recorder.onSubflowEntry(makeSubflowEvent('PaymentService', 'sf-pay', 'Processes payment', 'sf-pay-mount'));
    recorder.onSubflowExit(makeSubflowEvent('PaymentService', 'sf-pay', undefined, 'sf-pay-mount'));

    const entries = recorder.getEntries();
    expect(entries[0].stageId).toBe('sf-pay-mount');
    expect(entries[1].stageId).toBe('sf-pay-mount');
  });

  it('subflow stages have their own stageId (not parent)', () => {
    const recorder = new CombinedNarrativeRecorder();

    recorder.onStageExecuted(makeStageEvent('Root', undefined, undefined, 'root-id'));
    recorder.onStageExecuted(makeStageEvent('SubStage', 'sf-x', undefined, 'sub-stage-id'));

    const entries = recorder.getEntries();
    expect(entries[0].stageId).toBe('root-id');
    expect(entries[1].stageId).toBe('sub-stage-id');
  });

  it('loop entries carry stageId', () => {
    const recorder = new CombinedNarrativeRecorder();

    recorder.onLoop(makeLoopEvent('Retry', 2, 'retry-id'));

    const entries = recorder.getEntries();
    expect(entries[0].stageId).toBe('retry-id');
    expect(entries[0].type).toBe('loop');
  });

  it('break entries carry stageId', () => {
    const recorder = new CombinedNarrativeRecorder();

    recorder.onBreak(makeBreakEvent('EarlyExit', 'early-exit-id'));

    const entries = recorder.getEntries();
    expect(entries[0].stageId).toBe('early-exit-id');
    expect(entries[0].type).toBe('break');
  });

  it('error entries carry stageId', () => {
    const recorder = new CombinedNarrativeRecorder();

    recorder.onError(makeErrorEvent('FailStage', 'something broke', 'fail-id'));

    const entries = recorder.getEntries();
    expect(entries[0].stageId).toBe('fail-id');
    expect(entries[0].type).toBe('error');
  });

  it('all entry types in a full flow carry stageId', () => {
    const recorder = new CombinedNarrativeRecorder();

    // Root stage with write
    recorder.onWrite({ stageName: 'Init', key: 'x', value: 1, operation: 'set', pipelineId: '', timestamp: 0 });
    recorder.onStageExecuted(makeStageEvent('Init', undefined, 'Initialize', 'init-id'));

    // Decision
    recorder.onDecision(makeDecisionEvent('Route', 'fast', undefined, 'route-id'));

    // Fork
    recorder.onFork(makeForkEvent('Parallel', ['a', 'b'], 'parallel-id'));

    // Subflow
    recorder.onSubflowEntry(makeSubflowEvent('Worker', 'sf-w', 'Does work', 'worker-mount'));

    // Loop
    recorder.onLoop(makeLoopEvent('Retry', 1, 'retry-id'));

    // Break
    recorder.onBreak(makeBreakEvent('Stop', 'stop-id'));

    // Error
    recorder.onError(makeErrorEvent('Boom', 'kaboom', 'boom-id'));

    const entries = recorder.getEntries();
    // Every entry should have a stageId
    for (const entry of entries) {
      expect(entry.stageId).toBeDefined();
      expect(typeof entry.stageId).toBe('string');
    }

    // Verify we covered all entry types
    const types = new Set(entries.map((e) => e.type));
    expect(types.has('stage')).toBe(true);
    expect(types.has('step')).toBe(true);
    expect(types.has('condition')).toBe(true);
    expect(types.has('fork')).toBe(true);
    expect(types.has('subflow')).toBe(true);
    expect(types.has('loop')).toBe(true);
    expect(types.has('break')).toBe(true);
    expect(types.has('error')).toBe(true);
  });
});
