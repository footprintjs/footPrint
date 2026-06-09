/**
 * Snapshot/checkpoint boundary isolation (BACKLOG #8).
 *
 * Before this change, `getSnapshot().sharedState` and the pause checkpoint's
 * `sharedState` were the LIVE `SharedMemory` context object (the alias only
 * detached at the next commit; post-run it lasted forever), and `resume()`
 * seeded engine runtimes with live references into the caller's checkpoint.
 *
 * New contract:
 *   - Checkpoints are deep-copied at creation (structuredClone) — fully
 *     detached from engine state in BOTH directions.
 *   - `resume()` clones the checkpoint pieces it seeds into the engine
 *     (`sharedState`, `subflowStates`) — the engine never holds a reference
 *     to the caller's object.
 *   - `getSnapshot().sharedState` stays a zero-copy live view in production
 *     (treat as read-only), but in dev mode it is a deep-frozen CLONE so
 *     consumer mutation throws loudly.
 */
import { afterEach, describe, expect, it } from 'vitest';

import type { PausableHandler } from '../../../src';
import { disableDevMode, enableDevMode, flowChart, FlowChartExecutor } from '../../../src';

// ── Shared fixtures ────────────────────────────────────────────────

interface State {
  amount?: number;
  config?: { multiplier: number; tags: string[] };
  total?: number;
  approved?: boolean;
  [key: string]: unknown;
}

/** Seed → pausable Approve → Process (total = amount * config.multiplier). */
function buildChart() {
  return flowChart<State>(
    'Seed',
    (scope) => {
      scope.amount = 10;
      scope.config = { multiplier: 2, tags: ['original'] };
    },
    'seed',
  )
    .addPausableFunction(
      'Approve',
      {
        execute: async () => ({ question: 'Approve?' }),
        resume: async (scope, input) => {
          scope.approved = (input as { approved?: boolean }).approved ?? false;
        },
      } as PausableHandler<State, { approved: boolean }>,
      'approve',
    )
    .addFunction(
      'Process',
      (scope) => {
        const amount = scope.amount as number;
        const config = scope.config as { multiplier: number };
        scope.total = amount * config.multiplier;
      },
      'process',
    )
    .build();
}

interface InnerState {
  items?: string[];
  step?: number;
  [key: string]: unknown;
}

interface OuterState {
  stage?: string;
  items?: string[];
  [key: string]: unknown;
}

/** Outer chart mounting a subflow that pauses — exercises `subflowStates`. */
function buildSubflowPauseChart() {
  const inner = flowChart<InnerState>(
    'Accumulate',
    (scope) => {
      scope.items = ['original'];
      scope.step = 1;
    },
    'accumulate',
  )
    .addPausableFunction(
      'Review',
      {
        execute: async () => ({ question: 'Who reviewed?' }),
        resume: async (scope, input) => {
          const before = (scope.items as string[] | undefined) ?? [];
          scope.items = [...before, `reviewed-by-${(input as { reviewedBy: string }).reviewedBy}`];
          scope.step = 2;
        },
      } as PausableHandler<InnerState, { reviewedBy: string }>,
      'review',
    )
    .build();

  return flowChart<OuterState>(
    'OuterSeed',
    (scope) => {
      scope.stage = 'started';
    },
    'outer-seed',
  )
    .addSubFlowChartNext('sf-review', inner, 'Review', {
      inputMapper: () => ({}),
      outputMapper: (sfOutput) => ({ items: (sfOutput as InnerState).items }),
    })
    .build();
}

afterEach(() => {
  disableDevMode();
});

// ── (a) Checkpoint mutation cannot reach engine state ──────────────

