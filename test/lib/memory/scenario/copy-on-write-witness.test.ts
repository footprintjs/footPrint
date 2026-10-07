/**
 * The witness, judged (F1b). The differentials lean on one instrument
 * (fixture · `witnessing` / `witnessClause`): a commit "folds back" when its
 * bundle, replayed onto the stage's diff base, gives what the stage read, and
 * a run may differ from 9.28.0's only where 9.28.0's bundle did NOT fold back.
 * An instrument that cannot go red proves nothing, so this file tells the
 * build's buffer two lies on purpose and asks the clause to name each:
 *
 *   - C1 BACK (`cutAdmission`): the compact rows go out unchecked — the
 *     accumulated merge delta replayed at every `merge` row of a path, the
 *     lie 9.29.0 told. The build then commits the very bytes 9.28.0 does
 *     (`firstDifference` is empty — a byte differential is blind to it) and
 *     the clause is red all the same, at the commit that does not fold back.
 *   - A BYTE CHANGE THAT LIES ABOUT NOTHING (`rewriteCommits`): a commit that
 *     already folded back is written differently. The build folds back too;
 *     the clause names the commit because 9.28.0's bundle there did not lie.
 *
 * The lies run over every shape the witness must read — a root key, a
 * redacted field, a nested path, a run-namespaced key, fork children's
 * namespaces — and, as a generative property, over the programs of the
 * differential itself: with the admission cut it goes red inside a few dozen
 * programs; with it on, the same seed is green. The real 9.28.0 engine
 * (which has C1) is offered to the clause as a candidate, too.
 *
 * What turns what red — each tried by hand on 2026-10-02:
 *   - `witnessClause` without its build half (the `unadmitted` line): every
 *     "does not fold back" case below.
 *   - `witnessClause` without its baseline half (the `foldsBack` test at the
 *     first differing commit): the byte change that lies about nothing, the
 *     branch table, `witnessLegs`' leg 1 and the pause differential's two
 *     per-leg cases.
 *   - the patched commit's `foldsBack` forced true: the shape table (9.28.0
 *     must read as lying) and every cut.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  type ChartProgram,
  type Engine,
  type NestedProgram,
  type Witnessed,
  BASELINE,
  BUILD,
  chartProgramArb,
  cutAdmission,
  firstDifference,
  nestedProgramArb,
  rewriteCommits,
  runChart,
  runNested,
  witnessClause,
  witnessing,
  witnessingSync,
  witnessLegs,
} from '../property/copy-on-write-fixture.js';

const row = (bytes: string, foldsBack = true): Witnessed => ({ bytes, foldsBack });
const names = (n: number) => `the build's commit ${n} does not fold back to what its stage read`;
const LIE = /^the build's commit \d+ does not fold back to what its stage read$/;

describe('witnessClause — every branch, on hand-made rows', () => {
  it('a build commit that does not fold back is named — identical bytes or not', () => {
    expect(witnessClause([row('a'), row('b')], [row('a'), row('b', false)], false)).toBe(names(1));
    // the shape a byte differential cannot see: the build says what 9.28.0 said, and both lie
    expect(witnessClause([row('a', false)], [row('a', false)], false)).toBe(names(0));
    expect(witnessClause([row('a')], [row('A', false)], true)).toBe(names(0));
  });

  it('a difference where 9.28.0 lied is explained, and is the only one judged', () => {
    expect(witnessClause([row('a'), row('b', false)], [row('a'), row('B')], true)).toBe('');
    // after the first difference the engines hold different states: a later one is not compared
    expect(witnessClause([row('a', false), row('b')], [row('A'), row('B')], true)).toBe('');
  });

  it('a difference where 9.28.0 folded back is named', () => {
    expect(witnessClause([row('a'), row('b')], [row('a'), row('B')], true)).toBe(
      "commit 1 differs, but 9.28.0's bundle there folded back",
    );
  });

  it('a different number of commits, and runs that differ with every commit identical, are named', () => {
    expect(witnessClause([row('a')], [row('a'), row('b')], true)).toBe(
      'the engines made a different number of commits (1)',
    );
    expect(witnessClause([row('a'), row('b')], [row('a')], true)).toBe(
      'the engines made a different number of commits (1)',
    );
    expect(witnessClause([row('a')], [row('a')], true)).toBe('the runs differ but every commit is byte-identical');
  });

  it('identical and honest is silent', () => {
    expect(witnessClause([row('a'), row('b')], [row('a'), row('b')], false)).toBe('');
    expect(witnessClause([], [], false)).toBe('');
  });
});

describe('witnessLegs — a resumed leg is judged on its own when both engines start it together', () => {
  const together = () => true;
  const apart =
    (...legs: number[]) =>
    (leg: number) =>
      !legs.includes(leg);

  it('leg 1 is read even though leg 0 already differed — and named when 9.28.0 did not lie there', () => {
    const baseline = [[row('a', false)], [row('b')]];
    const build = [[row('A')], [row('B')]];
    // run-wide, the first difference (leg 0) is explained and the clause stops
    expect(witnessClause(baseline.flat(), build.flat(), true)).toBe('');
    expect(witnessLegs(baseline, build, together).broken).toBe(
      "leg 1: commit 0 differs, but 9.28.0's bundle there folded back",
    );
  });

  it('counts the legs it judged, explained, judged again after a difference, and left to the build’s half', () => {
    const baseline = [[row('a', false)], [row('b', false)], [row('c')]];
    const build = [[row('A')], [row('B')], [row('C')]];
    expect(witnessLegs(baseline, build, apart(2))).toEqual({
      broken: '',
      tally: { legs: 3, explained: 2, rejudged: 1, downstream: 1 },
    });
  });

  it('a leg that starts apart is held to the build’s half only: a difference there follows from an earlier leg', () => {
    const baseline = [[row('a', false)], [row('b')]];
    expect(witnessLegs(baseline, [[row('A')], [row('B')]], apart(1)).broken).toBe('');
    expect(witnessLegs(baseline, [[row('A')], [row('B', false)]], apart(1)).broken).toBe(`leg 1: ${names(0)}`);
  });

  it('the build’s half applies to every leg, and a missing leg counts as no commits', () => {
    expect(witnessLegs([[row('a')], [row('b')]], [[row('a')], [row('b', false)]], together).broken).toBe(
      `leg 1: ${names(0)}`,
    );
    expect(witnessLegs([[row('a')]], [[row('a')], [row('b')]], together).broken).toBe(
      'leg 1: the engines made a different number of commits (0)',
    );
  });
});

// ─── The real engines ────────────────────────────────────────────────────

/** `redacted`: the program runs under a policy, where the restored redaction law may serve more placeholders. */
type Ran = { out: Record<string, string>; seen: Witnessed[]; redacted?: boolean };
type Run = (engine: Engine) => Promise<Ran>;

