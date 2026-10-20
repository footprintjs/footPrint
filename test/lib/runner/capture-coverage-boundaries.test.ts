/** #111 — boundary/security/property cases. Scripted local stages only, zero model calls. */
import { readStoredRecord } from 'foottrace';
import { memorySink } from 'foottrace/write';
import { describe, expect, it } from 'vitest';

import { registerScopeRuntime } from '../../../src/advanced.js';
import { flowChart, FlowChartExecutor, getSubtreeSnapshot } from '../../../src/index.js';
import { controlDepRecorder } from '../../../src/trace.js';

const options = { captureCoverage: true };
const plain = () => flowChart('Empty', () => undefined, 'empty').build();

describe('capture evidence boundaries', () => {
  it('does not read acknowledgements or add bundle fields without opting in', async () => {
    const ex = new FlowChartExecutor(plain());
    const ctrl = controlDepRecorder();
    ex.attachFlowRecorder(ctrl);
    await ex.run();
    expect(ex.getSnapshot().recorders?.[0]).not.toHaveProperty('capture');
    expect(ex.getSnapshot()).not.toHaveProperty('capture');
  });

  it('invalid settings are refused before execution', () => {
    expect(() => new FlowChartExecutor(plain(), { captureCoverage: 'yes' as unknown as boolean })).toThrow(
      'captureCoverage must be a boolean',
    );
  });

  it('records an actual cancellation, without treating concurrent unrelated failure as cancellation', async () => {
    for (const ownReason of [true, false]) {
      const controller = new AbortController();
      const reason = new Error('PRIVATE_CANCEL');
      const other = new Error('PRIVATE_OTHER');
      const ex = new FlowChartExecutor(
        flowChart(
          'Abort',
          () => {
            controller.abort(reason);
            throw ownReason ? reason : other;
          },
          'abort',
        ).build(),
        options,
      );
      await expect(ex.run({ signal: controller.signal })).rejects.toBe(ownReason ? reason : other);
      expect(ex.getSnapshot().capture!.boundary.status).toBe(ownReason ? 'cancelled' : 'failed');
      expect(JSON.stringify(ex.getSnapshot().capture)).not.toMatch(/PRIVATE/);
    }
  });

  it('never attests data-only custom scopes from configured dials', async () => {
    const ex = new FlowChartExecutor(plain(), {
      ...options,
      scopeFactory: () => registerScopeRuntime({}, { target: {}, handlesAssignments: true }),
    });
    await ex.run();
    expect(ex.getSnapshot().capture!.channels).toMatchObject({
      reads: 'unknown',
      writes: 'unknown',
      attention: 'unknown',
    });
    expect(ex.getSnapshot().capture!.limitations).toContain('custom-scope');
  });

  it('marks failed read retention even when the stage catches it', async () => {
    const ex = new FlowChartExecutor(
      flowChart<Record<string, unknown>>(
        'Read',
        (s) => {
          s.$setValue('callback', () => undefined);
          try {
            s.$getValue('callback');
          } catch {
            /* business handles it */
          }
          s.$setValue('callback', null);
        },
        'read',
      ).build(),
      options,
    );
    await ex.run();
    expect(ex.getSnapshot().capture!.channels.reads).toBe('failed');
    expect(ex.getSnapshot().capture!.limitations).toContain('read-retention-failed');
  });

  it('marks commit retention failure without changing the original rejection', async () => {
    const ex = new FlowChartExecutor(
      flowChart<Record<string, unknown>>(
        'Write',
        (s) => {
          s.bad = () => undefined;
        },
        'write',
      ).build(),
      options,
    );
    await expect(ex.run()).rejects.toThrow();
    const note = ex.getSnapshot().capture!;
    expect(note.boundary.status).toBe('failed');
    expect(note.channels.writes).toBe('failed');
    expect(note.channels.attention).toBe('partial');
    expect(note.boundary.failure).toEqual(ex.getFailureContext());
  });

  it('does not hide recorder serialization failure or subsequently assert collection was full', async () => {
    const ex = new FlowChartExecutor(plain(), options);
    const original = new Error('PRIVATE_RECORDER_ERROR');
    let fail = true;
    ex.attachFlowRecorder({
      id: 'r',
      onRunStart() {},
      toSnapshot() {
        if (fail) throw original;
        return { name: 'r', data: {} };
      },
    });
    await ex.run();
    expect(() => ex.getSnapshot()).toThrow(original);
    fail = false;
    const note = ex.getSnapshot().capture!;
    expect(note.channels.control).toBe('failed');
    expect(note.limitations).toContain('recorder-snapshot-failed');
    expect(JSON.stringify(note)).not.toContain('PRIVATE_RECORDER_ERROR');
  });

  it.each(['missing', 'wrong-run', 'accessor', 'partial'] as const)(
    'never promotes a %s control acknowledgement',
    async (kind) => {
      let runId = '';
      let getterCalls = 0;
      const ex = new FlowChartExecutor(plain(), options);
      ex.attachFlowRecorder({
        id: 'r',
        onRunStart(e) {
          runId = e.traversalContext!.runId;
        },
        toSnapshot() {
          const capture =
            kind === 'accessor'
              ? {
                  version: 1,
                  runId,
                  get control() {
                    getterCalls++;
                    return 'captured';
                  },
                }
              : kind === 'missing'
              ? undefined
              : { version: 1, runId: kind === 'wrong-run' ? 'other' : runId, control: 'partial' as const };
          return { name: 'r', data: {}, capture } as never;
        },
      });
      await ex.run();
      expect(ex.getSnapshot().capture!.channels.control).not.toBe('captured');
      expect(getterCalls).toBe(0);
    },
  );

  it('records a mid-run recorder clear as partial, then resets for a fresh run', async () => {
    const ctrl = controlDepRecorder({ captureCoverage: true });
    let clear = true;
    const ex = new FlowChartExecutor(
      flowChart(
        'Clear',
        () => {
          if (clear) ctrl.clear();
        },
        'clear',
      ).build(),
      options,
    );
    ex.attachFlowRecorder(ctrl);
    await ex.run();
    expect(ex.getSnapshot().capture!.channels.control).toBe('partial');
    clear = false;
    const before = ex.getSnapshot().capture!;
    await ex.run();
    expect(ex.getSnapshot().capture!.channels.control).toBe('captured');
    expect(ex.getSnapshot().capture!.runId).not.toBe(before.runId);
    expect(before.channels.control).toBe('partial');
  });

  it('does not inherit a parent note when drilling into a subflow', async () => {
    const child = plain();
    const ex = new FlowChartExecutor(
      flowChart('Root', () => undefined, 'root')
        .addSubFlowChartNext('child', child, 'Child')
        .build(),
      options,
    );
    await ex.run();
    const snapshot = ex.getSnapshot();
    expect(snapshot.capture!.scope).toBe('root-log');
    expect(snapshot.capture!.limitations).toContain('child-scopes-not-attested');
    expect(snapshot.subflowResults).toBeDefined();
    for (const subflow of Object.values(snapshot.subflowResults!)) expect(subflow).not.toHaveProperty('capture');
    expect(getSubtreeSnapshot(snapshot, 'child')).not.toHaveProperty('capture');
  });

  it('a fresh-executor resume creates its own log and does not borrow a saved terminal note', async () => {
    const chart = flowChart('Ask', { execute: () => 'question', resume: () => undefined }, 'ask').build();
    const first = new FlowChartExecutor(chart, options);
    await first.run();
    const original = first.getSnapshot().capture!;
    const second = new FlowChartExecutor(chart, options);
    const checkpoint = JSON.parse(JSON.stringify(first.getCheckpoint()));
    checkpoint.capture = original; // unsupported/untrusted checkpoint extension cannot upgrade the new leg
    await second.resume(checkpoint);
    const note = second.getSnapshot().capture!;
    expect(note.runId).not.toBe(original.runId);
    expect(note.logAddress.logRunId).toBe(note.runId);
    expect(note.commits.from).toBe(0);
    expect(note.boundary.status).toBe('completed');
  });

  it('memory completion is never promoted to a durable capture marker', async () => {
    const sink = memorySink();
    const ex = new FlowChartExecutor(plain(), { ...options, sink });
    await ex.run();
    expect(ex.getSnapshot().capture!.persistence).toBe('memory-only');
    const prefix = sink.entries.filter((entry) => entry.kind !== 'closed');
    const stored = readStoredRecord(prefix).root(ex.getSnapshot().runId)!;
    expect(stored.complete).toBe(false);
    expect(stored).not.toHaveProperty('capture');
    expect(JSON.stringify(sink.entries)).not.toContain('"capture"');
  });
});

