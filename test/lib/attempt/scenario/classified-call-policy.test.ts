import { memorySink } from 'foottrace/write';
import { expect, it } from 'vitest';

import type { CallOptions, FlowAttemptEvent } from '../../../../src/index.js';
import { flowChart, FlowChartExecutor, interrupt } from '../../../../src/index.js';

const classificationOnly = { errorDetails: 'classification-only' } satisfies CallOptions;
const target = 'fixture.complete';
const silent = { info() {}, log() {}, debug() {}, error() {}, warn() {} };

it.each([undefined, classificationOnly])('preserves policy memory with options %j', async (options) => {
  const first = Object.assign(new Error('synthetic first'), { privateEvidence: 'SYNTHETIC-selected' });
  const wrapper = new Error('safe wrapper', { cause: first });
  const fresh = new Error('safe fresh');
  const events: FlowAttemptEvent[] = [];
  const chart = flowChart(
    'Caller keeps the original rejection',
    async (scope) => {
      await expect(
        scope.$call(
          target,
          () => {
            throw first;
          },
          undefined,
          options,
        ),
      ).rejects.toBe(first);
      // Only the earlier retention decision can mask the later diagnostic with the same child.
      delete (first as Partial<typeof first>).privateEvidence;
      await expect(
        scope.$call(target, () => {
          throw wrapper;
        }),
      ).rejects.toBe(wrapper);
      await expect(
        scope.$call(target, () => {
          throw fresh;
        }),
      ).rejects.toBe(fresh);
    },
    'caller',
  ).build();
  const executor = new FlowChartExecutor(chart);
  executor.setRedactionPolicy({ keys: ['privateEvidence'] });
  executor.attachFlowRecorder({ id: 'attempts', onAttempt: (event) => events.push(event) });
  await executor.run();
  expect(events).toHaveLength(3);
  const [initial, later, control] = events;
  if (options) {
    expect(initial.record).not.toHaveProperty('error');
    expect(initial).not.toHaveProperty('structuredError');
  } else {
    expect(initial.structuredError).toBeDefined();
    expect(initial.structuredError?.raw).toBeUndefined();
  }
  expect(later.structuredError).toBeDefined();
  expect(later.structuredError?.raw).toBeUndefined();
  expect(control.structuredError?.raw).toBe(fresh);
});

it('refuses an invalid publication choice before entry and leaves the first ordinal available', async () => {
  const sink = memorySink();
  let entries = 0;
  const chart = flowChart(
    'Admit before invoking',
    async (scope) => {
      expect(() =>
        scope.$call(target, () => entries++, undefined, { errorDetails: 'unsupported' } as unknown as CallOptions),
      ).toThrow("errorDetails must be 'classification-only'");
      await scope.$call(target, () => entries++, undefined, classificationOnly);
    },
    'refuse',
  ).build();
  const executor = new FlowChartExecutor(chart, { sink });
  await executor.run();
  expect(entries).toBe(1);
  const starts = sink.entries.filter((entry) => entry.kind === 'note' && entry.note === 'attempt-start');
  expect(starts).toHaveLength(1);
  expect(starts[0]).toMatchObject({ data: { series: 'refuse#0@1.1', attempt: 1 } });
});

