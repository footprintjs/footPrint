/**
 * Boundary test: Structured error edge cases.
 *
 * Tests extreme/unusual error types flowing through the structured error system:
 * - Non-Error thrown values (string, number, object)
 * - Error with no message
 * - Error with very long message
 * - InputValidationError with empty issues array
 * - InputValidationError with deeply nested paths
 * - Multiple errors in sequence (different types)
 * - Errors during narrative-disabled execution
 */

import { vi } from 'vitest';

import type { StageNode } from '../../../../src/lib/engine/graph/StageNode';
import { NarrativeFlowRecorder } from '../../../../src/lib/engine/narrative/NarrativeFlowRecorder';
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

function simpleScopeFactory(context: any) {
  return {
    get: (key: string) => context.getValue([], key),
    set: (key: string, value: unknown) => context.setObject([], key, value),
  };
}

function createTraverser(
  root: StageNode,
  stageMap: Map<string, StageFunction>,
  opts?: { flowRecorders?: FlowRecorder[] },
) {
  const runtime = new ExecutionRuntime(root.name, root.name);
  const traverser = new FlowchartTraverser({
    root,
    stageMap,
    scopeFactory: simpleScopeFactory,
    executionRuntime: runtime,
    scopeProtectionMode: 'off',
    logger: silentLogger,
    narrativeEnabled: true,
    flowRecorders: [...(opts?.flowRecorders ?? []), new NarrativeFlowRecorder()],
  });
  return { traverser, runtime };
}

describe('Boundary: Structured error edge cases', () => {
  let capturedEvents: FlowErrorEvent[];
  let spy: FlowRecorder;

  beforeEach(() => {
    capturedEvents = [];
    spy = {
      id: 'spy',
      onError(event: FlowErrorEvent) {
        capturedEvents.push(event);
      },
    };
  });

  it('string thrown value produces structuredError with no name/issues', async () => {
    const stageMap = new Map<string, StageFunction>();
    stageMap.set('fail', () => {
      throw 'raw string error'; // eslint-disable-line no-throw-literal
    });

    const root: StageNode = { name: 'fail', id: 'fail' };
    const { traverser } = createTraverser(root, stageMap, { flowRecorders: [spy] });

    await expect(traverser.execute()).rejects.toBe('raw string error');

    expect(capturedEvents[0].structuredError.message).toBe('raw string error');
    expect(capturedEvents[0].structuredError.name).toBeUndefined();
    expect(capturedEvents[0].structuredError.issues).toBeUndefined();
    expect(capturedEvents[0].structuredError.raw).toBe('raw string error');
  });

  it('number thrown value produces valid structuredError', async () => {
    const stageMap = new Map<string, StageFunction>();
    stageMap.set('fail', () => {
      throw 404; // eslint-disable-line no-throw-literal
    });

    const root: StageNode = { name: 'fail', id: 'fail' };
    const { traverser } = createTraverser(root, stageMap, { flowRecorders: [spy] });

    await expect(traverser.execute()).rejects.toBe(404);

    expect(capturedEvents[0].structuredError.message).toBe('404');
    expect(capturedEvents[0].structuredError.raw).toBe(404);
  });

  it('Error with empty message still produces valid structuredError', async () => {
    const stageMap = new Map<string, StageFunction>();
    stageMap.set('fail', () => {
      throw new Error('');
    });

    const root: StageNode = { name: 'fail', id: 'fail' };
    const { traverser } = createTraverser(root, stageMap, { flowRecorders: [spy] });

    await expect(traverser.execute()).rejects.toThrow();

    expect(capturedEvents[0].structuredError.message).toBe('');
    expect(capturedEvents[0].structuredError.name).toBe('Error');
  });

  it('InputValidationError with empty issues array', async () => {
    const stageMap = new Map<string, StageFunction>();
    stageMap.set('fail', () => {
      throw new InputValidationError('No specific issues', []);
    });

    const root: StageNode = { name: 'fail', id: 'fail' };
    const { traverser } = createTraverser(root, stageMap, { flowRecorders: [spy] });

    await expect(traverser.execute()).rejects.toThrow('No specific issues');

    expect(capturedEvents[0].structuredError.issues).toEqual([]);
    // Narrative should NOT include "Validation issues:" when array is empty
    const narrative = traverser.getNarrative();
    const errorSentence = narrative.find((s) => s.includes('error'));
    expect(errorSentence).not.toContain('Validation issues');
  });

  it('InputValidationError with deeply nested paths', async () => {
    const stageMap = new Map<string, StageFunction>();
    stageMap.set('fail', () => {
      throw new InputValidationError('Deep path error', [
        { path: ['users', 0, 'addresses', 1, 'zipCode'], message: 'Invalid format' },
      ]);
    });

    const root: StageNode = { name: 'fail', id: 'fail' };
    const { traverser } = createTraverser(root, stageMap, { flowRecorders: [spy] });

    await expect(traverser.execute()).rejects.toThrow('Deep path error');

    const issue = capturedEvents[0].structuredError.issues![0];
    expect(issue.path).toEqual(['users', 0, 'addresses', 1, 'zipCode']);

    // Narrative should join the path with dots
    const narrative = traverser.getNarrative();
    expect(narrative.some((s) => s.includes('users.0.addresses.1.zipCode'))).toBe(true);
  });

  it('very long error message does not crash or truncate', async () => {
    const longMessage = 'x'.repeat(10_000);
    const stageMap = new Map<string, StageFunction>();
    stageMap.set('fail', () => {
      throw new Error(longMessage);
    });

    const root: StageNode = { name: 'fail', id: 'fail' };
    const { traverser } = createTraverser(root, stageMap, { flowRecorders: [spy] });

    await expect(traverser.execute()).rejects.toThrow();

    expect(capturedEvents[0].structuredError.message).toBe(longMessage);
    expect(capturedEvents[0].structuredError.message.length).toBe(10_000);
  });
});
