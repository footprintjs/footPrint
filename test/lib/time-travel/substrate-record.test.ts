/** Reader compatibility; engine seed/resume/serving witnesses stay in substrate.test.ts. */
import { stateAt, timeTravel } from '../../../src/trace';
import { recordRun } from '../../helpers/recordRun';

describe('the fold base is optional, but never invented', () => {
  it('says `log-only` when no base travelled with the log', () => {
    const run = recordRun({ tenant: 'acme' });
    run.step('touch', (scope) => scope.set('touched', true));
    const snapshot = run.snapshot();
    const old = { commitLog: snapshot.commitLog };
    const folded = stateAt(old, 0);
    expect(folded.basis).toBe('log-only');
    expect(folded.state).toEqual({ touched: true });
    expect(stateAt(snapshot, 0).basis).toBe('initial+log');
  });
});

describe('back-compat — a 9.16.x snapshot still folds and still compiles', () => {
  it('a snapshot literal built WITHOUT a fold base folds from `{}` and says so', () => {
    // The shape a UI fixture or a stored 9.16.x trace has: no `initialState`.
    const legacy = {
      runId: 'r-legacy',
      sharedState: { n: 2 },
      executionTree: { id: 'root', logs: {}, errors: {}, metrics: {}, evals: {} },
      commitLog: [
        {
          idx: 0,
          stage: 'BUMP',
          stageId: 'bump',
          runtimeStageId: 'bump#0',
          trace: [{ path: 'n', verb: 'set' as const }],
          redactedPaths: [],
          overwrite: { n: 2 },
          updates: {},
        },
      ],
      commitValues: 'full' as const,
      writeProvenance: 'off' as const,
    };

    const folded = stateAt(legacy as never, 0);
    expect(folded.basis).toBe('log-only');
    expect(folded.state).toEqual({ n: 2 });

    // …and the cursor works over it: `initialState` is optional, not assumed.
    const cursor = timeTravel(legacy as never);
    expect(cursor.stops.map((s) => s.kind)).toEqual(['start', 'commit', 'end']);
    cursor.last();
    expect(cursor.stateAt().basis).toBe('log-only');
  });
});
