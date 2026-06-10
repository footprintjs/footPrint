/**
 * Byte-identity probe for #13b (release buffer/stateView at commit end).
 *
 * Runs representative charts and dumps commit logs + shared state + narrative
 * + execution tree (stageWrites/stageReads) as canonical JSON. Run ONCE on
 * pre-fix code, save the output, apply the fix, run again, `diff` the two
 * files. Any difference is an observable behavior change — must be zero for
 * the covered scenarios.
 *
 * Scenarios (each one exercises a verified commit-lifecycle corner):
 *   1. sequential        — linear chain: writes / reads / no-touch /
 *                          same-value write (net-no-change commit)
 *   2. fork              — parallel children (the routine DOUBLE-COMMIT path:
 *                          executeNode commits at FlowchartTraverser:1037,
 *                          then ChildrenExecutor's wrapper commits the SAME
 *                          child context again — post-release the second
 *                          commit must take the empty fast path and record a
 *                          byte-identical empty bundle)
 *   3. forkError         — a child throws (commit-on-error at traverser:1031
 *                          + the wrapper's second commit in the catch path)
 *   4. subflow           — mount with input/output mappers (seed-commit via
 *                          seedSubflowGlobalStore; SubflowExecutor REPLACES
 *                          the seeded root context, then the parent mount
 *                          context commits TWICE: outputContext.commit() at
 *                          :282 + parentContext.commit() at :317)
 *   5. forkSubflowBranch — selector fork where one branch is a SUBFLOW whose
 *                          outputMapper writes parent ROOT keys mid-fork (the
 *                          #13 first-touch anchor scenario: a sibling's
 *                          root-key commit lands while another branch is in
 *                          flight; outputContext = parentContext.parent)
 *   6. throttledFork     — fork child throws a throttling error; the engine
 *                          writes monitor.isThrottled AFTER the wrapper's
 *                          commit (ChildrenExecutor:71) — a post-commit WRITE
 *                          on a released context (staged, never committed —
 *                          must still land in stageWrites, not sharedState)
 *   7. deciderLoop       — branch loop, multiple executions of same stageId
 *   8. pauseResumeSame   — same-executor resume. NOTE: resume does NOT reuse
 *                          the paused StageContext — FlowChartExecutor walks
 *                          to the chain leaf and `leaf.createNext(...)` makes
 *                          a FRESH context for the resume chain. The pause
 *                          commit (traverser:1027) is that context's LAST use.
 *   9. pauseResumeCorner — resumeFn rewrites a key to its RUN-START value;
 *                          proves the resume diff base is the post-pause
 *                          state (a real change must be recorded)
 *
 * Usage: npx tsx scripts/byte-identity-probe.ts /tmp/probe.json
 * (output goes to the file — engine loggers write errors to stdout, which is
 * expected noise for the error scenarios)
 */

import { writeFileSync } from 'fs';

import { flowChart, FlowChartExecutor } from '../src/index';
import type { PausableHandler } from '../src/index';

type Loose = Record<string, unknown>;

/** JSON round-trip + recursive strip of volatile fields (timestamps). */
function canonical(value: unknown): unknown {
  const stripped = JSON.parse(JSON.stringify(value) ?? 'null');
  const strip = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(strip);
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        if (k === 'timestamp') continue; // Date.now() — varies per run
        out[k] = strip(val);
      }
      return out;
    }
    return v;
  };
  return strip(stripped);
}

async function snapshotOf(executor: FlowChartExecutor): Promise<Record<string, unknown>> {
  const snap = executor.getSnapshot();
  return {
    commitLog: canonical(snap.commitLog),
    sharedState: canonical(snap.sharedState),
    executionTree: canonical(snap.executionTree),
    narrative: canonical(executor.getNarrativeEntries().map((e) => ({ ...e }))),
  };
}

