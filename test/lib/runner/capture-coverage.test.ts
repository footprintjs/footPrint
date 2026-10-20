/** #111 stage 1 — native snapshot contract, lifecycle, privacy and default byte law. No providers/models. */
import { describe, expect, it } from 'vitest';

import { flowChart, FlowChartExecutor } from '../../../src/index.js';
import { controlDepRecorder } from '../../../src/trace.js';

const chart = () =>
  flowChart<{ n: number }>(
    'Seed',
    (s) => {
      s.n = 1;
    },
    'seed',
  )
    .addFunction(
      'Read',
      (s) => {
        s.n += 1;
      },
      'read',
    )
    .build();
const options = { captureCoverage: true, writeProvenance: 'reads-prefix' as const };

describe('native capture coverage', () => {
  it('is absent before a run and absent by default or explicit off', async () => {
    for (const opts of [{}, { captureCoverage: false }]) {
      const ex = new FlowChartExecutor(chart(), opts);
      expect(ex.getSnapshot()).not.toHaveProperty('capture');
      await ex.run();
      expect(ex.getSnapshot()).not.toHaveProperty('capture');
    }
  });

  it('records current native identity, extent, modes and captured empty engine attention', async () => {
    const ex = new FlowChartExecutor(chart(), options);
    expect(ex.getSnapshot()).not.toHaveProperty('capture');
    await ex.run();
    const snapshot = ex.getSnapshot();
    expect(snapshot.capture).toMatchObject({
      version: 1,
      runId: snapshot.runId,
      scope: 'root-log',
      logAddress: { logRunId: snapshot.runId, drillPath: [] },
      commits: { from: 0, to: snapshot.commitLog.length },
      boundary: { status: 'completed' },
      persistence: 'memory-only',
      channels: {
        reads: 'captured',
        writes: 'captured',
        attention: 'captured',
        control: 'unknown',
        readSources: 'not-collected',
      },
      modes: { readTracking: 'full', writeTracking: 'full', commitValues: 'full', writeProvenance: 'reads-prefix' },
    });
    expect(JSON.parse(JSON.stringify(snapshot.capture))).toEqual(snapshot.capture);
    expect(Object.isFrozen(snapshot.capture)).toBe(true);
    expect(Object.isFrozen(snapshot.capture!.channels)).toBe(true);
  });

  it.each(['off', 'summary', 'full'] as const)(
    'records actual retention mode %s independently of provenance',
    async (mode) => {
      const ex = new FlowChartExecutor(chart(), { ...options, readTracking: mode, writeTracking: mode });
      await ex.run();
      expect(ex.getSnapshot().capture!.channels).toMatchObject({
        reads: mode === 'off' ? 'disabled' : 'captured',
        writes: mode === 'off' ? 'disabled' : 'captured',
      });
    },
  );

  it('distinguishes captured empty control from an attached recorder with no acknowledgement', async () => {
    for (const acknowledged of [false, true]) {
      const ex = new FlowChartExecutor(chart(), options);
      ex.attachFlowRecorder(controlDepRecorder({ captureCoverage: acknowledged }));
      await ex.run();
      expect(ex.getSnapshot().capture!.channels.control).toBe(acknowledged ? 'captured' : 'unknown');
    }
  });

  it('does not reuse a previous ending when a new run fails admission', async () => {
    const ex = new FlowChartExecutor(chart(), options);
    await ex.run();
    const before = ex.getSnapshot().capture;
    await expect(ex.run({ env: { traceparent: 'invalid' } })).rejects.toThrow();
    expect(ex.getSnapshot().capture).toEqual(before); // previous run stays explicitly identified, never relabelled
    expect(ex.getFailureContext()).toEqual({ category: 'unknown' });
  });

  it('reports running without an ending, then failure without values or raw exception text', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ex = new FlowChartExecutor(
      flowChart(
        'Wait',
        async () => {
          await gate;
          throw new Error('PRIVATE_VALUE');
        },
        'wait',
      ).build(),
      options,
    );
    const running = ex.run();
    const prefix = ex.getSnapshot().capture!;
    expect(prefix.boundary.status).toBe('running');
    release();
    await expect(running).rejects.toThrow('PRIVATE_VALUE');
    const final = ex.getSnapshot().capture!;
    expect(final.boundary.status).toBe('failed');
    expect(final.boundary.failure?.stage?.runId).toBe(final.runId);
    expect(JSON.stringify(final)).not.toContain('PRIVATE_VALUE');
    expect(prefix.boundary.status).toBe('running');
  });

  it('does not turn a recovered retry into a terminal failure', async () => {
    let calls = 0;
    const ex = new FlowChartExecutor(
      flowChart(
        'Retry',
        () => {
          if (++calls === 1) throw Error('temporary');
        },
        'retry',
      )
        .retry({ attempts: 2 })
        .build(),
      options,
    );
    await ex.run();
    expect(ex.getSnapshot().capture!.boundary).toEqual({ status: 'completed' });
    expect(ex.getSnapshot().capture!.limitations).toContain('final-attempt-views');
  });

  it('binds same-executor resume to a new leg and nonoverlapping commit range', async () => {
    const c = flowChart<{ n: number }>(
      'Seed',
      (s) => {
        s.n = 1;
      },
      'seed',
    )
      .addPausableFunction('Ask', { execute: () => ({ question: 'continue?' }), resume: () => undefined }, 'ask')
      .addFunction('Done', () => undefined, 'done')
      .build();
    const ex = new FlowChartExecutor(c, options);
    await ex.run();
    const paused = ex.getSnapshot().capture!;
    expect(paused.boundary.status).toBe('paused');
    await ex.resume(JSON.parse(JSON.stringify(ex.getCheckpoint())));
    const resumed = ex.getSnapshot().capture!;
    expect(resumed.runId).not.toBe(paused.runId);
    expect(resumed.logAddress).toEqual(paused.logAddress);
    expect(resumed.commits.from).toBe(paused.commits.to);
    expect(resumed.boundary.status).toBe('completed');
    expect(paused.boundary.status).toBe('paused');
    expect(ex.getCheckpoint()).toBeUndefined();
  });

  it('records privacy limitations on a redacted export without naming selected keys', async () => {
    const ex = new FlowChartExecutor(chart(), options);
    ex.setRedactionPolicy({ keys: ['PRIVATE_KEY'] });
    await ex.run();
    const capture = ex.getSnapshot({ redact: true }).capture!;
    expect(capture.limitations).toContain('redacted-export');
    expect(JSON.stringify(capture)).not.toContain('PRIVATE_KEY');
  });
});
