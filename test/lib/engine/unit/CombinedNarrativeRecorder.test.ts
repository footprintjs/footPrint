/**
 * Unit tests for CombinedNarrativeRecorder per-subflow stage numbering.
 *
 * Validates that stage counters reset when entering a subflow,
 * so subflow stages start at "Stage 1" instead of continuing
 * the parent's counter.
 */

import { describe, expect, it } from 'vitest';

import { CombinedNarrativeRecorder } from '../../../../src/lib/engine/narrative/CombinedNarrativeRecorder.js';

function makeStageEvent(stageName: string, subflowId?: string, description?: string) {
  return {
    stageName,
    description,
    traversalContext:
      subflowId !== undefined
        ? { stageId: stageName, stageName, subflowId, depth: subflowId ? 1 : 0, parentStageId: undefined }
        : undefined,
  };
}

function makeDecisionEvent(decider: string, chosen: string, subflowId?: string) {
  return {
    decider,
    chosen,
    traversalContext:
      subflowId !== undefined
        ? { stageId: decider, stageName: decider, subflowId, depth: subflowId ? 1 : 0, parentStageId: undefined }
        : undefined,
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
