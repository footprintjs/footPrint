/**
 * PROPERTY — the walk back from a state value never omits a cause.
 *
 * The claim: for an app written as a footprint chart, the run record supports
 * a deterministic walk from any state value back to every stage and decision
 * that could have produced it, and the walk never omits a cause that flowed
 * through the scope.
 *
 * Random straight-line programs over number variables (constants, copies,
 * sums, in-stage conditionals), cut into stages at random points, with up to
 * two `decide()` diamonds, are run twice over: once by an independent
 * interpreter (`walk-back/programs.ts · judge`, the oracle — it imports no
 * library code) and once as the real chart (`walk-back/toChart.ts`). The walk
 * back is foottrace's `causalChain` from the variable's last writer, through
 * each stage's recorded reads and the control edges of `controlDepRecorder()`.
 *
 *   - SOUND: every stage the judge names as a true cause is in the walk back.
 *   - EXACT at one statement per stage: the two sets are equal.
 *   - DETERMINISTIC: the same chart run twice gives the same walk back.
 *
 * Excluded by construction, and pinned below as KNOWN GAP witnesses: a stage
 * that writes the value a key already holds (`NO_OP_WRITE_GUARD`). Also pinned:
 * a closure value (outside the scope, so outside the claim) and the blur of
 * many assignments in one stage (an over-approximation, not an omission).
 *
 * Rerun one batch: WALK_BACK_SEED=<seed> npx vitest run test/lib/slice/walk-back-soundness.property.test.ts
 * (add WALK_BACK_PATH=<path> from fast-check's report to replay one counterexample).
 *
 * Test type: property (fast-check) + known-gap examples.
 */

import fc from 'fast-check';
import { causalChain, findLastWriter, flattenCausalDAG, keysReadFromExecutionTree } from 'foottrace';
import { describe, expect, it } from 'vitest';

import { flowChart, FlowChartExecutor } from '../../../src/index.js';
import { type ProgramShape, describeProgram, generateProgram, judge, respectsNoOpGuard } from './walk-back/programs.js';
import { runAndWalk } from './walk-back/toChart.js';

// ─── Parameters: a printed seed, a bounded run count ───

function propertyParameters(env: Readonly<Record<string, string | undefined>>) {
  const seedText = env.WALK_BACK_SEED;
  const seed = seedText === undefined ? Math.floor(Math.random() * 2 ** 32) - 2 ** 31 : Number(seedText);
  if (!Number.isInteger(seed) || seed < -2147483648 || seed > 2147483647) {
    throw new Error('WALK_BACK_SEED must be a signed 32-bit decimal integer');
  }
  const path = env.WALK_BACK_PATH;
  if (path !== undefined) return { seed, numRuns: 1, path, endOnFailure: true as const };
  return { seed, numRuns: 1000 };
}

const parameters = propertyParameters(process.env);

const shapeArb = (perStage: fc.Arbitrary<ProgramShape['perStage']>) =>
  fc.record({
    programSeed: fc.integer(),
    shape: fc.record({
      vars: fc.integer({ min: 2, max: 8 }),
      statements: fc.integer({ min: 1, max: 20 }),
      perStage,
      maxDeciders: fc.integer({ min: 0, max: 2 }),
    }),
  });

const anyCutsArb = shapeArb(fc.oneof(fc.constant('random' as const), fc.integer({ min: 1, max: 4 })));
const oneStatementArb = shapeArb(fc.constant(1));

async function judgeAndWalk({ programSeed, shape }: { programSeed: number; shape: ProgramShape }) {
  const program = generateProgram(programSeed, shape);
  const verdict = judge(program);
  const run = await runAndWalk(program, verdict.causes.keys());
  return { program, verdict, run };
}

// ─── Properties ───

