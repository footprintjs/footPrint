import { describe, expect, it } from 'vitest';

import { FlowChartExecutor } from '../../src/index.js';
import { HEALTHY, RESUME_CHARTS, drive } from '../lib/pause/resume-real-chart-fixture.js';
import {
  answer,
  askChart,
  business,
  choiceScenario,
  describeError,
  jsonCheckpoint,
  report,
  scenario,
} from './baseline.fixtures.js';

describe('native pause law baseline', () => {
  it.each([
    { score: -1, picks: [] as string[], mount: false },
    { score: 1, picks: ['a'], mount: true },
    { score: 1, picks: ['a', 'b'], mount: true },
  ])('records declared rule/default, selector and mount paths: %j', async ({ score, picks, mount }) => {
    const decisions: unknown[] = [];
    const selections: unknown[] = [];
    const direct = new FlowChartExecutor(choiceScenario('direct', score, picks, mount));
    direct.attachFlowRecorder({
      id: 'path-facts',
      onDecision: (event) => {
        decisions.push({ decider: event.decider, chosen: event.chosen, evidence: event.evidence });
      },
      onSelected: (event) => {
        selections.push({
          parent: event.parent,
          selected: event.selected,
          total: event.total,
          evidence: event.evidence,
        });
      },
    });
    await direct.run();
    const resumed = await drive(choiceScenario('pause', score, picks, mount), 'cross', { collectLegs: false });
    const project = (state: Record<string, unknown>) => ({
      route: state.route,
      runs: state.runs,
      mounted: state.mounted,
      approved: state.approved,
    });
    report('paths.' + score + '.' + picks.length, 'comparison', {
      decisions,
      selections,
      direct: project(direct.getSnapshot().sharedState),
      resumed: project(resumed.state),
    });
    expect(project(resumed.state)).toEqual(project(direct.getSnapshot().sharedState));
    expect(decisions).toHaveLength(2);
    expect(decisions[0]).toMatchObject({ chosen: score > 0 ? 'High' : 'Low', evidence: expect.any(Object) });
    expect(selections).toHaveLength(1);
    expect(selections[0]).toMatchObject({ selected: picks.map((id) => id.toUpperCase()), total: 2 });
  });
  for (const kind of ['handler', 'interrupt'] as const) {
    for (const nested of [false, true]) {
      it(`${kind}/${nested ? 'nested' : 'root'}: fresh JSON resume preserves declared business state`, async () => {
        const direct = new FlowChartExecutor(scenario('direct', kind, 3, nested));
        await direct.run();
        const resumed = await drive(scenario('pause', kind, 3, nested), 'cross', {
          answer: (_n, cp) => answer((cp.pauseData as { round: number }).round),
          maxPauses: 4,
          collectLegs: false,
        });
        const actual = business(resumed.state);
        report(`pause.${kind}.${nested ? 'nested' : 'root'}`, 'comparison', {
          direct: business(direct.getSnapshot().sharedState),
          resumed: actual,
          pauses: resumed.pauses,
          pausedAtEnd: resumed.executor.isPaused(),
        });
        expect(resumed.executor.isPaused()).toBe(false);
        expect(resumed.pauses).toBe(3);
        expect(actual).toEqual(business(direct.getSnapshot().sharedState));
      });
    }
  }

  it.each([0, 1, 10])('keeps finite scenario counts honest at %s declared occurrences', async (count) => {
    const direct = new FlowChartExecutor(scenario('direct', 'handler', count));
    await direct.run();
    const resumed = await drive(scenario('pause', 'handler', count), 'cross', {
      answer: (n) => answer(n),
      maxPauses: count + 1,
      collectLegs: false,
    });
    report('bounds.' + count, 'comparison', {
      declared: count,
      actualPauses: resumed.pauses,
      paused: resumed.executor.isPaused(),
    });
    expect(resumed.executor.isPaused()).toBe(false);
    expect(resumed.pauses).toBe(count);
    expect(business(resumed.state)).toEqual(business(direct.getSnapshot().sharedState));
  });

  it('exposes exhaustion as still paused, not as a successful parity result', async () => {
    const run = await drive(scenario('pause', 'handler', 2), 'cross', {
      answer: (n) => answer(n),
      maxPauses: 1,
      collectLegs: false,
    });
    report('bounds.exhaustion', 'unfinished', {
      answered: run.pauses,
      paused: run.executor.isPaused(),
      state: business(run.state),
    });
    expect(run.pauses).toBe(1);
    expect(run.executor.isPaused()).toBe(true);
  });

  it.each(['askLoopInSubflow', 'pauseEveryPass', 'twoDeep'] as const)(
    'reuses the real-chart %s anchor without copying its body',
    async (name) => {
      const result = await drive(RESUME_CHARTS[name](), 'cross', { collectLegs: false });
      report('anchor.' + name, 'fixture-observation', {
        trace: result.trace,
        pauses: result.pauses,
        paused: result.executor.isPaused(),
      });
      expect(result.executor.isPaused()).toBe(false);
      expect({ trace: result.trace, pauses: result.pauses }).toEqual(HEALTHY[name]);
    },
  );

  it('detaches the JSON checkpoint before caller changes and refuses accessor metadata without running it', async () => {
    const first = new FlowChartExecutor(askChart());
    await first.run();
    const detached = jsonCheckpoint(first);
    const originalId = detached.pausedStageId;
    const callerCopy = jsonCheckpoint(first);
    Object.assign(callerCopy, { pausedStageId: 'changed' });
    expect(detached.pausedStageId).toBe(originalId);
    let reads = 0;
    Object.defineProperty(callerCopy, 'pausedStageId', {
      get() {
        reads++;
        throw new Error('metadata getter');
      },
    });
    const fresh = new FlowChartExecutor(askChart());
    let failure: unknown;
    try {
      await fresh.resume(callerCopy, true);
    } catch (error) {
      failure = error;
    }
    report('checkpoint.admission', 'observation', { failure: describeError(failure), getterCalls: reads, originalId });
    expect(failure).toBeDefined();
    expect(reads).toBe(0);
    await fresh.resume(detached, true);
    expect(fresh.getSnapshot().sharedState.answer).toBe(true);
  });
});
