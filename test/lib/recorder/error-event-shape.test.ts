/**
 * One `ErrorEvent.error` shape, inline and deferred (F8, 9.39.0).
 *
 * A recorder that throws in a scope hook is reported to the scope channel as
 * `onError`. Until 9.38.0 the inline paths (`ScopeFacade · _routeFailure`,
 * `FlowChartExecutor · resume`) passed the raw thrown value and the deferred
 * tier wrapped it in `new Error(...)` — two shapes for one event, and the
 * deferred tier skipped the failing listener, so a CompositeRecorder's other
 * children never heard a sibling's throw. Now ONE builder
 * (`recorder/hooks.ts · recorderFailureEvent`) makes the event everywhere:
 * `error` is the structured form (`message`, `name?`, `raw` = what was thrown).
 *
 * Test types: scenario (inline vs deferred over a real run), security (a
 * throw from `onError` is not routed again).
 */

import { describe, expect, it } from 'vitest';

import type { ErrorEvent, ScopeRecorder } from '../../../src/index.js';
import { CompositeRecorder, flowChart, FlowChartExecutor } from '../../../src/index.js';

type L = Record<string, unknown>;

const chart = () => flowChart<L>('Write', async (s: any) => s.$setValue('w', 1), 'write').build();

/** Run once with `thrower` (inline or deferred) and a watcher on the same tier; the watcher's onError events. */
async function errorsSeen(thrown: unknown, delivery: 'inline' | 'deferred'): Promise<ErrorEvent[]> {
  const seen: ErrorEvent[] = [];
  const executor = new FlowChartExecutor(chart());
  const options = delivery === 'deferred' ? { delivery: 'deferred' as const } : undefined;
  executor.attachScopeRecorder(
    {
      id: 'thrower',
      onWrite: () => {
        throw thrown;
      },
    },
    options,
  );
  executor.attachScopeRecorder({ id: 'watcher', onError: (e) => seen.push(e) }, options);
  await executor.run();
  await executor.drainObservers();
  return seen;
}

const shape = (e: ErrorEvent) => ({ ...e, timestamp: 0, pipelineId: '', stageName: '' });

describe('ErrorEvent.error — one structured shape on every path', () => {
  it.each([
    ['an Error', new TypeError('boom')],
    ['a string', 'str-thrown'],
    ['a number', 42],
    ['a plain object', { code: 'E1' }],
  ])('%s: inline and deferred deliver the same event', async (_, thrown) => {
    const [inline] = await errorsSeen(thrown, 'inline');
    const [deferred] = await errorsSeen(thrown, 'deferred');
    expect(inline.error.raw).toBe(thrown);
    expect(deferred.error.raw).toBe(thrown);
    expect(typeof inline.error.message).toBe('string');
    expect(shape(deferred)).toEqual(shape(inline));
  });

  it('an Error keeps its message and name readable as before', async () => {
    const [event] = await errorsSeen(new TypeError('boom'), 'inline');
    expect(event.error).toMatchObject({ message: 'boom', name: 'TypeError' });
    expect(event.operation).toBe('write');
  });

  it('the executor’s own onResume failure is reported in the same shape', async () => {
    const pausing = flowChart<L>('Seed', async () => undefined, 'seed')
      .addPausableFunction('Ask', { execute: () => ({ q: 1 }), resume: () => undefined }, 'ask')
      .build();
    const first = new FlowChartExecutor(pausing);
    await first.run();
    const seen: ErrorEvent[] = [];
    const second = new FlowChartExecutor(pausing);
    second.attachScopeRecorder({
      id: 'thrower',
      onResume: () => {
        // eslint-disable-next-line no-throw-literal -- a non-Error throw is the point
        throw 'resume-thrown';
      },
    });
    second.attachScopeRecorder({ id: 'watcher', onError: (e) => seen.push(e) });
    await second.resume(first.getCheckpoint()!, {});
    expect(seen).toHaveLength(1);
    expect(seen[0].error).toEqual({ message: 'resume-thrown', raw: 'resume-thrown' });
  });
});

describe('a CompositeRecorder’s children hear a sibling’s throw — inline and deferred alike', () => {
  async function childrenHeard(delivery: 'inline' | 'deferred'): Promise<string[]> {
    const heard: string[] = [];
    const thrower: ScopeRecorder = {
      id: 'child-thrower',
      onWrite: () => {
        throw new Error('child boom');
      },
      onError: () => heard.push('thrower'),
    };
    const sibling: ScopeRecorder = { id: 'child-sibling', onError: (e) => heard.push(`sibling:${e.error.message}`) };
    const executor = new FlowChartExecutor(chart());
    executor.attachScopeRecorder(
      new CompositeRecorder('composite', [thrower, sibling]),
      delivery === 'deferred' ? { delivery: 'deferred' } : undefined,
    );
    await executor.run();
    await executor.drainObservers();
    return heard;
  }

  it('inline (the reference behaviour)', async () => {
    expect(await childrenHeard('inline')).toEqual(['thrower', 'sibling:child boom']);
  });

  it('deferred — the same children, the same events', async () => {
    expect(await childrenHeard('deferred')).toEqual(await childrenHeard('inline'));
  });

  it('a throw from onError itself is not routed again (deferred)', async () => {
    let calls = 0;
    const executor = new FlowChartExecutor(chart());
    executor.attachScopeRecorder(
      {
        id: 'loud',
        onWrite: () => {
          throw new Error('first');
        },
        onError: () => {
          calls += 1;
          throw new Error('from onError');
        },
      },
      { delivery: 'deferred' },
    );
    await executor.run();
    await executor.drainObservers();
    expect(calls).toBe(1);
  });
});