it('a voluntary break reports an observed prefix without leaking the break reason', async () => {
  const ex = new FlowChartExecutor(
    flowChart(
      'Break',
      (s) => {
        s.$break('PRIVATE_BREAK');
      },
      'break',
    )
      .addFunction(
        'Unreached',
        () => {
          throw new Error('must not run');
        },
        'unreached',
      )
      .build(),
    options,
  );
  await ex.run();
  const note = ex.getSnapshot().capture!;
  expect(note.boundary.status).toBe('completed');
  expect(note.limitations).toContain('execution-broken');
  expect(JSON.stringify(note)).not.toContain('PRIVATE_BREAK');
});

it('a branded native deadline never becomes caller cancellation', async () => {
  const { deadlineReason } = await import('../../../src/lib/attempt/deadline.js');
  const reason = deadlineReason('synthetic deadline');
  const controller = new AbortController();
  controller.abort(reason);
  const ex = new FlowChartExecutor(plain(), options);
  await expect(ex.run({ signal: controller.signal })).rejects.toBe(reason);
  expect(ex.getSnapshot().capture!.boundary.status).toBe('failed');
  expect(ex.getSnapshot().capture!.boundary.failure).toEqual(ex.getFailureContext());
});

it('loop executions remain in one native extent rather than reusing a completed note', async () => {
  let turns = 0;
  const ex = new FlowChartExecutor(
    flowChart(
      'Work',
      (s) => {
        if (++turns === 4) s.$break();
      },
      'work',
    )
      .loopTo('work')
      .build(),
    options,
  );
  await ex.run();
  const snapshot = ex.getSnapshot();
  expect(snapshot.capture!.commits).toEqual({ from: 0, to: 4 });
  expect(snapshot.capture!.commits.to).toBe(snapshot.commitLog.length);
});

