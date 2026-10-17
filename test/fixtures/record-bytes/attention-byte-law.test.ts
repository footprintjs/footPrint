/** C2 optional attention and PR104's one explicitly retained commit-error diagnostic are the named laws. */
import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { pinnedText } from '../bytes.js';
import hashes from './pre-attention-hashes.json';
import { SCENARIOS } from './scenarios.js';

const CHANGED = new Set(['failures', 'forkError', 'retry', 'throttledFork']);

/** These fixtures are controlled records. Only actual stage-shaped objects lose the new projection. */
function withoutAttention(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(withoutAttention);
  const object = value as Record<string, unknown>;
  const stage =
    typeof object.id === 'string' && typeof object.runtimeStageId === 'string' && Object.hasOwn(object, 'errors');
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(object)) {
    if (stage && key === 'attention') continue;
    output[key] = withoutAttention(item);
  }
  return output;
}

/** PR104 changes exactly one diagnostic at one known failed commit; no general error-bag exemption. */
function projectCommitErrorDiagnostic(name: string, current: unknown, prior: unknown): void {
  if (name !== 'failures') return;
  type Fixture = {
    uncloneable: {
      failed: string;
      snapshot: {
        executionTree: {
          next: { id: string; runtimeStageId: string; errors: Record<string, unknown>; attention?: unknown };
        };
      };
    };
  };
  const uncloneable = (current as Fixture).uncloneable;
  const stage = uncloneable.snapshot.executionTree.next;
  expect(stage.id).toBe('uncloneable');
  expect(stage.runtimeStageId).toBe('uncloneable#1');
  expect(uncloneable.failed).toMatch(/^DataCloneError: /);
  expect(stage.errors).toEqual({ stageExecutionError: uncloneable.failed });
  expect(stage.attention).toEqual([
    { kind: 'error', reason: 'ERROR_RECORDED', evidence: ['errors:stageExecutionError'] },
  ]);
  const projected = (prior as Fixture).uncloneable.snapshot.executionTree.next;
  expect(projected.id).toBe(stage.id);
  expect(projected.runtimeStageId).toBe(stage.runtimeStageId);
  expect(projected.errors).toEqual({ stageExecutionError: uncloneable.failed });
  delete projected.errors.stageExecutionError;
}

describe('C2 record byte boundary against the captured pre-attention engine', () => {
  it.each(Object.keys(SCENARIOS))('%s preserves every byte outside the named law', async (name) => {
    const current: unknown = JSON.parse(pinnedText(await SCENARIOS[name]!()));
    const prior = withoutAttention(current);
    projectCommitErrorDiagnostic(name, current, prior);
    const normalized = JSON.stringify(prior, null, 2) + '\n';
    expect(createHash('sha256').update(normalized).digest('hex')).toBe(hashes[name as keyof typeof hashes]);
    if (!CHANGED.has(name)) expect(JSON.stringify(current, null, 2) + '\n').toBe(normalized);
  });
});
