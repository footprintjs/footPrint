/**
 * Failure listeners are an output boundary too (P6 security review after the P3 rebase).
 *
 * Threat model: a seeded state value or lifecycle meta selected by the run's policy must never escape through
 * `adapter.onFailure` when a sink throws or rejects. Foottrace reports its original entry; the engine must hand
 * the listener the SAME served entry the adapter saw, including when an asynchronous failure arrives after the
 * leg's rule changed. No retroactive scrub: later policy changes never rewrite the dispatched entry.
 *
 * Test types: Security (opened base / closed meta, throws / rejects), Boundary (delayed rejection after the rule
 * changes in either direction), Functional (one counted loss and a writer that keeps going).
 */
import type { RecordEntry, RecordSink } from 'foottrace/write';
import { EventLog } from 'foottrace/write';
import { describe, expect, it, vi } from 'vitest';

import {
  disableDevMode,
  enableDevMode,
  flowChart,
  FlowChartExecutor,
  RecordSinkError,
  UnknownEffectError,
} from '../../../../src/index.js';
import { RedactionRule } from '../../../../src/lib/memory/redaction.js';
import { RunRecord } from '../../../../src/lib/runner/recordSink.js';

const MARKER = 'SYNTHETIC-FAILURE-ENTRY-MARKER';
const address = { logRunId: 'failure-entry-test', drillPath: [] };