it('a rejected same-executor resume cannot attach a new leg note to the previous snapshot', async () => {
  const chart = flowChart('Ask', { execute: () => 'question', resume: () => undefined }, 'ask').build();
  const ex = new FlowChartExecutor(chart, options);
  await ex.run();
  const before = ex.getSnapshot();
  await expect(ex.resume(ex.getCheckpoint()!, undefined, { maxDepth: 0 })).rejects.toThrow('maxDepth');
  const after = ex.getSnapshot();
  expect(after.runId).toBe(before.runId);
  expect(after.capture).toEqual(before.capture);
  expect(after.capture!.runId).toBe(after.runId);
});

it('default/off snapshots never inspect a recorder capture property', async () => {
  let descriptorCalls = 0;
  const ex = new FlowChartExecutor(plain());
  ex.attachFlowRecorder({
    id: 'r',
    onRunStart() {},
    toSnapshot: () =>
      new Proxy(
        { name: 'r', data: {} },
        {
          getOwnPropertyDescriptor(target, key) {
            if (key === 'capture') {
              descriptorCalls++;
              throw new Error('must not inspect');
            }
            return Object.getOwnPropertyDescriptor(target, key);
          },
        },
      ),
  });
  await ex.run();
  expect(ex.getSnapshot().recorders?.[0].name).toBe('r');
  expect(descriptorCalls).toBe(0);
});

it('a business result with a paused property is not a native pause boundary', async () => {
  const sink = memorySink();
  const ex = new FlowChartExecutor(flowChart('Result', () => ({ paused: true }), 'result').build(), {
    ...options,
    sink,
  });
  await ex.run();
  expect(ex.isPaused()).toBe(false);
  expect(ex.getSnapshot().capture!.boundary.status).toBe('completed');
});