const cfg: ChartProgram['cfg'] = {
  commitValues: 'full',
  readTracking: 'full',
  writeTracking: 'full',
  writeProvenance: 'off',
  policy: false,
  initial: false,
};

/** probe1 of the admitted-record plan: `$update k {x:1}; k = {y:2}; $update k {z:3}` — the stage reads back `{y:2,z:3}`. */
const lie: ChartProgram['stages'][number] = [
  { t: 'update', k: 'obj', v: { x: 1 } },
  { t: 'set', k: 'obj', v: { y: 2 } },
  { t: 'update', k: 'obj', v: { z: 3 } },
];
const PROBE1: ChartProgram = { seed: [], stages: [lie], cfg };

const chart =
  (p: ChartProgram): Run =>
  async (engine) => {
    const [r, seen] = await witnessing(engine, () => runChart(engine, p));
    return { out: r.out, seen, redacted: p.cfg.policy };
  };

const nested =
  (p: NestedProgram): Run =>
  async (engine) => {
    const [out, seen] = witnessingSync(engine, () => runNested(engine, p));
    return { out, seen };
  };

/** The same three ops at `path` (0 = the root, 2 = `obj/deep`), in a stage with run namespace `runId`. */
const nestedProbe = (path: number, runId: '' | 'r1'): NestedProgram => ({
  initial: undefined,
  stages: [
    {
      runId,
      ops: [
        { t: 'merge', path, k: 'k', v: { x: 1 } },
        { t: 'set', path, k: 'k', v: { y: 2 } },
        { t: 'merge', path, k: 'k', v: { z: 3 } },
      ],
    },
  ],
  commitValues: 'full',
  mutate: false,
});

