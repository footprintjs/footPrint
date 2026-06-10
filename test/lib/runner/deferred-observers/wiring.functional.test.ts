/**
 * RFC-001 Block 7 — FUNCTIONAL tests for the wired dispatch sites.
 *
 * Happy path on all three channels: a deferred recorder receives the same
 * events an inline recorder receives (one beat behind), in seq order, with
 * payloads materialized per the capture policy; the built-in narrative is
 * unchanged by a deferred observer's presence.
 */
import { describe, expect, it } from 'vitest';

import type { EmitEvent, WriteEvent } from '../../../../src/index';
import { flowChart, FlowChartExecutor } from '../../../../src/index';

type Loose = Record<string, unknown>;

function twoStageChart() {
  return flowChart<Loose>(
    'Seed',
    async (scope) => {
      scope.$setValue('greeting', 'hello');
      scope.$emit('app.seeded', { ok: true });
    },
    'seed',
  )
    .addFunction(
      'Work',
      async (scope) => {
        const g = scope.$getValue('greeting');
        scope.$setValue('echo', `${g}-back`);
      },
      'work',
    )
    .build();
}

describe('Block 7 — dispatch-site wiring (functional)', () => {
  it("scope channel: deferred 'clone' delivery carries the SAME event shape as inline", async () => {
    // Inline twin
    const inlineEvents: Array<{ method: string; key?: string; value?: unknown }> = [];
    const inlineExec = new FlowChartExecutor(twoStageChart());
    inlineExec.attachScopeRecorder({
      id: 'twin',
      onWrite: (e) => inlineEvents.push({ method: 'onWrite', key: e.key, value: e.value }),
      onRead: (e) => inlineEvents.push({ method: 'onRead', key: e.key, value: e.value }),
    });
    await inlineExec.run();

    // Deferred twin — 'clone' materialization preserves the event structure.
    const deferredEvents: Array<{ method: string; key?: string; value?: unknown }> = [];
    const deferredExec = new FlowChartExecutor(twoStageChart());
    deferredExec.attachScopeRecorder(
      {
        id: 'twin',
        onWrite: (e: WriteEvent) => deferredEvents.push({ method: 'onWrite', key: e.key, value: e.value }),
        onRead: (e) => deferredEvents.push({ method: 'onRead', key: e.key, value: e.value }),
      },
      { delivery: 'deferred', capture: 'clone' },
    );
    await deferredExec.run();

    expect(deferredEvents).toEqual(inlineEvents);
  });

  it('emit channel: deferred onEmit receives enriched emit events', async () => {
    const names: string[] = [];
    let enriched: EmitEvent | undefined;
    const executor = new FlowChartExecutor(twoStageChart());
    executor.attachEmitRecorder(
      {
        id: 'emit-meter',
        onEmit: (e: EmitEvent) => {
          names.push(e.name);
          if (e.name === 'app.seeded') enriched = e;
        },
      },
      { delivery: 'deferred', capture: 'clone' },
    );
    await executor.run();
    expect(names).toContain('app.seeded');
    expect(enriched?.stageName).toBe('Seed');
    expect(enriched?.runtimeStageId).toBe('seed#0');
    expect(enriched?.payload).toEqual({ ok: true });
  });

  it('flow channel: deferred FlowRecorder receives control-flow events with traversalContext', async () => {
    const executed: Array<{ stageName: string; runtimeStageId?: string }> = [];
    const executor = new FlowChartExecutor(twoStageChart());
    executor.attachFlowRecorder(
      {
        id: 'flow-watch',
        onStageExecuted: (e) =>
          executed.push({ stageName: e.stageName, runtimeStageId: e.traversalContext?.runtimeStageId }),
      },
      { delivery: 'deferred', capture: 'clone' },
    );
    await executor.run();
    expect(executed.map((e) => e.stageName)).toEqual(['Seed', 'Work']);
    expect(executed[0].runtimeStageId).toBe('seed#0');
  });

  it('the built-in narrative is unchanged by a deferred observer (inline vs deferred presence)', async () => {
    const bare = new FlowChartExecutor(twoStageChart());
    bare.enableNarrative();
    await bare.run();
    const baseline = bare.getNarrativeEntries().map((e) => e.text);

    const withDeferred = new FlowChartExecutor(twoStageChart());
    withDeferred.enableNarrative();
    withDeferred.attachScopeRecorder(
      { id: 'shadow', onWrite: () => undefined, onRead: () => undefined },
      { delivery: 'deferred' },
    );
    await withDeferred.run();
    expect(withDeferred.getNarrativeEntries().map((e) => e.text)).toEqual(baseline);
  });

  it("default capture policy is 'clone': hooks receive the SAME event shape as inline (drop-in port)", async () => {
    // Review CRITICAL-2: the attach-surface default must keep existing
    // recorder code (e.key/e.value reads) working unchanged.
    const payloads: unknown[] = [];
    const executor = new FlowChartExecutor(twoStageChart());
    executor.attachScopeRecorder(
      { id: 'cloned', onWrite: (e) => payloads.push(e) },
      { delivery: 'deferred' }, // capture defaults to 'clone'
    );
    await executor.run();
    expect(payloads.length).toBeGreaterThan(0);
    for (const p of payloads) {
      const event = p as { __payloadSummary?: boolean; key?: string; runtimeStageId?: string };
      expect(event.__payloadSummary).toBeUndefined();
      expect(typeof event.key).toBe('string'); // domain fields intact
      expect(typeof event.runtimeStageId).toBe('string');
    }
  });

  it("explicit capture: 'summary' delivers a bounded PayloadSummary, never the live event", async () => {
    const payloads: unknown[] = [];
    const executor = new FlowChartExecutor(twoStageChart());
    executor.attachScopeRecorder(
      { id: 'summarized', onWrite: (e) => payloads.push(e) },
      { delivery: 'deferred', capture: 'summary' },
    );
    await executor.run();
    expect(payloads.length).toBeGreaterThan(0);
    for (const p of payloads) {
      expect((p as { __payloadSummary?: boolean }).__payloadSummary).toBe(true);
    }
  });

  it('per-listener delivery preserves arrival order across channels (one merged queue)', async () => {
    const order: string[] = [];
    const executor = new FlowChartExecutor(twoStageChart());
    executor.attachCombinedRecorder(
      {
        id: 'order-watch',
        onWrite: (e) => order.push(`write:${(e as WriteEvent).key}`),
        onStageExecuted: (e) => order.push(`executed:${e.stageName}`),
      },
      { delivery: 'deferred', capture: 'clone' },
    );
    await executor.run();
    // Scope events of a stage arrive BEFORE that stage's flow event —
    // the same relative order the inline tier observes (Event Ordering doc).
    expect(order.indexOf('write:greeting')).toBeLessThan(order.indexOf('executed:Seed'));
    expect(order.indexOf('executed:Seed')).toBeLessThan(order.indexOf('write:echo'));
    expect(order.indexOf('write:echo')).toBeLessThan(order.indexOf('executed:Work'));
  });

  it('async deferred listeners settle via executor.drainObservers({ timeoutMs })', async () => {
    let settled = 0;
    const executor = new FlowChartExecutor(twoStageChart());
    executor.attachScopeRecorder(
      {
        id: 'async-listener',
        onWrite: async () => {
          await new Promise((resolve) => setTimeout(resolve, 5));
          settled += 1;
        },
      },
      { delivery: 'deferred' },
    );
    await executor.run();
    const result = await executor.drainObservers({ timeoutMs: 2_000 });
    expect(result.pending).toBe(0);
    expect(settled).toBeGreaterThan(0);
  });

  it('drainObservers resolves with zeros when nobody ever opted in', async () => {
    const executor = new FlowChartExecutor(twoStageChart());
    await executor.run();
    await expect(executor.drainObservers()).resolves.toEqual({ done: 0, failed: 0, pending: 0 });
  });
});
