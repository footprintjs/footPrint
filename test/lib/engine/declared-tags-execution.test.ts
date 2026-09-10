/**
 * Declared tags (9.21.0) — the RUN-TIME half: the names an author declared
 * are stamped on the stage's commit bundle, exactly once per execution,
 * on every commit path the engine has.
 *
 * The stamp rides `runtimeStageId` (`FlowchartTraverser.executeNodeStep`)
 * and lands in `StageContext.commit` on BOTH commit paths (the zero-buffer
 * fast path included — an empty commit is a deliberate stop), then releases,
 * so a routine second commit on the same context (a fork child's fan-out
 * repeat, a mount's exit bundle) carries none: the once-per-execution law
 * `untrackedSources` already keeps.
 *
 * Test types: Functional (empty commit, both encodings, not inherited) ·
 * Scenario (retry, fork, subflow, decider, loop) · Integration (pause →
 * cross-executor resume; `interrupt()` → resume) · Regression (the error
 * path commits before it rethrows, so a failed stage keeps its tag).
 */
import { describe, expect, it } from 'vitest';

import type { CommitBundle, FlowchartCheckpoint, FlowRecorder, PausableHandler } from '../../../src/index.js';
import { flowChart, FlowChartExecutor, interrupt } from '../../../src/index.js';
import { tagStops, timeTravel } from '../../../src/trace.js';

interface State {
  n?: number;
  a?: number;
  b?: number;
  attempts?: number;
  trail?: string[];
  route?: string;
  summary?: string;
  approved?: boolean;
  count?: number;
  answer?: string;
  [key: string]: unknown;
}

const noop = () => undefined;

/** Bundles of one stage, in log order. */
const bundlesOf = (log: readonly CommitBundle[], stageId: string) => log.filter((b) => b.stageId === stageId);

describe('a tag is stamped on the bundle', () => {
  for (const commitValues of ['full', 'delta'] as const) {
    it(`an EMPTY commit carries the tag; the next (untagged) stage carries none — commitValues: ${commitValues}`, async () => {
      const chart = flowChart<State>(
        'Seed',
        (s) => {
          s.n = 1;
        },
        'seed',
      )
        .addFunction(
          'Idle',
          (s) => {
            if (s.n === undefined) throw new Error('seed did not run');
          },
          'idle',
        )
        .tag('milestone:idle', 'audit')
        .addFunction(
          'After',
          (s) => {
            s.n = 2;
          },
          'after',
        )
        .build();
      const executor = new FlowChartExecutor(chart, { commitValues });
      await executor.run();
      const log = executor.getSnapshot().commitLog;

      const [idle] = bundlesOf(log, 'idle');
      expect(idle.trace).toEqual([]);
      expect(idle.tags).toEqual(['milestone:idle', 'audit']);
      // Per-node identity: NOT inherited by the next context.
      expect(bundlesOf(log, 'after')[0]).not.toHaveProperty('tags');
      expect(bundlesOf(log, 'seed')[0]).not.toHaveProperty('tags');
      // The fragment is added after the payload encoding — same bytes either way.
      expect(Object.keys(idle)).toContain('tags');
    });
  }

  it('a stage that runs twice (a loop) is stamped on both executions', async () => {
    const chart = flowChart<State>(
      'Seed',
      (s) => {
        s.count = 0;
      },
      'seed',
    )
      .addFunction(
        'Bump',
        (s) => {
          s.count = (s.count ?? 0) + 1;
        },
        'bump',
      )
      .tag('iteration')
      .addDeciderFunction('More?', (s) => ((s.count ?? 0) < 3 ? 'again' : 'done'), 'more')
      .addFunctionBranch('again', 'Again', noop, undefined, { loopTo: 'bump' })
      .addFunctionBranch('done', 'Done', noop)
      .end()
      .build();
    const executor = new FlowChartExecutor(chart);
    await executor.run();
    const bumps = bundlesOf(executor.getSnapshot().commitLog, 'bump');
    expect(bumps.length).toBe(3);
    expect(bumps.map((b) => b.tags)).toEqual([['iteration'], ['iteration'], ['iteration']]);
    expect(new Set(bumps.map((b) => b.runtimeStageId)).size).toBe(3);
  });
});

