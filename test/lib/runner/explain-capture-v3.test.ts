import assert from 'node:assert/strict';

import { describe, expect, it } from 'vitest';

import { explain } from '../../../src/explain.js';
import { flowChart, FlowChartExecutor } from '../../../src/index.js';
import type { TerminalFailureContext } from '../../../src/lib/errors/terminalFailure.js';
import { controlDepRecorder } from '../../../src/trace.js';

const modes = {
  reads: ['full', 'summary', 'off'],
  writes: ['full', 'summary', 'off'],
  commitWrites: ['full', 'delta'],
  writePrefixes: ['reads-prefix', 'off'],
  nestedReads: ['on', 'off'],
  readSources: ['on', 'off'],
  inputHandoff: ['on', 'off'],
  outputHandoff: ['on', 'off'],
  fanoutHandoff: ['on', 'off'],
  attention: ['on', 'off'],
  control: ['on', 'off'],
} as const;
const reasonCodes = [
  'redacted',
  'budget-exhausted',
  'capture-failed',
  'missing-evidence',
  'missing-child',
  'unsupported-scope',
  'worker-boundary',
  'transport-boundary',
  'interval-incomplete',
  'unverified',
] as const;
type Channel = { mode: string; status: string; reasons: string[] };
type WireNote = {
  version: 3;
  runId: string;
  logAddress: { logRunId: string; drillPath: string[] };
  commits: { from: number; to: number };
  channels: Record<keyof typeof modes, Channel>;
};

function verifyNote(
  retained: unknown,
  expected: {
    runId: unknown;
    logAddress: unknown;
    from: number;
    to: number;
    boundary: 'paused' | 'completed' | 'failed';
    failure?: TerminalFailureContext;
  },
): WireNote {
  expect(retained).toMatchObject({ version: 3 });
  const note = retained as WireNote;
  expect(note).toEqual({
    version: 3,
    scope: 'log',
    runId: expected.runId,
    logAddress: expected.logAddress,
    commits: { from: expected.from, to: expected.to },
    boundary: { status: expected.boundary, ...(expected.failure && { failure: expected.failure }) },
    persistence: 'memory-only',
    channels: note.channels,
  });
  expect(JSON.parse(JSON.stringify(note))).toEqual(note);
  expect(Object.keys(note.channels).sort()).toEqual(Object.keys(modes).sort());
  for (const [name, allowed] of Object.entries(modes)) {
    const channel = note.channels[name as keyof typeof modes];
    expect(channel).toEqual({ mode: channel.mode, status: channel.status, reasons: channel.reasons });
    expect([...allowed, 'unknown']).toContain(channel.mode);
    expect(['collected', 'disabled', 'partial', 'failed', 'unknown']).toContain(channel.status);
    expect(channel.status === 'disabled').toBe(channel.mode === 'off');
    if (channel.mode === 'unknown') expect(channel.status).toBe('unknown');
    expect(channel.reasons).toBeInstanceOf(Array);
    expect([...new Set(channel.reasons)]).toEqual(channel.reasons);
    for (const reason of channel.reasons) expect(reasonCodes).toContain(reason);
    expect(channel.reasons.length === 0).toBe(channel.status === 'collected' || channel.status === 'disabled');
  }
  return note;
}

const collected = (mode: string) => ({ mode, status: 'collected', reasons: [] });
const disabled = { mode: 'off', status: 'disabled', reasons: [] };
const sourceGap = { mode: 'on', status: 'partial', reasons: ['missing-evidence'] };
const selected = 'selected-v3-value-7c77f8cc';
const key = 'privateBillingSecret';
const failureMessage = 'unretained native error message 6db5ea';
const failureDetail = 'unretained native error body 651bde';
const silent = { info() {}, log() {}, debug() {}, error() {}, warn() {} };

function failingChart(error: Error) {
  return flowChart(
    'Reject',
    () => {
      throw error;
    },
    'native-failure',
  )
    .setLogger(silent)
    .build();
}

type State = { [key]?: string; credential?: string; receipt?: string; receiptLen?: number };

