/**
 * 5-pattern tests for the Emit channel (Phase 3).
 *
 * Under test:
 *   - `scope.$emit(name, payload)` delivers events synchronously to every
 *     attached `EmitRecorder.onEmit`.
 *   - Events carry auto-enriched context: stageName, runtimeStageId,
 *     subflowPath, pipelineId, timestamp.
 *   - `RedactionPolicy.emitPatterns` scrubs payload before dispatch.
 *   - Legacy scope methods ($debug/$metric/$error) route through
 *     `$emit` as additive behaviour (backward compat preserved).
 *   - Fast-path: zero dispatch cost when no emit-recorder attached.
 *   - `attachCombinedRecorder` routes emit-only recorders correctly.
 *
 * Patterns: unit, boundary, scenario, property, security.
 */

import { describe, expect, it } from 'vitest';

import {
  type CombinedRecorder,
  type EmitEvent,
  type EmitRecorder,
  flowChart,
  FlowChartExecutor,
  hasEmitRecorderMethods,
} from '../../../src/index.js';

// ── Shared fixtures ────────────────────────────────────────────────────────

interface DemoState {
  value: number;
  result: string;
}

/** Single-stage chart that calls $emit during its execution. */
function chartEmits(name: string, payload: unknown) {
  return flowChart<DemoState>(
    'Emitter',
    (scope) => {
      scope.value = 1;
      scope.$emit(name, payload);
    },
    'emitter',
  ).build();
}

/** Collect every emit event the recorder sees (simple array-backed). */
function captureEmits(): { recorder: EmitRecorder; events: EmitEvent[] } {
  const events: EmitEvent[] = [];
  return {
    events,
    recorder: {
      id: 'capture',
      onEmit: (e) => {
        events.push(e);
      },
    },
  };
}

// ════════════════════════════════════════════════════════════════════════════
// 1. UNIT — predicate + basic dispatch
// ════════════════════════════════════════════════════════════════════════════

