/**
 * Pause types — 5-pattern tests.
 *
 * Tests PauseSignal, PauseResult, FlowchartCheckpoint, PausableHandler,
 * and type guards.
 */
import { describe, expect, it } from 'vitest';

import {
  type FlowchartCheckpoint,
  type PausableHandler,
  type PauseResult,
  isPauseResult,
  isPauseSignal,
  PauseSignal,
} from '../../../src/lib/pause';

// ── Unit ────────────────────────────────────────────────────

describe('Pause types — unit', () => {
  it('PauseSignal is an Error with pauseData and stageId', () => {
    const signal = new PauseSignal({ question: 'Approve?' }, 'approve-stage');
    expect(signal).toBeInstanceOf(Error);
    expect(signal.name).toBe('PauseSignal');
    expect(signal.message).toBe('Execution paused');
    expect(signal.pauseData).toEqual({ question: 'Approve?' });
    expect(signal.stageId).toBe('approve-stage');
    expect(signal.subflowPath).toEqual([]);
  });

  it('PauseSignal.prependSubflow builds path during bubble-up', () => {
    const signal = new PauseSignal(null, 'approve');
    signal.prependSubflow('sf-inner');
    signal.prependSubflow('sf-outer');
    // Path is built in reverse: inner first, then outer prepends
    expect(signal.subflowPath).toEqual(['sf-outer', 'sf-inner']);
  });

  it('isPauseResult correctly identifies PauseResult', () => {
    expect(isPauseResult({ pause: true })).toBe(true);
    expect(isPauseResult({ pause: true, data: { question: 'Yes?' } })).toBe(true);
    expect(isPauseResult({ pause: false })).toBe(false);
    expect(isPauseResult(null)).toBe(false);
    expect(isPauseResult(undefined)).toBe(false);
    expect(isPauseResult('string')).toBe(false);
    expect(isPauseResult(42)).toBe(false);
  });

  it('isPauseSignal correctly identifies PauseSignal instances', () => {
    expect(isPauseSignal(new PauseSignal(null, 'test'))).toBe(true);
    expect(isPauseSignal(new Error('regular error'))).toBe(false);
    expect(isPauseSignal(null)).toBe(false);
    expect(isPauseSignal({ name: 'PauseSignal' })).toBe(false); // duck-type doesn't match
  });

  it('FlowchartCheckpoint is JSON-serializable', () => {
    const checkpoint: FlowchartCheckpoint = {
      sharedState: { orderId: '123', amount: 299, approved: false },
      executionTree: {
        id: 'seed',
        status: 'done',
        next: { id: 'approve', status: 'paused' },
      },
      pauseData: { question: 'Approve $299 refund?' },
      pausedAt: Date.now(),
    };

    const json = JSON.stringify(checkpoint);
    const parsed = JSON.parse(json);
    expect(parsed.sharedState.orderId).toBe('123');
    expect(parsed.pauseData.question).toBe('Approve $299 refund?');
    expect(parsed.executionTree.next.status).toBe('paused');
  });
});

// ── Boundary ────────────────────────────────────────────────

describe('Pause types — boundary', () => {
  it('PauseSignal with undefined pauseData', () => {
    const signal = new PauseSignal(undefined, 'stage');
    expect(signal.pauseData).toBeUndefined();
  });

  it('PauseResult with no data', () => {
    const result: PauseResult = { pause: true };
    expect(isPauseResult(result)).toBe(true);
    expect(result.data).toBeUndefined();
  });

  it('FlowchartCheckpoint with minimal fields', () => {
    const checkpoint: FlowchartCheckpoint = {
      sharedState: {},
      executionTree: null,
      pausedAt: 0,
    };
    expect(JSON.stringify(checkpoint)).toBeTruthy();
  });

  it('PauseSignal subflowPath starts empty', () => {
    const signal = new PauseSignal(null, 'test');
    expect(signal.subflowPath).toHaveLength(0);
  });
});

// ── Scenario ────────────────────────────────────────────────

describe('Pause types — scenario', () => {
  it('approval gate: PausableHandler execute pauses, resume continues', () => {
    const handler: PausableHandler<{ orderId: string; approved?: boolean }, { approved: boolean }> = {
      execute: (scope) => {
        scope.orderId = 'ORD-123';
        return { pause: true, data: { question: 'Approve order ORD-123?' } };
      },
      resume: (scope, input) => {
        scope.approved = input.approved;
      },
    };

    // Simulate execute phase
    const scope = { orderId: '', approved: undefined as boolean | undefined };
    const result = handler.execute(scope);
    expect(isPauseResult(result)).toBe(true);
    expect(scope.orderId).toBe('ORD-123');

    // Simulate resume phase
    handler.resume(scope, { approved: true });
    expect(scope.approved).toBe(true);
  });

  it('subflow pause: signal carries nested path', () => {
    // Simulate: pause inside sf-payment/sf-validation/approve
    const signal = new PauseSignal({ question: 'Confirm?' }, 'approve');
    // SubflowExecutor for sf-validation catches and prepends
    signal.prependSubflow('sf-validation');
    // SubflowExecutor for sf-payment catches and prepends
    signal.prependSubflow('sf-payment');

    expect(signal.subflowPath).toEqual(['sf-payment', 'sf-validation']);
    expect(signal.stageId).toBe('approve');
  });
});

// ── Property ────────────────────────────────────────────────

describe('Pause types — property', () => {
  it('PauseSignal is throwable and catchable as Error', () => {
    const signal = new PauseSignal({ q: 'test' }, 'stage-1');

    let caught: unknown;
    try {
      throw signal;
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(PauseSignal);
    expect(caught).toBeInstanceOf(Error);
    expect(isPauseSignal(caught)).toBe(true);
    expect((caught as PauseSignal).stageId).toBe('stage-1');
  });

  it('FlowchartCheckpoint round-trips through JSON', () => {
    const original: FlowchartCheckpoint = {
      sharedState: { nested: { deep: [1, 2, 3] } },
      executionTree: { id: 'a', next: { id: 'b', children: [{ id: 'c' }] } },
      pauseData: { question: 'Continue?', options: ['yes', 'no'] },
      subflowResults: { 'sf-1': { result: 'done' } },
      pausedAt: 1712345678000,
    };

    const roundTripped = JSON.parse(JSON.stringify(original));
    expect(roundTripped).toEqual(original);
  });
});

// ── Security ────────────────────────────────────────────────

describe('Pause types — security', () => {
  it('FlowchartCheckpoint does not contain functions', () => {
    const checkpoint: FlowchartCheckpoint = {
      sharedState: { value: 'safe' },
      executionTree: {},
      pausedAt: Date.now(),
    };

    // Verify no functions in serialized output
    const json = JSON.stringify(checkpoint);
    expect(json).not.toContain('function');
    expect(json).not.toContain('=>');
  });

  it('PauseSignal pauseData is consumer-controlled — no secrets by default', () => {
    // The framework passes through whatever the consumer puts in $pause()
    // Consumer responsibility: don't put API keys in pauseData
    const signal = new PauseSignal({ question: 'Approve?', safe: true }, 'stage');
    expect(signal.pauseData).toEqual({ question: 'Approve?', safe: true });
    // No automatic data added by the framework
  });
});
