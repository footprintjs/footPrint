/** C2 named record law: only optional attention may change. */
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

describe('C2 record byte boundary against the captured pre-attention engine', () => {
  it.each(Object.keys(SCENARIOS))('%s preserves every byte outside the named law', async (name) => {
    const current: unknown = JSON.parse(pinnedText(await SCENARIOS[name]!()));
    const prior = withoutAttention(current);
    const normalized = JSON.stringify(prior, null, 2) + '\n';
    expect(createHash('sha256').update(normalized).digest('hex')).toBe(hashes[name as keyof typeof hashes]);
    if (!CHANGED.has(name)) expect(JSON.stringify(current, null, 2) + '\n').toBe(normalized);
  });
});
