/** Unit, property, load and omission proofs for #111. No LLM or external services. */
import fc from 'fast-check';
import { afterEach, expect, it, vi } from 'vitest';

import { flowChart, FlowChartExecutor } from '../../../src/index.js';
import { copyCaptureAcknowledgement, NativeCapture } from '../../../src/lib/capture/nativeCoverage.js';
import { StageAttention } from '../../../src/lib/memory/attention.js';
import { _resetRunIdStateForTesting } from '../../../src/lib/runner/runId.js';
import { controlDepRecorder } from '../../../src/trace.js';

afterEach(() => vi.restoreAllMocks());

it('no-option and explicit-off bytes match for varied retention policies', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(1000);
  await fc.assert(
    fc.asyncProperty(
      fc.constantFrom('full', 'summary', 'off'),
      fc.constantFrom('full', 'delta'),
      fc.integer({ min: 0, max: 100 }),
      async (readTracking, commitValues, n) => {
        const chart = flowChart<{ n: number }>(
          'Set',
          (s) => {
            s.n = n;
          },
          'set',
        )
          .addFunction(
            'Read',
            (s) => {
              s.n += 1;
            },
            'read',
          )
          .build();
        const snapshots: string[] = [];
        for (const extra of [{}, { captureCoverage: false }]) {
          _resetRunIdStateForTesting();
          const ex = new FlowChartExecutor(chart, { readTracking, commitValues, ...extra });
          await ex.run();
          snapshots.push(JSON.stringify(ex.getSnapshot()));
        }
        expect(snapshots[0]).toBe(snapshots[1]);
      },
    ),
    { numRuns: 24 },
  );
});

it('capture size stays bounded across a long execution and repeated same-executor runs', async () => {
  const builder = flowChart('Start', () => undefined, 'start');
  for (let n = 0; n < 250; n++) builder.addFunction('Step', () => undefined, 'step-' + n);
  const ex = new FlowChartExecutor(builder.build(), { captureCoverage: true });
  for (let n = 0; n < 3; n++) {
    await ex.run();
    const snapshot = ex.getSnapshot();
    expect(snapshot.capture!.commits).toEqual({ from: 0, to: snapshot.commitLog.length });
    expect(snapshot.capture!.commits.to).toBe(251);
    expect(JSON.stringify(snapshot.capture).length).toBeLessThan(2048);
  }
});

it('parallel siblings share the native log range without manufacturing another timeline', async () => {
  const ex = new FlowChartExecutor(
    flowChart('Start', () => undefined, 'start')
      .addListOfFunction([
        { id: 'a', name: 'A', fn: () => undefined },
        { id: 'b', name: 'B', fn: () => undefined },
      ])
      .addFunction('Join', () => undefined, 'join')
      .build(),
    { captureCoverage: true },
  );
  await ex.run();
  const s = ex.getSnapshot();
  expect(s.capture!.commits.to).toBe(ex.getCommitCount());
  expect(s.capture!.boundary.status).toBe('completed');
});

it('attention omission reports synchronously to the native collector, not from a snapshot walk', () => {
  let omissions = 0;
  const attention = new StageAttention(() => {
    omissions++;
  });
  attention.append({ kind: 'error', reason: 'ERROR_RECORDED', evidence: [] });
  expect(omissions).toBe(1);
  attention.begin();
  attention.attemptDropped();
  expect(omissions).toBe(2);
  const state = new NativeCapture('run', { logRunId: 'run', drillPath: [] }, 0, {
    readTracking: 'full',
    writeTracking: 'full',
    writeProvenance: 'off',
    commitValues: 'full',
  });
  state.limit('attention-omitted');
  expect(state.snapshot(1).channels.attention).toBe('partial');
});

it('large failure identities are omitted with an explicit gap, never shortened into another reference', () => {
  const state = new NativeCapture('run', { logRunId: 'run', drillPath: [] }, 0, {
    readTracking: 'full',
    writeTracking: 'full',
    writeProvenance: 'off',
    commitValues: 'full',
  });
  state.end('failed', { category: 'unknown', stage: { runId: 'run', runtimeStageId: 'x'.repeat(10000) } });
  state.end('completed');
  const note = state.snapshot(0);
  expect(note.boundary).toEqual({ status: 'failed', failure: { category: 'unknown' } });
  expect(note.limitations).toContain('identity-omitted');
  expect(JSON.stringify(note).length).toBeLessThan(2048);
});

it.each([
  null,
  false,
  [],
  Object.create(null),
  { version: 2 },
  { version: 1, runId: '' },
  { version: 1, runId: 'x'.repeat(2049), control: 'captured' },
  { version: 1, runId: 'run', control: 'invented' },
  new Proxy(
    {},
    {
      getPrototypeOf() {
        throw new Error('private');
      },
    },
  ),
])('refuses an invalid acknowledgement without inventing capture', (value) => {
  expect(copyCaptureAcknowledgement(value)).toBeUndefined();
});

it('does not treat a deferred acknowledgement as proof of delivered complete control', async () => {
  const ex = new FlowChartExecutor(flowChart('Step', () => undefined, 'step').build(), { captureCoverage: true });
  ex.attachFlowRecorder(controlDepRecorder({ captureCoverage: true }), { delivery: 'deferred' });
  await ex.run();
  expect(ex.getSnapshot().capture!.channels.control).toBe('unknown');
});

it('invalid host modes are unknown and cannot inject arbitrary policy strings into a note', () => {
  const state = new NativeCapture('run', { logRunId: 'run', drillPath: [] }, 0, {
    readTracking: 'PRIVATE_SETTING',
    writeTracking: 'PRIVATE_SETTING',
    commitValues: 'PRIVATE_SETTING',
    writeProvenance: 'PRIVATE_SETTING',
  } as never);
  const note = state.snapshot(0);
  expect(note.modes).toEqual({
    readTracking: 'unknown',
    writeTracking: 'unknown',
    commitValues: 'unknown',
    writeProvenance: 'unknown',
  });
  expect(note.channels.reads).toBe('unknown');
  expect(note.channels.writes).toBe('unknown');
  expect(JSON.stringify(note)).not.toContain('PRIVATE_SETTING');
});
