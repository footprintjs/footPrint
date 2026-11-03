import { describe, expect, it } from 'vitest';

import type { BoundRun, PausableHandler, RunLifecycle, RunSlot, TypedScope } from '../../../src';
import { createRunLifecycle, flowChart } from '../../../src';

describe('run lifecycle resume', () => {
  function fixture() {
    const scopes: unknown[] = [];
    const bindings: BoundRun[] = [];
    const handler: PausableHandler<TypedScope<{ visits?: number; answer?: string }>> = {
      execute: async (scope) => {
        scopes.push(scope);
        const bound = owner.forScope(scope);
        bindings.push(bound);
        bound.set(runtime!, 'paused-private-value');
        scope.visits = 1;
        return { question: 'continue?' };
      },
      resume: async (scope, input) => {
        scopes.push(scope);
        const bound = owner.forScope(scope);
        bindings.push(bound);
        expect(bound.read(runtime!)).toEqual({ present: false });
        bound.set(runtime!, 'resumed-private-value');
        scope.visits = (scope.visits ?? 0) + 1;
        scope.answer = String(input);
      },
    };
    const chart = flowChart('ask', handler, 'ask').build();
    const owner: RunLifecycle = createRunLifecycle(chart, { runnerId: 'pause-owner' });
    const runtime: RunSlot<string> = owner.slot<string>('runtime');
    return { chart, owner, scopes, bindings };
  }

  it('same-executor resume gets a new leg/bank and refuses all old-view methods', async () => {
    const { owner, scopes, bindings } = fixture();
    await owner.withRun((run) => run.execute({ kind: 'run' }, { narrative: {} }));
    const before = owner.view()!;
    const initialId = before.origin!.runId;
    const initialCommits = before.getCommitCount();
    const initialNarrative = before.getNarrativeEntries().length;
    const token = owner.continuation()!;
    const exported = token.checkpoint();
    expect(JSON.stringify(exported)).not.toContain('private-value');
    await owner.withRun((run) => run.execute({ kind: 'resume', mode: 'same', continuation: token, input: 'yes' }));

    const after = owner.view()!;
    expect(after.origin!.runId).not.toBe(initialId);
    expect(after.snapshot()!.sharedState).toMatchObject({ visits: 2, answer: 'yes' });
    expect(after.getCommitCount()).toBeGreaterThan(initialCommits);
    expect(after.getNarrativeEntries().length).toBeGreaterThan(initialNarrative);
    expect(bindings[0].retired).toBe(true);
    expect(bindings[1].origin.runId).toBe(after.origin!.runId);
    expect(owner.forScope(scopes[0]).origin.runId).toBe(initialId);
    for (const read of [
      () => before.snapshot(),
      () => before.getNarrativeEntries(),
      () => before.getCommitCount(),
      () => before.isPaused(),
      () => before.drainObservers(),
      () => before.liveState(),
    ])
      expect(read).toThrow('earlier native leg');
    expect(() => token.checkpoint()).toThrow('superseded');
    await expect(
      owner.withRun((run) => run.execute({ kind: 'resume', mode: 'same', continuation: token })),
    ).rejects.toThrow('Invalid or spent');
  });

  it('fresh restore uses the persisted checkpoint and supersedes the process-local token', async () => {
    const { owner, bindings } = fixture();
    await owner.withRun((run) => run.execute({ kind: 'run' }));
    const before = owner.view()!;
    const token = owner.continuation()!;
    const checkpoint = JSON.parse(JSON.stringify(token.checkpoint()));
    await owner.withRun((run) => run.execute({ kind: 'resume', mode: 'fresh', checkpoint, input: 'restored' }));
    expect(owner.view()!.snapshot()!.sharedState).toMatchObject({ visits: 2, answer: 'restored' });
    expect(owner.view()!.origin!.runId).not.toBe(bindings[0].origin.runId);
    // A different executor's old view continues to name that old actual execution.
    expect(before.isPaused()).toBe(true);
    expect(before.snapshot()!.runId).toBe(bindings[0].origin.runId);
    expect(() => token.checkpoint()).toThrow('superseded');
  });

  it('refuses foreign or fabricated tokens without consuming its valid pause', async () => {
    const one = fixture();
    const two = fixture();
    await one.owner.withRun((run) => run.execute({ kind: 'run' }));
    await two.owner.withRun((run) => run.execute({ kind: 'run' }));
    const valid = one.owner.continuation()!;
    for (const token of [two.owner.continuation()!, {} as typeof valid]) {
      await expect(
        one.owner.withRun((run) => run.execute({ kind: 'resume', mode: 'same', continuation: token })),
      ).rejects.toThrow('Invalid or spent');
      expect(one.owner.continuation()).toBe(valid);
    }
    await one.owner.withRun((run) =>
      run.execute({ kind: 'resume', mode: 'same', continuation: valid, input: 'valid' }),
    );
    expect(one.owner.view()!.snapshot()!.sharedState.answer).toBe('valid');
  });

  it.each(['same', 'fresh'] as const)('keeps mounted child bindings separate on %s resume', async (mode) => {
    const child = fixture();
    const chart = flowChart('root', async () => undefined, 'root')
      .addSubFlowChartNext('child', child.chart, 'child')
      .build();
    const parent = createRunLifecycle(chart, { runnerId: 'parent' });
    await parent.withRun((run) => run.execute({ kind: 'run' }));
    const paused = parent.continuation()!;
    const original = child.bindings[0].origin.runId;
    if (mode === 'same') {
      await parent.withRun((run) => run.execute({ kind: 'resume', mode, continuation: paused, input: 'nested' }));
    } else {
      const checkpoint = JSON.parse(JSON.stringify(paused.checkpoint()));
      await parent.withRun((run) => run.execute({ kind: 'resume', mode, checkpoint, input: 'nested' }));
    }
    expect(child.bindings).toHaveLength(2);
    expect(child.bindings[1].origin.runId).toBe(parent.view()!.origin!.runId);
    expect(child.bindings[1].origin.runId).not.toBe(original);
    expect(child.owner.forScope(child.scopes[0]).origin.runId).toBe(original);
    expect(child.bindings[0].retired).toBe(true);
    expect(child.owner.view()).toBeUndefined();
  });
});