describe(`property: the walk back never omits a cause (seed ${parameters.seed})`, () => {
  it('SOUND: every true cause stage is inside the walk back', async () => {
    await fc.assert(
      fc.asyncProperty(anyCutsArb, async (input) => {
        const { program, verdict, run } = await judgeAndWalk(input);
        expect(respectsNoOpGuard(program)).toBe(true);
        for (const [key, causes] of verdict.causes) {
          const context = `${key}\n${describeProgram(program)}`;
          // The chart computed what the judge computed, or the comparison means nothing.
          expect(run.state[key], context).toBe(verdict.values.get(key));
          const walk = run.walks.get(key);
          expect(walk, context).toBeDefined();
          expect(walk!.truncated, context).toBe(false);
          const missing = [...causes].filter((stage) => !walk!.stages.includes(stage));
          expect(missing, context).toEqual([]);
        }
      }),
      parameters,
    );
  });

  it('EXACT at one statement per stage: the walk back equals the true cause set', async () => {
    await fc.assert(
      fc.asyncProperty(oneStatementArb, async (input) => {
        const { program, verdict, run } = await judgeAndWalk(input);
        for (const [key, causes] of verdict.causes) {
          const walk = run.walks.get(key)!;
          expect([...new Set(walk.stages)].sort(), `${key}\n${describeProgram(program)}`).toEqual([...causes].sort());
        }
      }),
      parameters,
    );
  });

  it('DETERMINISTIC: the same chart run twice gives the same walk back', async () => {
    await fc.assert(
      fc.asyncProperty(anyCutsArb, async ({ programSeed, shape }) => {
        const program = generateProgram(programSeed, shape);
        const keys = [...judge(program).causes.keys()];
        const first = await runAndWalk(program, keys);
        const second = await runAndWalk(program, keys);
        expect([...second.walks.entries()]).toEqual([...first.walks.entries()]);
        expect(second.executed).toEqual(first.executed);
      }),
      { ...parameters, numRuns: Math.min(parameters.numRuns, 300) },
    );
  });
});

// ─── Known gaps: each asserts TODAY's behaviour. Update the witness when the gap is closed. ───

type S = Record<string, unknown>;

interface TreeNode {
  id: string;
  next?: TreeNode;
  stageReads?: Record<string, unknown>;
  stageWrites?: Record<string, unknown>;
}

async function runChart(chart: unknown, options: Record<string, unknown> = {}) {
  const executor = new FlowChartExecutor(chart as never, options as never);
  await executor.run();
  const snapshot = executor.getSnapshot();
  const reads = keysReadFromExecutionTree(snapshot.executionTree);
  const walkFrom = (key: string, extra: Record<string, unknown> = {}) => {
    const writer = findLastWriter(snapshot.commitLog, key)!;
    return causalChain(snapshot.commitLog, writer.runtimeStageId, reads.lookup, extra)!;
  };
  const treeNode = (id: string) => {
    let node = snapshot.executionTree as unknown as TreeNode | undefined;
    while (node && node.id !== id) node = node.next;
    return node!;
  };
  return { snapshot, walkFrom, treeNode };
}

