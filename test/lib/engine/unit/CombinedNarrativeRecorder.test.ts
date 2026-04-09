/**
 * Unit tests for CombinedNarrativeRecorder per-subflow stage numbering.
 *
 * Validates that stage counters reset when entering a subflow,
 * so subflow stages start at "Stage 1" instead of continuing
 * the parent's counter.
 */

import { describe, expect, it } from 'vitest';

import { CombinedNarrativeRecorder } from '../../../../src/lib/engine/narrative/CombinedNarrativeRecorder.js';

/** Helper for scope events (ReadEvent / WriteEvent) with required RecorderContext fields. */
function scopeEvent(stageName: string, runtimeStageId: string, extra: Record<string, unknown> = {}) {
  return { stageName, stageId: stageName, runtimeStageId, pipelineId: '', timestamp: 0, ...extra };
}

function makeStageEvent(
  stageName: string,
  subflowId?: string,
  description?: string,
  stageId?: string,
  runtimeStageId?: string,
) {
  return {
    stageName,
    description,
    traversalContext: {
      stageId: stageId ?? stageName,
      runtimeStageId: runtimeStageId ?? `${stageId ?? stageName}#0`,
      stageName,
      subflowId,
      depth: subflowId ? 1 : 0,
      parentStageId: undefined,
    },
  };
}

function makeDecisionEvent(
  decider: string,
  chosen: string,
  subflowId?: string,
  stageId?: string,
  runtimeStageId?: string,
) {
  return {
    decider,
    chosen,
    traversalContext: {
      stageId: stageId ?? decider,
      runtimeStageId: runtimeStageId ?? `${stageId ?? decider}#0`,
      stageName: decider,
      subflowId,
      depth: subflowId ? 1 : 0,
      parentStageId: undefined,
    },
  };
}

function makeForkEvent(parent: string, children: string[], stageId?: string, runtimeStageId?: string) {
  return {
    parent,
    children,
    traversalContext: {
      stageId: stageId ?? parent,
      runtimeStageId: runtimeStageId ?? `${stageId ?? parent}#0`,
      stageName: parent,
      depth: 0,
      parentStageId: undefined,
    },
  };
}

function makeLoopEvent(target: string, iteration: number, stageId?: string, runtimeStageId?: string) {
  return {
    target,
    iteration,
    traversalContext: {
      stageId: stageId ?? target,
      runtimeStageId: runtimeStageId ?? `${stageId ?? target}#0`,
      stageName: target,
      depth: 0,
      parentStageId: undefined,
    },
  };
}

function makeBreakEvent(stageName: string, stageId?: string, runtimeStageId?: string) {
  return {
    stageName,
    traversalContext: {
      stageId: stageId ?? stageName,
      runtimeStageId: runtimeStageId ?? `${stageId ?? stageName}#0`,
      stageName,
      depth: 0,
      parentStageId: undefined,
    },
  };
}

function makeErrorEvent(stageName: string, message: string, stageId?: string, runtimeStageId?: string) {
  return {
    stageName,
    message,
    structuredError: { type: 'Error', message, issues: [] },
    traversalContext: {
      stageId: stageId ?? stageName,
      runtimeStageId: runtimeStageId ?? `${stageId ?? stageName}#0`,
      stageName,
      depth: 0,
      parentStageId: undefined,
    },
  };
}

function makeSubflowEvent(
  name: string,
  subflowId: string,
  description?: string,
  stageId?: string,
  runtimeStageId?: string,
) {
  return {
    name,
    subflowId,
    description,
    traversalContext: {
      stageId: stageId ?? name,
      runtimeStageId: runtimeStageId ?? `${stageId ?? name}#0`,
      stageName: name,
      subflowId,
      depth: 1,
      parentStageId: undefined,
    },
  };
}

