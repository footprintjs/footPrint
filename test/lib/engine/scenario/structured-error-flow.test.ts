/**
 * Scenario test: Structured error flow through the narrative system.
 *
 * Verifies that InputValidationError (and other structured errors) preserve
 * field-level details all the way through to FlowRecorders and narrative output,
 * instead of being flattened to strings at the traverser level.
 *
 * Patterns covered:
 * - InputValidationError in linear stage → structured error in FlowErrorEvent
 * - InputValidationError in decider stage → same preservation
 * - Standard Error → structuredError present, no issues field
 * - Custom FlowRecorder receives structuredError on FlowErrorEvent
 * - NarrativeFlowRecorder enriches narrative with validation issues
 */

import { describe, expect, it, vi } from 'vitest';

import type { StageNode } from '../../../../src/lib/engine/graph/StageNode';
import type { FlowErrorEvent, FlowRecorder } from '../../../../src/lib/engine/narrative/types';
import { FlowchartTraverser } from '../../../../src/lib/engine/traversal/FlowchartTraverser';
import type { ILogger, StageFunction } from '../../../../src/lib/engine/types';
import { ExecutionRuntime } from '../../../../src/lib/runner/ExecutionRuntime';
import { InputValidationError } from '../../../../src/lib/schema/errors';

const silentLogger: ILogger = {
  info: vi.fn(),
  log: vi.fn(),
  debug: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
};

function simpleScopeFactory(context: any, stageName: string) {
  return {
    get: (key: string) => context.getValue([], key),
    set: (key: string, value: unknown) => context.setObject([], key, value),
  };
}

function createTraverser(
  root: StageNode,
  stageMap: Map<string, StageFunction>,
  opts?: { narrativeEnabled?: boolean; flowRecorders?: FlowRecorder[] },
) {
  const runtime = new ExecutionRuntime(root.name);
  const traverser = new FlowchartTraverser({
    root,
    stageMap,
    scopeFactory: simpleScopeFactory,
    executionRuntime: runtime,
    scopeProtectionMode: 'off',
    logger: silentLogger,
    narrativeEnabled: opts?.narrativeEnabled,
    flowRecorders: opts?.flowRecorders,
  });
  return { traverser, runtime };
}

// ─────────────────────── InputValidationError preservation ───────────────────────

describe('Structured error flow: InputValidationError', () => {
  const validationIssues = [
    { path: ['email'], message: 'Required', code: 'invalid_type', expected: 'string', received: 'undefined' },
    { path: ['age'], message: 'Expected number, received string', code: 'invalid_type' },
  ];

  it('custom FlowRecorder receives structuredError with issues on FlowErrorEvent', async () => {
    const capturedEvents: FlowErrorEvent[] = [];
    const spy: FlowRecorder = {
      id: 'spy',
      onError(event: FlowErrorEvent) {
        capturedEvents.push(event);
      },
    };

    const stageMap = new Map<string, StageFunction>();
    stageMap.set('validate', () => {
      throw new InputValidationError('Validation failed', validationIssues);
    });

    const root: StageNode = { name: 'validate', id: 'validate' };
    const { traverser } = createTraverser(root, stageMap, { narrativeEnabled: true, flowRecorders: [spy] });

    await expect(traverser.execute()).rejects.toThrow('Validation failed');

    expect(capturedEvents).toHaveLength(1);
    const event = capturedEvents[0];

    expect(event.message).toContain('Validation failed');
    expect(event.stageName).toBe('validate');

    // structuredError preserves full details
    expect(event.structuredError.name).toBe('InputValidationError');
    expect(event.structuredError.code).toBe('INPUT_VALIDATION_ERROR');
    expect(event.structuredError.issues).toHaveLength(2);
    expect(event.structuredError.issues![0].path).toEqual(['email']);
    expect(event.structuredError.issues![0].message).toBe('Required');
    expect(event.structuredError.issues![1].path).toEqual(['age']);
    expect(event.structuredError.raw).toBeInstanceOf(InputValidationError);
  });

  it('narrative includes field-level validation details', async () => {
    const stageMap = new Map<string, StageFunction>();
    stageMap.set('fetchData', () => 'data');
    stageMap.set('validate', () => {
      throw new InputValidationError('Validation failed', validationIssues);
    });

    const validate: StageNode = { name: 'validate', id: 'validate' };
    const root: StageNode = { name: 'fetchData', id: 'fetchData', next: validate };

    const { traverser } = createTraverser(root, stageMap, { narrativeEnabled: true });

    await expect(traverser.execute()).rejects.toThrow('Validation failed');

    const narrative = traverser.getNarrative();
    // Should have the error sentence with enriched details
    const errorSentence = narrative.find((s) => s.includes('error') && s.includes('validate'));
    expect(errorSentence).toBeDefined();
    expect(errorSentence).toContain('email');
    expect(errorSentence).toContain('age');
    expect(errorSentence).toContain('Validation issues');
  });
});