/** Run `run` on the build with `lie` told; the buffer is put back whatever happens. */
async function told(tell: () => () => void, run: Run): Promise<Ran> {
  const restore = tell();
  try {
    return await run(BUILD);
  } finally {
    restore();
  }
}

describe('C1 on the real engines', () => {
  it('9.28.0 commits probe1 as a lie; the build commits what the stage read', async () => {
    const old = await chart(PROBE1)(BASELINE);
    const honest = await chart(PROBE1)(BUILD);
    // the old accumulated delta {x:1,z:3} replays at both merge rows: x comes back after the hard write
    expect(JSON.parse(old.out.sharedState).obj).toEqual({ x: 1, y: 2, z: 3 });
    expect(JSON.parse(honest.out.sharedState).obj).toEqual({ y: 2, z: 3 });
    expect(old.seen.filter((c) => !c.foldsBack)).toHaveLength(1);
    expect(honest.seen.every((c) => c.foldsBack)).toBe(true);
    expect(witnessClause(old.seen, honest.seen, firstDifference(old.out, honest.out) !== '')).toBe('');
  });

  it('9.28.0, offered to the clause as the candidate, is named at its lying commit', async () => {
    const old = await chart(PROBE1)(BASELINE);
    const honest = await chart(PROBE1)(BUILD);
    const lying = old.seen.findIndex((c) => !c.foldsBack);
    expect(lying).toBeGreaterThanOrEqual(0);
    expect(witnessClause(honest.seen, old.seen, true)).toBe(names(lying));
  });

  it('the build with its admission cut commits 9.28.0’s bytes exactly — and is red all the same', async () => {
    const old = await chart(PROBE1)(BASELINE);
    const cut = await told(() => cutAdmission(BUILD), chart(PROBE1));
    expect(firstDifference(old.out, cut.out)).toBe('');
    const lying = old.seen.findIndex((c) => !c.foldsBack);
    expect(lying).toBeGreaterThanOrEqual(0);
    expect(cut.seen.map((c) => c.foldsBack)).toEqual(old.seen.map((c) => c.foldsBack));
    expect(witnessClause(old.seen, cut.seen, false)).toBe(names(lying));
  });
});

describe('every shape the witness must read', () => {
  const FORK: ChartProgram = { seed: [], stages: [[]], fork: { at: 0, children: [lie, lie] }, cfg };
  const SHAPES: Array<[string, Run]> = [
    ['a root key through the typed scope', chart(PROBE1)],
    ['a redacted field (obj.y under a redaction policy)', chart({ ...PROBE1, cfg: { ...cfg, policy: true } })],
    ['a nested path (obj/deep/k)', nested(nestedProbe(2, ''))],
    ['a run-namespaced key (runs/r1/k)', nested(nestedProbe(0, 'r1'))],
    ['a nested path under a run namespace (runs/r1/obj/deep/k)', nested(nestedProbe(2, 'r1'))],
    ['fork children, each in its own namespace', chart(FORK)],
  ];

  it.each(SHAPES)('%s: 9.28.0 lies, the build does not, and the cut build is caught', async (_shape, run) => {
    const old = await run(BASELINE);
    const honest = await run(BUILD);
    expect(old.seen.some((c) => !c.foldsBack)).toBe(true); // the shape is a real lie on 9.28.0
    expect(honest.seen.every((c) => c.foldsBack)).toBe(true);
    expect(witnessClause(old.seen, honest.seen, firstDifference(old.out, honest.out) !== '')).toBe('');
    const cut = await told(() => cutAdmission(BUILD), run);
    expect(firstDifference(old.out, cut.out)).toBe('');
    expect(witnessClause(old.seen, cut.seen, false)).toMatch(LIE);
  });

  it('a subflow’s seed is a commit like any other: its nested rows are read, and fold back', async () => {
    const SEEDED: ChartProgram = {
      seed: [],
      stages: [[]],
      sub: { at: 0, inner: [[]], seedObj: true, mergeObj: false, arrayReplace: false },
      cfg,
    };
    const { seen } = await chart(SEEDED)(BUILD);
    const seed = seen.find((c) => c.bytes.includes('obj\\u001fx'));
    expect(seed?.foldsBack).toBe(true);
  });
});

