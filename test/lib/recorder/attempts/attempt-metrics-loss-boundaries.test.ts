/** Consumer-facing omissions stay visible when bounded metrics cannot retain or admit evidence. */
import { describe, expect, it } from 'vitest';

import type { FlowAttemptEvent, FlowDecisionEvent, FlowRunEvent } from '../../../../src/index.js';
import type { AttemptQuery, AttemptRow } from '../../../../src/recorders.js';
import { attempts, memoryStore } from '../../../../src/recorders.js';

const context = (runId = 'run', index = 0) => ({
  runId,
  stageId: 'step',
  stageName: 'Step',
  runtimeStageId: `step#${index}`,
  depth: 0,
});
const attempt = (index = 0, patch: Partial<FlowAttemptEvent['record']> = {}): FlowAttemptEvent => ({
  stageName: 'Step',
  stageId: 'step',
  traversalContext: context('run', index),
  record: {
    series: `step#${index}`,
    kind: 'stage',
    attempt: 1,
    of: 1,
    startedAt: 10,
    durationMs: 2,
    outcome: 'ok',
    next: 'done',
    reason: 'succeeded',
    decision: { rules: [], chosen: 'done', default: 'retry' },
    ...patch,
  },
});
const call = (index: number): FlowAttemptEvent =>
  attempt(index, {
    series: `step#${index}@1.1`,
    kind: 'call',
    target: 'provider',
    retryLoop: { id: 'operation', series: `step#${index}`, attempt: 1, of: 2, phase: 'attempt' },
  });
const decision = (index: number): FlowDecisionEvent => ({
  decider: 'Decide',
  traversalContext: { ...context(), runtimeStageId: 'decide#3' },
  chosen: 'done',
  evidence: {
    rules: [],
    chosen: 'done',
    default: 'stop',
    retryLoop: {
      id: 'operation',
      series: `step#${index}`,
      attempt: 1,
      of: 2,
      effect: 'none',
      reconciled: false,
      next: 'done',
      reason: 'succeeded',
    },
  },
});

describe('attempt metrics missing and rejected evidence', () => {
  it('discloses bounded run ownership loss rather than inventing a completed start', () => {
    const recorder = attempts({ maxRows: 1 });
    recorder.onRunStart({ traversalContext: context('first') });
    recorder.onRunStart({ traversalContext: context('second') });
    recorder.onRunEnd({ traversalContext: context('first') });
    expect([...recorder.byRun().keys()]).toEqual(['second']);
    expect(recorder.byRun().get('second')?.outcome).toBe('running');
    expect(recorder.storage()).toMatchObject({ omittedRows: 3, incomplete: true });
    recorder.onRunEnd({ traversalContext: context('second') });
    expect(recorder.byRun().get('second')?.outcome).toBe('ok');
    expect(recorder.storage().incomplete).toBe(true);
  });

  it('ignores lifecycle events without a run while counting attempt events without an owner', () => {
    const recorder = attempts();
    const unowned: FlowRunEvent = {};
    recorder.onRunStart(unowned);
    recorder.onRunEnd(unowned);
    recorder.onRunFailed({ structuredError: { message: 'not retained', name: 'Error', raw: undefined } });
    recorder.onAttempt({ ...attempt(), traversalContext: undefined });
    expect(recorder.byRun().size).toBe(0);
    expect(recorder.storage()).toMatchObject({ omittedRows: 1, incomplete: true });
  });

  it.each([
    ['oversized identity', { series: 'x'.repeat(4097) }],
    ['invalid identity', { series: 'not-an-execution' }],
    ['invalid timing', { durationMs: Number.NaN }],
  ] as const)('rejects malformed attempt %s', (_name, patch) => {
    const recorder = attempts();
    recorder.onAttempt(attempt(0, patch));
    expect(recorder.byTarget().size).toBe(0);
    expect(recorder.storage()).toMatchObject({ omittedRows: 1, incomplete: true });
  });

  it('does not connect an evicted logical attempt to a later decision', () => {
    const recorder = attempts({ maxRows: 1 });
    recorder.onAttempt(call(0));
    recorder.onAttempt(call(1));
    const lost = recorder.storage().omittedRows;
    recorder.onDecision(decision(0));
    expect(recorder.storage().omittedRows).toBe(lost + 1);
    expect(recorder.series('step#0', 'run')).toEqual({ attempts: [], decisions: [] });
    recorder.onDecision(decision(1));
    expect(recorder.series('step#1', 'run').decisions).toEqual([
      expect.objectContaining({ attemptId: 'step#1@1.1@1', target: 'provider', next: 'done' }),
    ]);
  });

  it('rejects an invalid logical verdict even when a physical attempt was retained', () => {
    const recorder = attempts();
    recorder.onAttempt(call(0));
    const invalid = decision(0);
    const evidence = invalid.evidence;
    if (!evidence?.retryLoop) throw new Error('test decision must carry a retry-loop verdict');
    recorder.onDecision({
      ...invalid,
      evidence: { ...evidence, retryLoop: { ...evidence.retryLoop, of: 0 } },
    });
    expect(recorder.series('step#0', 'run').decisions).toEqual([]);
    expect(recorder.storage()).toMatchObject({ omittedRows: 1, incomplete: true });
  });

  it.each([
    null,
    {
      get since() {
        throw new Error('getter must not run');
      },
    },
  ])('refuses non-data query input before reading the adapter', async (query) => {
    let reads = 0;
    const recorder = attempts({
      store: {
        append() {},
        async read() {
          reads++;
          return [];
        },
      },
    });
    await expect(recorder.aggregate(query as AttemptQuery)).rejects.toThrow('attempts: invalid query');
    expect(reads).toBe(0);
  });

  it.each(['invalid', 'throw'] as const)(
    'marks %s store accounting as unknown without discarding valid rows',
    async (mode) => {
      const stored: AttemptRow[] = [];
      const recorder = attempts({
        store: {
          append(rows) {
            stored.push(...rows);
          },
          read: async () => stored,
          stats() {
            if (mode === 'throw') throw new Error('private store details');
            return { omittedRows: -1 };
          },
        },
      });
      recorder.onAttempt(attempt());
      const result = await recorder.aggregate();
      expect(result.byTarget.get('step')?.count).toBe(1);
      expect(result.storage).toMatchObject({ omittedRows: 0, incomplete: true });
      expect(JSON.stringify(result.storage)).not.toContain('private store details');
    },
  );

  it('releases a malformed store response slot so the next valid query can run', async () => {
    let reads = 0;
    const recorder = attempts({
      maxPending: 1,
      store: {
        append() {},
        async read() {
          return (++reads === 1 ? {} : []) as AttemptRow[];
        },
      },
    });
    await expect(recorder.aggregate()).rejects.toThrow('attempts: invalid store rows');
    expect(recorder.storage().pending).toBe(0);
    expect((await recorder.aggregate()).storage).toMatchObject({ pending: 0, incomplete: false });
    expect(reads).toBe(2);
  });

  it('the reference store counts rejected rows without retaining their payload', async () => {
    const store = memoryStore();
    store.append([{ kind: 'unrecognised', secret: 'not retained' } as unknown as AttemptRow]);
    expect(await store.read({})).toEqual([]);
    expect(store.stats()).toEqual({ rows: 0, omittedRows: 1 });
  });
});