describe('retry — one stamp regardless of attempts', () => {
  it('a stage that fails twice under attempts: 3 records ONE tagged bundle', async () => {
    let calls = 0;
    const retries: number[] = [];
    const recorder: FlowRecorder = { id: 'retries', onStageRetry: (e) => retries.push(e.attempt) };
    const chart = flowChart<State>('Seed', noop, 'seed')
      .addFunction(
        'Flaky',
        (s) => {
          calls += 1;
          s.attempts = calls;
          if (calls < 3) throw new Error(`attempt ${calls}`);
        },
        'flaky',
      )
      .retry({ attempts: 3, backoffMs: 0 })
      .tag('milestone:tool-call')
      .build();
    const executor = new FlowChartExecutor(chart);
    executor.attachFlowRecorder(recorder);
    await executor.run();

    expect(retries.length).toBe(2);
    const flaky = bundlesOf(executor.getSnapshot().commitLog, 'flaky');
    expect(flaky.length).toBe(1);
    expect(flaky[0].tags).toEqual(['milestone:tool-call']);
    expect(executor.getSnapshot().sharedState.attempts).toBe(3);
  });

  it('the error path commits before it rethrows, so a FAILED stage keeps its tag', async () => {
    const chart = flowChart<State>('Seed', noop, 'seed')
      .addFunction(
        'Boom',
        (s) => {
          s.n = 7;
          throw new Error('boom');
        },
        'boom',
      )
      .tag('milestone:llm-turn')
      .build();
    const executor = new FlowChartExecutor(chart);
    await expect(executor.run()).rejects.toThrow('boom');
    const boom = bundlesOf(executor.getSnapshot().commitLog, 'boom');
    expect(boom.length).toBe(1);
    expect(boom[0].tags).toEqual(['milestone:llm-turn']);
    expect(boom[0].overwrite).toEqual({ n: 7 });
  });
});

describe('fork children — each child carries its own tag, once', () => {
  it('two tagged children, an untagged parent; the fan-out repeat bundle carries none', async () => {
    const chart = flowChart<State>(
      'Seed',
      (s) => {
        s.n = 1;
      },
      'seed',
    )
      .addFunction('Fork', noop, 'fork')
      .addListOfFunction([
        {
          id: 'child-a',
          name: 'A',
          fn: (s) => {
            s.a = 10;
          },
          tags: ['branch:a'],
        },
        {
          id: 'child-b',
          name: 'B',
          fn: (s) => {
            s.b = 20;
          },
          tags: ['branch:b', 'audit'],
        },
      ])
      .addFunction(
        'Merge',
        (s) => {
          s.n = (s.a ?? 0) + (s.b ?? 0);
        },
        'merge',
      )
      .build();
    const executor = new FlowChartExecutor(chart);
    await executor.run();
    const log = executor.getSnapshot().commitLog;

    const a = bundlesOf(log, 'child-a');
    const b = bundlesOf(log, 'child-b');
    // Each child commits twice (stage funnel + fan-out); the SECOND is the empty repeat.
    expect(a.length).toBe(2);
    expect(b.length).toBe(2);
    expect(a[0].tags).toEqual(['branch:a']);
    expect(b[0].tags).toEqual(['branch:b', 'audit']);
    expect(a[1]).not.toHaveProperty('tags');
    expect(b[1]).not.toHaveProperty('tags');
    expect(bundlesOf(log, 'fork')[0]).not.toHaveProperty('tags');
    expect(bundlesOf(log, 'merge')[0]).not.toHaveProperty('tags');
  });
});

describe('subflow — the prefixed node keeps the tag; the subflow’s own log carries it', () => {
  it('inner tags land in the subflow’s log; the mount’s tag lands on its merge-back bundle in the parent log', async () => {
    const inner = flowChart<State>(
      'Inner seed',
      (s) => {
        s.count = 1;
      },
      'inner-seed',
    )
      .tag('inner:seed')
      .addFunction(
        'Inner work',
        (s) => {
          s.summary = `c${s.count}`;
        },
        'inner-work',
      )
      .tag('milestone:llm-turn')
      .build();
    const chart = flowChart<State>(
      'Seed',
      (s) => {
        s.n = 1;
      },
      'seed',
    )
      .addSubFlowChartNext('sf', inner, 'Sub', {
        inputMapper: (parent: State) => ({ n: parent.n }),
        outputMapper: (out: State) => ({ summary: out.summary }),
      })
      .tag('milestone:tool-call')
      .addFunction(
        'Finish',
        (s) => {
          s.trail = [s.summary ?? ''];
        },
        'finish',
      )
      .build();
    const executor = new FlowChartExecutor(chart);
    await executor.run();
    const snapshot = executor.getSnapshot();

    // The parent log: only the mount is tagged, on its FIRST bundle (the
    // output-mapping commit), not on the exit repeat.
    const mount = bundlesOf(snapshot.commitLog, 'sf');
    expect(mount.length).toBe(2);
    expect(mount[0].tags).toEqual(['milestone:tool-call']);
    expect(mount[0].overwrite).toEqual({ summary: 'c1' });
    expect(mount[1]).not.toHaveProperty('tags');
    expect(snapshot.commitLog.filter((b) => b.tags).map((b) => b.stageId)).toEqual(['sf']);

    // The subflow's own log: the prefixed ids, each with its tag.
    const sub = snapshot.subflowResults.sf as { treeContext: { history: CommitBundle[] } };
    const tagged = sub.treeContext.history.filter((b) => b.tags).map((b) => [b.stageId, b.tags] as const);
    expect(tagged).toEqual([
      ['sf/inner-seed', ['inner:seed']],
      ['sf/inner-work', ['milestone:llm-turn']],
    ]);
    // …and `drill` reads them straight off that log.
    const cursor = timeTravel(snapshot, { strategy: tagStops() });
    const child = cursor.drill(mount[0].runtimeStageId)!;
    // The prefixer twins prefix names as well as ids — the shipped law.
    expect(child.stops.map((s) => s.label)).toEqual(['Run start', 'sf/Inner seed', 'sf/Inner work', 'Run end']);
    expect(child.stops[2].meta).toEqual(['milestone:llm-turn']);
  });
});

