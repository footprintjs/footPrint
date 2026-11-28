import { describe, expect, it, vi } from 'vitest';

import { createChildContinuation } from '../../../src/child-continuation.js';
import { flowChart, FlowChartExecutor } from '../../../src/index.js';

const binding = { occurrence: 'parent/turn/1', implementation: 'finance/v1+policy/v1' };
const finance = flowChart(
  'Seed',
  (scope) => {
    scope.value = 7;
  },
  'seed',
)
  .addPausableFunction(
    'Approve',
    {
      execute: () => ({ question: 'Approve?' }),
      resume: (scope) => {
        scope.done = true;
      },
    },
    'review',
  )
  .addFunction('Finish', (scope) => ({ value: scope.value, done: scope.done }), 'finish')
  .build();

function loadFresh() {
  return new FlowChartExecutor(finance);
}

async function wait() {
  const child = createChildContinuation(binding, loadFresh, { kind: 'new' });
  const result = await child.advance({ kind: 'start' });
  if (result.kind !== 'waiting') throw new Error('Expected the native pause');
  return { child, result };
}

describe('independent child continuation', () => {
  it('rejects stale IDs and revisions before loading while leaving the exact match available', async () => {
    const { result } = await wait();
    const loader = vi.fn(loadFresh);
    const child = createChildContinuation(binding, loader, { kind: 'restore', saved: result.saved });
    for (const gate of [
      { ...result.gate, id: 'old-or-sibling' },
      { ...result.gate, revision: result.gate.revision + 1 },
    ]) {
      expect((await child.advance({ kind: 'answer', gate, answer: true })).kind).toBe('unavailable');
    }
    expect(loader).not.toHaveBeenCalled();
    expect(await child.advance({ kind: 'answer', gate: result.gate, answer: true })).toEqual({
      kind: 'finished',
      value: { value: 7, done: true },
    });
    expect(loader).toHaveBeenCalledExactlyOnceWith(binding.implementation);
    expect((await child.advance({ kind: 'answer', gate: result.gate, answer: true })).kind).toBe('unavailable');
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it.each([
    { ...binding, occurrence: 'parent/turn/2' },
    { ...binding, implementation: 'finance/v1+policy/v2' },
  ])('refuses a restored envelope bound to a different occurrence or implementation', async (nextBinding) => {
    const { result } = await wait();
    const loader = vi.fn(loadFresh);
    const child = createChildContinuation(nextBinding, loader, { kind: 'restore', saved: result.saved });
    expect((await child.advance({ kind: 'answer', gate: result.gate, answer: true })).kind).toBe('unavailable');
    expect(loader).not.toHaveBeenCalled();
  });

  it('rejects legacy wire and malformed locator before native upcasting or dropping fields', async () => {
    const { result } = await wait();
    const loader = vi.fn(loadFresh);
    function altered(
      edit: (value: {
        checkpoint: { checkpointVersion?: number; pausedExecution: { runId: string | number }; pausedStageId: string };
      }) => void,
    ) {
      const value = JSON.parse(result.saved);
      edit(value);
      return JSON.stringify(value);
    }
    const refuse = (saved: string) =>
      createChildContinuation(binding, loader, { kind: 'restore', saved }).advance({
        kind: 'answer',
        gate: result.gate,
        answer: true,
      });
    const unknowns = await Promise.all([
      refuse(
        altered((value) => {
          value.checkpoint.checkpointVersion = 1;
        }),
      ),
      refuse(
        altered((value) => {
          delete value.checkpoint.checkpointVersion;
        }),
      ),
      refuse(
        altered((value) => {
          value.checkpoint.pausedExecution.runId = 7;
        }),
      ),
      refuse(
        altered((value) => {
          value.checkpoint.pausedExecution.runId += '-other';
        }),
      ),
      refuse(
        altered((value) => {
          value.checkpoint.pausedStageId = 'finish';
        }),
      ),
    ]);
    expect(unknowns.map((result) => result.kind)).toEqual(Array(5).fill('unavailable'));
    expect(unknowns[0]).toEqual(unknowns[1]);
    expect(loader).not.toHaveBeenCalled();
    expect((await refuse(result.saved)).kind).toBe('finished');
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('keeps private fields out of invalid saved, competing-gate, and missing-reference results', async () => {
    const { result } = await wait();
    const envelope = JSON.parse(result.saved);
    const loader = vi.fn(() => undefined);
    const refuse = (saved: string) =>
      createChildContinuation(binding, loader, { kind: 'restore', saved }).advance({
        kind: 'answer',
        gate: result.gate,
        answer: 'PRIVATE_ANSWER',
      });
    const denied = await Promise.all([
      refuse('invalid JSON'),
      refuse(JSON.stringify({ ...envelope, version: 7 })),
      refuse(JSON.stringify({ ...envelope, checkpoint: undefined })),
      refuse(
        JSON.stringify({
          ...envelope,
          checkpoint: {
            ...envelope.checkpoint,
            pendingPauses: [{ pausedStageId: 'other', subflowPath: [], pausedAt: 1, pauseData: 'PRIVATE_OTHER' }],
          },
        }),
      ),
    ]);
    expect(denied.every((result) => result.kind === 'unavailable')).toBe(true);
    expect(JSON.stringify(denied)).not.toContain('PRIVATE_');
    expect(loader).not.toHaveBeenCalled();
    const missing = await refuse(result.saved);
    expect(missing.kind).toBe('unavailable');
    expect(JSON.stringify(missing)).not.toContain('PRIVATE_');
    expect(loader).toHaveBeenCalledExactlyOnceWith(binding.implementation);
  });

  it('reserves the exact waiting leg before an asynchronous resolver settles', async () => {
    const { result } = await wait();
    let release!: (executor: FlowChartExecutor) => void;
    const pending = new Promise<FlowChartExecutor>((resolve) => {
      release = resolve;
    });
    const loader = vi.fn(() => pending);
    const child = createChildContinuation(binding, loader, { kind: 'restore', saved: result.saved });
    const entry = { kind: 'answer', gate: result.gate, answer: true } as const;
    const first = child.advance(entry);
    const duplicate = child.advance(entry);
    release(loadFresh());
    expect((await duplicate).kind).toBe('unavailable');
    expect((await first).kind).toBe('finished');
    expect((await child.advance(entry)).kind).toBe('unavailable');
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('keeps a pause-shaped normal value and its genuine repeat distinct', async () => {
    const value = { paused: true, checkpoint: { synthetic: true } };
    const chart = flowChart('Return a lookalike', () => value, 'ordinary').build();
    const child = createChildContinuation(binding, () => new FlowChartExecutor(chart), { kind: 'new' });
    expect(await child.advance({ kind: 'start' })).toEqual({ kind: 'finished', value });
    expect((await child.advance({ kind: 'start' })).kind).toBe('unavailable');
  });

  it('keeps a returned gate and pause payload detached from the offered state', async () => {
    const { child, result } = await wait();
    const gate = { ...result.gate };
    Object.assign(result.gate, { id: 'forged' });
    Object.assign(result.pauseData as object, { question: 'new text' });
    expect((await child.advance({ kind: 'answer', gate: result.gate, answer: true })).kind).toBe('unavailable');
    expect(await child.advance({ kind: 'answer', gate, answer: true })).toEqual({
      kind: 'finished',
      value: { value: 7, done: true },
    });
    const refused = await child.advance({ kind: 'start' });
    Object.assign(refused, { kind: 'new' });
    expect((await child.advance({ kind: 'start' })).kind).toBe('unavailable');
  });

  it('forwards pre-abort without authorizing a native stage', async () => {
    const touched = vi.fn();
    const chart = flowChart('Never entered', touched, 'never').build();
    const child = createChildContinuation(binding, () => new FlowChartExecutor(chart), { kind: 'new' });
    const reason = new Error('caller stopped before entry');
    await expect(child.advance({ kind: 'start', options: { signal: AbortSignal.abort(reason) } })).rejects.toBe(reason);
    expect(touched).not.toHaveBeenCalled();
  });

  it('preserves the original loader error and the original error thrown by a child', async () => {
    const error = new Error('ordinary failure');
    for (const resolver of [
      () => {
        throw error;
      },
      () =>
        new FlowChartExecutor(
          flowChart(
            'Fail with the original error',
            () => {
              throw error;
            },
            'bad',
          ).build(),
        ),
    ]) {
      const entry = createChildContinuation(binding, resolver, { kind: 'new' });
      await expect(entry.advance({ kind: 'start' })).rejects.toBe(error);
    }
  });
});
