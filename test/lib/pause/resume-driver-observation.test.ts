/**
 * The resume driver collects observations only when its caller needs them.
 * Count public snapshot reads, not wall time: the property needs final state,
 * while the invariant tests still need a snapshot of every execution leg.
 */

import { type MockInstance, describe, expect, it, vi } from 'vitest';

import type { FlowChart } from '../../../src/index.js';
import { flowChart, FlowChartExecutor } from '../../../src/index.js';
import { type ResumeMode, type S, drive, HEALTHY, pauseEveryPassChart } from './resume-real-chart-fixture.js';

function instrumentExecutors() {
  const observations: Array<{
    snapshot: MockInstance<FlowChartExecutor['getSnapshot']>;
    checkpoint: MockInstance<FlowChartExecutor['getCheckpoint']>;
    resume: MockInstance<FlowChartExecutor['resume']>;
  }> = [];
  const newExecutor = vi.fn((chart: FlowChart) => {
    const executor = new FlowChartExecutor(chart);
    observations.push({
      snapshot: vi.spyOn(executor, 'getSnapshot'),
      checkpoint: vi.spyOn(executor, 'getCheckpoint'),
      resume: vi.spyOn(executor, 'resume'),
    });
    return executor;
  });
  return { observations, newExecutor };
}

const collectionModes = [
  { name: 'default collection', collectLegs: undefined },
  { name: 'final state only', collectLegs: false },
] as const;

describe.each<ResumeMode>(['same', 'cross'])('resume driver observations — %s-executor', (mode) => {
  describe.each(collectionModes)('$name', ({ collectLegs }) => {
    it.each([
      { name: 'no pauses', plannedPauses: 0, maxPauses: 12, expectedPauses: 0 },
      { name: 'multiple pauses', plannedPauses: 3, maxPauses: 12, expectedPauses: 3 },
      { name: 'pause limit reached', plannedPauses: 3, maxPauses: 1, expectedPauses: 1 },
    ])(
      '$name: avoids redundant snapshots without changing the drive',
      async ({ plannedPauses, maxPauses, expectedPauses }) => {
        const chart =
          plannedPauses === 0
            ? flowChart(
                'Done',
                (s: S) => {
                  s.trace = ['done'];
                },
                'done',
              ).build()
            : pauseEveryPassChart();
        const { observations, newExecutor } = instrumentExecutors();
        const run = await drive(chart, mode, { collectLegs, maxPauses, newExecutor });
        const snapshots = observations.flatMap(({ snapshot }) => snapshot.mock.results);
        const checkpoints = observations.flatMap(({ checkpoint }) => checkpoint.mock.results);
        const resumes = observations.flatMap(({ resume }) => resume.mock.calls);

        expect(newExecutor).toHaveBeenCalledTimes(mode === 'same' ? 1 : expectedPauses + 1);
        expect(resumes).toHaveLength(expectedPauses);
        expect(checkpoints).toHaveLength(expectedPauses);
        expect(run.pauses).toBe(expectedPauses);
        expect(run.checkpoints).toHaveLength(expectedPauses);
        expect(run.executor.isPaused()).toBe(expectedPauses < plannedPauses);
        expect(snapshots).toHaveLength(collectLegs === false ? 1 : expectedPauses + 1);
        expect(run.legs).toHaveLength(collectLegs === false ? 0 : expectedPauses + 1);
        expect(run.state).toBe(snapshots.at(-1)?.value.sharedState);
        expect(run.trace).toEqual(run.state.trace);
        if (collectLegs !== false) expect(run.legs.at(-1)).toBe(snapshots.at(-1)?.value);
        if (plannedPauses === 0) expect(run.trace).toEqual(['done']);
        if (expectedPauses === 3) expect(run.trace).toEqual(HEALTHY.pauseEveryPass.trace);

        for (let i = 0; i < expectedPauses; i++) {
          const raw = checkpoints[i].value;
          const served = run.checkpoints[i];
          expect(resumes[i][0]).toBe(served);
          if (mode === 'same') {
            expect(served).toBe(raw);
          } else {
            expect(served).not.toBe(raw);
            expect(served).toEqual(JSON.parse(JSON.stringify(raw)));
            expect(served.sharedState).not.toBe(raw.sharedState);
            expect(served.subflowStates).not.toBe(raw.subflowStates);
          }
        }
      },
    );

    it('does not swallow an answer failure', async () => {
      const failure = new Error('answer refused');
      const { observations, newExecutor } = instrumentExecutors();
      await expect(
        drive(pauseEveryPassChart(), mode, {
          collectLegs,
          newExecutor,
          answer: () => {
            throw failure;
          },
        }),
      ).rejects.toBe(failure);
      expect(observations.flatMap(({ resume }) => resume.mock.calls)).toHaveLength(0);
    });
  });

  it.each([1, 12])('collection does not change state or checkpoint observations (limit %s)', async (maxPauses) => {
    const complete = await drive(pauseEveryPassChart(), mode, { maxPauses });
    const finalOnly = await drive(pauseEveryPassChart(), mode, { collectLegs: false, maxPauses });
    expect(finalOnly.state).toEqual(complete.state);
    expect(finalOnly.trace).toEqual(complete.trace);
    expect(finalOnly.pauses).toBe(complete.pauses);
    expect(finalOnly.executor.isPaused()).toBe(complete.executor.isPaused());
    expect(finalOnly.checkpoints.map(({ pauseData }) => pauseData)).toEqual(
      complete.checkpoints.map(({ pauseData }) => pauseData),
    );
    expect(finalOnly.checkpoints.map(({ subflowPath }) => subflowPath)).toEqual(
      complete.checkpoints.map(({ subflowPath }) => subflowPath),
    );
  });
});