describe('failure listeners receive the dispatched served entry', () => {
  for (const kind of ['opened', 'closed'] as const) {
    it.each(['throw', 'reject'] as const)(
      `${kind}: a %s never exposes selected values through onFailure`,
      async (how) => {
        let dispatched: unknown;
        let reported: RecordEntry | undefined;
        const adapter: RecordSink = {
          opened() {},
          commit() {},
          note() {},
          closed() {},
          [kind](entry: unknown) {
            dispatched = entry;
            if (how === 'throw') throw new Error('synthetic sink failure');
            return Promise.reject(new Error('synthetic sink failure'));
          },
          onFailure: ({ entry }) => {
            reported = entry;
          },
        };
        const record = new RunRecord({ adapter, onFailure: 'report', flush: 'auto' });
        record.useRule(new RedactionRule({ keys: ['token'] }));
        const log = new EventLog({ token: MARKER }, { sink: record.sink, address });
        if (kind === 'closed') log.close('ok', { token: MARKER });
        await Promise.resolve();
        await Promise.resolve();
        expect(JSON.stringify(dispatched)).not.toContain(MARKER);
        expect(JSON.stringify(reported)).not.toContain(MARKER);
        expect(reported).toEqual({ ...(dispatched as object), kind });
        expect(record.stats().failed).toBe(1);
        expect(log.length).toBe(0); // the writer remains usable; a failed sink is never the writer's error
      },
    );

    it.each([false, true])(
      `${kind}: a delayed failure preserves the rule at dispatch (initially masked: %s)`,
      async (masked) => {
        let rejectPending: ((error: Error) => void) | undefined;
        let dispatched: unknown;
        let reported: RecordEntry | undefined;
        const adapter: RecordSink = {
          opened() {},
          commit() {},
          note() {},
          closed() {},
          [kind](entry: unknown) {
            dispatched = entry;
            return new Promise<void>((_resolve, reject) => {
              rejectPending = reject;
            });
          },
          onFailure: ({ entry }) => {
            reported = entry;
          },
        };
        const record = new RunRecord({ adapter, onFailure: 'report', flush: 'auto' });
        record.useRule(masked ? new RedactionRule({ keys: ['token'] }) : undefined);
        const log = new EventLog({ token: MARKER }, { sink: record.sink, address });
        if (kind === 'closed') log.close('ok', { token: MARKER });
        record.useRule(masked ? undefined : new RedactionRule({ keys: ['token'] }));
        rejectPending?.(new Error('delayed synthetic sink failure'));
        await Promise.resolve();
        await Promise.resolve();
        expect(JSON.stringify(dispatched).includes(MARKER)).toBe(!masked);
        expect(reported).toEqual({ ...(dispatched as object), kind });
        expect(record.stats().failed).toBe(1);
      },
    );
  }

  it('a refusal before dispatch is counted without handing the adapter an unserved payload', () => {
    const reported: RecordEntry[] = [];
    const adapter: RecordSink = {
      opened() {},
      commit() {},
      note() {},
      closed() {},
      onFailure: ({ entry }) => reported.push(entry),
    };
    const record = new RunRecord({ adapter, onFailure: 'fail', flush: 'auto' });
    record.useRule(new RedactionRule({ keys: ['token'] }));
    const error = new Error('synthetic entry could not be admitted');
    record.sink.onFailure?.({ entry: { kind: 'opened', address, at: 0, initialState: { token: MARKER } }, error });
    expect(reported).toEqual([]); // no dispatched served entry exists; do not invent a stored empty base
    expect(record.stats().failed).toBe(1);
    expect(record.fatal?.cause).toBe(error);
    expect(record.stopSignal?.aborted).toBe(true);
  });

  it.each(['report', 'fail'] as const)(
    '%s: diagnostic selectors mask sink errors on every observer surface',
    (mode) => {
      let reported: unknown;
      const error = new Error(MARKER);
      const adapter: RecordSink = {
        opened() {
          throw error;
        },
        commit() {},
        note() {},
        closed() {},
        onFailure: (failure) => {
          reported = failure;
        },
      };
      const record = new RunRecord({ adapter, onFailure: mode, flush: 'auto' });
      record.useRule(new RedactionRule({ diagnostics: { patterns: [/^errors\./] } }));
      new EventLog({}, { sink: record.sink, address });
      expect(JSON.stringify(record.stats())).not.toContain(MARKER);
      expect(JSON.stringify(reported)).not.toContain(MARKER);
      expect(record.stats().failed).toBe(1);
      if (mode === 'fail') {
        expect(record.fatal?.message).not.toContain(MARKER);
        expect(record.fatal?.cause).toBe(error); // only the calling code's exception retains the real cause
      }
    },
  );

  it('an asynchronous sink error uses the dispatching leg rule after the current rule changes', async () => {
    let rejectPending: ((error: Error) => void) | undefined;
    let reported: unknown;
    const adapter: RecordSink = {
      opened: () => new Promise<void>((_resolve, reject) => (rejectPending = reject)),
      commit() {},
      note() {},
      closed() {},
      onFailure: (failure) => {
        reported = failure;
      },
    };
    const record = new RunRecord({ adapter, onFailure: 'fail', flush: 'auto' });
    record.useRule(new RedactionRule({ diagnostics: { keys: ['errors.recordSinkError'] } }));
    new EventLog({}, { sink: record.sink, address });
    record.useRule(undefined);
    rejectPending?.(new Error(MARKER));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(record.stats().failed).toBe(1);
    expect(JSON.stringify(record.stats())).not.toContain(MARKER);
    expect(JSON.stringify(reported)).not.toContain(MARKER);
    expect(record.fatal?.message).not.toContain(MARKER);
  });

  it('a selected sink error never reaches the development warning', () => {
    enableDevMode();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const adapter: RecordSink = {
        opened() {
          throw new Error(MARKER);
        },
        commit() {},
        note() {},
        closed() {},
      };
      const record = new RunRecord({ adapter, onFailure: 'report', flush: 'auto' });
      record.useRule(new RedactionRule({ diagnostics: { patterns: [/^errors\./] } }));
      new EventLog({}, { sink: record.sink, address });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(warn.mock.calls)).not.toContain(MARKER);
    } finally {
      warn.mockRestore();
      disableDevMode();
    }
  });

  it('a mark made while an invocation is pending protects the error when it is first seen', async () => {
    let rejectPending: ((error: Error) => void) | undefined;
    let reported: unknown;
    const adapter: RecordSink = {
      opened: () => new Promise<void>((_resolve, reject) => (rejectPending = reject)),
      commit() {},
      note() {},
      closed() {},
      onFailure: (failure) => {
        reported = failure;
      },
    };
    const record = new RunRecord({ adapter, onFailure: 'report', flush: 'auto' });
    const rule = new RedactionRule();
    record.useRule(rule);
    new EventLog({}, { sink: record.sink, address });
    rule.mark('recordSinkError');
    rejectPending?.(new Error(MARKER));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(record.stats().failed).toBe(1);
    expect(JSON.stringify(record.stats())).not.toContain(MARKER);
    expect(JSON.stringify(reported)).not.toContain(MARKER);
  });

  it('a fatal sink wrapper keeps its raw cause only for the caller, never for run-failure observers', async () => {
    const cause = new Error(MARKER);
    const adapter: RecordSink = {
      opened() {},
      commit() {
        throw cause;
      },
      note() {},
      closed() {},
    };
    const chart = flowChart('Write', (scope) => scope.$setValue('n', 1), 'write')
      .addFunction('After', () => undefined, 'after')
      .build();
    const executor = new FlowChartExecutor(chart, { sink: { adapter, onFailure: 'fail' } });
    executor.setRedactionPolicy({ diagnostics: { keys: ['errors.recordSinkError'] } });
    let observed: { raw?: unknown; message: string } | undefined;
    executor.attachFlowRecorder({
      id: 'safe-failure-listener',
      onRunFailed: (event) => {
        observed = event.structuredError;
      },
    });
    const failure = await executor.run().then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(RecordSinkError);
    expect((failure as RecordSinkError).cause).toBe(cause);
    expect(observed).toBeDefined();
    expect(observed?.raw).toBeUndefined(); // JSON.stringify alone cannot see an Error's non-enumerable message
    expect(observed?.message).not.toContain(MARKER);
  });

  it('a touching stage inherits masking through an unknown-effect wrapper while the caller keeps both causes', async () => {
    const cause = new Error(MARKER);
    let rejectPending: ((error: Error) => void) | undefined;
    const adapter: RecordSink = {
      opened: () => new Promise<void>((_resolve, reject) => (rejectPending = reject)),
      commit() {},
      note() {},
      closed() {},
    };
    const chart = flowChart(
      'Change outside state',
      () => {
        rejectPending?.(cause);
        return new Promise<void>(() => {});
      },
      'change',
      { touches: { system: 'mock-provider', idempotencyKey: () => 'synthetic-operation' } },
    ).build();
    const executor = new FlowChartExecutor(chart, { sink: { adapter, onFailure: 'fail' } });
    executor.setRedactionPolicy({ diagnostics: { keys: ['errors.recordSinkError'] } });
    let observed: { raw?: unknown; message: string } | undefined;
    executor.attachFlowRecorder({
      id: 'safe-touching-failure-listener',
      onRunFailed: (event) => {
        observed = event.structuredError;
      },
    });
    const failure = await executor.run().then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(UnknownEffectError);
    expect((failure as UnknownEffectError).cause).toBeInstanceOf(RecordSinkError);
    expect(((failure as UnknownEffectError).cause as RecordSinkError).cause).toBe(cause);
    expect(observed).toBeDefined();
    expect(observed?.raw).toBeUndefined();
    expect(observed?.message).not.toContain(MARKER);
  });
});
