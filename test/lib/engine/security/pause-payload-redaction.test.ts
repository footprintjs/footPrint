/**
 * Pause payloads under the restored redaction law (owner ruling (a), gap 2).
 *
 * A pause payload — a pausable stage's return or an `interrupt()` payload — is
 * a record handed out whole: every observer (scope and flow `onPause`, inline
 * and deferred, the narrative, recorder rows) is served it under the policy;
 * the CHECKPOINT keeps the real payload, because resume hands it back to the
 * caller who asked the question.
 */
import { describe, expect, it } from 'vitest';

import { flowChart, FlowChartExecutor, interrupt } from '../../../../src/index.js';

const SECRET = 'sk-pause-9d1';
const MASK = '[REDACTED]';

function observe(executor: FlowChartExecutor) {
  const seen: unknown[] = [];
  const recorder = (id: string) => ({
    id,
    onPause: (event: unknown) => seen.push(event),
    toSnapshot: () => ({ name: id, data: seen }),
  });
  executor.attachCombinedRecorder(recorder('pause-inline'));
  executor.attachCombinedRecorder(recorder('pause-deferred'), { delivery: 'deferred' });
  executor.enableNarrative();
  return seen;
}

describe('pause payloads are served under the policy; the checkpoint keeps them real', () => {
  it.each(['pausable', 'interrupt'] as const)('%s: every served view is masked, resume answers', async (kind) => {
    const ask = { reason: 'approve the transfer', token: SECRET, profile: { name: 'Ada', ssn: '123-45' } };
    const builder = flowChart<any>(
      'Seed',
      (scope) => {
        scope.started = true;
      },
      'seed',
    );
    const chart = (
      kind === 'pausable'
        ? builder.addPausableFunction(
            'Ask',
            {
              execute: () => ask,
              resume: (scope: any, input: any) => {
                scope.approved = input.ok;
              },
            },
            'ask',
          )
        : builder.addFunction(
            'Ask',
            (scope: any) => {
              const answer = interrupt(scope, ask) as { ok: boolean };
              scope.approved = answer.ok;
            },
            'ask',
          )
    ).build();
    const executor = new FlowChartExecutor(chart);
    executor.setRedactionPolicy({ keys: ['token'], fields: { profile: ['ssn'] } });
    const seen = observe(executor);

    await executor.run();
    await executor.drainObservers();
    const checkpoint = executor.getCheckpoint()!;
    expect(checkpoint.pauseData).toEqual(ask);

    const served = JSON.stringify({
      seen,
      narrative: executor.getNarrativeEntries(),
      snapshot: executor.getSnapshot({ redact: true }),
      plainRecorders: executor.getSnapshot().recorders,
    });
    expect(served).not.toContain(SECRET);
    expect(served).not.toContain('123-45');
    // Both channels, both tiers: 2 recorders × (scope + flow).
    const payloads = seen.map((event) => (event as { pauseData: unknown }).pauseData);
    expect(payloads).toHaveLength(4);
    for (const payload of payloads) {
      expect(payload).toEqual({ reason: 'approve the transfer', token: MASK, profile: { name: 'Ada', ssn: MASK } });
    }
    expect(ask.token).toBe(SECRET); // the stage's own value is never edited

    await executor.resume(checkpoint, { ok: true });
    expect(executor.getSnapshot().sharedState).toMatchObject({ started: true, approved: true });
  });

  it('a payload whose scrub cannot run is served as the placeholder — never raw', async () => {
    const ask = { profile: { ssn: SECRET, callback: () => 1 } };
    const chart = flowChart<any>('Seed', () => undefined, 'seed')
      .addPausableFunction('Ask', { execute: () => ask, resume: () => undefined }, 'ask')
      .build();
    const executor = new FlowChartExecutor(chart);
    executor.setRedactionPolicy({ fields: { profile: ['ssn'] } });
    const seen = observe(executor);
    // The checkpoint contract refuses the function on its own terms (unchanged); the served
    // events fired first and carried the placeholder, never the raw payload.
    await expect(executor.run()).rejects.toThrow(/cannot build the pause checkpoint/);
    const inline = seen.map((event) => (event as { pauseData: unknown }).pauseData);
    expect(inline.length).toBeGreaterThan(0);
    for (const payload of inline) expect(payload).toBe(MASK);
  });

  it('without a policy the payload is served as it is — the same object', async () => {
    const ask = { token: SECRET };
    const chart = flowChart<any>('Seed', () => undefined, 'seed')
      .addPausableFunction('Ask', { execute: () => ask, resume: () => undefined }, 'ask')
      .build();
    const executor = new FlowChartExecutor(chart);
    const seen: unknown[] = [];
    executor.attachCombinedRecorder({ id: 'raw', onPause: (event: any) => seen.push(event.pauseData) });
    await executor.run();
    expect(seen).toHaveLength(2);
    for (const payload of seen) expect(payload).toBe(ask);
  });
});