function makeSelectedEvent(selected: string[], total: number, stageId?: string, runtimeStageId?: string) {
  return {
    selected,
    total,
    traversalContext: {
      stageId: stageId ?? 'selector',
      runtimeStageId: runtimeStageId ?? `${stageId ?? 'selector'}#0`,
      stageName: 'selector',
      depth: 0,
      parentStageId: undefined,
    },
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

    recorder.onWrite({ ...scopeEvent('Fetch', 'fetch-id#0'), key: 'data', value: [1, 2], operation: 'set' });
    recorder.onStageExecuted(makeStageEvent('Fetch', undefined, undefined, 'fetch-id', 'fetch-id#0'));

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
    recorder.onWrite({ ...scopeEvent('Init', 'init-id#0'), key: 'x', value: 1, operation: 'set' });
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

// ============================================================================
// Dual-index: runtimeStageId propagation + time-travel queries
// ============================================================================

describe('CombinedNarrativeRecorder: runtimeStageId propagation', () => {
  it('stage entries carry runtimeStageId from traversalContext', () => {
    const recorder = new CombinedNarrativeRecorder();

    recorder.onStageExecuted(makeStageEvent('Seed', undefined, undefined, 'seed', 'seed#0'));
    recorder.onStageExecuted(makeStageEvent('CallLLM', undefined, undefined, 'call-llm', 'call-llm#1'));

    const entries = recorder.getEntries();
    expect(entries[0].runtimeStageId).toBe('seed#0');
    expect(entries[1].runtimeStageId).toBe('call-llm#1');
  });

  it('step entries inherit runtimeStageId from their parent stage', () => {
    const recorder = new CombinedNarrativeRecorder();

    recorder.onWrite({ ...scopeEvent('Fetch', 'fetch#3'), key: 'data', value: [1, 2], operation: 'set' });
    recorder.onRead({ ...scopeEvent('Fetch', 'fetch#3'), key: 'url', value: 'https://example.com' });
    recorder.onStageExecuted(makeStageEvent('Fetch', undefined, undefined, 'fetch', 'fetch#3'));

    const steps = recorder.getEntries().filter((e) => e.type === 'step');
    expect(steps).toHaveLength(2);
    expect(steps[0].runtimeStageId).toBe('fetch#3');
    expect(steps[1].runtimeStageId).toBe('fetch#3');
  });

  it('decision + condition entries carry runtimeStageId', () => {
    const recorder = new CombinedNarrativeRecorder();

    recorder.onDecision(makeDecisionEvent('Classify', 'high', undefined, 'classify', 'classify#2'));

    const entries = recorder.getEntries();
    const stage = entries.find((e) => e.type === 'stage')!;
    const condition = entries.find((e) => e.type === 'condition')!;
    expect(stage.runtimeStageId).toBe('classify#2');
    expect(condition.runtimeStageId).toBe('classify#2');
  });

  it('all entry types carry runtimeStageId in a full flow', () => {
    const recorder = new CombinedNarrativeRecorder();

    recorder.onWrite({ ...scopeEvent('Init', 'init#0'), key: 'x', value: 1, operation: 'set' });
    recorder.onStageExecuted(makeStageEvent('Init', undefined, 'Initialize', 'init', 'init#0'));
    recorder.onDecision(makeDecisionEvent('Route', 'fast', undefined, 'route', 'route#1'));
    recorder.onFork(makeForkEvent('Parallel', ['a', 'b'], 'parallel', 'parallel#2'));
    recorder.onSelected(makeSelectedEvent(['a'], 2, 'sel', 'sel#3'));
    recorder.onSubflowEntry(makeSubflowEvent('Worker', 'sf-w', 'Does work', 'worker', 'worker#4'));
    recorder.onLoop(makeLoopEvent('Retry', 1, 'retry', 'retry#5'));
    recorder.onBreak(makeBreakEvent('Stop', 'stop', 'stop#6'));
    recorder.onError(makeErrorEvent('Boom', 'kaboom', 'boom', 'boom#7'));

    const entries = recorder.getEntries();
    for (const entry of entries) {
      expect(entry.runtimeStageId).toBeDefined();
      expect(entry.runtimeStageId).toMatch(/#\d+$/);
    }
  });

  it('loop iterations produce distinct runtimeStageIds', () => {
    const recorder = new CombinedNarrativeRecorder();

    // First iteration
    recorder.onStageExecuted(makeStageEvent('CallLLM', undefined, undefined, 'call-llm', 'call-llm#0'));
    recorder.onStageExecuted(makeStageEvent('Check', undefined, undefined, 'check', 'check#1'));
    recorder.onLoop(makeLoopEvent('CallLLM', 1, 'check', 'check#1'));

    // Second iteration
    recorder.onStageExecuted(makeStageEvent('CallLLM', undefined, undefined, 'call-llm', 'call-llm#2'));
    recorder.onStageExecuted(makeStageEvent('Check', undefined, undefined, 'check', 'check#3'));

    const stageEntries = recorder.getEntries().filter((e) => e.type === 'stage');
    expect(stageEntries[0].runtimeStageId).toBe('call-llm#0');
    expect(stageEntries[1].runtimeStageId).toBe('check#1');
    expect(stageEntries[2].runtimeStageId).toBe('call-llm#2'); // different from #0
    expect(stageEntries[3].runtimeStageId).toBe('check#3');
  });
});

describe('CombinedNarrativeRecorder: getEntriesForStep (O(1) per-step lookup)', () => {
  it('returns all entries for a given runtimeStageId', () => {
    const recorder = new CombinedNarrativeRecorder();

    recorder.onWrite({ ...scopeEvent('Seed', 'seed#0'), key: 'x', value: 1, operation: 'set' });
    recorder.onRead({ ...scopeEvent('Seed', 'seed#0'), key: 'config', value: {} });
    recorder.onStageExecuted(makeStageEvent('Seed', undefined, 'Initialize', 'seed', 'seed#0'));

    recorder.onStageExecuted(makeStageEvent('Transform', undefined, undefined, 'transform', 'transform#1'));

    const seedEntries = recorder.getEntriesForStep('seed#0');
    expect(seedEntries).toHaveLength(3); // 1 stage + 2 steps
    expect(seedEntries[0].type).toBe('stage');
    expect(seedEntries[1].type).toBe('step');
    expect(seedEntries[2].type).toBe('step');

    const transformEntries = recorder.getEntriesForStep('transform#1');
    expect(transformEntries).toHaveLength(1);
    expect(transformEntries[0].type).toBe('stage');
  });

  it('returns empty array for unknown runtimeStageId', () => {
    const recorder = new CombinedNarrativeRecorder();
    expect(recorder.getEntriesForStep('nonexistent#99')).toEqual([]);
  });

  it('decision step includes stage + condition entries', () => {
    const recorder = new CombinedNarrativeRecorder();

    recorder.onRead({ ...scopeEvent('Classify', 'classify#5'), key: 'score', value: 750 });
    recorder.onDecision(makeDecisionEvent('Classify', 'approved', undefined, 'classify', 'classify#5'));

    const entries = recorder.getEntriesForStep('classify#5');
    expect(entries).toHaveLength(3); // stage + step (read) + condition
    expect(entries.map((e) => e.type)).toEqual(['stage', 'step', 'condition']);
  });

  it('returns same object references as getEntries (no copy)', () => {
    const recorder = new CombinedNarrativeRecorder();
    recorder.onStageExecuted(makeStageEvent('A', undefined, undefined, 'a', 'a#0'));

    const allEntries = recorder.getEntries();
    const stepEntries = recorder.getEntriesForStep('a#0');

    // getEntries returns a copy, but the objects inside are the same references
    // getEntriesForStep returns the internal array (readonly), so same objects
    expect(stepEntries[0].text).toBe(allEntries[0].text);
    expect(stepEntries[0].stageId).toBe(allEntries[0].stageId);
  });
});

describe('CombinedNarrativeRecorder: getEntriesUpTo (progressive time-travel)', () => {
  function buildLinearFlow(recorder: CombinedNarrativeRecorder) {
    // Seed#0 → CallLLM#1 → Check#2 → (loop) → CallLLM#3 → Check#4
    recorder.onWrite({ ...scopeEvent('Seed', 'seed#0'), key: 'prompt', value: 'hello', operation: 'set' });
    recorder.onStageExecuted(makeStageEvent('Seed', undefined, 'Initialize', 'seed', 'seed#0'));

    recorder.onRead({ ...scopeEvent('CallLLM', 'call-llm#1'), key: 'prompt', value: 'hello' });
    recorder.onWrite({ ...scopeEvent('CallLLM', 'call-llm#1'), key: 'response', value: 'world', operation: 'set' });
    recorder.onStageExecuted(makeStageEvent('CallLLM', undefined, undefined, 'call-llm', 'call-llm#1'));

    recorder.onDecision(makeDecisionEvent('Check', 'continue', undefined, 'check', 'check#2'));
    recorder.onLoop(makeLoopEvent('CallLLM', 1, 'check', 'check#2'));

    recorder.onRead({ ...scopeEvent('CallLLM', 'call-llm#3'), key: 'prompt', value: 'hello' });
    recorder.onWrite({ ...scopeEvent('CallLLM', 'call-llm#3'), key: 'response', value: 'world2', operation: 'set' });
    recorder.onStageExecuted(makeStageEvent('CallLLM', undefined, undefined, 'call-llm', 'call-llm#3'));

    recorder.onDecision(makeDecisionEvent('Check', 'done', undefined, 'check', 'check#4'));
  }

  it('shows nothing when visibleIds is empty', () => {
    const recorder = new CombinedNarrativeRecorder();
    buildLinearFlow(recorder);
    expect(recorder.getEntriesUpTo(new Set())).toEqual([]);
  });

  it('shows only first stage at slider position 0', () => {
    const recorder = new CombinedNarrativeRecorder();
    buildLinearFlow(recorder);

    const visible = recorder.getEntriesUpTo(new Set(['seed#0']));
    expect(visible.every((e) => e.runtimeStageId === 'seed#0')).toBe(true);
    expect(visible).toHaveLength(2); // stage + step (write)
  });

  it('progressively reveals more entries as slider moves', () => {
    const recorder = new CombinedNarrativeRecorder();
    buildLinearFlow(recorder);

    const at1 = recorder.getEntriesUpTo(new Set(['seed#0', 'call-llm#1']));
    const at2 = recorder.getEntriesUpTo(new Set(['seed#0', 'call-llm#1', 'check#2']));
    const atAll = recorder.getEntriesUpTo(new Set(['seed#0', 'call-llm#1', 'check#2', 'call-llm#3', 'check#4']));

    expect(at1.length).toBeGreaterThan(2); // seed entries + callLLM entries
    expect(at2.length).toBeGreaterThan(at1.length); // + check entries
    expect(atAll.length).toBe(recorder.getEntries().length); // everything
  });

  it('loop entries are included when surrounded by visible steps', () => {
    const recorder = new CombinedNarrativeRecorder();
    buildLinearFlow(recorder);

    // Include check#2 (which triggers the loop) and call-llm#3 (loop target)
    const visible = recorder.getEntriesUpTo(new Set(['seed#0', 'call-llm#1', 'check#2', 'call-llm#3']));
    const loopEntries = visible.filter((e) => e.type === 'loop');
    expect(loopEntries).toHaveLength(1);
  });

  it('loop entry with runtimeStageId is included when that id is visible', () => {
    const recorder = new CombinedNarrativeRecorder();
    buildLinearFlow(recorder);

    // Loop entry has runtimeStageId 'check#2' (from the decider that caused the loop).
    // When check#2 is visible, the loop entry is correctly part of that step's narrative.
    const visible = recorder.getEntriesUpTo(new Set(['seed#0', 'call-llm#1', 'check#2']));
    const loopEntries = visible.filter((e) => e.type === 'loop');
    expect(loopEntries).toHaveLength(1);
  });

  it('loop entry excluded when its runtimeStageId is NOT in visible set', () => {
    const recorder = new CombinedNarrativeRecorder();
    buildLinearFlow(recorder);

    // Only seed and callLLM visible — check#2 (which owns the loop) is not visible.
    const visible = recorder.getEntriesUpTo(new Set(['seed#0', 'call-llm#1']));
    const loopEntries = visible.filter((e) => e.type === 'loop');
    expect(loopEntries).toHaveLength(0);
  });

  it('trailing markers without runtimeStageId are discarded (defensive)', () => {
    const recorder = new CombinedNarrativeRecorder();

    // Stage with runtimeStageId
    recorder.onStageExecuted(makeStageEvent('Seed', undefined, undefined, 'seed', 'seed#0'));

    // Simulate a structural marker without traversalContext.runtimeStageId
    // (defensive case — normally all events have traversalContext)
    recorder.onLoop({ target: 'Seed', iteration: 1, traversalContext: undefined as any });

    // Stage after the marker — NOT in visible set
    recorder.onStageExecuted(makeStageEvent('Next', undefined, undefined, 'next', 'next#2'));

    // Only seed visible — the marker trails seed but next#2 is not visible,
    // so the marker should be discarded.
    const visible = recorder.getEntriesUpTo(new Set(['seed#0']));
    expect(visible.filter((e) => e.type === 'loop')).toHaveLength(0);
    expect(visible).toHaveLength(1); // only the seed stage entry
  });

  it('markers without runtimeStageId included when between visible steps', () => {
    const recorder = new CombinedNarrativeRecorder();

    recorder.onStageExecuted(makeStageEvent('A', undefined, undefined, 'a', 'a#0'));
    // Marker without runtimeStageId between two visible steps
    recorder.onLoop({ target: 'A', iteration: 1, traversalContext: undefined as any });
    recorder.onStageExecuted(makeStageEvent('B', undefined, undefined, 'b', 'b#1'));

    const visible = recorder.getEntriesUpTo(new Set(['a#0', 'b#1']));
    expect(visible.filter((e) => e.type === 'loop')).toHaveLength(1);
  });

  it('subflow entry/exit included via runtimeStageId (not as structural markers)', () => {
    const recorder = new CombinedNarrativeRecorder();

    recorder.onStageExecuted(makeStageEvent('Root', undefined, undefined, 'root', 'root#0'));
    recorder.onSubflowEntry(makeSubflowEvent('Payment', 'sf-pay', 'Process', 'sf-pay-mount', 'sf-pay-mount#1'));
    recorder.onStageExecuted(makeStageEvent('Charge', 'sf-pay', undefined, 'sf-pay/charge', 'sf-pay/charge#2'));
    recorder.onSubflowExit(makeSubflowEvent('Payment', 'sf-pay', undefined, 'sf-pay-mount', 'sf-pay-mount#3'));

    // Subflow entry has its own runtimeStageId — included when that ID is in visible set
    const atRoot = recorder.getEntriesUpTo(new Set(['root#0']));
    expect(atRoot.filter((e) => e.type === 'subflow')).toHaveLength(0);

    const atEntry = recorder.getEntriesUpTo(new Set(['root#0', 'sf-pay-mount#1']));
    expect(atEntry.filter((e) => e.type === 'subflow')).toHaveLength(1);

    const atAll = recorder.getEntriesUpTo(new Set(['root#0', 'sf-pay-mount#1', 'sf-pay/charge#2', 'sf-pay-mount#3']));
    expect(atAll.filter((e) => e.type === 'subflow')).toHaveLength(2); // entry + exit
  });

  it('preserves insertion order', () => {
    const recorder = new CombinedNarrativeRecorder();
    buildLinearFlow(recorder);

    const allEntries = recorder.getEntries();
    const visible = recorder.getEntriesUpTo(new Set(['seed#0', 'call-llm#1', 'check#2', 'call-llm#3', 'check#4']));

    // Same entries, same order
    expect(visible.map((e) => e.text)).toEqual(allEntries.map((e) => e.text));
  });
});

describe('CombinedNarrativeRecorder: stepCount', () => {
  it('counts unique runtimeStageIds', () => {
    const recorder = new CombinedNarrativeRecorder();

    recorder.onWrite({ ...scopeEvent('Seed', 'seed#0'), key: 'x', value: 1, operation: 'set' });
    recorder.onStageExecuted(makeStageEvent('Seed', undefined, undefined, 'seed', 'seed#0'));
    recorder.onStageExecuted(makeStageEvent('Transform', undefined, undefined, 'transform', 'transform#1'));

    expect(recorder.stepCount).toBe(2); // 2 unique runtimeStageIds (step entries share seed's id)
  });

  it('resets on clear()', () => {
    const recorder = new CombinedNarrativeRecorder();
    recorder.onStageExecuted(makeStageEvent('A', undefined, undefined, 'a', 'a#0'));
    expect(recorder.stepCount).toBe(1);

    recorder.clear();
    expect(recorder.stepCount).toBe(0);
  });
});

describe('CombinedNarrativeRecorder: clear() resets dual-index', () => {
  it('clears both entries array and byRuntimeStageId map', () => {
    const recorder = new CombinedNarrativeRecorder();

    recorder.onStageExecuted(makeStageEvent('A', undefined, undefined, 'a', 'a#0'));
    recorder.onStageExecuted(makeStageEvent('B', undefined, undefined, 'b', 'b#1'));
    expect(recorder.getEntries()).toHaveLength(2);
    expect(recorder.getEntriesForStep('a#0')).toHaveLength(1);

    recorder.clear();

    expect(recorder.getEntries()).toHaveLength(0);
    expect(recorder.getEntriesForStep('a#0')).toEqual([]);
    expect(recorder.stepCount).toBe(0);
  });

  it('fresh entries after clear have correct runtimeStageIds', () => {
    const recorder = new CombinedNarrativeRecorder();

    recorder.onStageExecuted(makeStageEvent('Old', undefined, undefined, 'old', 'old#0'));
    recorder.clear();

    recorder.onStageExecuted(makeStageEvent('New', undefined, undefined, 'new', 'new#0'));
    expect(recorder.getEntriesForStep('old#0')).toEqual([]);
    expect(recorder.getEntriesForStep('new#0')).toHaveLength(1);
  });
});

describe('CombinedNarrativeRecorder: pause/resume with dual-index', () => {
  it('pause entry is indexed by runtimeStageId', () => {
    const recorder = new CombinedNarrativeRecorder();

    recorder.onStageExecuted(makeStageEvent('Seed', undefined, undefined, 'seed', 'seed#0'));
    recorder.onPause({
      stageName: 'Approve',
      stageId: 'approve',
      subflowPath: undefined,
      traversalContext: {
        stageId: 'approve',
        runtimeStageId: 'approve#1',
        stageName: 'Approve',
        depth: 0,
        parentStageId: undefined,
      },
    });

    expect(recorder.getEntriesForStep('approve#1')).toHaveLength(1);
    expect(recorder.getEntriesForStep('approve#1')[0].type).toBe('pause');
    expect(recorder.stepCount).toBe(2); // seed + approve
  });

  it('resume entry is indexed by runtimeStageId', () => {
    const recorder = new CombinedNarrativeRecorder();

    recorder.onResume({
      stageName: 'Approve',
      stageId: 'approve',
      hasInput: true,
      subflowPath: undefined,
      traversalContext: {
        stageId: 'approve',
        runtimeStageId: 'approve#1',
        stageName: 'Approve',
        depth: 0,
        parentStageId: undefined,
      },
    });

    expect(recorder.getEntriesForStep('approve#1')).toHaveLength(1);
    expect(recorder.getEntriesForStep('approve#1')[0].type).toBe('resume');
  });

  it('getEntriesForStep returns a copy (mutation safe)', () => {
    const recorder = new CombinedNarrativeRecorder();
    recorder.onStageExecuted(makeStageEvent('A', undefined, undefined, 'a', 'a#0'));

    const copy1 = recorder.getEntriesForStep('a#0');
    copy1.push({ type: 'stage', text: 'injected', depth: 0 }); // mutate the copy
    const copy2 = recorder.getEntriesForStep('a#0');
    expect(copy2).toHaveLength(1); // internal state unaffected
  });
});