describe('decider — the decider stage and the chosen branch each carry their own', () => {
  it('a tagged decider, a tagged chosen branch, an untagged unchosen one', async () => {
    const chart = flowChart<State>(
      'Seed',
      (s) => {
        s.n = 5;
      },
      'seed',
    )
      .addDeciderFunction('Route', (s) => ((s.n ?? 0) > 3 ? 'high' : 'low'), 'route', undefined, {
        tags: ['milestone:decision'],
      })
      .addFunctionBranch(
        'high',
        'High',
        (s) => {
          s.route = 'high';
        },
        undefined,
        { tags: ['went-high'] },
      )
      .addFunctionBranch(
        'low',
        'Low',
        (s) => {
          s.route = 'low';
        },
        undefined,
        { tags: ['went-low'] },
      )
      .end()
      .build();
    const executor = new FlowChartExecutor(chart);
    await executor.run();
    const log = executor.getSnapshot().commitLog;
    expect(log.map((b) => [b.stageId, b.tags])).toEqual([
      ['seed', undefined],
      ['route', ['milestone:decision']],
      ['high', ['went-high']],
    ]);
  });
});

describe('pause → resume on a fresh executor: tags per leg', () => {
  const gate: PausableHandler<any> = {
    execute: async () => ({ question: 'Approve?' }),
    resume: async (scope: State, input: unknown) => {
      scope.approved = (input as { approved?: boolean } | undefined)?.approved ?? false;
    },
  };

  it('the paused leg and the resumed leg each stamp the gate; the chain shows both', async () => {
    const chart = flowChart<State>(
      'Seed',
      (s) => {
        s.n = 1;
      },
      'seed',
    )
      .addPausableFunction('Gate', gate, 'gate')
      .tag('milestone:approval')
      .addFunction(
        'Finish',
        (s) => {
          s.trail = ['done'];
        },
        'finish',
      )
      .build();

    const before = new FlowChartExecutor(chart);
    await before.run();
    const checkpoint = before.getCheckpoint()!;
    const paused = before.getSnapshot();
    // The checkpoint carries no commit log — nothing to survive it.
    expect(JSON.stringify(checkpoint)).not.toContain('"tags"');

    const after = new FlowChartExecutor(chart);
    await after.resume(checkpoint, { approved: true });
    const resumed = after.getSnapshot();

    expect(bundlesOf(paused.commitLog, 'gate').map((b) => b.tags)).toEqual([['milestone:approval']]);
    expect(bundlesOf(resumed.commitLog, 'gate').map((b) => b.tags)).toEqual([['milestone:approval']]);

    const cursor = timeTravel([paused, resumed], { strategy: tagStops(['milestone:approval']) });
    const gates = cursor.stops.filter((s) => s.kind === 'commit');
    expect(gates.map((s) => [s.sourceIdx, s.runtimeStageId, s.meta])).toEqual([
      [0, 'gate#1', ['milestone:approval']],
      [1, 'gate#2', ['milestone:approval']],
    ]);
  });
});

describe('interrupt() → resume: two tagged stops, because the stage ran twice', () => {
  function buildRefundChart() {
    return flowChart<State>(
      'Refund',
      (scope) => {
        scope.n = 4200;
        const answer = interrupt<{ approved: boolean }>(scope, { reason: 'Approve?' });
        scope.approved = answer.approved;
      },
      'refund',
    )
      .tag('milestone:approval')
      .addFunction(
        'Finish',
        (s) => {
          s.trail = ['done'];
        },
        'finish',
      )
      .build();
  }

  it('the interrupted run tags the stage; the resumed run tags it again', async () => {
    const chart = buildRefundChart();
    const first = new FlowChartExecutor(chart);
    const pausedResult = await first.run();
    const checkpoint = (pausedResult as { checkpoint: FlowchartCheckpoint }).checkpoint;
    const paused = first.getSnapshot();

    const second = new FlowChartExecutor(chart);
    await second.resume(checkpoint, { approved: true });
    const resumed = second.getSnapshot();

    expect(bundlesOf(paused.commitLog, 'refund').map((b) => b.tags)).toEqual([['milestone:approval']]);
    expect(bundlesOf(resumed.commitLog, 'refund').map((b) => b.tags)).toEqual([['milestone:approval']]);

    const cursor = timeTravel([paused, resumed], { strategy: tagStops() });
    expect(cursor.stops.filter((s) => s.kind === 'commit').map((s) => [s.sourceIdx, s.stageId])).toEqual([
      [0, 'refund'],
      [1, 'refund'],
    ]);
  });
});