function nestedChart() {
  const leaf = flowChart<State>(
    'Leaf',
    (s) => {
      s.receipt = s.credential;
    },
    'leaf-seed',
  ).build();
  const outer = flowChart<State>('Outer', () => undefined, 'outer-seed')
    .addSubFlowChartNext('leaf-mount', leaf, 'Leaf', {
      inputMapper: (s) => ({ credential: s.credential }),
      outputMapper: (s: State) => ({ receipt: s.receipt }),
    })
    .build();
  return flowChart<State>(
    'Start',
    (s) => {
      s[key] = selected;
    },
    'start',
  )
    .addSubFlowChartNext('outer-mount', outer, 'Outer', {
      inputMapper: (s) => ({ credential: s[key] }),
      outputMapper: (s: State) => ({ receipt: s.receipt }),
    })
    .addFunction(
      'Read receipt',
      (s) => {
        s.receiptLen = s.receipt?.length ?? 0;
      },
      'read-receipt',
    )
    .build();
}

describe('explain native capture note version 3', () => {
  it('binds separate root and nested mount notes to their own full addresses and log intervals', async () => {
    const executor = new FlowChartExecutor(nestedChart(), explain(true));
    executor.attachFlowRecorder(controlDepRecorder({ captureCoverage: true }));
    await executor.run();
    const snapshot = executor.getSnapshot();
    expect(snapshot.sharedState).toMatchObject({ receipt: selected, receiptLen: selected.length });
    expect(snapshot.logAddress).toEqual({ logRunId: snapshot.runId, drillPath: [] });
    const root = verifyNote(snapshot.capture, {
      runId: snapshot.runId,
      logAddress: snapshot.logAddress,
      from: 0,
      to: snapshot.commitLog.length,
      boundary: 'completed',
    });
    // Input mapping observes the live parent view. The matching native handoff
    // is retained, while scalar sources for that live read stay untracked.
    expect(snapshot.readSources?.limitations).toEqual(['untracked-read']);
    expect(root.channels).toMatchObject({
      reads: collected('full'),
      writes: collected('full'),
      commitWrites: collected('full'),
      writePrefixes: collected('reads-prefix'),
      nestedReads: collected('on'),
      readSources: sourceGap,
      inputHandoff: collected('on'),
      outputHandoff: collected('on'),
      fanoutHandoff: collected('on'),
      attention: collected('on'),
      control: collected('on'),
    });
    const mounts = Object.entries(snapshot.subflowResults ?? {}).filter(([id]) => id.includes('#'));
    expect(mounts).toHaveLength(2);
    const childPaths = mounts
      .map(([mountId, { treeContext: child }]) => {
        expect(child.logAddress?.logRunId).toBe(snapshot.runId);
        expect(child.logAddress?.drillPath.at(-1)).toBe(mountId);
        const note = verifyNote(Reflect.get(child, 'capture'), {
          runId: snapshot.runId,
          logAddress: child.logAddress,
          from: 0,
          to: child.history.length,
          boundary: 'completed',
        });
        if (note.logAddress.drillPath.length === 1) {
          expect(child.readSources?.limitations).toEqual(['untracked-read']);
          expect(note.channels.readSources).toEqual(sourceGap);
        } else {
          expect(child.readSources?.status).toBe('captured');
          expect(note.channels.readSources).toEqual(collected('on'));
        }
        return note.logAddress.drillPath;
      })
      .sort((a, b) => a.length - b.length);
    expect(childPaths.map((address) => address.length)).toEqual([1, 2]);
    expect(childPaths[1]?.slice(0, -1)).toEqual(childPaths[0]);
  });

  it('records host overrides as effective modes and distinguishes summary retention from disabled channels', async () => {
    const chart = flowChart<{ n: number }>(
      'Count',
      (s) => {
        s.n = 1;
      },
      'count',
    )
      .addFunction(
        'Increment',
        (s) => {
          s.n++;
        },
        'increment',
      )
      .build();
    const executor = new FlowChartExecutor(
      chart,
      explain(true, {
        readTracking: 'summary',
        writeTracking: 'off',
        writeProvenance: 'off',
        commitValues: 'delta',
        nestedReadTracking: false,
        readSources: false,
        captureInputHandoff: false,
        captureOutputHandoff: false,
        captureFanoutHandoff: false,
      }),
    );
    await executor.run();
    const snapshot = executor.getSnapshot();
    const note = verifyNote(snapshot.capture, {
      runId: snapshot.runId,
      logAddress: snapshot.logAddress,
      from: 0,
      to: snapshot.commitLog.length,
      boundary: 'completed',
    });
    expect(note.channels).toMatchObject({
      reads: collected('summary'),
      writes: disabled,
      commitWrites: collected('delta'),
      writePrefixes: disabled,
      nestedReads: disabled,
      readSources: disabled,
      inputHandoff: disabled,
      outputHandoff: disabled,
      fanoutHandoff: disabled,
      attention: collected('on'),
    });
  });

  it('recomputes privacy gaps for served source evidence and emits no selected state path or value in the note', async () => {
    const executor = new FlowChartExecutor(nestedChart(), explain(true));
    executor.setRedactionPolicy({ keys: [key, 'credential', 'receipt'] });
    await executor.run();
    const raw = executor.getSnapshot();
    const safe = executor.getSnapshot({ redact: true });
    const bounds = {
      runId: raw.runId,
      logAddress: raw.logAddress,
      from: 0,
      to: raw.commitLog.length,
      boundary: 'completed' as const,
    };
    const rawNote = verifyNote(raw.capture, bounds);
    const safeNote = verifyNote(safe.capture, bounds);
    expect(raw.sharedState).toMatchObject({ receipt: selected });
    expect(JSON.stringify(safe)).not.toContain(selected);
    for (const note of [rawNote, safeNote]) {
      const bytes = JSON.stringify(note);
      expect(bytes).not.toContain(key);
      expect(bytes).not.toContain(selected);
    }
    expect(safeNote.channels.readSources.mode).toBe('on');
    expect(['partial', 'unknown']).toContain(safeNote.channels.readSources.status);
    expect(safeNote.channels.readSources.reasons).toContain('redacted');
    expect(safeNote.channels.outputHandoff).toMatchObject({
      mode: 'on',
      status: 'partial',
      reasons: expect.arrayContaining(['redacted']),
    });
  });

  it('binds a same-log resume note only to the new leg and new half-open range', async () => {
    const chart = flowChart<{ n: number }>(
      'Count',
      (s) => {
        s.n = 1;
      },
      'count',
    )
      .addPausableFunction('Ask', { execute: () => ({ question: 'Continue?' }), resume: () => undefined }, 'ask')
      .addFunction(
        'Increment',
        (s) => {
          s.n++;
        },
        'increment',
      )
      .build();
    const executor = new FlowChartExecutor(chart, explain(true));
    await executor.run();
    const paused = executor.getSnapshot();
    const prior = verifyNote(paused.capture, {
      runId: paused.runId,
      logAddress: paused.logAddress,
      from: 0,
      to: paused.commitLog.length,
      boundary: 'paused',
    });
    const retained = JSON.stringify(prior);
    await executor.resume(JSON.parse(JSON.stringify(executor.getCheckpoint())));
    const resumed = executor.getSnapshot();
    expect(resumed.runId).not.toBe(paused.runId);
    expect(resumed.logAddress).toEqual(paused.logAddress);
    const note = verifyNote(resumed.capture, {
      runId: resumed.runId,
      logAddress: resumed.logAddress,
      from: prior.commits.to,
      to: resumed.commitLog.length,
      boundary: 'completed',
    });
    expect(note.commits.to).toBeGreaterThan(note.commits.from);
    expect(note.logAddress.logRunId).toBe(paused.runId);
    expect(JSON.stringify(paused.capture)).toBe(retained);
  });

  it.each(['runId', 'logRunId'])('omits root and child notes when redaction selects their %s identity', async (key) => {
    const executor = new FlowChartExecutor(nestedChart(), explain(true));
    executor.setRedactionPolicy({ keys: [key] });
    await executor.run();
    const raw = executor.getSnapshot();
    const served = executor.getSnapshot({ redact: true });
    expect(raw.capture?.version).toBe(3);
    expect(served).not.toHaveProperty('capture');
    const rawChildren = Object.entries(raw.subflowResults ?? {}).filter(([id]) => id.includes('#'));
    expect(rawChildren).toHaveLength(2);
    for (const [id, result] of rawChildren) {
      expect(result.treeContext.capture?.version).toBe(3);
      const servedChild = served.subflowResults?.[id]?.treeContext;
      expect(servedChild).toBeDefined();
      expect(servedChild).not.toHaveProperty('capture');
    }
    expect(executor.getSnapshot().capture).toEqual(raw.capture);
  });

  it('retains the declared root failure category and native stage without the error or its body', async () => {
    const error = Object.assign(new Error(failureMessage), { status: 503, body: failureDetail });
    const executor = new FlowChartExecutor(failingChart(error), explain(true));
    await expect(executor.run()).rejects.toBe(error);
    const snapshot = executor.getSnapshot();
    assert.ok(snapshot.runId);
    const failure = {
      category: 'server',
      stage: { runId: snapshot.runId, runtimeStageId: 'native-failure#0' },
    } as const;
    expect(executor.getFailureContext()).toEqual(failure);
    const note = verifyNote(snapshot.capture, {
      runId: snapshot.runId,
      logAddress: snapshot.logAddress,
      from: 0,
      to: snapshot.commitLog.length,
      boundary: 'failed',
      failure,
    });
    expect(JSON.stringify(note)).not.toContain(failureMessage);
    expect(JSON.stringify(note)).not.toContain(failureDetail);
  });

  it('withholds only the failure stage when the served policy redacts its runtimeStageId', async () => {
    const error = Object.assign(new Error(failureMessage), { status: 503 });
    const executor = new FlowChartExecutor(failingChart(error), explain(true));
    executor.setRedactionPolicy({ keys: ['runtimeStageId'] });
    await expect(executor.run()).rejects.toBe(error);
    const raw = executor.getSnapshot();
    assert.ok(raw.runId);
    const safe = executor.getSnapshot({ redact: true });
    const bounds = {
      runId: raw.runId,
      logAddress: raw.logAddress,
      from: 0,
      to: raw.commitLog.length,
      boundary: 'failed' as const,
    };
    verifyNote(raw.capture, {
      ...bounds,
      failure: { category: 'server', stage: { runId: raw.runId, runtimeStageId: 'native-failure#0' } },
    });
    const note = verifyNote(safe.capture, { ...bounds, failure: { category: 'server' } });
    expect(JSON.stringify(note)).not.toContain('native-failure#0');
    expect(JSON.stringify(note)).not.toContain(failureMessage);
  });

  it('retains a failed child stage only under its exact native log and leg', async () => {
    const error = Object.assign(new Error(failureMessage), { status: 503 });
    const chart = flowChart('Start', () => undefined, 'start')
      .addSubFlowChartNext('child', failingChart(error), 'Child')
      .setLogger(silent)
      .build();
    const executor = new FlowChartExecutor(chart, explain(true));
    await expect(executor.run()).rejects.toBe(error);
    const snapshot = executor.getSnapshot();
    const child = snapshot.subflowResults?.child?.treeContext;
    assert.ok(child && snapshot.runId);
    expect(child.logAddress?.drillPath).toEqual(['child#1']);
    expect(child.history.some((row) => row.runtimeStageId === 'child/native-failure#2')).toBe(true);
    const note = verifyNote(child.capture, {
      runId: snapshot.runId,
      logAddress: child.logAddress,
      from: 0,
      to: child.history.length,
      boundary: 'failed',
      failure: { category: 'server', stage: { runId: snapshot.runId, runtimeStageId: 'child/native-failure#2' } },
    });
    expect(JSON.stringify(note)).not.toContain(failureMessage);
  });
});