describe('checkpoint isolation — mutating a returned checkpoint leaves engine state untouched', () => {
  it('checkpoint.sharedState is a detached copy, not the live context', async () => {
    const executor = new FlowChartExecutor(buildChart());
    await executor.run();
    expect(executor.isPaused()).toBe(true);

    const cp = executor.getCheckpoint()!;
    const live = executor.getSnapshot().sharedState;

    // Different object graph — no shared references at any depth.
    expect(cp.sharedState).not.toBe(live);
    expect(cp.sharedState.config).not.toBe(live.config);
    expect((cp.sharedState.config as State['config'])!.tags).not.toBe((live.config as State['config'])!.tags);
    // ...but equal content.
    expect(cp.sharedState).toEqual(live);
  });

  it('run → pause → mutate checkpoint → resume works from the ORIGINAL data', async () => {
    const executor = new FlowChartExecutor(buildChart());
    await executor.run();
    const cp = executor.getCheckpoint()!;

    // Vandalize the checkpoint at every depth.
    cp.sharedState.amount = 999;
    (cp.sharedState.config as { multiplier: number }).multiplier = -1;
    (cp.sharedState.config as { tags: string[] }).tags.push('EVIL');
    (cp.executionTree as { name?: string }).name = 'TAMPERED';

    // Engine state is untouched by the checkpoint mutation.
    const live = executor.getSnapshot().sharedState;
    expect(live.amount).toBe(10);
    expect((live.config as State['config'])!.multiplier).toBe(2);
    expect((live.config as State['config'])!.tags).toEqual(['original']);
    expect(executor.getSnapshot().executionTree.name).not.toBe('TAMPERED');

    // Same-executor resume (even handed the vandalized checkpoint) continues
    // from the engine's original data: total = 10 * 2, not 999 * -1.
    await executor.resume(cp, { approved: true });
    const after = executor.getSnapshot().sharedState;
    expect(after.total).toBe(20);
    expect(after.approved).toBe(true);
  });

  it('subflow pause: mutating checkpoint.subflowStates cannot poison the resumed subflow', async () => {
    const executor = new FlowChartExecutor(buildSubflowPauseChart());
    await executor.run();
    const cp = executor.getCheckpoint()!;
    expect(cp.subflowPath).toEqual(['sf-review']);
    expect(cp.subflowStates['sf-review'].items).toEqual(['original']);

    // JSON-snapshot the checkpoint, then vandalize the live object.
    const persisted = JSON.parse(JSON.stringify(cp));
    (cp.subflowStates['sf-review'].items as string[]).push('EVIL');

    // Resume a FRESH executor from the persisted (unmutated) copy — the
    // engine-side capture was a deep copy, so the original data survived.
    const fresh = new FlowChartExecutor(buildSubflowPauseChart());
    await fresh.resume(persisted, { reviewedBy: 'alice' });
    const items = fresh.getSnapshot().sharedState.items as string[];
    expect(items).toContain('original');
    expect(items).toContain('reviewed-by-alice');
    expect(items).not.toContain('EVIL');
  });

  it('checkpoint survives a JSON round-trip byte-identically (no live re-aliasing on getCheckpoint)', async () => {
    const executor = new FlowChartExecutor(buildChart());
    await executor.run();
    const cp = executor.getCheckpoint()!;
    const roundTripped = JSON.parse(JSON.stringify(cp));
    expect(roundTripped).toEqual(JSON.parse(JSON.stringify(executor.getCheckpoint()!)));
    // Two reads return the SAME detached object (last-run-wins contract).
    expect(executor.getCheckpoint()).toBe(cp);
  });
});

// ── (b) Cross-executor resume is isolated from the caller's checkpoint ──

describe('checkpoint isolation — cross-executor resume clones the checkpoint in', () => {
  it('mutating the original checkpoint object does not affect the resumed run', async () => {
    const original = new FlowChartExecutor(buildChart());
    await original.run();
    const cp = original.getCheckpoint()!;

    // Fresh executor (simulates a new process restoring from storage).
    const fresh = new FlowChartExecutor(buildChart());
    // Start the resume, then SYNCHRONOUSLY vandalize the checkpoint before
    // the engine has executed anything — if resume() held a live reference,
    // the Process stage would read multiplier -1.
    const pending = fresh.resume(cp, { approved: true });
    cp.sharedState.amount = 999;
    (cp.sharedState.config as { multiplier: number }).multiplier = -1;
    await pending;

    const after = fresh.getSnapshot().sharedState;
    expect(after.total).toBe(20); // 10 * 2 — original data, not 999 * -1
    expect(after.approved).toBe(true);
  });

  it('engine writes during the resumed run do not bleed back into the checkpoint', async () => {
    const original = new FlowChartExecutor(buildChart());
    await original.run();
    const cp = original.getCheckpoint()!;
    const before = JSON.parse(JSON.stringify(cp));

    const fresh = new FlowChartExecutor(buildChart());
    await fresh.resume(cp, { approved: true });

    // The resumed run wrote `approved` and `total` — none of it reached
    // the caller's checkpoint object.
    expect(JSON.parse(JSON.stringify(cp))).toEqual(before);
    expect(cp.sharedState.total).toBeUndefined();
  });
});

// ── (c) Dev mode: getSnapshot().sharedState is a deep-frozen clone ──

describe('snapshot isolation — dev mode deep-freezes sharedState', () => {
  it('mutating getSnapshot().sharedState throws at every depth', async () => {
    enableDevMode();
    const executor = new FlowChartExecutor(buildChart());
    await executor.run();

    const shared = executor.getSnapshot().sharedState;
    expect(Object.isFrozen(shared)).toBe(true);
    expect(Object.isFrozen(shared.config)).toBe(true);
    expect(Object.isFrozen((shared.config as State['config'])!.tags)).toBe(true);

    expect(() => {
      shared.amount = 999;
    }).toThrow(TypeError);
    expect(() => {
      (shared.config as { multiplier: number }).multiplier = -1;
    }).toThrow(TypeError);
    expect(() => {
      (shared.config as { tags: string[] }).tags.push('EVIL');
    }).toThrow(TypeError);
  });

  it('freezes a CLONE — the live engine state stays writable (resume still works)', async () => {
    enableDevMode();
    const executor = new FlowChartExecutor(buildChart());
    await executor.run();

    const first = executor.getSnapshot().sharedState;
    const second = executor.getSnapshot().sharedState;
    // Each call clones — frozen views are independent objects.
    expect(first).not.toBe(second);
    expect(first).toEqual(second);

    // The engine itself was not frozen: the resumed run commits new writes.
    await executor.resume(executor.getCheckpoint()!, { approved: true });
    expect(executor.getSnapshot().sharedState.total).toBe(20);
  });
});