describe('a byte change that lies about nothing', () => {
  const CLEAN: ChartProgram = { seed: [], stages: [[{ t: 'set', k: 'a', v: 1 }]], cfg };
  /** The last row of a commit, said twice — a `set` replays to the same value. */
  const sayLastSetTwice = (payload: { trace: Array<{ verb: string }> }) => {
    const last = payload.trace[payload.trace.length - 1];
    if (last?.verb === 'set') payload.trace.push({ ...last });
  };

  it('is named: the build folds back, and so did 9.28.0 at that commit', async () => {
    const old = await chart(CLEAN)(BASELINE);
    const honest = await chart(CLEAN)(BUILD);
    expect(firstDifference(old.out, honest.out)).toBe('');
    expect(witnessClause(old.seen, honest.seen, false)).toBe('');
    const changed = await told(() => rewriteCommits(BUILD, sayLastSetTwice), chart(CLEAN));
    expect(changed.seen.every((c) => c.foldsBack)).toBe(true); // it lies about nothing
    expect(firstDifference(old.out, changed.out)).not.toBe('');
    const first = old.seen.findIndex((c, i) => c.bytes !== changed.seen[i]?.bytes);
    expect(first).toBeGreaterThanOrEqual(0);
    expect(witnessClause(old.seen, changed.seen, true)).toBe(
      `commit ${first} differs, but 9.28.0's bundle there folded back`,
    );
  });
});

describe('the generative differentials, with the admission cut', () => {
  /** What a differential asks of one program: the clause over 9.28.0's run and the build's. */
  const verdict = async (run: Run): Promise<string> => {
    const a = await run(BASELINE);
    const b = await run(BUILD);
    // Under a policy the restored redaction law may serve MORE placeholders than 9.28.0 (fixture · `sameUnderLaw`).
    const redacted = a.redacted === true;
    return witnessClause(a.seen, b.seen, firstDifference(a.out, b.out, redacted) !== '', redacted);
  };

  const FAMILIES: Array<[string, fc.Arbitrary<{ run: Run; label: string }>]> = [
    ['NESTED', nestedProgramArb.map((p) => ({ run: nested(p), label: JSON.stringify(p) }))],
    ['CHART', chartProgramArb.map((p) => ({ run: chart(p), label: JSON.stringify(p) }))],
  ];

  it.each(FAMILIES)(
    '%s programs: green with the admission on, red within 200 programs with it cut',
    async (_family, arb) => {
      const holds = fc.asyncProperty(arb, async ({ run }) => (await verdict(run)) === '');
      const options = { numRuns: 200, seed: 20261003 };
      await fc.assert(holds, options);
      const restore = cutAdmission(BUILD);
      try {
        const found = await fc.check(holds, options);
        expect(found.failed).toBe(true);
        const [minimal] = found.counterexample ?? [];
        expect(await verdict((minimal as { run: Run }).run)).toMatch(LIE);
      } finally {
        restore();
      }
    },
  );
});
