/**
 * Scenario test: onRunFailed — the terminal failure boundary.
 *
 * A top-level run must close its boundary SYMMETRICALLY: every onRunStart
 * is followed by exactly one onRunEnd (clean) or onRunFailed (error).
 * Before this, a thrown run fired onRunStart then went silent — a live
 * monitor couldn't tell "still running" from "crashed." onRunFailed is
 * the observable terminal signal; the error still throws (observation,
 * not recovery).
 *
 * Patterns:
 *   - thrown run → onRunFailed fires once, with structured error; still throws
 *   - clean run → onRunEnd fires, onRunFailed does NOT
 *   - pause → neither onRunEnd nor onRunFailed (suspension, not termination)
 *   - symmetric boundary: onRunStart always paired with one terminal event
 *   - structured error preserved (InputValidationError issues)
 *   - dispatcher fans out onRunFailed to ALL recorders
 */

import { describe, expect, it, vi } from 'vitest';

import type { StageNode } from '../../../../src/lib/engine/graph/StageNode';
import type { FlowRecorder, FlowRunEvent, FlowRunFailedEvent } from '../../../../src/lib/engine/narrative/types';
import { FlowchartTraverser } from '../../../../src/lib/engine/traversal/FlowchartTraverser';
import type { ILogger, StageFunction } from '../../../../src/lib/engine/types';
import { PauseSignal } from '../../../../src/lib/pause/types';
import { ExecutionRuntime } from '../../../../src/lib/runner/ExecutionRuntime';
import { InputValidationError } from '../../../../src/lib/schema/errors';

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

function createTraverser(root: StageNode, stageMap: Map<string, StageFunction>, flowRecorders: FlowRecorder[]) {
  const runtime = new ExecutionRuntime(root.name, root.name);
  const traverser = new FlowchartTraverser({
    root,
    stageMap,
    scopeFactory: simpleScopeFactory,
    executionRuntime: runtime,
    scopeProtectionMode: 'off',
    logger: silentLogger,
    narrativeEnabled: true,
    flowRecorders,
  });
  return { traverser, runtime };
}

/** Spy recorder capturing the run-boundary lifecycle in order. */
function boundarySpy() {
  const calls: string[] = [];
  const failed: FlowRunFailedEvent[] = [];
  const ended: FlowRunEvent[] = [];
  const rec: FlowRecorder = {
    id: 'boundary-spy',
    onRunStart: () => calls.push('start'),
    onRunEnd: (e) => {
      calls.push('end');
      ended.push(e);
    },
    onRunFailed: (e) => {
      calls.push('failed');
      failed.push(e);
    },
  };
  return { rec, calls, failed, ended };
}

describe('onRunFailed — fires on a thrown run', () => {
  it('fires once before the error propagates, and the run still throws', async () => {
    const spy = boundarySpy();
    const stageMap = new Map<string, StageFunction>();
    stageMap.set('boom', () => {
      throw new Error('kaboom');
    });
    const root: StageNode = { name: 'boom', id: 'boom' };
    const { traverser } = createTraverser(root, stageMap, [spy.rec]);

    await expect(traverser.execute()).rejects.toThrow('kaboom');

    expect(spy.failed).toHaveLength(1);
    expect(spy.failed[0].structuredError.message).toContain('kaboom');
    // Symmetric boundary: started then failed, never ended.
    expect(spy.calls).toEqual(['start', 'failed']);
  });

  it('preserves structured error details (InputValidationError issues)', async () => {
    const spy = boundarySpy();
    const issues = [
      { path: ['email'], message: 'Required', code: 'invalid_type' },
      { path: ['age'], message: 'Expected number', code: 'invalid_type' },
    ];
    const stageMap = new Map<string, StageFunction>();
    stageMap.set('validate', () => {
      throw new InputValidationError('Validation failed', issues);
    });
    const root: StageNode = { name: 'validate', id: 'validate' };
    const { traverser } = createTraverser(root, stageMap, [spy.rec]);

    await expect(traverser.execute()).rejects.toThrow('Validation failed');

    expect(spy.failed).toHaveLength(1);
    const err = spy.failed[0].structuredError;
    expect(err.name).toBe('InputValidationError');
    expect(err.issues).toHaveLength(2);
    expect(err.issues![0].path).toEqual(['email']);
  });
});

describe('onRunFailed — NOT fired on the happy path', () => {
  it('a clean run fires onRunEnd, never onRunFailed', async () => {
    const spy = boundarySpy();
    const stageMap = new Map<string, StageFunction>();
    stageMap.set('ok', () => 'done');
    const root: StageNode = { name: 'ok', id: 'ok' };
    const { traverser } = createTraverser(root, stageMap, [spy.rec]);

    await traverser.execute();

    expect(spy.failed).toHaveLength(0);
    expect(spy.ended).toHaveLength(1);
    expect(spy.calls).toEqual(['start', 'end']);
  });
});

describe('onRunFailed — NOT fired on pause (suspension, not termination)', () => {
  it('a PauseSignal fires neither onRunEnd nor onRunFailed and re-throws untouched', async () => {
    const spy = boundarySpy();
    const stageMap = new Map<string, StageFunction>();
    stageMap.set('pause', () => {
      throw new PauseSignal({ question: 'approve?' }, 'pause');
    });
    const root: StageNode = { name: 'pause', id: 'pause' };
    const { traverser } = createTraverser(root, stageMap, [spy.rec]);

    await expect(traverser.execute()).rejects.toBeInstanceOf(PauseSignal);

    // Pause is expected control flow — the boundary is NOT terminal.
    expect(spy.failed).toHaveLength(0);
    expect(spy.ended).toHaveLength(0);
    expect(spy.calls).toEqual(['start']);
  });
});

describe('onRunFailed — dispatcher fans out to all recorders', () => {
  it('every attached recorder receives onRunFailed exactly once', async () => {
    const a = boundarySpy();
    const b = boundarySpy();
    const stageMap = new Map<string, StageFunction>();
    stageMap.set('boom', () => {
      throw new Error('x');
    });
    const root: StageNode = { name: 'boom', id: 'boom' };
    const { traverser } = createTraverser(root, stageMap, [a.rec, b.rec]);

    await expect(traverser.execute()).rejects.toThrow('x');

    expect(a.failed).toHaveLength(1);
    expect(b.failed).toHaveLength(1);
  });

  it('a recorder throwing in onRunFailed does not break others or swallow the original error', async () => {
    const good = boundarySpy();
    const bad: FlowRecorder = {
      id: 'bad',
      onRunFailed: () => {
        throw new Error('recorder blew up');
      },
    };
    const stageMap = new Map<string, StageFunction>();
    stageMap.set('boom', () => {
      throw new Error('original');
    });
    const root: StageNode = { name: 'boom', id: 'boom' };
    const { traverser } = createTraverser(root, stageMap, [bad, good.rec]);

    // The ORIGINAL error propagates, not the recorder's.
    await expect(traverser.execute()).rejects.toThrow('original');
    // The good recorder still got its event (error isolation).
    expect(good.failed).toHaveLength(1);
  });
});