async function scenarioSequential() {
  const chart = flowChart<Loose>(
    'Seed',
    async (scope) => {
      scope.$setValue('greeting', 'hello');
      scope.$setValue('config', { retries: 3 });
    },
    'seed',
  )
    .addFunction(
      'ReadWrite',
      async (scope) => {
        const g = scope.$getValue('greeting');
        scope.$setValue('echo', `${g}-back`);
      },
      'read-write',
    )
    .addFunction('NoTouch', async () => undefined, 'no-touch')
    .addFunction(
      'SameValue',
      async (scope) => {
        scope.$setValue('greeting', 'hello'); // net no-change
      },
      'same-value',
    )
    .build();
  const executor = new FlowChartExecutor(chart);
  executor.enableNarrative();
  await executor.run();
  return snapshotOf(executor);
}

async function scenarioFork(withError: boolean) {
  const chart = flowChart<Loose>(
    'Seed',
    async (scope) => {
      scope.$setValue('k', 'orig');
    },
    'seed',
  )
    .addListOfFunction([
      {
        id: 'child-a',
        name: 'ChildA',
        fn: async (scope: Loose & { $setValue(k: string, v: unknown): void }) => {
          scope.$setValue('a', 1);
        },
      },
      {
        id: 'child-b',
        name: 'ChildB',
        fn: async (scope: Loose & { $setValue(k: string, v: unknown): void }) => {
          scope.$setValue('b', 2);
          if (withError) throw new Error('child-b boom');
        },
      },
    ])
    .addFunction(
      'Join',
      async (scope) => {
        scope.$setValue('joined', true);
      },
      'join',
    )
    .build();
  const executor = new FlowChartExecutor(chart);
  executor.enableNarrative();
  await executor.run();
  return snapshotOf(executor);
}

async function scenarioSubflow() {
  const inner = flowChart<Loose>(
    'InnerWork',
    async (scope) => {
      scope.$setValue('innerResult', `got:${scope.$getValue('seededKey')}`);
    },
    'inner-work',
  )
    .addFunction(
      'InnerSecond',
      async (scope) => {
        scope.$setValue('innerSecond', true);
      },
      'inner-second',
    )
    .build();

  const chart = flowChart<Loose>(
    'Outer',
    async (scope) => {
      scope.$setValue('outerKey', 'outer-value');
    },
    'outer',
  )
    .addSubFlowChartNext('sf-inner', inner, 'Inner', {
      inputMapper: () => ({ seededKey: 'seeded-value' }),
      outputMapper: (out: Loose) => ({ innerResult: out.innerResult }),
    })
    .addFunction(
      'After',
      async (scope) => {
        scope.$setValue('after', scope.$getValue('innerResult'));
      },
      'after',
    )
    .build();
  const executor = new FlowChartExecutor(chart);
  executor.enableNarrative();
  await executor.run();
  return snapshotOf(executor);
}

async function scenarioForkSubflowBranch() {
  const inner = flowChart<Loose>(
    'BranchWork',
    async (scope) => {
      scope.$setValue('branchResult', 'from-subflow');
    },
    'branch-work',
  ).build();

  const chart = flowChart<Loose>(
    'Seed',
    async (scope) => {
      scope.$setValue('k', 'orig');
    },
    'seed',
  )
    .addSelectorFunction('PickBoth', async () => ['plain', 'sf-branch'], 'pick-both')
    .addFunctionBranch('plain', 'Plain', async (scope: Loose & { $setValue(k: string, v: unknown): void }) => {
      scope.$setValue('plainDone', true);
    })
    .addSubFlowChartBranch('sf-branch', inner, 'SubflowBranch', {
      // outputMapper writes a parent ROOT key mid-fork — the #13
      // first-touch anchor case (sibling root-key commit in flight).
      outputMapper: (out: Loose) => ({ branchResult: out.branchResult }),
    })
    .end()
    .addFunction(
      'Join',
      async (scope) => {
        scope.$setValue('joined', scope.$getValue('branchResult'));
      },
      'join',
    )
    .build();
  const executor = new FlowChartExecutor(chart);
  executor.enableNarrative();
  await executor.run();
  return snapshotOf(executor);
}

