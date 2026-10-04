/** Narrative readback owns its view; independent recorders must not displace it. */
import { describe, expect, it } from 'vitest';

import { flowChart, FlowChartExecutor, narrative } from '../../../../src/index.js';
import { CombinedNarrativeRecorder } from '../../../../src/lib/engine/narrative/CombinedNarrativeRecorder.js';

function chart() {
  return flowChart<{ value: number }>(
    'Seed',
    (scope) => {
      scope.value = 7;
    },
    'seed',
  )
    .addFunction(
      'Read',
      (scope) => {
        scope.$emit('seen', scope.value);
      },
      'read',
    )
    .build();
}

function pausingChart() {
  return flowChart<{ value: number }>(
    'Seed',
    (scope) => {
      scope.value = 7;
    },
    'seed',
  )
    .addPausableFunction(
      'Gate',
      {
        execute: async () => ({ question: 'Continue?' }),
        resume: async (scope) => {
          scope.value = 8;
        },
      },
      'gate',
    )
    .addFunction(
      'Read',
      (scope) => {
        scope.$emit('seen', scope.value);
      },
      'read',
    )
    .build();
}

describe('narrative readback — independent identities', () => {
  it.each(['inline', 'deferred'] as const)(
    'retains full read/write/emit entries with %s attachment',
    async (delivery) => {
      const trace = narrative();
      const executor = new FlowChartExecutor(chart());
      executor.attachCombinedRecorder(trace, { delivery });
      await executor.run();

      const entries = executor.getNarrativeEntries();
      expect(entries).toEqual(trace.getEntries());
      expect(entries.map((entry) => entry.type)).toEqual(['stage', 'step', 'stage', 'step', 'emit']);
      expect(entries.filter((entry) => entry.type === 'step').map((entry) => entry.key)).toEqual(['value', 'value']);
      // The executor's internal view stays out of the explicitly attached recorder rows.
      expect(executor.getSnapshot().recorders?.map((recorder) => recorder.id)).toEqual([trace.id]);
    },
  );

  it('gives independently created default narrators distinct IDs and snapshots', async () => {
    const first = narrative();
    const second = narrative();
    expect(first.id).not.toBe(second.id);
    const executor = new FlowChartExecutor(chart());
    executor.attachCombinedRecorder(first);
    executor.attachCombinedRecorder(second);
    await executor.run();

    expect(first.getEntries()).toEqual(executor.getNarrativeEntries());
    expect(second.getEntries()).toEqual(first.getEntries());
    expect(first.getEntries()).toHaveLength(5);
    expect(executor.getScopeRecorders()).toEqual([first, second]);
    expect(executor.getFlowRecorders()).toEqual([first, second]);
    expect(executor.getSnapshot().recorders?.map((recorder) => recorder.id)).toEqual([first.id, second.id]);
  });

  it('keeps reattaching one instance idempotent', async () => {
    const trace = narrative();
    const executor = new FlowChartExecutor(chart());
    executor.attachCombinedRecorder(trace);
    executor.attachCombinedRecorder(trace);
    await executor.run();
    expect(trace.getEntries()).toHaveLength(5);
    expect(executor.getNarrativeEntries()).toEqual(trace.getEntries());
    expect(executor.getScopeRecorders()).toEqual([trace]);
    expect(executor.getFlowRecorders()).toEqual([trace]);
  });

  it('still replaces explicitly matching user IDs', async () => {
    const first = new CombinedNarrativeRecorder({ id: 'same-view' });
    const replacement = new CombinedNarrativeRecorder({ id: first.id });
    const executor = new FlowChartExecutor(chart());
    executor.attachCombinedRecorder(first);
    executor.attachCombinedRecorder(replacement);
    await executor.run();
    expect(first.getEntries()).toEqual([]);
    expect(replacement.getEntries()).toEqual(executor.getNarrativeEntries());
    expect(replacement.getEntries()).toHaveLength(5);
    expect(executor.getSnapshot().recorders?.map((recorder) => recorder.id)).toEqual([replacement.id]);
  });

  it('detaches only the requested instance and can reattach it', async () => {
    const first = narrative();
    const second = narrative();
    const executor = new FlowChartExecutor(chart());
    executor.attachCombinedRecorder(first);
    executor.attachCombinedRecorder(second);
    executor.detachCombinedRecorder(first.id);
    await executor.run();
    expect(first.getEntries()).toEqual([]);
    expect(second.getEntries()).toHaveLength(5);
    expect(executor.getNarrativeEntries()).toEqual(second.getEntries());
    executor.attachCombinedRecorder(first);
    await executor.run();
    expect(first.getEntries()).toEqual(second.getEntries());
    expect(first.getEntries()).toHaveLength(5);
  });

  it.each(['inline', 'deferred'] as const)('swaps from %s delivery without duplicate callbacks', async (delivery) => {
    const trace = narrative();
    const executor = new FlowChartExecutor(chart());
    executor.attachCombinedRecorder(trace, { delivery });
    executor.attachCombinedRecorder(trace, { delivery: delivery === 'inline' ? 'deferred' : 'inline' });
    await executor.run();
    expect(trace.getEntries()).toHaveLength(5);
    expect(executor.getNarrativeEntries()).toEqual(trace.getEntries());
    expect(executor.getScopeRecorders()).toEqual([trace]);
    expect(executor.getFlowRecorders()).toEqual([trace]);
  });

  it('keeps the executor renderer independent from attached views', async () => {
    const first = narrative({ renderer: { renderOp: (op) => `first:${op.key}` } });
    const second = narrative({ renderer: { renderOp: (op) => `second:${op.key}` } });
    const executor = new FlowChartExecutor(chart());
    executor.enableNarrative({ renderer: { renderOp: (op) => `executor:${op.key}` } });
    executor.attachCombinedRecorder(first);
    executor.attachCombinedRecorder(second);
    await executor.run();
    const steps = (entries: ReturnType<typeof first.getEntries>) =>
      entries.filter((entry) => entry.type === 'step').map((entry) => entry.text);
    expect(steps(executor.getNarrativeEntries())).toEqual(['executor:value', 'executor:value']);
    expect(steps(first.getEntries())).toEqual(['first:value', 'first:value']);
    expect(steps(second.getEntries())).toEqual(['second:value', 'second:value']);
  });

  it('clears a fresh run instead of accumulating or duplicating prior entries', async () => {
    const trace = narrative();
    const executor = new FlowChartExecutor(chart());
    executor.attachCombinedRecorder(trace);
    await executor.run();
    const before = trace.getEntries();
    await executor.run();
    expect(trace.getEntries()).toEqual(before);
    expect(executor.getNarrativeEntries()).toEqual(before);
  });
});

