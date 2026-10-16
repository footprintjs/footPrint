/**
 * `$call` at its edges (design §3.6, packet P2).
 *
 * Test types: Boundary (a malformed policy or function is refused at the call; `attempts: 1` with a cap; a thrown
 * `null`, a string and a null-prototype object; a synchronous function; a declining `retryOn`; an `interrupt()`
 * inside a call — a pause is never retried).
 */
import { describe, expect, it } from 'vitest';

import type { StageSnapshot } from '../../../../src/advanced.js';
import type { RetryPolicy, TypedScope } from '../../../../src/index.js';
import { flowChart, FlowChartExecutor, interrupt } from '../../../../src/index.js';

type S = Record<string, unknown>;
const silent = { info: () => {}, log: () => {}, debug: () => {}, error: () => {}, warn: () => {} };

function nodes(root: StageSnapshot | undefined): StageSnapshot[] {
  const out: StageSnapshot[] = [];
  const stack = root ? [root] : [];
  while (stack.length > 0) {
    const n = stack.pop()!;
    out.push(n);
    if (n.next) stack.push(n.next);
    for (const child of n.children ?? []) stack.push(child);
  }
  return out;
}
const node = (executor: FlowChartExecutor<any, any>, id: string) =>
  nodes(executor.getSnapshot().executionTree as StageSnapshot).find((n) => n.id === id)!;

/** Run one stage that calls `call(scope)`, catching what it throws; returns the executor and the caught value. */
async function inStage(call: (scope: TypedScope<S>) => Promise<unknown> | unknown) {
  let caught: unknown;
  const chart = flowChart<S>(
    'Stage',
    async (scope: TypedScope<S>) => {
      try {
        scope.result = (await call(scope)) as never;
      } catch (error) {
        caught = error;
      }
    },
    'stage',
  )
    .setLogger(silent)
    .build();
  const executor = new FlowChartExecutor(chart);
  executor.enableNarrative();
  await executor.run();
  return { executor, caught, stage: node(executor, 'stage') };
}

describe('a malformed call is refused at the call — nothing runs, nothing is recorded', () => {
  it.each<[string, unknown]>([
    ['attempts 0', { attempts: 0 }],
    ['attempts NaN', { attempts: Number.NaN }],
    ['attempts 1.5', { attempts: 1.5 }],
    ['timeoutMs 0', { attempts: 1, timeoutMs: 0 }],
    ['timeoutMs Infinity', { attempts: 1, timeoutMs: Infinity }],
    ['a policy that is null', null],
    ['a policy that is a number', 3],
  ])('%s', async (_why, policy) => {
    let ran = false;
    const { caught, stage } = await inStage((scope) =>
      scope.$call(
        'svc',
        () => {
          ran = true;
        },
        policy as RetryPolicy,
      ),
    );
    expect(caught).toBeInstanceOf(TypeError);
    expect(String((caught as Error).message)).toMatch(/^\$call\('svc'\)/);
    expect(ran).toBe(false);
    expect(stage.attempts).toBeUndefined();
  });

  it('a function that is not one', async () => {
    const { caught, stage } = await inStage((scope) => scope.$call('svc', 'nope' as never));
    expect(caught).toBeInstanceOf(TypeError);
    expect(stage.attempts).toBeUndefined();
  });
});

describe('edges of a call that runs', () => {
  it('`attempts: 1` with a cap: one timeout record, told without "no attempts left"; the stage goes on', async () => {
    const { executor, caught, stage } = await inStage((scope) =>
      scope.$call('svc', () => new Promise(() => undefined), { attempts: 1, timeoutMs: 15 }),
    );
    expect((caught as Error).name).toBe('AttemptTimeoutError');
    expect(stage.attempts).toHaveLength(1);
    expect(stage.attempts![0]).toMatchObject({ outcome: 'timeout', next: 'stop', reason: 'exhausted', timeoutMs: 15 });
    const [line] = executor.getNarrativeEntries().filter((e) => e.type === 'attempt');
    expect(line.text).toMatch(/^Call svc timed out after \d+ms\.$/);
  });

  it('a synchronous function is a call like any other', async () => {
    const { stage } = await inStage((scope) => scope.$call('sync', () => 5));
    expect(stage.attempts![0]).toMatchObject({ outcome: 'ok', next: 'done' });
  });

  it.each<[string, unknown, string]>([
    ['null', null, 'null'],
    ['a string', 'plain text', 'plain text'],
    ['a null-prototype object', Object.create(null), '[unserializable error]'],
  ])('a thrown %s: recorded, category unknown, the run unharmed', async (_why, thrown, message) => {
    const { caught, stage } = await inStage((scope) =>
      scope.$call('svc', () => {
        throw thrown;
      }),
    );
    expect(caught).toBe(thrown);
    expect(stage.attempts![0]).toMatchObject({ outcome: 'failed', category: 'unknown', error: { message } });
  });

  it('a declining retryOn stops the call at once, `declined`', async () => {
    let calls = 0;
    const { stage } = await inStage((scope) =>
      scope.$call(
        'svc',
        () => {
          calls += 1;
          throw Object.assign(new Error('bad request'), { status: 400 });
        },
        { attempts: 5, retryOn: () => false },
      ),
    );
    expect(calls).toBe(1);
    expect(stage.attempts![0]).toMatchObject({ category: 'permanent', next: 'stop', reason: 'declined' });
  });

  it('an interrupt() inside a call is a pause: never retried, and the stage pauses', async () => {
    let calls = 0;
    const chart = flowChart<S>(
      'Approve',
      async (scope: TypedScope<S>) => {
        scope.answer = (await scope.$call(
          'human.review',
          () => {
            calls += 1;
            return interrupt(scope, { question: 'ship it?' });
          },
          { attempts: 3 },
        )) as never;
      },
      'approve',
    )
      .setLogger(silent)
      .build();
    const executor = new FlowChartExecutor(chart);
    const result = (await executor.run()) as { paused?: boolean };
    expect(result.paused).toBe(true);
    expect(calls).toBe(1);
    expect(node(executor, 'approve').attempts).toEqual([
      expect.objectContaining({ kind: 'call', outcome: 'paused', next: 'stop', reason: 'paused' }),
    ]);
  });
});
