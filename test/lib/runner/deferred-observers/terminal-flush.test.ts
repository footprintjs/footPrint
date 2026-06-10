/**
 * RFC-001 Block 8 — terminal flush at the OUTERMOST run boundary.
 *
 * The contract: "one beat behind" never becomes "lost at exit".
 *   - run RESOLVE  → every captured event delivered before run() returns;
 *   - run REJECT   → delivered before the rejection reaches the caller;
 *   - PAUSE        → delivered before the checkpoint becomes available;
 *   - pathological listener cascade → capped by flushSync's maxRounds, the
 *     stranded remainder surfaced on observerStats.terminalStranded and
 *     dev-warned — never silent.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { PausableHandler } from '../../../../src/index';
import { disableDevMode, enableDevMode, flowChart, FlowChartExecutor } from '../../../../src/index';

type Loose = Record<string, unknown>;

afterEach(() => {
  disableDevMode();
  vi.restoreAllMocks();
});

describe('Block 8 — terminal flush', () => {
  it('run resolve: all captured events are delivered BEFORE run() returns', async () => {
    const chart = flowChart<Loose>(
      'Seed',
      async (scope) => {
        scope.$setValue('a', 1);
        scope.$setValue('b', 2);
      },
      'seed',
    ).build();
    const keys: string[] = [];
    const executor = new FlowChartExecutor(chart);
    executor.attachScopeRecorder(
      { id: 'late', onWrite: (e) => keys.push(e.key) },
      { delivery: 'deferred', capture: 'clone' },
    );
    await executor.run();
    // Synchronously after the await — no extra microtask turn granted.
    expect(keys).toEqual(['a', 'b']);
  });

  it('crash mid-stage: captured events are delivered before the rejection reaches the caller', async () => {
    const chart = flowChart<Loose>(
      'Seed',
      async (scope) => {
        scope.$setValue('preCrash', 'written');
      },
      'seed',
    )
      .addFunction(
        'Boom',
        async (scope) => {
          scope.$setValue('inCrashingStage', 'also-written');
          throw new Error('stage boom');
        },
        'boom',
      )
      .build();

    const keys: string[] = [];
    const flowErrors: string[] = [];
    const executor = new FlowChartExecutor(chart);
    executor.attachCombinedRecorder(
      {
        id: 'crash-watch',
        onWrite: (e) => keys.push((e as { key: string }).key),
        onError: (e) => flowErrors.push((e as { message?: string }).message ?? 'scope-error'),
      },
      { delivery: 'deferred', capture: 'clone' },
    );

    let deliveredAtRejection: string[] | undefined;
    let errorsAtRejection: string[] | undefined;
    try {
      await executor.run();
      expect.unreachable('run() must reject');
    } catch (err) {
      // The instant the rejection reaches the caller, delivery is complete.
      deliveredAtRejection = [...keys];
      errorsAtRejection = [...flowErrors];
      expect((err as Error).message).toContain('stage boom');
    }
    expect(deliveredAtRejection).toContain('preCrash');
    expect(deliveredAtRejection).toContain('inCrashingStage');
    expect(errorsAtRejection?.length).toBeGreaterThan(0);
  });

  it('pause: captured events are delivered before the checkpoint becomes available', async () => {
    const handler: PausableHandler<Loose> = {
      execute: async () => ({ question: 'approve?' }),
      resume: async () => undefined,
    };
    const chart = flowChart<Loose>(
      'Seed',
      async (scope) => {
        scope.$setValue('prePause', 'yes');
      },
      'seed',
    )
      .addPausableFunction('Approve', handler, 'approve')
      .build();

    const keys: string[] = [];
    const pauses: string[] = [];
    const executor = new FlowChartExecutor(chart);
    executor.attachCombinedRecorder(
      {
        id: 'pause-watch',
        onWrite: (e) => keys.push((e as { key: string }).key),
        onPause: (e) => pauses.push((e as { stageName: string }).stageName),
      },
      { delivery: 'deferred', capture: 'clone' },
    );

    const result = await executor.run();
    // Synchronously after run() returned the paused result: all delivered.
    expect((result as { paused?: boolean }).paused).toBe(true);
    expect(executor.getCheckpoint()).toBeDefined();
    expect(keys).toContain('prePause');
    expect(pauses).toContain('Approve');
  });

  it('listener cascade at terminal flush hits the maxRounds cap and is surfaced, never silent', () => {
    enableDevMode();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const chart = flowChart<Loose>(
      'Seed',
      async (scope) => {
        scope.$setValue('k', 1);
      },
      'seed',
    ).build();

    const executor = new FlowChartExecutor(chart);
    let deliveries = 0;
    // A SELF-LIMITED feeder (a truly unbounded one would chain microtask
    // flushes forever after the test and hang the process — the cap exists
    // exactly because such a listener is pathological). 1 500 > the 1 000
    // flushSync round cap, so the terminal flush is guaranteed to strand.
    const FEED_LIMIT = 1_500;
    executor.attachScopeRecorder(
      {
        id: 'self-feeder',
        onWrite: () => {
          deliveries += 1;
          if (deliveries >= FEED_LIMIT) return;
          tier.capture('scope', 'onWrite', 'synthetic#0', 'run', { key: 'k', value: deliveries });
        },
      },
      { delivery: 'deferred', capture: 'clone' },
    );
    const tier = (
      executor as unknown as {
        deferredTier: {
          capture(c: 'scope', m: string, r: string, run: string, p: unknown): void;
          terminalFlush(): void;
        };
      }
    ).deferredTier;

    // Seed one event, then drive the terminal flush synchronously (no run —
    // a mid-run cascade would starve the engine's own awaits by design).
    tier.capture('scope', 'onWrite', 'seed#0', 'run', { key: 'k', value: 0 });
    tier.terminalFlush(); // must terminate — flushSync's maxRounds cap

    expect(deliveries).toBeGreaterThanOrEqual(1_000); // the cap let it run the full rounds first
    const stats = executor.getSnapshot().observerStats!;
    expect(stats.terminalStranded).toBeGreaterThan(0); // surfaced in stats (Block 9 carries it)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('terminal flush hit the runaway-cascade cap'));
  });

  it('drainObservers settles async continuations spawned by terminal-flush deliveries', async () => {
    const chart = flowChart<Loose>(
      'Seed',
      async (scope) => {
        scope.$setValue('k', 1);
      },
      'seed',
    ).build();
    const settled: string[] = [];
    const executor = new FlowChartExecutor(chart);
    executor.attachScopeRecorder(
      {
        id: 'slow-async',
        onWrite: async (e) => {
          await new Promise((resolve) => setTimeout(resolve, 10));
          settled.push(e.key);
        },
      },
      { delivery: 'deferred', capture: 'clone' },
    );
    await executor.run();
    const result = await executor.drainObservers({ timeoutMs: 2_000 });
    expect(result.pending).toBe(0);
    expect(settled).toEqual(['k']);
  });

  it('drainObservers reports honest pending on timeout', async () => {
    const chart = flowChart<Loose>(
      'Seed',
      async (scope) => {
        scope.$setValue('k', 1);
      },
      'seed',
    ).build();
    const executor = new FlowChartExecutor(chart);
    let release: (() => void) | undefined;
    executor.attachScopeRecorder(
      {
        id: 'stuck-async',
        onWrite: () =>
          new Promise<void>((resolve) => {
            release = resolve;
          }),
      },
      { delivery: 'deferred' },
    );
    await executor.run();
    const result = await executor.drainObservers({ timeoutMs: 25 });
    expect(result.pending).toBeGreaterThan(0);
    release?.(); // clean up the hanging continuation
  });
});