it('preserves the in-flight cancellation and refuses another call and late settlement', async () => {
  const controller = new AbortController();
  const reason = new Error('SYNTHETIC-cancel');
  const sink = memorySink();
  const events: FlowAttemptEvent[] = [];
  let late: (() => void) | undefined;
  let signalEntry = () => {};
  const entered = new Promise<void>((resolve) => {
    signalEntry = resolve;
  });
  let called = 0;
  const chart = flowChart(
    'Await business call',
    async (scope) => {
      await expect(
        scope.$call(
          target,
          () => {
            called++;
            return new Promise<void>((resolve) => {
              late = resolve;
              signalEntry();
            });
          },
          undefined,
          classificationOnly,
        ),
      ).rejects.toBe(reason);
      await expect(scope.$call(target, () => called++, undefined, classificationOnly)).rejects.toBe(reason);
    },
    'cut',
  )
    .setLogger(silent)
    .build();
  const executor = new FlowChartExecutor(chart, { sink });
  executor.attachFlowRecorder({ id: 'attempts', onAttempt: (event) => events.push(event) });
  const result = executor.run({ signal: controller.signal }).catch((error: unknown) => error);
  await entered;
  controller.abort(reason);
  expect(await result).toBe(reason);
  late?.();
  await Promise.resolve();
  expect(called).toBe(1);
  expect(sink.entries.filter((entry) => entry.kind === 'note' && entry.note === 'attempt-start')).toHaveLength(1);
  expect(events).toHaveLength(1);
  expect(events[0].record).toMatchObject({ kind: 'call', outcome: 'aborted' });
  expect(events[0].record).not.toHaveProperty('error');
  expect(events[0]).not.toHaveProperty('structuredError');
});

it('preserves native retry order and pause control flow', async () => {
  const events: FlowAttemptEvent[] = [];
  const calls: number[] = [];
  const retryInputs: unknown[] = [];
  const failure = Object.assign(new Error('synthetic transient error'), { status: 503 });
  const chart = flowChart(
    'Retry and pause',
    async (scope) => {
      await scope.$call(
        target,
        (attempt) => {
          calls.push(attempt.attempt);
          if (attempt.attempt === 1) throw failure;
          return interrupt(scope, { reason: 'synthetic checkpoint' });
        },
        {
          attempts: 2,
          retryOn: (error) => {
            retryInputs.push(error);
            return true;
          },
        },
        classificationOnly,
      );
    },
    'checkpoint',
  ).build();
  const executor = new FlowChartExecutor(chart);
  executor.attachFlowRecorder({ id: 'attempts', onAttempt: (event) => events.push(event) });
  const result = await executor.run();
  expect(result).toMatchObject({ paused: true });
  expect(calls).toEqual([1, 2]);
  expect(retryInputs).toEqual([failure]);
  expect(retryInputs[0]).toBe(failure);
  expect(events.map(({ record }) => [record.outcome, record.category, record.next])).toEqual([
    ['failed', 'server', 'retry'],
    ['paused', undefined, 'stop'],
  ]);
  for (const event of events) {
    expect(event).not.toHaveProperty('structuredError');
    expect(event.record).not.toHaveProperty('error');
  }
});

it('keeps pause available after refusing invalid options for a keyless touching call', async () => {
  const sink = memorySink();
  let entered = 0;
  const chart = flowChart(
    'Refuse then pause',
    async (scope) => {
      expect(() =>
        scope.$call(target, () => entered++, undefined, {
          touches: 'fixture',
          errorDetails: 'unsupported',
        } as unknown as CallOptions),
      ).toThrow(TypeError);
      return interrupt(scope, { reason: 'synthetic checkpoint' });
    },
    'refuse-then-pause',
  )
    .setLogger(silent)
    .build();
  const executor = new FlowChartExecutor(chart, { sink });
  expect(await executor.run()).toMatchObject({ paused: true });
  expect(entered).toBe(0);
  expect(sink.entries.filter((entry) => entry.kind === 'note' && entry.note === 'attempt-start')).toHaveLength(0);
});

it('still refuses a pause after an entered keyless touching call', async () => {
  const sink = memorySink();
  let entered = 0;
  const chart = flowChart(
    'Touch then pause',
    async (scope) => {
      await scope.$call(target, () => entered++, undefined, { ...classificationOnly, touches: 'fixture' });
      return interrupt(scope, { reason: 'synthetic checkpoint' });
    },
    'touch-then-pause',
  )
    .setLogger(silent)
    .build();
  const executor = new FlowChartExecutor(chart, { sink });
  await expect(executor.run()).rejects.toThrow('made a touching $call');
  expect(entered).toBe(1);
  expect(sink.entries.filter((entry) => entry.kind === 'note' && entry.note === 'attempt-start')).toHaveLength(1);
});
