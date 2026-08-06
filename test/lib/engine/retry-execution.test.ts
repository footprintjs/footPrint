/**
 * Declarative per-stage retry — the RUN-TIME laws.
 *
 * WHY the feature exists: a retry hand-rolled inside a stage function leaves no
 * mark on the trace. These tests pin the two halves of the promise — that the
 * retry actually happens, and that it is VISIBLE.
 *
 * Test types: Unit (attempt counting, backoff resolution) · Functional
 * (succeed-after-failure, exhaustion, retryOn, every stage kind) · Integration
 * (commit log + snapshot + narrative on real charts) · Security (attempt
 * isolation — a discarded attempt's writes must not reach the next attempt,
 * shared state, or the record).
 */
import { describe, expect, it, vi } from 'vitest';

import type { FlowRecorder, FlowStageRetryEvent } from '../../../src/index.js';
import { flowChart, FlowChartExecutor } from '../../../src/index.js';

interface State {
  attempts?: number;
  value?: string;
  partial?: string;
  seen?: string[];
  [key: string]: unknown;
}

/** Collects every onStageRetry event the engine fires. */
function retryProbe(): { id: string; events: FlowStageRetryEvent[] } & FlowRecorder {
  const events: FlowStageRetryEvent[] = [];
  return {
    id: 'retry-probe',
    events,
    onStageRetry: (event) => {
      events.push(event);
    },
  };
}

/** Read a fork/selector branch's own namespaced state (`runs/<branchId>`). */
function branchState(executor: FlowChartExecutor<any, any>, branchId: string): Record<string, unknown> {
  const runs = executor.getSnapshot().sharedState.runs as Record<string, Record<string, unknown>> | undefined;
  return runs?.[branchId] ?? {};
}

/** A stage function that throws for the first `failCount` calls, then succeeds. */
function flaky(failCount: number, onEachCall?: (call: number) => void) {
  let calls = 0;
  return (scope: State) => {
    calls += 1;
    onEachCall?.(calls);
    if (calls <= failCount) throw new Error(`boom ${calls}`);
    scope.value = `ok after ${calls}`;
  };
}

describe('retry — it actually retries', () => {
  it('runs the stage again after a failure and lets the run succeed', async () => {
    const chart = flowChart<State>(
      'Seed',
      (scope) => {
        scope.attempts = 0;
      },
      'seed',
    )
      .addFunction('Flaky', flaky(2), 'flaky')
      .retry({ attempts: 3 })
      .build();

    const executor = new FlowChartExecutor(chart);
    await executor.run();

    expect(executor.getSnapshot().sharedState.value).toBe('ok after 3');
  });

  it('stops at the ceiling and rethrows the LAST failure', async () => {
    const chart = flowChart<State>('Seed', () => undefined, 'seed')
      .addFunction('Always fails', flaky(99), 'always')
      .retry({ attempts: 3 })
      .build();

    const executor = new FlowChartExecutor(chart);
    await expect(executor.run()).rejects.toThrow('boom 3');
  });

  it('attempts: 1 is a declared-but-off policy — one run, no retry', async () => {
    let calls = 0;
    const chart = flowChart<State>('Seed', () => undefined, 'seed')
      .addFunction(
        'Once',
        () => {
          calls += 1;
          throw new Error('nope');
        },
        'once',
      )
      .retry({ attempts: 1 })
      .build();

    await expect(new FlowChartExecutor(chart).run()).rejects.toThrow('nope');
    expect(calls).toBe(1);
  });

  it('a stage that succeeds first time runs exactly once', async () => {
    let calls = 0;
    const probe = retryProbe();
    const chart = flowChart<State>('Seed', () => undefined, 'seed')
      .addFunction(
        'Fine',
        (scope: State) => {
          calls += 1;
          scope.value = 'fine';
        },
        'fine',
      )
      .retry({ attempts: 5 })
      .build();

    const executor = new FlowChartExecutor(chart);
    executor.attachFlowRecorder(probe);
    await executor.run();

    expect(calls).toBe(1);
    expect(probe.events).toHaveLength(0);
  });
});

