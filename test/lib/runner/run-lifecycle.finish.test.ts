/**
 * `OwnedRun.finish()`: the body runs the run's finalizers itself, inside its own async context,
 * while the lease is still held. Without `finish()`, `withRun` finalizes after the body as before.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

import { describe, expect, it } from 'vitest';

import type { ComponentEnd, OwnedRun, PausableHandler, RunLifecycle } from '../../../src';
import { createRunLifecycle, flowChart, RunInFlightError } from '../../../src';

type EndKind = ComponentEnd['kind'];

function deferred() {
  let settle!: () => void;
  const promise = new Promise<void>((resolve) => {
    settle = resolve;
  });
  return { promise, resolve: settle };
}

function plainOwner(runnerId: string): RunLifecycle {
  return createRunLifecycle(flowChart('work', async () => undefined, 'work').build(), { runnerId });
}

function failingOwner(error: Error): RunLifecycle {
  const chart = flowChart(
    'work',
    async () => {
      throw error;
    },
    'work',
  ).build();
  return createRunLifecycle(chart, { runnerId: 'failing' });
}

function pausingOwner(): RunLifecycle {
  const handler: PausableHandler<never> = {
    execute: async () => ({ question: 'continue?' }),
    resume: async () => undefined,
  };
  return createRunLifecycle(flowChart('ask', handler, 'ask').build(), { runnerId: 'pausing' });
}

/** Registers one finalizer that records each end it is given. */
function recordEnds(run: OwnedRun): EndKind[] {
  const ends: EndKind[] = [];
  run.onFinalize((end) => {
    ends.push(end.kind);
  });
  return ends;
}

