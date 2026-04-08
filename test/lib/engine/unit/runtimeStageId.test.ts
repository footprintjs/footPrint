/**
 * Unit tests for runtimeStageId builder and parser.
 *
 * 5 patterns: basic, loop, subflow, nested subflow, parse round-trip.
 */
import { describe, expect, it } from 'vitest';

import {
  buildRuntimeStageId,
  createExecutionCounter,
  parseRuntimeStageId,
} from '../../../../src/lib/engine/runtimeStageId';

describe('buildRuntimeStageId', () => {
  it('basic — stageId + executionIndex', () => {
    expect(buildRuntimeStageId('seed', 0)).toBe('seed#0');
    expect(buildRuntimeStageId('call-llm', 5)).toBe('call-llm#5');
    expect(buildRuntimeStageId('finalize', 12)).toBe('finalize#12');
  });

  it('loop — same stageId, different indices', () => {
    expect(buildRuntimeStageId('process', 1)).toBe('process#1');
    expect(buildRuntimeStageId('process', 3)).toBe('process#3');
    expect(buildRuntimeStageId('process', 5)).toBe('process#5');
    // All unique despite same stageId
    const ids = [1, 3, 5].map((i) => buildRuntimeStageId('process', i));
    expect(new Set(ids).size).toBe(3);
  });

  it('subflow — subflowPath prefix', () => {
    expect(buildRuntimeStageId('execute-tool-calls', 8, 'sf-tools')).toBe('sf-tools/execute-tool-calls#8');
    expect(buildRuntimeStageId('resolve-prompt', 1, 'sf-system-prompt')).toBe('sf-system-prompt/resolve-prompt#1');
  });

  it('nested subflow — deep path', () => {
    expect(buildRuntimeStageId('validate', 3, 'sf-outer/sf-inner')).toBe('sf-outer/sf-inner/validate#3');
    expect(buildRuntimeStageId('call-llm', 5, 'sf-billing/sf-tools')).toBe('sf-billing/sf-tools/call-llm#5');
  });

  it('same stage name in different subflows — unique', () => {
    const root = buildRuntimeStageId('validate', 0);
    const sfA = buildRuntimeStageId('validate', 1, 'sf-a');
    const sfB = buildRuntimeStageId('validate', 2, 'sf-a/sf-b');
    expect(root).toBe('validate#0');
    expect(sfA).toBe('sf-a/validate#1');
    expect(sfB).toBe('sf-a/sf-b/validate#2');
    expect(new Set([root, sfA, sfB]).size).toBe(3);
  });
});

describe('parseRuntimeStageId', () => {
  it('basic — no subflow', () => {
    const parsed = parseRuntimeStageId('call-llm#5');
    expect(parsed.stageId).toBe('call-llm');
    expect(parsed.executionIndex).toBe(5);
    expect(parsed.subflowPath).toBeUndefined();
  });

  it('subflow — single level', () => {
    const parsed = parseRuntimeStageId('sf-tools/execute-tool-calls#8');
    expect(parsed.stageId).toBe('execute-tool-calls');
    expect(parsed.executionIndex).toBe(8);
    expect(parsed.subflowPath).toBe('sf-tools');
  });

  it('nested subflow — multi level', () => {
    const parsed = parseRuntimeStageId('sf-billing/sf-tools/call-llm#5');
    expect(parsed.stageId).toBe('call-llm');
    expect(parsed.executionIndex).toBe(5);
    expect(parsed.subflowPath).toBe('sf-billing/sf-tools');
  });

  it('round-trip — build then parse', () => {
    const cases = [
      { stageId: 'seed', executionIndex: 0, subflowPath: undefined },
      { stageId: 'call-llm', executionIndex: 9, subflowPath: undefined },
      { stageId: 'validate', executionIndex: 3, subflowPath: 'sf-auth' },
      { stageId: 'process', executionIndex: 7, subflowPath: 'sf-a/sf-b/sf-c' },
    ];
    for (const c of cases) {
      const built = buildRuntimeStageId(c.stageId, c.executionIndex, c.subflowPath);
      const parsed = parseRuntimeStageId(built);
      expect(parsed.stageId).toBe(c.stageId);
      expect(parsed.executionIndex).toBe(c.executionIndex);
      expect(parsed.subflowPath).toBe(c.subflowPath);
    }
  });

  it('no hash — fallback', () => {
    const parsed = parseRuntimeStageId('legacy-stage');
    expect(parsed.stageId).toBe('legacy-stage');
    expect(parsed.executionIndex).toBe(0);
    expect(parsed.subflowPath).toBeUndefined();
  });
});

describe('ExecutionCounter', () => {
  it('starts at 0', () => {
    const counter = createExecutionCounter();
    expect(counter.value).toBe(0);
  });

  it('shared by reference — mutations visible across holders', () => {
    const counter = createExecutionCounter();
    const ref1 = counter;
    const ref2 = counter;
    ref1.value++;
    expect(ref2.value).toBe(1);
    ref2.value++;
    expect(ref1.value).toBe(2);
  });
});
