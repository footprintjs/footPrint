import { afterEach, describe, expect, it, vi } from 'vitest';

import { CompositeRecorder, disableDevMode, enableDevMode, flowChart, FlowChartExecutor } from '../../../src/index.js';
import { narrative } from '../../../src/recorders.js';
import { BoundaryStateStore, InOutRecorder, KeyedStore, QualityRecorder } from '../../../src/trace.js';

afterEach(() => {
  disableDevMode();
  vi.restoreAllMocks();
});

describe('public recorder queries and lifecycle', () => {
  it('filters and removes keyed entries without reordering the retained keys', () => {
    const store = new KeyedStore<number>();
    store.set('first', 1);
    store.set('second', 2);
    store.set('third', 3);
    store.set('first', 10);
    expect(store.has('first')).toBe(true);
    expect(store.has('absent')).toBe(false);
    expect(store.filterByKeys(new Set(['third', 'first', 'absent']))).toEqual([10, 3]);
    expect(store.delete('second')).toBe(true);
    expect(store.delete('second')).toBe(false);
    expect(store.values()).toEqual([10, 3]);
    expect(store.accumulate((total, value) => total + value, 0)).toBe(13);
  });

  it('rate-limits missing-boundary warnings by key and resets them on clear', () => {
    enableDevMode();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const update = vi.fn((n: number) => n + 1);
    const store = new BoundaryStateStore<number>('stream');
    for (let i = 0; i < 101; i++) store.update('missing', update);
    expect(update).not.toHaveBeenCalled();
    expect(warn.mock.calls.map(([message]) => message)).toEqual([
      "[stream] update('missing') — no active boundary. Update dropped.",
      "[stream] update('missing') — 10 dropped updates. Wiring bug?",
      "[stream] update('missing') — 100 dropped updates. Wiring bug?",
    ]);
    store.update('other', update);
    expect(warn).toHaveBeenCalledTimes(4);
    store.clear();
    store.update('missing', update);
    expect(warn).toHaveBeenCalledTimes(5);
    expect(store.getAll().size).toBe(0);
  });

  it('warns on overwritten and leaked boundaries with bounded diagnostics, but still clears all state', () => {
    enableDevMode();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = new BoundaryStateStore<number>('stream');
    store.start('first', 1);
    store.start('first', 2);
    expect(store.get('first')).toBe(2);
    expect(warn).toHaveBeenLastCalledWith(expect.stringContaining('likely a missed stop'));
    store.clear();
    expect(warn).toHaveBeenLastCalledWith(expect.stringContaining('Leaked keys: first'));
    for (let i = 0; i < 12; i++) store.start(`step-${i}`, i);
    expect([...store.getAll().keys()]).toHaveLength(12);
    store.clear();
    expect(warn).toHaveBeenLastCalledWith(expect.stringContaining('step-9 ...(+2 more)'));
    expect(store.hasActive).toBe(false);
    disableDevMode();
    store.start('quiet', 1);
    store.start('quiet', 2);
    store.update('missing', () => 0);
    store.clear();
    expect(warn).toHaveBeenCalledTimes(3);
  });

  it('quality queries agree with the recorded steps and the visible-key selection', async () => {
    const quality = new QualityRecorder((_id, event) => ({ score: event.stageName === 'first' ? 0.4 : 0.8 }));
    const chart = flowChart<{ answer: number }>(
      'first',
      (scope) => {
        scope.answer = 1;
      },
      'first',
    )
      .addFunction(
        'second',
        (scope) => {
          scope.answer = 2;
        },
        'second',
      )
      .build();
    await chart.recorder(quality).run();
    const entries = [...quality.getMap()];
    expect(entries.map(([, entry]) => entry.score)).toEqual([0.4, 0.8]);
    expect(quality.values()).toEqual(entries.map(([, entry]) => entry));
    expect(quality.aggregate((sum, entry) => sum + entry.score, 0)).toBeCloseTo(1.2);
    expect(quality.accumulate((sum, entry) => sum + entry.score, 0, new Set([entries[0][0]]))).toBe(0.4);
    expect(quality.accumulate((sum, entry) => sum + entry.score, 0)).toBeCloseTo(1.2);
  });

  it('narrative reductions follow the captured entries and preserve the selected visit boundary', async () => {
    const recorder = narrative();
    const chart = flowChart<{ answer: number }>(
      'first',
      (scope) => {
        scope.answer = 1;
      },
      'first',
    )
      .addFunction(
        'second',
        (scope) => {
          scope.answer = 2;
        },
        'second',
      )
      .build();
    await chart.recorder(recorder).run();
    const entries = recorder.getEntries();
    expect(recorder.entryCount).toBe(entries.length);
    expect(recorder.aggregate((lines, entry) => [...lines, entry.text], [] as string[])).toEqual(
      entries.map((entry) => entry.text),
    );
    const key = entries[0].runtimeStageId;
    expect(key).toBeTruthy();
    expect(recorder.accumulate((count) => count + 1, 0, new Set([key!]))).toBe(
      entries.filter((entry) => entry.runtimeStageId === key).length,
    );
    expect(recorder.accumulate((count) => count + 1, 0)).toBe(entries.length);
  });

  it('composite child lookup preserves recorder identity, and boundary ranges select exactly the recorded entries', async () => {
    const boundaries = new InOutRecorder();
    const quality = new QualityRecorder(() => ({ score: 1 }));
    const composite = new CompositeRecorder('combined', [boundaries, quality]);
    expect(composite.get(QualityRecorder)).toBe(quality);
    expect(composite.get(InOutRecorder)).toBe(boundaries);
    expect(composite.get(KeyedStore)).toBeUndefined();
    const child = flowChart('child', () => {}, 'child').build();
    const chart = flowChart('root', () => {}, 'root')
      .addSubFlowChart('nested', child, 'nested')
      .build();
    await chart.recorder(composite).run();
    const all = boundaries.getBoundaries();
    const nested = boundaries.getSteps().find((step) => !step.isRoot)!;
    expect(nested).toBeDefined();
    const selected = boundaries.getEntriesUpTo(new Set([nested.runtimeStageId]));
    expect(selected).toEqual(all.filter((entry) => entry.runtimeStageId === nested.runtimeStageId));
    expect(selected.map((entry) => entry.phase)).toEqual(['entry', 'exit']);
    const range = boundaries.getEntryRanges().get(nested.runtimeStageId)!;
    expect(all.slice(range.firstIdx, range.endIdx)).toEqual(selected);
    composite.clear();
    expect(boundaries.getEntryRanges().size).toBe(0);
    expect(quality.size).toBe(0);
  });

  it('emit-recorder listing is defensive and detaching removes only the matching observer in either tier', async () => {
    const chart = flowChart(
      'emitter',
      (scope) => {
        scope.$emit('result', 42);
      },
      'emitter',
    ).build();
    const executor = new FlowChartExecutor(chart);
    const inline = { id: 'inline', onEmit: vi.fn() };
    const deferred = { id: 'deferred', onEmit: vi.fn() };
    const scopeOnly = { id: 'scope-only', onWrite: vi.fn() };
    executor.attachEmitRecorder(inline);
    executor.attachEmitRecorder(deferred, { delivery: 'deferred' });
    executor.attachScopeRecorder(scopeOnly);
    const listed = executor.getEmitRecorders();
    expect(listed).toEqual([inline, deferred]);
    listed.splice(0);
    expect(executor.getEmitRecorders()).toEqual([inline, deferred]);
    executor.detachEmitRecorder('inline');
    executor.detachEmitRecorder('never-attached');
    await executor.run();
    expect(inline.onEmit).not.toHaveBeenCalled();
    expect(deferred.onEmit).toHaveBeenCalledOnce();
    executor.detachEmitRecorder('deferred');
    expect(executor.getEmitRecorders()).toEqual([]);
    expect(executor.getScopeRecorders()).toEqual([scopeOnly]);
  });

  it('stage-local scope observer methods attach, expose and detach the same recorder', async () => {
    const onWrite = vi.fn();
    const observer = { id: 'stage-local', onWrite };
    const chart = flowChart<{ answer: number }>(
      'local',
      (scope) => {
        scope.$attachScopeRecorder(observer);
        expect(scope.$getScopeRecorders()).toContain(observer);
        scope.answer = 1;
        scope.$detachScopeRecorder(observer.id);
        expect(scope.$getScopeRecorders()).not.toContain(observer);
        scope.answer = 2;
      },
      'local',
    ).build();
    await chart.run();
    expect(onWrite).toHaveBeenCalledOnce();
    expect(onWrite).toHaveBeenCalledWith(expect.objectContaining({ key: 'answer', value: 1 }));
  });

  it('a rejected async stage removes the abort listener while preserving its original error', async () => {
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    const error = new Error('stage rejected');
    const next = vi.fn();
    const chart = flowChart(
      'reject',
      async () => {
        throw error;
      },
      'reject',
    )
      .addFunction('never', next, 'never')
      .build();
    const executor = new FlowChartExecutor(chart);
    await expect(executor.run({ signal: controller.signal })).rejects.toBe(error);
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
    expect(next).not.toHaveBeenCalled();
  });
});