describe('OwnedRun.finish', () => {
  it('runs finalizers inside the async context the body set around its work', async () => {
    const turn = new AsyncLocalStorage<string>();
    const seen: Array<string | undefined> = [];
    await plainOwner('context').withRun((run) =>
      turn.run('turn-1', async () => {
        run.onFinalize(async () => {
          await Promise.resolve();
          seen.push(turn.getStore());
        });
        await run.execute({ kind: 'run' });
        await run.finish();
        expect(seen).toEqual(['turn-1']);
      }),
    );
    expect(seen).toEqual(['turn-1']);
  });

  it('keeps the lease held after finish() until the body returns', async () => {
    const owner = plainOwner('lease');
    let runId: string | undefined;
    await owner.withRun(async (run) => {
      await run.execute({ kind: 'run' });
      runId = run.origin!.runId;
      await run.finish();
      await expect(owner.withRun(() => 'second')).rejects.toMatchObject({
        name: 'RunInFlightError',
        activeRunId: runId,
      });
      expect(owner.view()!.phase).toBe('postprocessing');
      expect(owner.continuation()).toBeUndefined();
    });
    expect(owner.view()!.phase).toBe('settled');
    expect(await owner.withRun(() => 'second')).toBe('second');
  });

  it('gives a completed run its end, once', async () => {
    const owner = plainOwner('completed');
    let ends!: EndKind[];
    const value = await owner.withRun(async (run) => {
      ends = recordEnds(run);
      await run.execute({ kind: 'run' });
      await run.finish();
      expect(ends).toEqual(['completed']);
      return 'answer';
    });
    expect(value).toBe('answer');
    expect(ends).toEqual(['completed']);
  });

  it('gives a failed run its end, once, and withRun still rejects with the stage failure', async () => {
    const stageError = new Error('stage');
    let ends!: EndKind[];
    const result = failingOwner(stageError).withRun(async (run) => {
      ends = recordEnds(run);
      await run.execute({ kind: 'run' }).catch(() => undefined);
      await run.finish();
      expect(ends).toEqual(['failed']);
    });
    await expect(result).rejects.toBe(stageError);
    expect(ends).toEqual(['failed']);
  });

  it('gives a paused run its end, once, and still offers the continuation', async () => {
    const owner = pausingOwner();
    let ends!: EndKind[];
    await owner.withRun(async (run) => {
      ends = recordEnds(run);
      const result = await run.execute({ kind: 'run' });
      expect(result).toMatchObject({ paused: true });
      await run.finish();
      expect(ends).toEqual(['paused']);
    });
    expect(ends).toEqual(['paused']);
    expect(owner.continuation()).toBeDefined();
  });

  it('gives an aborted run the failed end, once', async () => {
    const abort = new AbortController();
    const entered = deferred();
    const chart = flowChart(
      'work',
      async () => {
        entered.resolve();
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      },
      'work',
    ).build();
    let ends!: EndKind[];
    let inBody: EndKind[] | undefined;
    let nativeFailure: unknown;
    const result = createRunLifecycle(chart, { runnerId: 'aborted' }).withRun(async (run) => {
      ends = recordEnds(run);
      const execution = run.execute({ kind: 'run', options: { signal: abort.signal } });
      await entered.promise;
      abort.abort(new Error('stop'));
      nativeFailure = await execution.catch((error: unknown) => error);
      await run.finish();
      inBody = [...ends];
    });
    const failure = await result.catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(failure).toBe(nativeFailure);
    expect(inBody).toEqual(['failed']);
    expect(ends).toEqual(['failed']);
  });

  it('waits for an execution still in flight before deciding the end', async () => {
    const gate = deferred();
    const chart = flowChart('work', () => gate.promise, 'work').build();
    let ends!: EndKind[];
    await createRunLifecycle(chart, { runnerId: 'in-flight' }).withRun(async (run) => {
      ends = recordEnds(run);
      const execution = run.execute({ kind: 'run' });
      const finishing = run.finish();
      await Promise.resolve();
      expect(ends).toEqual([]);
      gate.resolve();
      await finishing;
      expect(ends).toEqual(['completed']);
      await execution;
    });
    expect(ends).toEqual(['completed']);
  });

  it('finishes a body that requested no execution as completed', async () => {
    let ends!: EndKind[];
    await plainOwner('no-execution').withRun(async (run) => {
      ends = recordEnds(run);
      await run.finish();
    });
    expect(ends).toEqual(['completed']);
  });

  describe('misuse', () => {
    it('is idempotent inside the body: a second call shares the first and runs nothing again', async () => {
      let calls = 0;
      await plainOwner('twice').withRun(async (run) => {
        run.onFinalize(() => {
          calls += 1;
        });
        await run.execute({ kind: 'run' });
        const first = run.finish();
        const second = run.finish();
        await Promise.all([first, second]);
        await run.finish();
        expect(calls).toBe(1);
      });
      expect(calls).toBe(1);
    });

    it('refuses by name once the body has settled', async () => {
      const owner = plainOwner('late');
      let handle!: OwnedRun;
      let closing!: () => Promise<void>;
      const cleanupEntered = deferred();
      const release = deferred();
      const result = owner.withRun((run) => {
        handle = run;
        run.onFinalize(async () => {
          cleanupEntered.resolve();
          await release.promise;
        });
        closing = () => run.finish();
      });
      await cleanupEntered.promise;
      expect(() => closing()).toThrow('Owned run body has closed');
      release.resolve();
      await result;
      expect(() => handle.finish()).toThrow('Owned run has retired');
    });

    it('refuses a finalizer registered after finish(), by name', async () => {
      await plainOwner('register-late').withRun(async (run) => {
        await run.execute({ kind: 'run' });
        const finishing = run.finish();
        expect(() => run.onFinalize(() => undefined)).toThrow('Owned run has finished');
        await finishing;
        expect(() => run.onFinalize(() => undefined)).toThrow('Owned run has finished');
      });
    });

    it('refuses an execution requested after finish(), by name', async () => {
      await plainOwner('execute-late').withRun(async (run) => {
        await run.finish();
        expect(() => run.execute({ kind: 'run' })).toThrow('Owned run has finished');
      });
    });

    it('keeps the sealed end when the body throws after finish(), and withRun rejects with the body failure', async () => {
      const owner = pausingOwner();
      const bodyError = new Error('after finish');
      let ends!: EndKind[];
      const result = owner.withRun(async (run) => {
        ends = recordEnds(run);
        await run.execute({ kind: 'run' });
        await run.finish();
        throw bodyError;
      });
      await expect(result).rejects.toBe(bodyError);
      expect(ends).toEqual(['paused']);
      // A failed body still withdraws the SAME continuation; the native pause is still reported.
      expect(owner.continuation()).toBeUndefined();
      expect(owner.view()!.isPaused()).toBe(true);
    });

    it('rejects with the first cleanup failure of a completed run, and withRun keeps it', async () => {
      const cleanupError = new Error('cleanup');
      let order: string[] = [];
      const result = plainOwner('cleanup-failure').withRun(async (run) => {
        order = [];
        run.onFinalize(() => {
          order.push('first');
        });
        run.onFinalize(() => {
          order.push('second');
          throw cleanupError;
        });
        await run.execute({ kind: 'run' });
        await expect(run.finish()).rejects.toBe(cleanupError);
        return 'swallowed';
      });
      await expect(result).rejects.toBe(cleanupError);
      expect(order).toEqual(['second', 'first']);
    });

    it('lets a pause win over a cleanup failure', async () => {
      const owner = pausingOwner();
      await owner.withRun(async (run) => {
        run.onFinalize(() => {
          throw new Error('cleanup');
        });
        await run.execute({ kind: 'run' });
        await run.finish();
      });
      expect(owner.continuation()).toBeDefined();
    });
  });
});

describe('withRun without finish()', () => {
  it('still finalizes after the body, outside its async context, before releasing the lease', async () => {
    const turn = new AsyncLocalStorage<string>();
    const owner = plainOwner('unchanged');
    const order: string[] = [];
    let blocked!: Promise<unknown>;
    const result = owner
      .withRun((run) =>
        turn.run('turn-1', async () => {
          run.onFinalize((end) => {
            order.push(`finalize:${end.kind}:${turn.getStore() ?? 'outside'}`);
            blocked = owner.withRun(() => undefined);
          });
          await run.execute({ kind: 'run' });
          order.push('body-return');
          return 'answer';
        }),
      )
      .then((value) => {
        order.push('withRun-resolve');
        return value;
      });
    expect(await result).toBe('answer');
    expect(order).toEqual(['body-return', 'finalize:completed:outside', 'withRun-resolve']);
    await expect(blocked).rejects.toBeInstanceOf(RunInFlightError);
  });
});
