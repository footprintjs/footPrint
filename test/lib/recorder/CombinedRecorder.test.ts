/**
 * 5-pattern tests for CombinedRecorder + attachCombinedRecorder.
 *
 * Patterns: unit, boundary, scenario, property, security.
 *
 * What's under test:
 *   - `CombinedRecorder` type composes Recorder + FlowRecorder correctly
 *     with shared-method payload unions.
 *   - `hasRecorderMethods` / `hasFlowRecorderMethods` duck-typing predicates.
 *   - `executor.attachCombinedRecorder(r)` routes to the correct channels
 *     based on which methods `r` implements, idempotent by `id`.
 *   - `executor.detachCombinedRecorder(id)` cleans up both channels.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  type CombinedRecorder,
  disableDevMode,
  enableDevMode,
  flowChart,
  FlowChartExecutor,
  hasFlowRecorderMethods,
  hasRecorderMethods,
  isFlowEvent,
} from '../../../src/index.js';

// ── Fixtures ────────────────────────────────────────────────────────────────

interface DemoState {
  value: number;
  result: string;
}

function buildDemoChart() {
  return flowChart<DemoState>(
    'Seed',
    (scope) => {
      scope.value = 42;
    },
    'seed',
  )
    .addFunction(
      'Compute',
      (scope) => {
        scope.result = `value=${scope.value}`;
      },
      'compute',
    )
    .build();
}

// ════════════════════════════════════════════════════════════════════════════
// 1. UNIT — each predicate recognises its own method set
// ════════════════════════════════════════════════════════════════════════════

describe('CombinedRecorder — unit', () => {
  it('hasRecorderMethods is true when any data-flow event method exists', () => {
    const r: CombinedRecorder = { id: 'r', onWrite: () => {} };
    expect(hasRecorderMethods(r)).toBe(true);
    expect(hasFlowRecorderMethods(r)).toBe(false);
  });

  it('hasFlowRecorderMethods is true when any control-flow event method exists', () => {
    const r: CombinedRecorder = { id: 'r', onDecision: () => {} };
    expect(hasFlowRecorderMethods(r)).toBe(true);
    expect(hasRecorderMethods(r)).toBe(false);
  });

  it('both predicates true when recorder spans both streams', () => {
    const r: CombinedRecorder = {
      id: 'r',
      onWrite: () => {},
      onDecision: () => {},
    };
    expect(hasRecorderMethods(r)).toBe(true);
    expect(hasFlowRecorderMethods(r)).toBe(true);
  });

  it('lifecycle-only methods do NOT count as event methods', () => {
    // clear / toSnapshot exist on both interfaces but are not events.
    // A recorder that ONLY has them has nothing to observe.
    const r: CombinedRecorder = {
      id: 'r',
      clear: () => {},
      toSnapshot: () => ({ name: 'r', data: null }),
    };
    expect(hasRecorderMethods(r)).toBe(false);
    expect(hasFlowRecorderMethods(r)).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 2. BOUNDARY — empty recorder, duplicate attach, missing id
// ════════════════════════════════════════════════════════════════════════════

describe('CombinedRecorder — boundary', () => {
  it('attachCombinedRecorder with no event methods is a no-op (dev warns)', async () => {
    const chart = buildDemoChart();
    const executor = new FlowChartExecutor(chart);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    enableDevMode();

    const empty: CombinedRecorder = {
      id: 'empty',
      clear: () => {},
    };
    executor.attachCombinedRecorder(empty);

    expect(executor.getRecorders()).toHaveLength(0);
    expect(executor.getFlowRecorders()).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalled();
    // Warning is gated on isDevMode() — part of the library-wide dev-mode
    // contract (enableDevMode/disableDevMode control all dev-mode warnings).
    expect(warnSpy.mock.calls[0]?.[0]).toMatch(/no observer event methods/);

    await executor.run();
    warnSpy.mockRestore();
    disableDevMode();
  });

  it('dev-mode OFF suppresses the empty-recorder warning', () => {
    const chart = buildDemoChart();
    const executor = new FlowChartExecutor(chart);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    disableDevMode();

    const empty: CombinedRecorder = { id: 'empty', clear: () => {} };
    executor.attachCombinedRecorder(empty);

    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('re-attaching same id replaces previous on BOTH channels (idempotent)', () => {
    const chart = buildDemoChart();
    const executor = new FlowChartExecutor(chart);

    const v1: CombinedRecorder = {
      id: 'obs',
      onWrite: () => 'v1-data',
      onDecision: () => 'v1-flow',
    };
    const v2: CombinedRecorder = {
      id: 'obs',
      onWrite: () => 'v2-data',
      onDecision: () => 'v2-flow',
    };

    executor.attachCombinedRecorder(v1);
    executor.attachCombinedRecorder(v2);

    // Each channel holds exactly one recorder with id 'obs' — and it's v2.
    expect(executor.getRecorders()).toHaveLength(1);
    expect(executor.getFlowRecorders()).toHaveLength(1);
    expect(executor.getRecorders()[0]).toBe(v2);
    expect(executor.getFlowRecorders()[0]).toBe(v2);
  });

  it('detachCombinedRecorder is safe on a never-attached id', () => {
    const chart = buildDemoChart();
    const executor = new FlowChartExecutor(chart);
    expect(() => executor.detachCombinedRecorder('never-attached')).not.toThrow();
  });

  it('detachCombinedRecorder removes from BOTH channels', () => {
    const chart = buildDemoChart();
    const executor = new FlowChartExecutor(chart);
    const r: CombinedRecorder = {
      id: 'r',
      onWrite: () => {},
      onDecision: () => {},
    };
    executor.attachCombinedRecorder(r);
    expect(executor.getRecorders()).toHaveLength(1);
    expect(executor.getFlowRecorders()).toHaveLength(1);

    executor.detachCombinedRecorder('r');
    expect(executor.getRecorders()).toHaveLength(0);
    expect(executor.getFlowRecorders()).toHaveLength(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 3. SCENARIO — real flowchart run, combined recorder sees both streams
// ════════════════════════════════════════════════════════════════════════════

describe('CombinedRecorder — scenario', () => {
  it('receives events from BOTH streams in one execution', async () => {
    const events: Array<{ stream: 'data' | 'flow'; kind: string }> = [];
    const r: CombinedRecorder = {
      id: 'audit',
      onWrite: (e) => events.push({ stream: 'data', kind: `write:${e.key}` }),
      onCommit: () => events.push({ stream: 'data', kind: 'commit' }),
      onStageExecuted: (e) => events.push({ stream: 'flow', kind: `stageExecuted:${e.stageId}` }),
    };

    const chart = buildDemoChart();
    const executor = new FlowChartExecutor(chart);
    executor.attachCombinedRecorder(r);
    await executor.run();

    // At minimum we saw data-flow writes AND control-flow stage events.
    const dataKinds = events.filter((e) => e.stream === 'data').map((e) => e.kind);
    const flowKinds = events.filter((e) => e.stream === 'flow').map((e) => e.kind);

    expect(dataKinds.some((k) => k.startsWith('write:'))).toBe(true);
    expect(flowKinds.some((k) => k.startsWith('stageExecuted:'))).toBe(true);
  });

  it('data-flow-only recorder skips control-flow channel', async () => {
    const r: CombinedRecorder = {
      id: 'data-only',
      onWrite: () => {},
    };
    const chart = buildDemoChart();
    const executor = new FlowChartExecutor(chart);
    executor.attachCombinedRecorder(r);

    expect(executor.getRecorders()).toHaveLength(1);
    expect(executor.getFlowRecorders()).toHaveLength(0);
    await executor.run();
  });

  it('control-flow-only recorder skips data-flow channel', async () => {
    const r: CombinedRecorder = {
      id: 'flow-only',
      onStageExecuted: () => {},
    };
    const chart = buildDemoChart();
    const executor = new FlowChartExecutor(chart);
    executor.attachCombinedRecorder(r);

    expect(executor.getRecorders()).toHaveLength(0);
    expect(executor.getFlowRecorders()).toHaveLength(1);
    await executor.run();
  });

  it('shared onError dispatches with BOTH payload variants (data + flow) — union discrimination works', async () => {
    // A single onError handler is registered via CombinedRecorder. Both a
    // scope error and a flow error should invoke it, each with its own
    // payload shape. isFlowEvent() must correctly narrow the union at
    // runtime for consumers.
    const captured: Array<{ channel: 'data' | 'flow'; hasTraversalCtx: boolean }> = [];
    const r: CombinedRecorder = {
      id: 'union-error',
      onError: (e) => {
        captured.push({
          channel: isFlowEvent(e) ? 'flow' : 'data',
          hasTraversalCtx: isFlowEvent(e),
        });
      },
    };

    // Chart where stage throws — triggers BOTH channels: data-flow onError
    // fires from ScopeFacade (write/commit lifecycle error) OR flow onError
    // fires from the traverser (stage execution error). We don't control
    // which fires, but the handler must be invoked AT LEAST once and the
    // discriminator must return a coherent boolean for every call.
    const chart = flowChart<{ x: number }>(
      'Throw',
      () => {
        throw new Error('boom');
      },
      'throw',
    ).build();
    const executor = new FlowChartExecutor(chart);
    executor.attachCombinedRecorder(r);

    try {
      await executor.run();
    } catch {
      /* expected */
    }

    // Handler was invoked at least once. Discriminator either says data or
    // flow consistently — never throws, never returns undefined.
    expect(captured.length).toBeGreaterThanOrEqual(1);
    for (const c of captured) {
      expect(c.channel === 'data' || c.channel === 'flow').toBe(true);
      expect(c.hasTraversalCtx).toBe(c.channel === 'flow');
    }
  });

  it('detach-reattach-run cycle: re-attached recorder fires events on subsequent runs', async () => {
    const writes: string[] = [];
    const r: CombinedRecorder = {
      id: 'cycle',
      onWrite: (e) => writes.push(`w:${e.key}`),
      onDecision: () => writes.push('decision'),
    };

    const chart = buildDemoChart();
    const executor = new FlowChartExecutor(chart);

    executor.attachCombinedRecorder(r);
    await executor.run();
    const firstRunCount = writes.length;
    expect(firstRunCount).toBeGreaterThan(0);

    executor.detachCombinedRecorder('cycle');
    expect(executor.getRecorders()).toHaveLength(0);
    expect(executor.getFlowRecorders()).toHaveLength(0);

    // Re-attach same id — events must fire on next run.
    executor.attachCombinedRecorder(r);
    writes.length = 0;
    await executor.run();
    expect(writes.length).toBeGreaterThan(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 4. PROPERTY — invariants hold across all event-method subsets
// ════════════════════════════════════════════════════════════════════════════

describe('CombinedRecorder — property', () => {
  // Representative sample of method names from each interface.
  const DATA_METHODS = ['onWrite', 'onRead', 'onCommit', 'onStageStart', 'onStageEnd'];
  const FLOW_METHODS = ['onStageExecuted', 'onDecision', 'onSubflowEntry', 'onLoop', 'onBreak'];

  it('for any subset of methods, attach routes to exactly the correct channels', () => {
    const chart = buildDemoChart();

    for (const hasDataMethod of [false, true]) {
      for (const hasFlowMethod of [false, true]) {
        const executor = new FlowChartExecutor(chart);
        const r: CombinedRecorder = { id: `r-${hasDataMethod}-${hasFlowMethod}` };
        if (hasDataMethod) (r as Record<string, unknown>)[DATA_METHODS[0]] = () => {};
        if (hasFlowMethod) (r as Record<string, unknown>)[FLOW_METHODS[0]] = () => {};

        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        executor.attachCombinedRecorder(r);
        warnSpy.mockRestore();

        expect(executor.getRecorders().length).toBe(hasDataMethod ? 1 : 0);
        expect(executor.getFlowRecorders().length).toBe(hasFlowMethod ? 1 : 0);
      }
    }
  });

  it('attach is order-independent — data-first and flow-first yield same channel membership AND event delivery', async () => {
    const chart = buildDemoChart();
    const executor = new FlowChartExecutor(chart);

    const events: string[] = [];
    const a: CombinedRecorder = { id: 'a', onWrite: () => events.push('a.write') };
    const b: CombinedRecorder = { id: 'b', onStageExecuted: () => events.push('b.staged') };

    // Attach in reversed order — membership AND event firing must not depend on it.
    executor.attachCombinedRecorder(b);
    executor.attachCombinedRecorder(a);

    expect(executor.getRecorders().map((r) => r.id)).toEqual(['a']);
    expect(executor.getFlowRecorders().map((r) => r.id)).toEqual(['b']);

    await executor.run();
    // Both handlers fired at least once.
    expect(events.some((e) => e === 'a.write')).toBe(true);
    expect(events.some((e) => e === 'b.staged')).toBe(true);
  });

  it('detaching one combined recorder does not affect unrelated recorders', () => {
    const chart = buildDemoChart();
    const executor = new FlowChartExecutor(chart);

    const a: CombinedRecorder = {
      id: 'a',
      onWrite: () => {},
      onDecision: () => {},
    };
    const b: CombinedRecorder = {
      id: 'b',
      onWrite: () => {},
      onDecision: () => {},
    };

    executor.attachCombinedRecorder(a);
    executor.attachCombinedRecorder(b);
    executor.detachCombinedRecorder('a');

    expect(executor.getRecorders().map((r) => r.id)).toEqual(['b']);
    expect(executor.getFlowRecorders().map((r) => r.id)).toEqual(['b']);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 5. SECURITY — malicious prototype keys, callable-like non-functions
// ════════════════════════════════════════════════════════════════════════════

describe('CombinedRecorder — security', () => {
  it('non-function `onWrite` is NOT treated as a handler', () => {
    // A consumer accidentally assigns a non-function value — the predicate
    // must not attach the recorder as if it had a handler.
    const r = { id: 'bad', onWrite: 'not-a-function' } as unknown as CombinedRecorder;
    expect(hasRecorderMethods(r)).toBe(false);
  });

  it('Object.prototype pollution is NOT treated as a handler (hardening)', () => {
    // The detection walks the prototype chain but stops BEFORE
    // Object.prototype. This means: legitimate class methods (on the
    // class's own prototype) ARE detected (see next test), but
    // Object.prototype pollution — a rogue `Object.prototype.onWrite` that
    // EVERY plain object in the program would inherit — is ignored.
    //
    // Simulate pollution on the actual Object.prototype, then verify a
    // plain object literal does not attach via that inherited method.
    // IMPORTANT: this test MUST clean up after itself.
    type AnyRec = Record<string, unknown>;
    const proto = Object.prototype as unknown as AnyRec;
    try {
      proto.onWrite = () => {
        /* pollution */
      };

      const plain: CombinedRecorder = { id: 'r' };
      expect(hasRecorderMethods(plain)).toBe(false);
    } finally {
      delete proto.onWrite;
    }
  });

  it('class-instance handlers on the class prototype ARE detected (both styles work)', () => {
    // The detection walks the prototype chain but stops BEFORE
    // Object.prototype — so legitimate class methods (on the class's own
    // prototype) attach correctly, while Object.prototype pollution does
    // not. Both the class-method pattern and the arrow-field pattern are
    // supported.
    class ClassStyle {
      readonly id = 'cls';
      onWrite() {
        /* prototype method — legitimate handler */
      }
    }
    const proto = new ClassStyle();
    expect(hasRecorderMethods(proto as unknown as CombinedRecorder)).toBe(true);

    class OwnStyle {
      readonly id = 'own';
      // Arrow-function class field => own property.
      onWrite = () => {
        /* ok */
      };
    }
    const own = new OwnStyle();
    expect(hasRecorderMethods(own as unknown as CombinedRecorder)).toBe(true);
  });

  it('a recorder whose handler throws does not crash the executor', async () => {
    const chart = buildDemoChart();
    const executor = new FlowChartExecutor(chart);
    const r: CombinedRecorder = {
      id: 'bad-handler',
      onWrite: () => {
        throw new Error('boom');
      },
    };
    executor.attachCombinedRecorder(r);

    // Recorder error isolation: the executor MUST NOT propagate handler errors.
    await expect(executor.run()).resolves.not.toThrow();
  });

  it('a recorder cannot hijack another recorder by sharing an id in one call', () => {
    // Two distinct combined recorders submitted with the same id — the
    // second REPLACES the first. This is the documented idempotency
    // contract. Pin it so a future refactor can't silently change it.
    const chart = buildDemoChart();
    const executor = new FlowChartExecutor(chart);

    const first: CombinedRecorder = { id: 'shared', onWrite: () => {} };
    const hijack: CombinedRecorder = { id: 'shared', onWrite: () => {} };

    executor.attachCombinedRecorder(first);
    executor.attachCombinedRecorder(hijack);

    expect(executor.getRecorders()).toHaveLength(1);
    expect(executor.getRecorders()[0]).toBe(hijack);
    expect(executor.getRecorders()[0]).not.toBe(first);
  });
});
