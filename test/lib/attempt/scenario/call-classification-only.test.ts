import { readStoredRecord } from 'foottrace';
import { memorySink } from 'foottrace/write';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CallOptions, FlowAttemptEvent } from '../../../../src/index.js';
import {
  flowChart,
  FlowChartExecutor,
  InputValidationError,
  stringifySnapshot,
  UnknownEffectError,
} from '../../../../src/index.js';
import { _resetRunIdStateForTesting } from '../../../../src/lib/runner/runId.js';
import { attempts } from '../../../../src/recorders.js';

const classificationOnly = { errorDetails: 'classification-only' } satisfies CallOptions;
const target = 'fixture.complete';
const silent = { info() {}, log() {}, debug() {}, error() {}, warn() {} };

function serverError(suffix: string) {
  const error = Object.assign(
    new Error('SYNTHETIC-message-' + suffix, {
      cause: new Error('SYNTHETIC-cause-' + suffix),
    }),
    {
      name: 'SYNTHETIC-name-' + suffix,
      code: 'SYNTHETIC-code-' + suffix,
      remoteRequestId: 'SYNTHETIC-error-request-' + suffix,
      status: 503,
      body: 'SYNTHETIC-body-' + suffix,
    },
  );
  error.stack = 'SYNTHETIC-stack-' + suffix;
  return error;
}

async function capturedCall(work: () => unknown, options?: CallOptions, escape = false) {
  _resetRunIdStateForTesting();
  const sink = memorySink();
  const events: FlowAttemptEvent[] = [];
  let entered = 0;
  let received: unknown;
  const chart = flowChart(
    'Synthetic provider',
    async (scope) => {
      try {
        received = await scope.$call(
          target,
          () => {
            entered++;
            expect(
              sink.entries.filter((entry) => entry.kind === 'note' && entry.note === 'attempt-start'),
            ).toHaveLength(1);
            return work();
          },
          undefined,
          options,
        );
      } catch (error) {
        received = error;
        if (escape) throw error;
      }
    },
    'provider',
  )
    .setLogger(silent)
    .build();
  const executor = new FlowChartExecutor(chart, { sink });
  executor.attachFlowRecorder({ id: 'call-events', onAttempt: (event) => events.push(event) });
  const metrics = attempts();
  // Pin this generated recorder ID along with the clock and run IDs for complete wire comparisons.
  Object.defineProperty(metrics, 'id', { value: 'call-metrics' });
  executor.attachFlowRecorder(metrics);
  const rejected = await executor.run().then(
    () => undefined,
    (error: unknown) => error,
  );
  const ordinary = executor.getSnapshot();
  const redacted = executor.getSnapshot({ redact: true });
  const rawEntries = JSON.stringify(sink.entries);
  const log = readStoredRecord(JSON.parse(rawEntries)).root(ordinary.runId);
  if (!log) throw new Error('Expected the recorded root log');
  const event = events[0];
  const saved = log.notes.find((note) => note.kind === 'attempt')?.data.record;
  expect(entered).toBe(1);
  expect(events).toHaveLength(1);
  expect(Object.isFrozen(event.record)).toBe(true);
  expect(saved).toEqual(event.record);
  expect(ordinary.executionTree.attempts).toEqual([event.record]);
  expect(redacted.executionTree.attempts).toEqual([event.record]);
  const wires = [JSON.stringify(events), rawEntries, stringifySnapshot(ordinary), stringifySnapshot(redacted)];
  return { event, log, received, rejected, wires };
}

afterEach(() => vi.restoreAllMocks());

