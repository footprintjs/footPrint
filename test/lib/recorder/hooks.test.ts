/**
 * The hook registry and the one dispatcher (F6) — `recorder/hooks.ts`.
 *
 * - `hooksOn(channel)` replaces the three hand lists, same contents and order as 9.35.0;
 * - `fire` isolates every throw, including one that cannot be turned into a string;
 * - the `CompositeRecorder` fan-out is GENERATED: one case per registry member and channel;
 * - R10: a throwing recorder on the executor-made `onResume` no longer rejects `resume()`.
 *
 * The compile-time half (a hook added to an interface and not to `HOOKS` does not compile) is
 * test/architecture/hook-registry-compile.test.ts.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { FlowRecorder, PausableHandler, ScopeRecorder } from '../../../src/index.js';
import { CompositeRecorder, disableDevMode, enableDevMode, flowChart, FlowChartExecutor } from '../../../src/index.js';
import type { HookChannel, HookName } from '../../../src/lib/recorder/hooks.js';
import { describeThrown, fire, HOOK_NAMES, HOOKS, hooksOn } from '../../../src/lib/recorder/hooks.js';

afterEach(() => {
  disableDevMode();
  vi.restoreAllMocks();
});

const CHANNELS: readonly HookChannel[] = ['scope', 'flow', 'emit'];

describe('the registry', () => {
  it("hooksOn gives the three channel lists with the 9.35.0 hand lists' contents and order", () => {
    expect([...hooksOn('scope')]).toEqual([
      'onRead',
      'onWrite',
      'onCommit',
      'onError',
      'onStageStart',
      'onStageEnd',
      'onPause',
      'onResume',
    ]);
    expect([...hooksOn('flow')]).toEqual([
      'onStageExecuted',
      'onNext',
      'onDecision',
      'onFork',
      'onSelected',
      'onSubflowEntry',
      'onSubflowExit',
      'onSubflowRegistered',
      'onLoop',
      'onBreak',
      'onError',
      'onStageRetry',
      'onPause',
      'onResume',
      'onRunStart',
      'onRunEnd',
      'onRunFailed',
    ]);
    expect([...hooksOn('emit')]).toEqual(['onEmit']);
  });

  it('declares 23 hooks over 26 channel slots; onResume is the one executor-made event', () => {
    expect(HOOK_NAMES).toHaveLength(23);
    expect(CHANNELS.reduce((n, c) => n + hooksOn(c).length, 0)).toBe(26);
    expect(HOOK_NAMES.filter((h) => HOOKS[h].executorMade)).toEqual(['onResume']);
  });
});

describe('fire', () => {
  it('calls every recorder in order and hands a throw to the failure policy, never to the caller', () => {
    const seen: string[] = [];
    const failures: string[] = [];
    const recorders = [
      { id: 'a', onLoop: () => seen.push('a') },
      {
        id: 'b',
        onLoop: () => {
          throw new Error('b broke');
        },
      },
      { id: 'c', onLoop: () => seen.push('c') },
      { id: 'd' },
    ];
    const event = { target: 'x', iteration: 1 };
    fire(recorders, 'onLoop', event, (error, r, hook) =>
      failures.push(`${(r as { id: string }).id}:${hook}:${describeThrown(error)}`),
    );
    expect(seen).toEqual(['a', 'c']);
    expect(failures).toEqual(['b:onLoop:Error: b broke']);
  });

  it('swallows a throw from the failure policy itself', () => {
    const thrower = {
      id: 't',
      onNext: () => {
        throw new Error('x');
      },
    };
    expect(() =>
      fire([thrower], 'onNext', { from: 'a', to: 'b' }, () => {
        throw new Error('policy broke');
      }),
    ).not.toThrow();
  });

  it('describes a value `${}` cannot stringify (null prototype, symbol)', () => {
    expect(describeThrown(Object.create(null))).toBe('[object Object]');
    expect(describeThrown(Symbol('s'))).toBe('Symbol(s)');
    expect(describeThrown(new Error('e'))).toBe('Error: e');
  });
});

// ── The generated composite test — one case per registry member, per channel ─────────────

const SLOTS: Array<[HookName, HookChannel]> = HOOK_NAMES.flatMap((h) =>
  (Object.keys(HOOKS[h].on) as HookChannel[]).map((c): [HookName, HookChannel] => [h, c]),
);

describe('CompositeRecorder fans out every registry hook (26/26)', () => {
  it('covers 26 slots', () => {
    expect(SLOTS).toHaveLength(26);
  });

  it.each(SLOTS)('%s (%s channel) reaches every child that implements it, in order', (hook, channel) => {
    const got: string[] = [];
    const event = { channel, probe: hook };
    const child = (id: string) => ({
      id,
      [hook]: function (this: { id: string }, e: unknown) {
        expect(e).toBe(event);
        got.push(this.id);
      },
    });
    const composite = new CompositeRecorder('c', [
      child('one'),
      { id: 'bare' } as ScopeRecorder,
      child('two'),
    ] as ScopeRecorder[]);
    expect(typeof (composite as unknown as Record<string, unknown>)[hook]).toBe('function');
    (composite as unknown as Record<string, (e: unknown) => void>)[hook](event);
    expect(got).toEqual(['one', 'two']);
  });

  it('keeps description / preferredOperation / meta on each child row (the one copier)', () => {
    const composite = new CompositeRecorder('c', [
      {
        id: 'kid',
        toSnapshot: () => ({
          name: 'Kid',
          description: 'what it holds',
          preferredOperation: 'aggregate' as const,
          data: 1,
          meta: { shape: 'v2' },
        }),
      },
    ]);
    expect(composite.toSnapshot().data.children).toEqual([
      {
        id: 'kid',
        name: 'Kid',
        description: 'what it holds',
        preferredOperation: 'aggregate',
        data: 1,
        meta: { shape: 'v2' },
      },
    ]);
  });

  it('end to end: a composite child sees onRunStart / onRunEnd / onEmit (new in F6)', async () => {
    const hooks: string[] = [];
    const kid = {
      id: 'kid',
      onRunStart: () => hooks.push('onRunStart'),
      onRunEnd: () => hooks.push('onRunEnd'),
      onEmit: () => hooks.push('onEmit'),
    };
    const chart = flowChart<{ x?: number }>(
      'A',
      (s) => {
        s.$emit('ping', 1);
      },
      'a',
    ).build();
    const ex = new FlowChartExecutor(chart);
    ex.attachCombinedRecorder(new CompositeRecorder('comp', [kid as unknown as FlowRecorder]));
    await ex.run();
    expect(hooks).toEqual(['onRunStart', 'onEmit', 'onRunEnd']);
  });
});

// ── R10 — executor-made events go through `fire` ──────────────────────────────────────

function pausingChart() {
  const handler: PausableHandler<{ ok?: boolean }> = {
    execute: () => ({ question: 'ok?' }),
    resume: (scope, input) => {
      scope.ok = (input as { ok: boolean }).ok;
    },
  };
  return flowChart<{ ok?: boolean }>('Ask', handler, 'ask').build();
}

describe('R10: a throwing onResume does not abort resume()', () => {
  it('flow channel: the throw is isolated (dev-mode warning) and resume completes', async () => {
    enableDevMode();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const after: string[] = [];
    const ex = new FlowChartExecutor(pausingChart());
    ex.attachFlowRecorder({
      id: 'bad',
      onResume: () => {
        throw new Error('resume hook broke');
      },
    });
    ex.attachFlowRecorder({ id: 'good', onResume: () => after.push('good') });
    await ex.run();
    await ex.resume(ex.getCheckpoint()!, { ok: true }); // rejected on 9.35.0
    expect(after).toEqual(['good']);
    expect(ex.getSnapshot().sharedState.ok).toBe(true);
    expect(warn.mock.calls.some(([m]) => String(m).includes('"bad" threw in onResume'))).toBe(true);
  });

  it('scope channel: the throw becomes onError on the scope recorders, as a stage hook failure does', async () => {
    const errors: Array<{ operation: string; message: string }> = [];
    const ex = new FlowChartExecutor(pausingChart());
    ex.attachScopeRecorder({
      id: 'bad',
      onResume: () => {
        throw new Error('scope resume broke');
      },
    });
    ex.attachScopeRecorder({
      id: 'watch',
      onError: (e) => errors.push({ operation: e.operation, message: e.error.message }),
    });
    await ex.run();
    await ex.resume(ex.getCheckpoint()!, { ok: true }); // rejected on 9.35.0
    expect(errors).toContainEqual({ operation: 'write', message: 'scope resume broke' });
  });
});

describe('recorder errors are always isolated — even a value that cannot be stringified', () => {
  it('a flow hook throwing a null-prototype object does not reject run() in dev mode', async () => {
    enableDevMode();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const chart = flowChart<{ v?: number }>(
      'A',
      (s) => {
        s.v = 1;
      },
      'a',
    ).build();
    const ex = new FlowChartExecutor(chart);
    ex.attachFlowRecorder({
      id: 'weird',
      onStageExecuted: () => {
        throw Object.create(null);
      },
    });
    await expect(ex.run()).resolves.toBeUndefined();
    expect(warn.mock.calls.some(([m]) => String(m).includes('"weird" threw in onStageExecuted: [object Object]'))).toBe(
      true,
    );
  });
});
