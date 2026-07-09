/**
 * snapshot.runId — the run's id surfaced read-only on getSnapshot() (D20/P2).
 *
 * `runId` always existed internally (generated per run()/resume(),
 * FlowChartExecutor.ts, stamped on every TraversalContext) but the snapshot
 * never carried it — so a consumer holding a RuntimeSnapshot could not join
 * it against the event stream or an external correlation table without
 * scraping a recorder. Now `FlowchartTraverser.getSnapshot()` stamps its own
 * `runId` onto the runtime snapshot.
 *
 * Contract under test:
 *   - present: snapshot.runId is a non-empty string;
 *   - stable within a run: repeated getSnapshot() calls agree, and the value
 *     equals the runId recorders saw on the run's events;
 *   - fresh across runs: a second run() on the SAME executor gets a new id;
 *   - fresh across resume: resume() regenerates runId (resume is logically a
 *     distinct run — FlowChartExecutor.ts resume() docs), for both
 *     same-executor and cross-executor resume.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import type { FlowRecorder, PausableHandler } from '../../../src/index.js';
import { flowChart, FlowChartExecutor } from '../../../src/index.js';
import { _resetRunIdStateForTesting } from '../../../src/lib/runner/runId.js';

beforeEach(() => {
  _resetRunIdStateForTesting();
});

const simpleChart = () =>
  flowChart<Record<string, unknown>>(
    'Seed',
    (scope) => {
      scope.value = 'set';
    },
    'seed',
  ).build();

const pausableChart = () =>
  flowChart<Record<string, unknown>>(
    'Seed',
    (scope) => {
      scope.value = 'init';
    },
    'seed',
  )
    .addPausableFunction(
      'Gate',
      {
        execute: async (scope) => {
          scope.value = 'pending';
          return { pause: true, data: { question: 'OK?' } };
        },
        resume: async (scope, input) => {
          scope.approved = (input as { approved: boolean }).approved;
        },
      } satisfies PausableHandler<any>,
      'gate',
    )
    .addFunction(
      'Finish',
      (scope) => {
        scope.value = 'done';
      },
      'finish',
    )
    .build();

describe('getSnapshot().runId — presence + stability within a run', () => {
  it('is a non-empty string and stable across repeated getSnapshot() calls', async () => {
    const executor = new FlowChartExecutor(simpleChart());
    await executor.run();

    const first = executor.getSnapshot();
    const second = executor.getSnapshot();

    expect(typeof first.runId).toBe('string');
    expect(first.runId.length).toBeGreaterThan(0);
    expect(second.runId).toBe(first.runId);
  });

  it('equals the runId recorders saw on the run events (one joinable id)', async () => {
    const seen: string[] = [];
    const recorder: FlowRecorder = {
      id: 'rec-runid',
      onRunStart: (e) => {
        if (e.traversalContext?.runId) seen.push(e.traversalContext.runId);
      },
    };

    const executor = new FlowChartExecutor(simpleChart());
    executor.attachFlowRecorder(recorder);
    await executor.run();

    expect(seen).toHaveLength(1);
    expect(executor.getSnapshot().runId).toBe(seen[0]);
  });
});

describe('getSnapshot().runId — fresh per run()', () => {
  it('differs across two sequential run() calls on the same executor', async () => {
    const executor = new FlowChartExecutor(simpleChart());

    await executor.run();
    const firstRunId = executor.getSnapshot().runId;

    await executor.run();
    const secondRunId = executor.getSnapshot().runId;

    expect(firstRunId.length).toBeGreaterThan(0);
    expect(secondRunId.length).toBeGreaterThan(0);
    expect(secondRunId).not.toBe(firstRunId);
  });
});

describe('getSnapshot().runId — fresh per resume()', () => {
  it('same-executor resume regenerates runId (resume = logically distinct run)', async () => {
    const executor = new FlowChartExecutor(pausableChart());

    const runResult = await executor.run();
    expect((runResult as { paused?: boolean }).paused).toBe(true);
    const pausedRunId = executor.getSnapshot().runId;
    expect(pausedRunId.length).toBeGreaterThan(0);

    await executor.resume(executor.getCheckpoint()!, { approved: true });
    const resumedSnapshot = executor.getSnapshot();

    expect(resumedSnapshot.sharedState.value).toBe('done'); // resume really completed
    expect(resumedSnapshot.runId.length).toBeGreaterThan(0);
    expect(resumedSnapshot.runId).not.toBe(pausedRunId);
  });

  it('cross-executor resume gets its own runId too', async () => {
    const executor = new FlowChartExecutor(pausableChart());
    const runResult = await executor.run();
    expect((runResult as { paused?: boolean }).paused).toBe(true);
    const pausedRunId = executor.getSnapshot().runId;

    // Fresh executor, resumed purely from the detached checkpoint.
    const checkpoint = executor.getCheckpoint()!;
    const fresh = new FlowChartExecutor(pausableChart());
    await fresh.resume(checkpoint, { approved: true });
    const resumedSnapshot = fresh.getSnapshot();

    expect(resumedSnapshot.sharedState.value).toBe('done');
    expect(resumedSnapshot.runId.length).toBeGreaterThan(0);
    expect(resumedSnapshot.runId).not.toBe(pausedRunId);
  });
});