describe('known gaps of the walk back (witnesses of today; update each when its gap closes)', () => {
  // When this gap closes, drop `NO_OP_WRITE_GUARD` from the generator in walk-back/programs.ts.
  it('KNOWN GAP: a stage that writes the value a key already holds leaves no commit row, so the walk back skips it', async () => {
    const chart = flowChart<S>(
      'SetStatus',
      (s) => {
        s.status = 'pending';
      },
      'set-status',
    )
      .addFunction(
        'Review',
        (s) => {
          s.status = 'pending'; // the bug: should have been 'approved'
        },
        'review',
      )
      .addFunction(
        'Notify',
        (s) => {
          s.message = `status is ${s.status as string}`;
        },
        'notify',
      )
      .build();
    const { snapshot, walkFrom, treeNode } = await runChart(chart);

    // The execution tree lists Review's write…
    expect(Object.keys(treeNode('review').stageWrites ?? {})).toEqual(['status']);
    // …but its commit holds no row,
    const review = snapshot.commitLog.find((bundle) => bundle.stageId === 'review')!;
    expect(review.trace).toEqual([]);
    // so the walk back from `message` names the first writer and never Review.
    const stages = flattenCausalDAG(walkFrom('message')).map((n) => n.stageId);
    expect(stages).toEqual(['notify', 'set-status']);
  });

  // Same family, found by the property with the stage-start half of `isNoOpWrite` switched off:
  // the commit is a NET change, so a stage that moves a key away and back within itself also
  // leaves no row. When this gap closes, drop the stage-start half of the guard.
  it('KNOWN GAP: a stage that returns a key to its start value leaves no row, so the walk back names an earlier writer', async () => {
    const chart = flowChart<S>(
      'SetV',
      (s) => {
        s.v = 5;
      },
      'set-v',
    )
      .addFunction(
        'Rework',
        (s) => {
          s.v = 3;
          s.v = (s.v as number) + 2; // v is 5 again, now computed by this stage
        },
        'rework',
      )
      .addFunction(
        'UseV',
        (s) => {
          s.w = (s.v as number) * 10;
        },
        'use-v',
      )
      .build();
    const { snapshot, walkFrom, treeNode } = await runChart(chart);

    expect(snapshot.sharedState.w).toBe(50);
    expect(Object.keys(treeNode('rework').stageWrites ?? {})).toEqual(['v']);
    expect(snapshot.commitLog.find((bundle) => bundle.stageId === 'rework')!.trace).toEqual([]);
    expect(flattenCausalDAG(walkFrom('w')).map((n) => n.stageId)).toEqual(['use-v', 'set-v']);
  });

  it('KNOWN GAP: a value taken from a closure variable is recorded with no read and no flag', async () => {
    const hidden = 41;
    const chart = flowChart<S>(
      'Seed',
      (s) => {
        s.seeded = true;
      },
      'seed',
    )
      .addFunction(
        'Probe',
        (s) => {
          s.y = hidden + 1;
        },
        'probe',
      )
      .build();
    const { snapshot, walkFrom, treeNode } = await runChart(chart);

    expect(snapshot.sharedState.y).toBe(42);
    expect(Object.keys(treeNode('probe').stageReads ?? {})).toEqual([]);
    const probe = snapshot.commitLog.find((bundle) => bundle.stageId === 'probe')!;
    expect(probe.untrackedSources).toBeUndefined();
    // The walk back ends at the stage with no parent and no honesty marker: the closure is invisible.
    const root = walkFrom('y');
    expect(root.parents).toEqual([]);
    expect(root.incompleteSources).toBeUndefined();
    expect(root.preRunReads).toBeUndefined();
  });

  it('KNOWN GAP: many assignments in one stage give one node with no inner edges, so the walk back names a non-cause', async () => {
    const chart = flowChart<S>(
      'SetX',
      (s) => {
        s.x = 5;
      },
      'set-x',
    )
      .addFunction(
        'SetZ',
        (s) => {
          s.z = 7;
        },
        'set-z',
      )
      .addFunction(
        'Mixed',
        (s) => {
          s.y = s.x;
          s.note = `z was ${s.z as number}`;
        },
        'mixed',
      )
      .build();

    // y = x only, yet the stage-level walk back from y also names SetZ (read for `note`).
    const plain = await runChart(chart);
    expect(flattenCausalDAG(plain.walkFrom('y')).map((n) => n.stageId)).toEqual(['mixed', 'set-x', 'set-z']);

    // Today's narrowing (opt-in, and only by read ORDER): per-write provenance drops SetZ here because z
    // was read after y was written. It does not split a stage whose reads all precede its writes.
    const perWrite = await runChart(chart, { writeProvenance: 'reads-prefix' });
    const narrowed = perWrite.walkFrom('y', { edgeAttribution: 'per-write', rootLinkKeys: ['y'] });
    expect(flattenCausalDAG(narrowed).map((n) => n.stageId)).toEqual(['mixed', 'set-x']);
  });
});
