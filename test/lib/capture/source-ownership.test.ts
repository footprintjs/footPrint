import { describe, expect, it } from 'vitest';

import { SourceOwnershipCollector } from '../../../src/lib/capture/sourceOwnership.js';
import { SOURCE_OWNERSHIP_V1_LIMITS } from '../../../src/lib/capture/sourceOwnershipFormat.js';

function collector() {
  return new SourceOwnershipCollector('run', { logRunId: 'run', drillPath: [] }, 0);
}

describe('bounded native source ownership collector', () => {
  it('retains the first real commit and never substitutes a later continuation', () => {
    const capture = collector();
    capture.begin('run', 's#0', []);
    capture.attempt('s#0', 1);
    capture.commit('s#0', 0);
    capture.commit('s#0', 4);
    expect(capture.snapshot(5, 1).executions[0].firstCommit).toBe(0);
  });

  it.each(['wrong run', 'invalid identity', 'duplicate identity', 'deep address', 'long address'])(
    'keeps %s unknown',
    (kind) => {
      const capture = collector();
      if (kind === 'wrong run') capture.begin('other', 's#0', []);
      if (kind === 'invalid identity') capture.begin('run', 'not-an-execution', []);
      if (kind === 'duplicate identity') {
        capture.begin('run', 's#0', []);
        capture.begin('run', 's#0', []);
      }
      if (kind === 'deep address') capture.begin('run', 's#0', Array(65).fill('x'));
      if (kind === 'long address') capture.begin('run', 's#0', ['x'.repeat(2049)]);
      expect(capture.snapshot(0, 1)).toMatchObject({ status: 'unknown', limitations: ['identity-unavailable'] });
    },
  );

  it.each(['unknown owner', 'skip first attempt', 'duplicate attempt', 'invalid attempt'])(
    'cannot establish %s',
    (kind) => {
      const capture = collector();
      capture.begin('run', 's#0', []);
      if (kind === 'unknown owner') capture.attempt('other#0', 1);
      if (kind === 'skip first attempt') capture.attempt('s#0', 2);
      if (kind === 'duplicate attempt') {
        capture.attempt('s#0', 1);
        capture.attempt('s#0', 1);
      }
      if (kind === 'invalid attempt') capture.attempt('s#0', 0);
      expect(capture.snapshot(0, 1)).toMatchObject({ status: 'unknown', limitations: ['attempt-unavailable'] });
    },
  );

  it.each(['unknown owner', 'invalid index'])('does not attach a commit with %s', (kind) => {
    const capture = collector();
    capture.begin('run', 's#0', []);
    capture.commit(kind === 'unknown owner' ? 'other#0' : 's#0', kind === 'invalid index' ? -1 : 0);
    expect(capture.snapshot(0, 1)).toMatchObject({ status: 'unknown', limitations: ['commit-unavailable'] });
  });

  it('bounds executions without replacing them with a complete empty extent', () => {
    const capture = collector();
    for (let index = 0; index <= SOURCE_OWNERSHIP_V1_LIMITS.executions; index++) capture.begin('run', `s#${index}`, []);
    const result = capture.snapshot(0, 1);
    expect(result.executions).toHaveLength(SOURCE_OWNERSHIP_V1_LIMITS.executions);
    expect(result).toMatchObject({ status: 'unknown', limitations: ['execution-limit'] });
  });

  it('bounds actual invocation identities independently of the source row budget', () => {
    const capture = collector();
    capture.begin('run', 's#0', []);
    for (let attempt = 1; attempt <= SOURCE_OWNERSHIP_V1_LIMITS.attempts + 1; attempt++)
      capture.attempt('s#0', attempt);
    expect(capture.snapshot(0, 1)).toMatchObject({ status: 'unknown', limitations: ['attempt-limit'] });
    expect(capture.snapshot(0, 1).executions[0].attemptIds).toHaveLength(SOURCE_OWNERSHIP_V1_LIMITS.attempts);
  });

  it('charges exact escaped JSON bytes, retaining a bounded unknown witness at the limit', () => {
    const capture = collector();
    const address = Array(64).fill('\u0001'.repeat(128));
    for (let index = 0; index < 20; index++) capture.begin('run', `s#${index}`, address);
    const result = capture.snapshot(20, 1);
    expect(result.status).toBe('unknown');
    expect(result.limitations).toContain('bytes-limit');
    expect(new TextEncoder().encode(JSON.stringify(result)).length).toBeLessThanOrEqual(
      SOURCE_OWNERSHIP_V1_LIMITS.bytes,
    );
    expect(result.executions.length).toBeGreaterThan(0);
  });

  it('serves detached frozen snapshots that do not grow with later entries', () => {
    const capture = collector();
    capture.begin('run', 's#0', []);
    capture.attempt('s#0', 1);
    const first = capture.snapshot(0, 1);
    capture.attempt('s#0', 2);
    capture.begin('run', 's#1', []);
    expect(first.executions).toHaveLength(1);
    expect(first.executions[0].attemptIds).toEqual(['s#0@1']);
    expect(Object.isFrozen(first.executions[0].attemptIds)).toBe(true);
  });
});