// ── (d) Non-dev mode: getSnapshot is unchanged (no freeze, no clone) ──

describe('snapshot isolation — production mode is unchanged', () => {
  it('sharedState is not frozen and mutation does not throw (treat as read-only)', async () => {
    disableDevMode();
    const executor = new FlowChartExecutor(buildChart());
    await executor.run();

    const shared = executor.getSnapshot().sharedState;
    expect(Object.isFrozen(shared)).toBe(false);
    expect(Object.isFrozen(shared.config)).toBe(false);
    expect(() => {
      shared.probe = 'ok';
    }).not.toThrow();
  });
});

// ── (e) Clone resilience — non-cloneable diagnostics never abort a pause ──

/** Same Seed → Approve → Process chart, but Seed $debug/$metric's FUNCTIONS. */
function buildDiagnosticChart() {
  return flowChart<State>(
    'Seed',
    (scope) => {
      scope.amount = 10;
      scope.config = { multiplier: 2, tags: ['original'] };
      scope.$debug('callback', () => 'not-cloneable');
      scope.$metric('timing', { cb: () => 1, ms: 42 });
    },
    'seed',
  )
    .addPausableFunction(
      'Approve',
      {
        execute: async () => ({ question: 'Approve?' }),
        resume: async (scope, input) => {
          scope.approved = (input as { approved?: boolean }).approved ?? false;
        },
      } as PausableHandler<State, { approved: boolean }>,
      'approve',
    )
    .addFunction(
      'Process',
      (scope) => {
        scope.total = (scope.amount as number) * (scope.config as { multiplier: number }).multiplier;
      },
      'process',
    )
    .build();
}

describe('checkpoint clone resilience — diagnostic bags are sanitized, the pause survives', () => {
  it('a $debug-ed FUNCTION no longer aborts the pause — sanitized to a marker in the checkpoint', async () => {
    const executor = new FlowChartExecutor(buildDiagnosticChart());
    const result = await executor.run();
    expect(result).toMatchObject({ paused: true });
    expect(executor.isPaused()).toBe(true);

    const tree = executor.getCheckpoint()!.executionTree as {
      logs: Record<string, unknown>;
      metrics: Record<string, unknown>;
    };
    expect(tree.logs.callback).toBe('[non-serializable: function]');
    // Nested non-cloneable is replaced; the cloneable sibling survives intact.
    expect(tree.metrics.timing).toEqual({ cb: '[non-serializable: function]', ms: 42 });
    // The sanitized checkpoint is JSON-safe end-to-end (the persistence contract).
    expect(() => JSON.stringify(executor.getCheckpoint())).not.toThrow();
  });

  it('sanitization touches only the checkpoint — live engine diagnostics keep the raw value', async () => {
    const executor = new FlowChartExecutor(buildDiagnosticChart());
    await executor.run();
    expect(typeof executor.getSnapshot().executionTree.logs.callback).toBe('function');
  });

  it('resume completes normally after a sanitized pause', async () => {
    const executor = new FlowChartExecutor(buildDiagnosticChart());
    await executor.run();
    await executor.resume(executor.getCheckpoint()!, { approved: true });
    const after = executor.getSnapshot().sharedState;
    expect(after.total).toBe(20);
    expect(after.approved).toBe(true);
  });

  it('non-cloneable pauseData throws a DESCRIPTIVE contract error, never a naked DataCloneError', async () => {
    const chart = flowChart<State>(
      'Seed',
      (scope) => {
        scope.amount = 10;
      },
      'seed',
    )
      .addPausableFunction(
        'Approve',
        {
          // Function in pauseData = genuine JSON-safe contract violation.
          execute: async () => ({ question: 'Approve?', onApprove: () => true }),
          resume: async () => {},
        } as PausableHandler<State, unknown>,
        'approve',
      )
      .build();
    const executor = new FlowChartExecutor(chart);

    let caught: unknown;
    try {
      await executor.run();
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    const err = caught as Error;
    // Descriptive: names the offending checkpoint field and the contract doc.
    expect(err.name).not.toBe('DataCloneError');
    expect(err.message).toContain('pauseData');
    expect(err.message).toContain('docs/guides/execution-model.md');
    // The original clone error is preserved for debugging.
    expect((err.cause as Error | undefined)?.name).toBe('DataCloneError');
    // A failed pause leaves no half-built checkpoint behind.
    expect(executor.isPaused()).toBe(false);
    expect(executor.getCheckpoint()).toBeUndefined();
  });
});