describe('classified call publication', () => {
  it('omits authored error fields from both snapshot views, saved evidence and metrics', async () => {
    const error = serverError('private');
    const { event, received, wires } = await capturedCall(() => {
      throw error;
    }, classificationOnly);
    expect(received).toBe(error);
    expect(event.record).toMatchObject({ kind: 'call', target, outcome: 'failed', category: 'server' });
    expect(event.record).not.toHaveProperty('error');
    for (const wire of wires.slice(1)) expect(wire).not.toContain('SYNTHETIC-');
  });

  it('omits the live diagnostic property and preserves the original rejection by identity', async () => {
    const error = serverError('private');
    const { event, received } = await capturedCall(() => {
      throw error;
    }, classificationOnly);
    expect(received).toBe(error);
    expect(event).not.toHaveProperty('structuredError');
  });

  it('publishes equal bytes for distinct private failures with the same classification', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000);
    const errors = [serverError('a'), serverError('different-length-private-b')];
    const first = await capturedCall(() => {
      throw errors[0];
    }, classificationOnly);
    const second = await capturedCall(() => {
      throw errors[1];
    }, classificationOnly);
    expect(first.received).toBe(errors[0]);
    expect(second.received).toBe(errors[1]);
    expect(first.wires).toEqual(second.wires);
  });

  it('continues to publish legacy details by default', async () => {
    const error = serverError('legacy');
    const { event, wires } = await capturedCall(() => {
      throw error;
    });
    expect(event.record.error).toMatchObject({ name: error.name, code: error.code, message: error.message });
    expect(event.structuredError?.raw).toBe(error);
    expect(wires[1]).toContain(error.message);
  });

  it('keeps a real unknown classification and omits validation issues', async () => {
    const validation = new InputValidationError('SYNTHETIC-validation', [
      { path: ['SYNTHETIC-path'], message: 'SYNTHETIC-issue', code: 'SYNTHETIC-code' },
    ]);
    const cases = [
      { error: validation, category: 'permanent' },
      { error: 'SYNTHETIC-primitive', category: 'unknown' },
    ];
    for (const { error, category } of cases) {
      const { event, received, wires } = await capturedCall(() => {
        throw error;
      }, classificationOnly);
      expect(received).toBe(error);
      expect(event.record.category).toBe(category);
      expect(event.record).not.toHaveProperty('error');
      expect(event).not.toHaveProperty('structuredError');
      for (const wire of wires) expect(wire).not.toContain('SYNTHETIC-');
    }
  });

  it('keeps answer identity and independently authorized evidence', async () => {
    const answer = { status: 503, body: 'SYNTHETIC-response' };
    const observe = vi.fn(() => ({ remoteRequestId: 'authorized-answer' }));
    const { event, received, log, wires } = await capturedCall(() => answer, {
      ...classificationOnly,
      evidence: { inputRefs: ['authorized-input'], observe },
    });
    expect(received).toBe(answer);
    expect(observe).toHaveBeenCalledExactlyOnceWith(answer);
    expect(event.record.outcome).toBe('ok');
    expect(event.record).not.toHaveProperty('category');
    expect(event).not.toHaveProperty('structuredError');
    expect(log.notes.find((note) => note.kind === 'attempt-start')?.data).toMatchObject({
      inputRefs: ['authorized-input'],
    });
    expect(log.notes.find((note) => note.kind === 'attempt')?.data).toMatchObject({
      remoteRequestId: 'authorized-answer',
    });
    for (const wire of wires) expect(wire).not.toContain(answer.body);
  });

  it('keeps the existing escaped rejection and unknown-effect cause', async () => {
    const error = serverError('escape');
    const escaped = await capturedCall(
      () => {
        throw error;
      },
      classificationOnly,
      true,
    );
    expect(escaped.received).toBe(error);
    expect(escaped.rejected).toBe(error);
    expect(escaped.event.record).not.toHaveProperty('error');

    const touching = await capturedCall(
      () => {
        throw error;
      },
      { ...classificationOnly, touches: 'fixture' },
    );
    expect(touching.received).toBeInstanceOf(UnknownEffectError);
    expect((touching.received as Error).cause).toBe(error);
    expect(touching.event.record).toMatchObject({ effect: 'unknown', category: 'server' });
    expect(touching.event).not.toHaveProperty('structuredError');
  });
});