describe('retry — retryOn', () => {
  it('retries only the errors the predicate accepts', async () => {
    let calls = 0;
    const chart = flowChart<State>('Seed', () => undefined, 'seed')
      .addFunction(
        'Typed',
        (scope: State) => {
          calls += 1;
          if (calls === 1) throw new Error('TRANSIENT');
          if (calls === 2) throw new Error('PERMANENT');
          scope.value = 'never reached';
        },
        'typed',
      )
      .retry({ attempts: 5, retryOn: (error) => (error as Error).message === 'TRANSIENT' })
      .build();

    await expect(new FlowChartExecutor(chart).run()).rejects.toThrow('PERMANENT');
    expect(calls).toBe(2);
  });

  it('a declining predicate emits ZERO retry events — the error path speaks for itself', async () => {
    const probe = retryProbe();
    const chart = flowChart<State>('Seed', () => undefined, 'seed')
      .addFunction(
        'Fails',
        () => {
          throw new Error('permanent');
        },
        'fails',
      )
      .retry({ attempts: 4, retryOn: () => false })
      .build();

    const executor = new FlowChartExecutor(chart);
    executor.attachFlowRecorder(probe);
    await expect(executor.run()).rejects.toThrow('permanent');
    expect(probe.events).toHaveLength(0);
  });

  it('a THROWING predicate ends the stage — a broken gate never becomes an infinite loop', async () => {
    let calls = 0;
    const chart = flowChart<State>('Seed', () => undefined, 'seed')
      .addFunction(
        'Fails',
        () => {
          calls += 1;
          throw new Error('original');
        },
        'fails',
      )
      .retry({
        attempts: 10,
        retryOn: () => {
          throw new Error('predicate is broken');
        },
      })
      .build();

    // The ORIGINAL error surfaces, not the predicate's — the stage's failure is
    // the fact; the predicate's bug must not overwrite it.
    await expect(new FlowChartExecutor(chart).run()).rejects.toThrow('original');
    expect(calls).toBe(1);
  });
});