// ─────────────────────── Standard Error ───────────────────────

describe('Structured error flow: Standard Error', () => {
  it('standard Error flows through without issues field', async () => {
    const capturedEvents: FlowErrorEvent[] = [];
    const spy: FlowRecorder = {
      id: 'spy',
      onError(event: FlowErrorEvent) {
        capturedEvents.push(event);
      },
    };

    const stageMap = new Map<string, StageFunction>();
    stageMap.set('fail', () => {
      throw new Error('plain error');
    });

    const root: StageNode = { name: 'fail', id: 'fail' };
    const { traverser } = createTraverser(root, stageMap, { narrativeEnabled: true, flowRecorders: [spy] });

    await expect(traverser.execute()).rejects.toThrow('plain error');

    expect(capturedEvents).toHaveLength(1);
    const event = capturedEvents[0];

    expect(event.structuredError.name).toBe('Error');
    expect(event.structuredError.message).toBe('plain error');
    expect(event.structuredError.issues).toBeUndefined();
  });

  it('narrative for standard Error does not include "Validation issues"', async () => {
    const stageMap = new Map<string, StageFunction>();
    stageMap.set('fail', () => {
      throw new Error('plain error');
    });

    const root: StageNode = { name: 'fail', id: 'fail' };
    const { traverser } = createTraverser(root, stageMap, { narrativeEnabled: true });

    await expect(traverser.execute()).rejects.toThrow('plain error');

    const narrative = traverser.getNarrative();
    const errorSentence = narrative.find((s) => s.includes('error'));
    expect(errorSentence).toBeDefined();
    expect(errorSentence).not.toContain('Validation issues');
  });
});

// ─────────────────────── Decider with structured error ───────────────────────

describe('Structured error flow: Decider', () => {
  it('InputValidationError in decider preserves structured error', async () => {
    const capturedEvents: FlowErrorEvent[] = [];
    const spy: FlowRecorder = {
      id: 'spy',
      onError(event: FlowErrorEvent) {
        capturedEvents.push(event);
      },
    };

    const issues = [{ path: ['threshold'], message: 'Must be positive', code: 'too_small' }];

    const stageMap = new Map<string, StageFunction>();
    stageMap.set('decide', () => {
      throw new InputValidationError('Invalid threshold', issues);
    });

    const branchA: StageNode = { name: 'branchA', id: 'branchA', fn: () => 'a' };
    const root: StageNode = { name: 'decide', id: 'decide', deciderFn: true, children: [branchA] };

    const { traverser } = createTraverser(root, stageMap, { narrativeEnabled: true, flowRecorders: [spy] });

    await expect(traverser.execute()).rejects.toThrow('Invalid threshold');

    expect(capturedEvents).toHaveLength(1);
    expect(capturedEvents[0].structuredError.issues).toHaveLength(1);
    expect(capturedEvents[0].structuredError.issues![0].path).toEqual(['threshold']);
  });
});

// ─────────────────────── Narrative disabled (no regression) ───────────────────────

describe('Structured error flow: Narrative disabled', () => {
  it('errors still propagate correctly when narrative is disabled', async () => {
    const stageMap = new Map<string, StageFunction>();
    stageMap.set('fail', () => {
      throw new InputValidationError('Bad input', [{ path: ['x'], message: 'Required' }]);
    });

    const root: StageNode = { name: 'fail', id: 'fail' };
    const { traverser, runtime } = createTraverser(root, stageMap);

    await expect(traverser.execute()).rejects.toThrow('Bad input');

    // Error metadata still recorded in snapshot
    const snapshot = runtime.getSnapshot();
    const treeStr = JSON.stringify(snapshot.executionTree);
    expect(treeStr).toContain('stageExecutionError');
  });
});