describe('narrative readback — lifecycle boundaries', () => {
  it.each(['inline', 'deferred'] as const)(
    'accumulates once across same-executor resume with %s delivery',
    async (delivery) => {
      const trace = narrative();
      const executor = new FlowChartExecutor(pausingChart());
      executor.attachCombinedRecorder(trace, { delivery });
      await executor.run();
      const paused = trace.getEntries();
      expect(executor.getNarrativeEntries()).toEqual(paused);
      await executor.resume(executor.getCheckpoint()!, {});
      const entries = trace.getEntries();
      expect(executor.getNarrativeEntries()).toEqual(entries);
      expect(entries.slice(0, paused.length)).toEqual(paused);
      expect(entries.filter((entry) => entry.type === 'pause')).toHaveLength(1);
      expect(entries.filter((entry) => entry.type === 'resume')).toHaveLength(1);
      expect(entries.some((entry) => entry.type === 'step' && entry.text.includes('8'))).toBe(true);
    },
  );

  it.each(['inline', 'deferred', 'built-in'] as const)(
    'initializes %s narrative for a fresh-executor resume without inventing history',
    async (delivery) => {
      const flow = pausingChart();
      const original = new FlowChartExecutor(flow);
      await original.run();
      const trace = narrative();
      const resumed = new FlowChartExecutor(flow);
      if (delivery === 'built-in') resumed.enableNarrative();
      else resumed.attachCombinedRecorder(trace, { delivery });
      await resumed.resume(original.getCheckpoint()!, {});
      const entries = resumed.getNarrativeEntries();
      if (delivery !== 'built-in') expect(entries).toEqual(trace.getEntries());
      expect(entries.filter((entry) => entry.type === 'resume')).toHaveLength(1);
      expect(entries.filter((entry) => entry.type === 'pause')).toHaveLength(0);
      expect(entries.some((entry) => entry.stageId === 'seed')).toBe(false);
      expect(entries.some((entry) => entry.type === 'step' && entry.text.includes('8'))).toBe(true);
      expect(entries.filter((entry) => entry.type === 'emit')).toHaveLength(1);
    },
  );

  it.each(['inline', 'deferred'] as const)('flushes the %s error narrative before rejection', async (delivery) => {
    const trace = narrative();
    const broken = flowChart<{ value: number }>(
      'Seed',
      (scope) => {
        scope.value = 7;
      },
      'seed',
    )
      .addFunction(
        'Read',
        (scope) => {
          scope.$emit('seen', scope.value);
        },
        'read',
      )
      .addFunction(
        'Fail',
        () => {
          throw new Error('planned');
        },
        'fail',
      )
      .build();
    const executor = new FlowChartExecutor(broken);
    executor.attachCombinedRecorder(trace, { delivery });
    await expect(executor.run()).rejects.toThrow('planned');
    expect(executor.getNarrativeEntries()).toEqual(trace.getEntries());
    expect(trace.getEntries().filter((entry) => entry.type === 'error')).toHaveLength(1);
    expect(trace.getEntries().filter((entry) => entry.type === 'step')).toHaveLength(2);
  });

  it('does not turn narration on without opt-in or expose the built-in as an attached snapshot row', async () => {
    const executor = new FlowChartExecutor(chart());
    await executor.run();
    expect(executor.getNarrativeEntries()).toEqual([]);
    executor.enableNarrative();
    await executor.run();
    expect(executor.getNarrativeEntries()).toHaveLength(5);
    expect(executor.getSnapshot().recorders ?? []).toEqual([]);
  });
});