describe('Emit channel — unit', () => {
  it('hasEmitRecorderMethods detects onEmit on a recorder', () => {
    const r: CombinedRecorder = { id: 'r', onEmit: () => {} };
    expect(hasEmitRecorderMethods(r)).toBe(true);

    const empty: CombinedRecorder = { id: 'empty' };
    expect(hasEmitRecorderMethods(empty)).toBe(false);

    // Data-flow-only recorder: emit predicate returns false.
    const dataOnly: CombinedRecorder = { id: 'data', onWrite: () => {} };
    expect(hasEmitRecorderMethods(dataOnly)).toBe(false);
  });

  it('scope.$emit delivers to a single attached emit-recorder', async () => {
    const { recorder, events } = captureEmits();
    const chart = chartEmits('myapp.unit.test', { n: 42 });
    const executor = new FlowChartExecutor(chart);
    executor.attachEmitRecorder(recorder);

    await executor.run();

    expect(events).toHaveLength(1);
    expect(events[0].name).toBe('myapp.unit.test');
    expect(events[0].payload).toEqual({ n: 42 });
  });

  it('events carry all auto-enrichment fields', async () => {
    const { recorder, events } = captureEmits();
    const chart = chartEmits('myapp.enriched', 'hello');
    const executor = new FlowChartExecutor(chart);
    executor.attachEmitRecorder(recorder);
    await executor.run();

    const e = events[0];
    expect(e.stageName).toBe('Emitter');
    expect(typeof e.runtimeStageId).toBe('string');
    expect(e.runtimeStageId.length).toBeGreaterThan(0);
    expect(Array.isArray(e.subflowPath)).toBe(true);
    expect(e.subflowPath).toHaveLength(0); // root chart
    expect(typeof e.pipelineId).toBe('string');
    expect(typeof e.timestamp).toBe('number');
    expect(e.timestamp).toBeGreaterThan(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 2. BOUNDARY — no recorders, duplicate ids, no-payload, deep subflow
// ════════════════════════════════════════════════════════════════════════════

describe('Emit channel — boundary', () => {
  it('no attached recorder: $emit is a no-op, execution succeeds', async () => {
    const chart = chartEmits('myapp.noop', { x: 1 });
    const executor = new FlowChartExecutor(chart);
    // NO recorder attached — $emit must be safe (fast-path return)
    await expect(executor.run()).resolves.not.toThrow();
  });

  it('re-attach with same id replaces the previous recorder on the channel', async () => {
    const v1Events: EmitEvent[] = [];
    const v2Events: EmitEvent[] = [];
    const v1: EmitRecorder = { id: 'shared', onEmit: (e) => v1Events.push(e) };
    const v2: EmitRecorder = { id: 'shared', onEmit: (e) => v2Events.push(e) };

    const chart = chartEmits('myapp.replace', 'x');
    const executor = new FlowChartExecutor(chart);
    executor.attachEmitRecorder(v1);
    executor.attachEmitRecorder(v2); // REPLACES v1 (same id)

    await executor.run();

    expect(v1Events).toHaveLength(0);
    expect(v2Events).toHaveLength(1);
  });

  it('$emit without a payload (undefined) works; event.payload is undefined', async () => {
    const { recorder, events } = captureEmits();
    const chart = flowChart<DemoState>(
      'NoPayload',
      (scope) => {
        scope.value = 1;
        scope.$emit('myapp.nopayload');
      },
      'nopayload',
    ).build();

    const executor = new FlowChartExecutor(chart);
    executor.attachEmitRecorder(recorder);
    await executor.run();

    expect(events).toHaveLength(1);
    expect(events[0].payload).toBeUndefined();
  });

  it('subflow: emits from inside a subflow carry subflowPath', async () => {
    const inner = flowChart<{ v: number }>(
      'Inner',
      (scope) => {
        scope.v = 1;
        scope.$emit('myapp.inner.event', { nested: true });
      },
      'inner',
    ).build();

    const outer = flowChart<DemoState>(
      'Seed',
      (scope) => {
        scope.value = 0;
      },
      'seed',
    )
      .addSubFlowChartNext('sf-inner', inner, 'Nested', {
        inputMapper: () => ({}),
      })
      .build();

    const { recorder, events } = captureEmits();
    const executor = new FlowChartExecutor(outer);
    executor.attachEmitRecorder(recorder);
    await executor.run();

    const innerEmit = events.find((e) => e.name === 'myapp.inner.event');
    expect(innerEmit).toBeDefined();
    // subflowPath ends with 'sf-inner' for emits from within the subflow.
    expect(innerEmit!.subflowPath.length).toBeGreaterThanOrEqual(1);
    expect(innerEmit!.subflowPath[innerEmit!.subflowPath.length - 1]).toBe('sf-inner');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 3. SCENARIO — multiple events, ordering, legacy routing
// ════════════════════════════════════════════════════════════════════════════

describe('Emit channel — scenario', () => {
  it('multiple $emit calls deliver in call order, synchronously', async () => {
    const { recorder, events } = captureEmits();
    const chart = flowChart<DemoState>(
      'MultiEmit',
      (scope) => {
        scope.value = 0;
        scope.$emit('myapp.a', { n: 1 });
        scope.$emit('myapp.b', { n: 2 });
        scope.$emit('myapp.c', { n: 3 });
      },
      'multi-emit',
    ).build();

    const executor = new FlowChartExecutor(chart);
    executor.attachEmitRecorder(recorder);
    await executor.run();

    expect(events.map((e) => e.name)).toEqual(['myapp.a', 'myapp.b', 'myapp.c']);
    expect(events.map((e) => (e.payload as { n: number }).n)).toEqual([1, 2, 3]);
  });

  it('legacy $debug routes through emit — EmitRecorder sees it as log.debug.{key}', async () => {
    const { recorder, events } = captureEmits();
    const chart = flowChart<DemoState>(
      'LegacyDebug',
      (scope) => {
        scope.value = 0;
        scope.$debug('checkpoint', { step: 1 });
      },
      'legacy-debug',
    ).build();

    const executor = new FlowChartExecutor(chart);
    executor.attachEmitRecorder(recorder);
    await executor.run();

    const debugEvent = events.find((e) => e.name === 'log.debug.checkpoint');
    expect(debugEvent).toBeDefined();
    expect(debugEvent!.payload).toMatchObject({
      key: 'checkpoint',
      value: { step: 1 },
      level: 'debug',
    });
  });

  it('legacy $metric routes through emit — dispatched as metric.{name}', async () => {
    const { recorder, events } = captureEmits();
    const chart = flowChart<DemoState>(
      'LegacyMetric',
      (scope) => {
        scope.value = 0;
        scope.$metric('tokens', 1234);
      },
      'legacy-metric',
    ).build();

    const executor = new FlowChartExecutor(chart);
    executor.attachEmitRecorder(recorder);
    await executor.run();

    const metricEvent = events.find((e) => e.name === 'metric.tokens');
    expect(metricEvent).toBeDefined();
    expect(metricEvent!.payload).toMatchObject({ name: 'tokens', value: 1234 });
  });

  it('legacy $error also routes through the emit channel', async () => {
    const { recorder, events } = captureEmits();
    const chart = flowChart<DemoState>(
      'LegacyError',
      (scope) => {
        scope.value = 0;
        scope.$error('validation', { issue: 'bad input' });
      },
      'legacy-error',
    ).build();

    const executor = new FlowChartExecutor(chart);
    executor.attachEmitRecorder(recorder);
    await executor.run();

    expect(events.some((e) => e.name === 'log.error.validation')).toBe(true);
  });

  it('attachCombinedRecorder routes emit-only recorder correctly', async () => {
    const events: EmitEvent[] = [];
    const r: CombinedRecorder = {
      id: 'emit-only-combined',
      onEmit: (e) => events.push(e),
      // no Recorder or FlowRecorder methods
    };

    const chart = chartEmits('myapp.combined', 'test');
    const executor = new FlowChartExecutor(chart);
    executor.attachCombinedRecorder(r);
    await executor.run();

    expect(events).toHaveLength(1);
    expect(events[0].name).toBe('myapp.combined');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 4. PROPERTY — invariants across payload shapes + recorder counts
// ════════════════════════════════════════════════════════════════════════════

describe('Emit channel — property', () => {
  it('for any payload shape, event.payload is passed through unchanged', async () => {
    const cases: unknown[] = [
      undefined,
      null,
      0,
      '',
      'string',
      42,
      true,
      false,
      [],
      [1, 2, 3],
      { a: 1, b: { c: 2 } },
      new Date(0),
    ];

    for (const payload of cases) {
      const { recorder, events } = captureEmits();
      const chart = flowChart<DemoState>(
        'P',
        (scope) => {
          scope.value = 0;
          scope.$emit('myapp.prop', payload);
        },
        'p',
      ).build();
      const executor = new FlowChartExecutor(chart);
      executor.attachEmitRecorder(recorder);
      await executor.run();

      expect(events).toHaveLength(1);
      // Strict equality / deep equality depending on type
      if (typeof payload === 'object' && payload !== null) {
        expect(events[0].payload).toEqual(payload);
      } else {
        expect(events[0].payload).toBe(payload);
      }
    }
  });

  it('N distinct ids: every recorder receives every event exactly once', async () => {
    const events1: EmitEvent[] = [];
    const events2: EmitEvent[] = [];
    const events3: EmitEvent[] = [];
    const chart = chartEmits('myapp.multi', 'x');
    const executor = new FlowChartExecutor(chart);
    executor.attachEmitRecorder({ id: 'a', onEmit: (e) => events1.push(e) });
    executor.attachEmitRecorder({ id: 'b', onEmit: (e) => events2.push(e) });
    executor.attachEmitRecorder({ id: 'c', onEmit: (e) => events3.push(e) });

    await executor.run();

    expect(events1).toHaveLength(1);
    expect(events2).toHaveLength(1);
    expect(events3).toHaveLength(1);
  });

  it('idempotency by id: re-attach with same id does not double-fire', async () => {
    const events: EmitEvent[] = [];
    const chart = chartEmits('myapp.idempotent', 'x');
    const executor = new FlowChartExecutor(chart);
    // Attach 3 different function bodies, all with id 'same'.
    // Only the last one should be active.
    executor.attachEmitRecorder({ id: 'same', onEmit: (e) => events.push({ ...e, payload: 'v1' }) });
    executor.attachEmitRecorder({ id: 'same', onEmit: (e) => events.push({ ...e, payload: 'v2' }) });
    executor.attachEmitRecorder({ id: 'same', onEmit: (e) => events.push({ ...e, payload: 'v3' }) });

    await executor.run();

    expect(events).toHaveLength(1);
    expect(events[0].payload).toBe('v3');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 5. SECURITY — redaction + error isolation
// ════════════════════════════════════════════════════════════════════════════

describe('Emit channel — security', () => {
  it('RedactionPolicy.emitPatterns scrubs payload to [REDACTED]', async () => {
    const { recorder, events } = captureEmits();
    const chart = chartEmits('myapp.auth.login', { password: 'secret123', user: 'alice' });
    const executor = new FlowChartExecutor(chart);
    executor.attachEmitRecorder(recorder);
    executor.setRedactionPolicy({ emitPatterns: [/\.auth\./] });

    await executor.run();

    expect(events).toHaveLength(1);
    expect(events[0].name).toBe('myapp.auth.login');
    expect(events[0].payload).toBe('[REDACTED]');
  });

  it('non-matching pattern leaves payload untouched', async () => {
    const { recorder, events } = captureEmits();
    const chart = chartEmits('myapp.public.data', { value: 42 });
    const executor = new FlowChartExecutor(chart);
    executor.attachEmitRecorder(recorder);
    executor.setRedactionPolicy({ emitPatterns: [/\.auth\./] });

    await executor.run();

    expect(events[0].payload).toEqual({ value: 42 });
  });

  it('a throwing onEmit does not crash the executor (error isolation)', async () => {
    const goodEvents: EmitEvent[] = [];
    const chart = chartEmits('myapp.crash', 'x');
    const executor = new FlowChartExecutor(chart);
    executor.attachEmitRecorder({
      id: 'bad',
      onEmit: () => {
        throw new Error('recorder bomb');
      },
    });
    executor.attachEmitRecorder({ id: 'good', onEmit: (e) => goodEvents.push(e) });

    await expect(executor.run()).resolves.not.toThrow();
    // The "good" recorder still fired — the bad one's throw was isolated.
    expect(goodEvents).toHaveLength(1);
  });

  it('redaction does NOT mutate caller-side payload object', async () => {
    const { recorder, events } = captureEmits();
    const payload = { password: 'secret', user: 'alice' };
    const chart = flowChart<DemoState>(
      'P',
      (scope) => {
        scope.value = 0;
        scope.$emit('myapp.auth.login', payload);
      },
      'p',
    ).build();
    const executor = new FlowChartExecutor(chart);
    executor.attachEmitRecorder(recorder);
    executor.setRedactionPolicy({ emitPatterns: [/\.auth\./] });
    await executor.run();

    // Caller-side payload unchanged
    expect(payload.password).toBe('secret');
    // Recorder saw the redacted version
    expect(events[0].payload).toBe('[REDACTED]');
  });
});
