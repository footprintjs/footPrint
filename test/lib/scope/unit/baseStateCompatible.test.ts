import { EventLog, SharedMemory } from 'foottrace/write';
import { describe, expect, it } from 'vitest';

import { flowChart, FlowChartExecutor } from '../../../../src/index.js';
import { StageContext } from '../../../../src/lib/memory/index.js';
import { attachScopeMethods } from '../../../../src/lib/scope/providers/baseStateCompatible.js';

function makeCtx(initial: Record<string, unknown> = {}, runId = 'run-1') {
  return new StageContext(runId, 'stage1', 'stage1', new SharedMemory(undefined, initial), '', new EventLog(initial));
}

describe('attachScopeMethods — one real facade behind the convenience methods', () => {
  it('attaches the public conveniences without replacing the target or its own data', () => {
    const target = { existing: true };
    const result = attachScopeMethods(target, makeCtx(), 'stage1');
    expect(result).toBe(target);
    expect(result.existing).toBe(true);
    for (const name of [
      'addDebugInfo',
      'addDebugMessage',
      'addErrorInfo',
      'addMetric',
      'addEval',
      'getInitialValueFor',
      'getValue',
      'setValue',
      'updateValue',
      'setObjectInRoot',
      'getArgs',
      'getEnv',
      'getPipelineId',
      'emitEvent',
    ])
      expect(typeof (result as any)[name]).toBe('function');
  });

  it('retains debug info in the real diagnostic bag', () => {
    const ctx = makeCtx();
    attachScopeMethods({}, ctx, 'stage1').addDebugInfo('key1', 'val1');
    expect(ctx.getSnapshot().logs).toEqual({ key1: 'val1' });
  });

  it('appends debug messages in order', () => {
    const ctx = makeCtx();
    const scope = attachScopeMethods({}, ctx, 'stage1');
    scope.addDebugMessage('hello');
    scope.addDebugMessage('again');
    expect(ctx.getSnapshot().logs).toEqual({ messages: ['hello', 'again'] });
  });

  it('retains errors in the real error bag', () => {
    const ctx = makeCtx();
    attachScopeMethods({}, ctx, 'stage1').addErrorInfo('err-key', 'err-val');
    expect(ctx.getSnapshot().errors).toEqual({ 'err-key': 'err-val' });
  });

  it('records metrics in metrics, not a metric-prefixed log', () => {
    const ctx = makeCtx();
    attachScopeMethods({}, ctx, 'stage1').addMetric('latency', 42);
    expect(ctx.getSnapshot().metrics).toEqual({ latency: 42 });
    expect(ctx.getSnapshot().logs).toEqual({});
  });

  it('records evaluations in evals, not an eval-prefixed log', () => {
    const ctx = makeCtx();
    attachScopeMethods({}, ctx, 'stage1').addEval('accuracy', 0.95);
    expect(ctx.getSnapshot().evals).toEqual({ accuracy: 0.95 });
    expect(ctx.getSnapshot().logs).toEqual({});
  });

  it('reads initial global values from the real shared memory', () => {
    const scope = attachScopeMethods({}, makeCtx({ initial: 'initial-val' }), 'stage1');
    expect(scope.getInitialValueFor('initial')).toBe('initial-val');
    expect(scope.getInitialValueFor('absent')).toBeUndefined();
  });

  it('tracks real keyed reads', () => {
    const ctx = makeCtx({ myKey: 'value' });
    const scope = attachScopeMethods({}, ctx, 'stage1');
    expect(scope.getValue('myKey')).toBe('value');
    expect(ctx.getSnapshot().stageReads).toEqual({ myKey: 'value' });
  });

  it('redacts retained writes while keeping real values available to the stage', () => {
    const ctx = makeCtx();
    const scope = attachScopeMethods({}, ctx, 'stage1');
    scope.setValue('secret', 'value', true, 'description');
    ctx.commit();
    expect(ctx.getValue([], 'secret')).toBe('value');
    expect(ctx.getSnapshot().stageWrites).toEqual({ secret: '[REDACTED]' });
    expect(ctx.getSnapshot().logs).toEqual({ message: '[WRITE] description' });
  });

  it('keeps unmarked writes clear by default', () => {
    const ctx = makeCtx();
    const scope = attachScopeMethods({}, ctx, 'stage1');
    scope.setValue('key', 'value');
    ctx.commit();
    expect(ctx.getValue([], 'key')).toBe('value');
    expect(ctx.getSnapshot().stageWrites).toEqual({ key: 'value' });
  });

  it('updates through the real merge path', () => {
    const ctx = makeCtx();
    const scope = attachScopeMethods({}, ctx, 'stage1');
    scope.setValue('key', { original: 1 });
    scope.updateValue('key', { added: 2 }, 'merged');
    ctx.commit();
    expect(ctx.getValue([], 'key')).toEqual({ original: 1, added: 2 });
    expect(ctx.getSnapshot().logs).toEqual({ message: 'merged' });
  });

  it('stages and commits setObjectInRoot through the context', () => {
    const ctx = makeCtx();
    const scope = attachScopeMethods({}, ctx, 'stage1');
    scope.setObjectInRoot('rootKey', { data: 1 });
    ctx.commit();
    expect(ctx.getRoot('rootKey')).toEqual({ data: 1 });
  });

  it('uses the real context run ID for the pipeline ID', () => {
    const ctx = makeCtx({}, 'pipeline-1');
    expect(attachScopeMethods({}, ctx, 'stage1').getPipelineId()).toBe(ctx.runId);
  });

  it('binds extracted methods to their own facade, not the caller or another scope', () => {
    const first = attachScopeMethods({}, makeCtx({}, 'first'), 'stage1');
    const second = attachScopeMethods({}, makeCtx({}, 'second'), 'stage1');
    const { getPipelineId, setValue, getValue } = first;
    setValue('key', 'first-only');
    expect(getPipelineId()).toBe('first');
    expect(getValue('key')).toBe('first-only');
    expect(second.getValue('key')).toBeUndefined();
  });

  it('integrates args, environment, emits and one read/write/commit observer through the executor', async () => {
    const reads: unknown[] = [];
    const writes: unknown[] = [];
    const commits: unknown[] = [];
    const emits: string[] = [];
    const chart = flowChart<any>(
      'Run',
      (scope) => {
        expect(scope.custom).toBe('kept');
        expect(scope.getArgs()).toEqual({ amount: 4 });
        expect(scope.getEnv().traceId).toBe('helper-trace');
        expect(Object.isFrozen(scope.getEnv())).toBe(true);
        scope.setValue('answer', 5);
        expect(scope.getValue('answer')).toBe(5);
        scope.addDebugInfo('source', 'helper');
        scope.addMetric('latency', 1);
        scope.addEval('quality', 0.9);
        scope.emitEvent('result', { answer: 5 });
      },
      'run',
    ).build();
    const executor = new FlowChartExecutor(chart, {
      scopeFactory: (ctx, name, args, env) => attachScopeMethods({ custom: 'kept' }, ctx, name, args, env),
    });
    executor.attachCombinedRecorder({
      id: 'helper',
      onRead: (event) => {
        reads.push({ key: event.key, value: event.value });
      },
      onWrite: (event) => {
        writes.push({ key: event.key, value: event.value });
      },
      onCommit: (event) => {
        commits.push(event.mutations);
      },
      onEmit: (event) => {
        emits.push(event.name);
      },
    });
    await executor.run({ input: { amount: 4 }, env: { traceId: 'helper-trace' } });
    expect(reads).toEqual([{ key: 'answer', value: 5 }]);
    expect(writes).toEqual([{ key: 'answer', value: 5 }]);
    expect(commits).toEqual([[{ key: 'answer', value: 5, operation: 'set' }]]);
    expect(emits).toEqual(['log.debug.source', 'metric.latency', 'eval.quality', 'result']);
    expect(executor.getSnapshot().commitLog[0].untrackedSources).toEqual(['args', 'env']);
  });

  it('does not leave helper writes silently usable after commit', () => {
    const ctx = makeCtx();
    const scope = attachScopeMethods({}, ctx, 'stage1');
    scope.setValue('key', 1);
    ctx.commit();
    expect(() => scope.setValue('key', 2)).toThrow(/already committed/);
    expect(() => scope.updateValue('key', 2)).toThrow(/already committed/);
    expect(() => scope.setObjectInRoot('key', 2)).toThrow(/already committed/);
  });
});