describe('narrative readback — subflows and redaction', () => {
  it.each(['inline', 'deferred'] as const)(
    'preserves %s subflow boundaries and scrubs both views',
    async (delivery) => {
      const inner = flowChart<{ secret: string; output: number }>(
        'Inner',
        (scope) => {
          scope.output = scope.secret.length;
        },
        'inner',
      ).build();
      const flow = flowChart<{ secret: string; output: number }>(
        'Seed',
        (scope) => {
          scope.secret = 'do-not-record';
        },
        'seed',
      )
        .addSubFlowChartNext('sf', inner, 'Subflow', {
          inputMapper: (scope) => ({ secret: scope.secret }),
          outputMapper: (scope) => ({ output: scope.output }),
        })
        .build();
      const trace = narrative();
      const executor = new FlowChartExecutor(flow);
      executor.setRedactionPolicy({ keys: ['secret'] });
      executor.attachCombinedRecorder(trace, { delivery });
      await executor.run();
      const entries = executor.getNarrativeEntries();
      expect(entries).toEqual(trace.getEntries());
      expect(entries.filter((entry) => entry.type === 'subflow').map((entry) => entry.direction)).toEqual([
        'entry',
        'exit',
      ]);
      expect(entries.some((entry) => entry.type === 'step' && entry.key === 'secret')).toBe(true);
      expect(JSON.stringify(entries)).not.toContain('do-not-record');
      expect(JSON.stringify(executor.getSnapshot().recorders)).not.toContain('do-not-record');
    },
  );
});