async function scenarioThrottledFork() {
  const chart = flowChart<Loose>(
    'Seed',
    async (scope) => {
      scope.$setValue('k', 'orig');
    },
    'seed',
  )
    .addListOfFunction([
      {
        id: 'ok-child',
        name: 'OkChild',
        fn: async (scope: Loose & { $setValue(k: string, v: unknown): void }) => {
          scope.$setValue('ok', true);
        },
      },
      {
        id: 'throttled-child',
        name: 'ThrottledChild',
        fn: async () => {
          throw new Error('429 rate limited');
        },
      },
    ])
    .addFunction(
      'Join',
      async (scope) => {
        scope.$setValue('joined', true);
      },
      'join',
    )
    .build();
  const executor = new FlowChartExecutor(chart, {
    throttlingErrorChecker: (error: unknown) => String(error).includes('429'),
  });
  executor.enableNarrative();
  await executor.run();
  return snapshotOf(executor);
}

async function scenarioDeciderLoop() {
  const chart = flowChart<Loose>(
    'Seed',
    async (scope) => {
      scope.$setValue('i', 0);
      scope.$setValue('history', []);
    },
    'seed',
  )
    .addFunction(
      'Work',
      async (scope) => {
        const i = scope.$getValue('i') as number;
        scope.$batchArray('history', (arr) => {
          arr.push({ idx: i });
        });
        scope.$setValue('i', i + 1);
        if (i + 1 >= 5) scope.$break();
      },
      'work',
    )
    .loopTo('work')
    .build();
  const executor = new FlowChartExecutor(chart);
  executor.enableNarrative();
  await executor.run();
  return snapshotOf(executor);
}

async function scenarioPauseResume(corner: boolean) {
  const handler: PausableHandler<Loose> = {
    execute: async (scope) => {
      void scope;
      return { question: 'approve?' };
    },
    resume: async (scope, input) => {
      const s = scope as Loose & {
        $getValue(k: string): unknown;
        $setValue(k: string, v: unknown): void;
      };
      const seen = s.$getValue('k');
      if (corner) {
        // Rewrite k back to its RUN-START value ('orig'). Pre-pause stages
        // changed it to 'mutated', so this IS a real change at resume time —
        // the resume context's first-touch base is the post-pause state, and
        // the commit bundle MUST record k. (The resume context is freshly
        // created via leaf.createNext — see FlowChartExecutor.createTraverser.)
        s.$setValue('k', 'orig');
      } else {
        s.$setValue('k', `resumed:${String(seen)}:${String((input as Loose).approved)}`);
      }
      s.$setValue('resumeRead', seen);
    },
  };

  const chart = flowChart<Loose>(
    'Seed',
    async (scope) => {
      scope.$setValue('k', 'orig');
    },
    'seed',
  )
    .addFunction(
      'Mutate',
      async (scope) => {
        scope.$setValue('k', 'mutated');
      },
      'mutate',
    )
    .addPausableFunction('Approve', handler, 'approve')
    .addFunction(
      'Finish',
      async (scope) => {
        scope.$setValue('finished', scope.$getValue('k'));
      },
      'finish',
    )
    .build();

  const executor = new FlowChartExecutor(chart);
  executor.enableNarrative();
  await executor.run();
  const paused = executor.isPaused();
  const checkpoint = executor.getCheckpoint();
  const result = await executor.resume(checkpoint!, { approved: true });
  const snap = await snapshotOf(executor);
  return { paused, result: canonical(result), ...snap };
}

async function main() {
  const out: Record<string, unknown> = {};
  out.sequential = await scenarioSequential();
  out.fork = await scenarioFork(false);
  out.forkError = await scenarioFork(true);
  out.subflow = await scenarioSubflow();
  out.forkSubflowBranch = await scenarioForkSubflowBranch();
  out.throttledFork = await scenarioThrottledFork();
  out.deciderLoop = await scenarioDeciderLoop();
  out.pauseResumeSame = await scenarioPauseResume(false);
  out.pauseResumeCorner = await scenarioPauseResume(true);
  const target = process.argv[2];
  if (!target) throw new Error('usage: byte-identity-probe.ts <output.json>');
  writeFileSync(target, JSON.stringify(out, null, 2));
  console.log(`wrote ${target}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