describe('retry — evidence (the reason this is declarative)', () => {
  it('fires attempts-1 retry events, each carrying the attempt, ceiling, wait and error', async () => {
    const probe = retryProbe();
    const chart = flowChart<State>('Seed', () => undefined, 'seed')
      .addFunction('Flaky', flaky(2), 'flaky')
      .retry({ attempts: 3, backoffMs: 1 })
      .build();

    const executor = new FlowChartExecutor(chart);
    executor.attachFlowRecorder(probe);
    await executor.run();

    expect(probe.events).toHaveLength(2);
    expect(probe.events.map((e) => e.attempt)).toEqual([1, 2]);
    for (const event of probe.events) {
      expect(event.stageName).toBe('Flaky');
      expect(event.stageId).toBe('flaky');
      expect(event.maxAttempts).toBe(3);
      expect(event.delayMs).toBe(1);
      expect(event.channel).toBe('flow');
      expect(event.structuredError.name).toBe('Error');
      expect(event.message).toBe(`boom ${event.attempt}`);
    }
  });

  it('an exhausted policy emits attempts-1 retry events THEN one error event', async () => {
    const retries: number[] = [];
    const errors: string[] = [];
    const chart = flowChart<State>('Seed', () => undefined, 'seed')
      .addFunction('Always fails', flaky(99), 'always')
      .retry({ attempts: 3 })
      .build();

    const executor = new FlowChartExecutor(chart);
    executor.attachFlowRecorder({
      id: 'both',
      onStageRetry: (e) => retries.push(e.attempt),
      onError: (e) => errors.push(e.message),
    });
    await expect(executor.run()).rejects.toThrow();

    expect(retries).toEqual([1, 2]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('boom 3');
  });

  it('stamps the SAME runtimeStageId as the stage itself — attempts are one execution', async () => {
    const probe = retryProbe();
    const executed: string[] = [];
    const chart = flowChart<State>('Seed', () => undefined, 'seed')
      .addFunction('Flaky', flaky(1), 'flaky')
      .retry({ attempts: 2 })
      .build();

    const executor = new FlowChartExecutor(chart);
    executor.attachFlowRecorder(probe);
    executor.attachFlowRecorder({
      id: 'stages',
      onStageExecuted: (e) => {
        if (e.traversalContext?.stageId === 'flaky') executed.push(e.traversalContext.runtimeStageId);
      },
    });
    await executor.run();

    expect(executed).toHaveLength(1);
    expect(probe.events[0].traversalContext?.runtimeStageId).toBe(executed[0]);
  });

  it('narrates the retry in plain English, in order, inside its own stage', async () => {
    const chart = flowChart<State>('Seed', () => undefined, 'seed')
      .addFunction('Flaky', flaky(1), 'flaky')
      .retry({ attempts: 2 })
      .build();

    const executor = new FlowChartExecutor(chart);
    executor.enableNarrative();
    await executor.run();

    const entries = executor.getNarrativeEntries();
    const retryIdx = entries.findIndex((e) => e.type === 'retry');
    expect(retryIdx).toBeGreaterThan(-1);
    expect(entries[retryIdx].text).toContain('attempt 1 of 2');
    expect(entries[retryIdx].text).toContain('boom 1');
    expect(entries[retryIdx].stageName).toBe('Flaky');
    expect(entries[retryIdx].depth).toBe(1);

    // The retry line sits INSIDE its stage, after that stage's header — not
    // dangling before it, which is what an unbuffered flow event would do.
    const stageIdx = entries.findIndex((e) => e.type === 'stage' && e.stageName === 'Flaky');
    expect(stageIdx).toBeGreaterThan(-1);
    expect(retryIdx).toBeGreaterThan(stageIdx);
  });
});

describe('retry — attempt isolation (the law that makes it safe)', () => {
  it('attempt 2 does NOT see attempt 1 writes', async () => {
    const seenAtStart: unknown[] = [];
    let calls = 0;
    const chart = flowChart<State>('Seed', () => undefined, 'seed')
      .addFunction(
        'Flaky',
        (scope: State) => {
          calls += 1;
          seenAtStart.push(scope.partial);
          scope.partial = `written on attempt ${calls}`;
          if (calls < 3) throw new Error('not yet');
          scope.value = 'done';
        },
        'flaky',
      )
      .retry({ attempts: 3 })
      .build();

    const executor = new FlowChartExecutor(chart);
    await executor.run();

    // Every attempt started from committed state, where `partial` was never set.
    expect(seenAtStart).toEqual([undefined, undefined, undefined]);
    // Only the FINAL attempt's write is committed.
    expect(executor.getSnapshot().sharedState.partial).toBe('written on attempt 3');
  });

  it('a discarded attempt leaves NOTHING in the commit log', async () => {
    const chart = flowChart<State>('Seed', () => undefined, 'seed')
      .addFunction(
        'Flaky',
        (scope: State) => {
          scope.attempts = ((scope.attempts as number) ?? 0) + 1;
          scope.partial = 'garbage';
          if (!scope.value) {
            scope.value = undefined;
          }
          throw new Error('always');
        },
        'flaky',
      )
      .retry({ attempts: 3, retryOn: () => true })
      .build();

    const executor = new FlowChartExecutor(chart);
    await expect(executor.run()).rejects.toThrow();

    const log = executor.getSnapshot().commitLog;
    // One bundle per EXECUTED stage — three attempts are ONE stage execution.
    expect(log.filter((b) => b.stageId === 'flaky')).toHaveLength(1);
  });

  it('a discarded attempt leaves nothing in the stage snapshot either', async () => {
    let calls = 0;
    const chart = flowChart<State>('Seed', () => undefined, 'seed')
      .addFunction(
        'Flaky',
        (scope: State) => {
          calls += 1;
          if (calls === 1) {
            scope.partial = 'ghost';
            throw new Error('discard me');
          }
          scope.value = 'real';
        },
        'flaky',
      )
      .retry({ attempts: 2 })
      .build();

    const executor = new FlowChartExecutor(chart);
    await executor.run();

    const findStage = (node: any): any => {
      if (!node) return undefined;
      if (node.id === 'flaky') return node;
      return findStage(node.next) ?? (node.children ?? []).map(findStage).find(Boolean);
    };
    const stage = findStage(executor.getSnapshot().executionTree);
    expect(stage?.stageWrites).toEqual({ value: 'real' });
    expect(stage?.stageWrites?.partial).toBeUndefined();
    expect(executor.getSnapshot().sharedState.partial).toBeUndefined();
  });

  it('the FINAL attempt still commits what it wrote before throwing (M1 is untouched)', async () => {
    const chart = flowChart<State>('Seed', () => undefined, 'seed')
      .addFunction(
        'Flaky',
        (scope: State) => {
          scope.partial = 'landed';
          throw new Error('final failure');
        },
        'flaky',
      )
      .retry({ attempts: 2 })
      .build();

    const executor = new FlowChartExecutor(chart);
    await expect(executor.run()).rejects.toThrow('final failure');
    // Commit-on-error: the last attempt's writes are preserved, exactly as a
    // stage with no policy would preserve them.
    expect(executor.getSnapshot().sharedState.partial).toBe('landed');
  });
});

describe('retry — no-policy charts are untouched', () => {
  it('produces a byte-identical commit log to the same chart run without a policy', async () => {
    const build = (withRetry: boolean) => {
      const b = flowChart<State>(
        'Seed',
        (scope: State) => {
          scope.value = 'seeded';
        },
        'seed',
      ).addFunction(
        'Fails',
        (scope: State) => {
          scope.partial = 'before the throw';
          throw new Error('same failure');
        },
        'fails',
      );
      // attempts: 1 exercises the policy PATH while allowing exactly one run —
      // the strictest possible comparison against no policy at all.
      return (withRetry ? b.retry({ attempts: 1 }) : b).build();
    };

    const strip = (log: unknown[]) =>
      JSON.stringify(log, (key, value) => (key === 'timestamp' || key === 'runtimeStageId' ? undefined : value));

    const plain = new FlowChartExecutor(build(false));
    await expect(plain.run()).rejects.toThrow();
    const withPolicy = new FlowChartExecutor(build(true));
    await expect(withPolicy.run()).rejects.toThrow();

    expect(strip(withPolicy.getSnapshot().commitLog)).toBe(strip(plain.getSnapshot().commitLog));
    expect(withPolicy.getSnapshot().sharedState).toEqual(plain.getSnapshot().sharedState);
  });
});

describe('retry — backoff', () => {
  it('waits the fixed number of milliseconds between attempts', async () => {
    const chart = flowChart<State>('Seed', () => undefined, 'seed')
      .addFunction('Flaky', flaky(1), 'flaky')
      .retry({ attempts: 2, backoffMs: 40 })
      .build();

    const started = Date.now();
    await new FlowChartExecutor(chart).run();
    expect(Date.now() - started).toBeGreaterThanOrEqual(30);
  });

  it('calls a backoff function with the attempt that just failed, 1-based', async () => {
    const seen: number[] = [];
    const chart = flowChart<State>('Seed', () => undefined, 'seed')
      .addFunction('Flaky', flaky(2), 'flaky')
      .retry({
        attempts: 3,
        backoffMs: (attempt) => {
          seen.push(attempt);
          return 1;
        },
      })
      .build();

    await new FlowChartExecutor(chart).run();
    expect(seen).toEqual([1, 2]);
  });

  it.each([
    ['a negative number', -50],
    ['NaN', NaN],
    ['Infinity', Infinity],
  ])('treats %s as no wait rather than crashing or hanging', async (_label, value) => {
    const chart = flowChart<State>('Seed', () => undefined, 'seed')
      .addFunction('Flaky', flaky(1), 'flaky')
      .retry({ attempts: 2, backoffMs: value })
      .build();

    const probe = retryProbe();
    const executor = new FlowChartExecutor(chart);
    executor.attachFlowRecorder(probe);
    await executor.run();
    expect(probe.events[0].delayMs).toBe(0);
  });

  it('a THROWING backoff function degrades to no wait — the retry still happens', async () => {
    const chart = flowChart<State>('Seed', () => undefined, 'seed')
      .addFunction('Flaky', flaky(1), 'flaky')
      .retry({
        attempts: 2,
        backoffMs: () => {
          throw new Error('bad dial');
        },
      })
      .build();

    const executor = new FlowChartExecutor(chart);
    await executor.run();
    expect(executor.getSnapshot().sharedState.value).toBe('ok after 2');
  });
});

describe('retry — control flow is never retried', () => {
  it('a pausable stage pauses instead of retrying', async () => {
    let calls = 0;
    const chart = flowChart<State>('Seed', () => undefined, 'seed')
      .addPausableFunction(
        'Gate',
        {
          execute: () => {
            calls += 1;
            return { question: 'approve?' };
          },
          resume: (scope: State, input: unknown) => {
            scope.value = String(input);
          },
        },
        'gate',
      )
      .retry({ attempts: 5 })
      .build();

    const executor = new FlowChartExecutor(chart);
    const result = (await executor.run()) as { paused?: true };
    expect(result.paused).toBe(true);
    // The stage ran ONCE — a pause is a suspension, not a failure to retry.
    expect(calls).toBe(1);
  });

  it('an aborted run does not sit through a backoff and then try again', async () => {
    const controller = new AbortController();
    let calls = 0;
    const chart = flowChart<State>('Seed', () => undefined, 'seed')
      .addFunction(
        'Flaky',
        () => {
          calls += 1;
          controller.abort();
          throw new Error('failed while cancelling');
        },
        'flaky',
      )
      .retry({ attempts: 5, backoffMs: 5_000 })
      .build();

    const executor = new FlowChartExecutor(chart);
    const started = Date.now();
    await expect(executor.run({ signal: controller.signal })).rejects.toThrow('failed while cancelling');
    expect(calls).toBe(1);
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});

describe('retry — every stage kind the engine funnels through executeStage', () => {
  it('retries a DECIDER stage and still routes to the right branch', async () => {
    let calls = 0;
    const probe = retryProbe();
    const chart = flowChart<State>('Seed', () => undefined, 'seed')
      .addDeciderFunction(
        'Route',
        () => {
          calls += 1;
          if (calls < 3) throw new Error('flaky router');
          return 'left';
        },
        'route',
        undefined,
        { retry: { attempts: 3 } },
      )
      .addFunctionBranch('left', 'Left', (scope: State) => {
        scope.value = 'left';
      })
      .addFunctionBranch('right', 'Right', (scope: State) => {
        scope.value = 'right';
      })
      .end()
      .build();

    const executor = new FlowChartExecutor(chart);
    executor.attachFlowRecorder(probe);
    await executor.run();

    expect(executor.getSnapshot().sharedState.value).toBe('left');
    expect(probe.events.map((e) => e.stageId)).toEqual(['route', 'route']);
  });

  it('retries a SELECTOR stage', async () => {
    let calls = 0;
    const probe = retryProbe();
    const chart = flowChart<State>('Seed', () => undefined, 'seed')
      .addSelectorFunction(
        'Pick',
        () => {
          calls += 1;
          if (calls < 2) throw new Error('flaky selector');
          return ['one'];
        },
        'pick',
        undefined,
        { retry: { attempts: 2 } },
      )
      .addFunctionBranch('one', 'One', (scope: State) => {
        scope.value = 'one';
      })
      .end()
      .build();

    const executor = new FlowChartExecutor(chart);
    executor.attachFlowRecorder(probe);
    await executor.run();

    // A selected branch writes into its own run namespace (`runs/<branchId>`).
    expect(branchState(executor, 'one').value).toBe('one');
    expect(probe.events).toHaveLength(1);
  });

  it('retries a FORK CHILD without disturbing its siblings', async () => {
    let calls = 0;
    const probe = retryProbe();
    const chart = flowChart<State>('Seed', () => undefined, 'seed')
      .addListOfFunction([
        {
          id: 'flaky-child',
          name: 'Flaky child',
          fn: (scope: State) => {
            calls += 1;
            if (calls < 2) throw new Error('flaky branch');
            scope.value = 'child ok';
          },
          retry: { attempts: 2 },
        },
        {
          id: 'steady-child',
          name: 'Steady child',
          fn: (scope: State) => {
            scope.partial = 'steady';
          },
        },
      ])
      .build();

    const executor = new FlowChartExecutor(chart);
    executor.attachFlowRecorder(probe);
    await executor.run();

    // Fork children are namespace-isolated — each writes under `runs/<childId>`.
    expect(branchState(executor, 'flaky-child').value).toBe('child ok');
    expect(branchState(executor, 'steady-child').partial).toBe('steady');
    expect(probe.events.map((e) => e.stageId)).toEqual(['flaky-child']);
  });

  it('retries a stage INSIDE a subflow, addressed by its prefixed id', async () => {
    let calls = 0;
    const probe = retryProbe();
    const inner = flowChart<State>(
      'Inner work',
      (scope: State) => {
        calls += 1;
        if (calls < 3) throw new Error('flaky inner');
        scope.value = 'inner ok';
      },
      'inner-work',
    )
      .retry({ attempts: 3 })
      .build();

    const chart = flowChart<State>('Seed', () => undefined, 'seed')
      .addSubFlowChartNext('sf', inner, 'Sub')
      .build();

    const executor = new FlowChartExecutor(chart);
    executor.attachFlowRecorder(probe);
    await executor.run();

    expect(probe.events).toHaveLength(2);
    // The policy survived the subflow id prefixer with the node.
    expect(probe.events[0].stageId).toBe('sf/inner-work');
    expect(probe.events[0].traversalContext?.subflowId).toBe('sf');
  });

  it('retries a stage in a LOOP without consuming loop iterations', async () => {
    let pass = 0;
    let failuresInjected = 0;
    const probe = retryProbe();
    const chart = flowChart<State>(
      'Seed',
      (scope: State) => {
        scope.seen = [];
      },
      'seed',
    )
      .addFunction(
        'Work',
        (scope: State) => {
          // Fail once on the first pass only, then behave.
          if (pass === 0 && failuresInjected === 0) {
            failuresInjected += 1;
            throw new Error('flaky pass');
          }
          pass += 1;
          scope.seen = [...((scope.seen as string[]) ?? []), `pass ${pass}`];
        },
        'work',
      )
      .retry({ attempts: 2 })
      .addDeciderFunction(
        'More?',
        (scope: State) => (((scope.seen as string[]) ?? []).length < 3 ? 'again' : 'done'),
        'more',
      )
      .addFunctionBranch('again', 'Again', () => undefined, undefined, { loopTo: 'work' })
      .addFunctionBranch('done', 'Done', () => undefined)
      .end()
      .build();

    const executor = new FlowChartExecutor(chart);
    executor.attachFlowRecorder(probe);
    await executor.run({ maxIterations: 3 });

    expect(executor.getSnapshot().sharedState.seen).toEqual(['pass 1', 'pass 2', 'pass 3']);
    // The retry did NOT count as a loop iteration — the loop still got its 3.
    expect(probe.events).toHaveLength(1);
  });
});

describe('retry — deferred observers see it too', () => {
  it('delivers onStageRetry to a recorder attached with delivery: deferred', async () => {
    const seen: FlowStageRetryEvent[] = [];
    const chart = flowChart<State>('Seed', () => undefined, 'seed')
      .addFunction('Flaky', flaky(2), 'flaky')
      .retry({ attempts: 3 })
      .build();

    const executor = new FlowChartExecutor(chart);
    executor.attachFlowRecorder(
      {
        id: 'deferred-retry',
        onStageRetry: (event) => {
          seen.push(event);
        },
      },
      { delivery: 'deferred' },
    );
    await executor.run();

    // Terminal flush at run resolve guarantees delivery before run() returns —
    // this is the assertion that catches a missing FLOW_RECORDER_EVENT_METHODS
    // entry, which would otherwise fail SILENTLY.
    expect(seen.map((e) => e.attempt)).toEqual([1, 2]);
    expect(seen[0].stageName).toBe('Flaky');
  });
});

describe('retry — the spec records the declared policy', () => {
  it('carries retryAttempts on the built structure so a visualiser can show it', async () => {
    const chart = flowChart<State>('Seed', () => undefined, 'seed')
      .addFunction('Flaky', flaky(0), 'flaky')
      .retry({ attempts: 3, backoffMs: () => 5 })
      .build();

    expect(chart.buildTimeStructure.next?.retryAttempts).toBe(3);
    // The spec stays JSON-safe: no functions leaked into it.
    expect(() => JSON.stringify(chart.buildTimeStructure)).not.toThrow();
  });
});

describe('retry — recorder isolation', () => {
  it('a throwing onStageRetry recorder never breaks the run', async () => {
    const chart = flowChart<State>('Seed', () => undefined, 'seed')
      .addFunction('Flaky', flaky(1), 'flaky')
      .retry({ attempts: 2 })
      .build();

    const executor = new FlowChartExecutor(chart);
    executor.attachFlowRecorder({
      id: 'bad',
      onStageRetry: () => {
        throw new Error('recorder is broken');
      },
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await executor.run();
    warn.mockRestore();

    expect(executor.getSnapshot().sharedState.value).toBe('ok after 2');
  });
});
