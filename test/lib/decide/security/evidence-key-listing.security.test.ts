/**
 * THE LAW: a read counts for the taint law (`RedactionRule · servesThreshold`, `retainStageText`) when it hands the
 * stage a value a rule selects. Listing a scope's keys hands it names, so it never counts. A read through the `get`
 * trap counts by that key's verdict, and a whole-state read counts when what it hands over holds a selected name.
 *
 * Test types: Security (a real read still counts, on every surface) · Boundary (a listing beside a selected key, the
 * state rule's reach) · Scenario (select, a fan-out's items, a rule's thrown text, a break reason) · Differential (a
 * policy that selects nothing equals no policy, and no policy equals the pinned main evidence).
 */
import { describe, expect, it } from 'vitest';

import type { RedactionPolicy } from '../../../../src/index.js';
import { decide, flowChart, FlowChartExecutor, select } from '../../../../src/index.js';
import { conditionsOf, evidenceSurfaces, surfacesHolding } from '../helpers/evidenceSurfaces.js';

const SECRET = 'SEKRET-1138-LEAK';

type Door = readonly [string, (s: any) => any];

/** Each hands the stage names and no value. */
const LISTINGS: readonly Door[] = [
  ['Object.keys(s)', (s) => Object.keys(s)],
  [
    'for (k in s)',
    (s) => {
      const names: string[] = [];
      for (const name in s) names.push(name);
      return names;
    },
  ],
  ['Reflect.ownKeys(s)', (s) => Reflect.ownKeys(s)],
  ['Object.getOwnPropertyNames(s)', (s) => Object.getOwnPropertyNames(s)],
];

/** Each lists the keys, then reads every value through the `get` trap. */
const VALUE_READS: readonly Door[] = [
  ['JSON.stringify(s)', (s) => JSON.parse(JSON.stringify(s))],
  ['{ ...s }', (s) => ({ ...s })],
  ['Object.assign({}, s)', (s) => Object.assign({}, s)],
  ['Object.entries(s)', (s) => Object.fromEntries(Object.entries(s))],
];

/** Each hands over the whole state in one read. */
const WHOLE_READS: readonly Door[] = [
  ['s.$getValue()', (s) => s.$getValue()],
  ['a silent whole-state read', (s) => s.$toRaw().getValueSilent()],
  ['the inspect hook', (s) => s[Symbol.for('nodejs.util.inspect.custom')]()],
];

/** A decider that runs `door` first, then decides on a threshold the stage builds from what it got. */
function deciderAfter(seed: (s: any) => void, door: (s: any) => any, threshold: (got: any) => unknown = () => 600) {
  return flowChart<any>('Seed', seed, 'seed')
    .addDeciderFunction(
      'Route',
      (s: any) => decide(s, [{ when: { score: { gt: threshold(door(s)) } }, then: 'yes' }], 'no'),
      'route',
    )
    .addFunctionBranch('yes', 'Yes', () => undefined)
    .addFunctionBranch('no', 'No', () => undefined)
    .setDefault('no')
    .end()
    .build();
}

const seedScore = (s: any) => {
  s.score = 700;
};

/** Each route selects the key `ssn`, whose value is the secret or holds it. */
const SELECTED: ReadonlyArray<readonly [string, RedactionPolicy | undefined, (s: any) => void, (got: any) => unknown]> =
  [
    [
      '`keys`',
      { keys: ['ssn'] },
      (s) => {
        s.score = 700;
        s.ssn = SECRET;
      },
      (got) => got.ssn,
    ],
    [
      '`patterns`',
      { patterns: [/^ss/] },
      (s) => {
        s.score = 700;
        s.ssn = SECRET;
      },
      (got) => got.ssn,
    ],
    [
      'a run-time mark',
      undefined,
      (s) => {
        s.score = 700;
        s.$setValue('ssn', SECRET, true);
      },
      (got) => got.ssn,
    ],
    [
      '`fields`',
      { fields: { ssn: ['inner'] } },
      (s) => {
        s.score = 700;
        s.ssn = { inner: SECRET };
      },
      (got) => got.ssn.inner,
    ],
  ];

/** Every door of the matrix, against every selection route. */
function crossed(doors: readonly Door[]) {
  return doors.flatMap(([door, read]) =>
    SELECTED.map(([route, policy, seed, pick]) => [door, route, read, policy, seed, pick] as const),
  );
}

const VISIBLE = {
  key: 'score',
  op: 'gt',
  threshold: 600,
  actualSummary: '700',
  result: true,
  redacted: false,
};

describe('a listing hands the stage no value', () => {
  it.each(LISTINGS.map(([name, door]) => [name, door] as const))(
    '%s beside a policy that selects nothing in state',
    async (_name, door) => {
      const surfaces = await evidenceSurfaces(deciderAfter(seedScore, door), { keys: ['nothing-here'] });
      expect(conditionsOf(surfaces)).toEqual([VISIBLE]);
    },
  );

  it.each(crossed(LISTINGS))('%s beside a key selected by %s', async (_door, _route, door, policy, seed) => {
    const surfaces = await evidenceSurfaces(deciderAfter(seed, door), policy);
    expect(conditionsOf(surfaces)).toEqual([VISIBLE]);
  });

  it('a listing still answers the truth: the stage gets every name', async () => {
    let names: unknown;
    const chart = deciderAfter(
      (s) => {
        s.score = 700;
        s.ssn = SECRET;
      },
      (s) => {
        names = Object.keys(s);
        return names;
      },
    );
    await evidenceSurfaces(chart, { keys: ['ssn'] });
    expect(names).toEqual(['score', 'ssn']);
  });

  it('a listing still leaves its read rows, the selected key masked', async () => {
    const chart = deciderAfter((s) => {
      s.score = 700;
      s.ssn = SECRET;
    }, LISTINGS[0][1]);
    const executor = new FlowChartExecutor(chart);
    executor.setRedactionPolicy({ keys: ['ssn'] });
    await executor.run();
    const route = executor.getSnapshot({ redact: true }).executionTree.next;
    expect(route?.stageReads).toMatchObject({ score: expect.anything(), ssn: '[REDACTED]' });
    expect(JSON.stringify(route?.stageReads)).not.toContain(SECRET);
  });

  it('a real read after a listing counts: the listing did not excuse it', async () => {
    const surfaces = await evidenceSurfaces(
      deciderAfter(
        (s) => {
          s.score = 700;
          s.ssn = SECRET;
        },
        (s) => {
          Object.keys(s);
          return s.ssn;
        },
        (got) => got,
      ),
      { keys: ['ssn'] },
    );
    const [condition] = conditionsOf(surfaces);
    expect(condition.threshold).toBe('[REDACTED]');
    expect(condition.thresholdRedacted).toBe(true);
    expect(surfacesHolding(surfaces, SECRET)).toEqual([]);
  });

  it('asking about one key by name stays a read: `in` counts as it always did', async () => {
    const surfaces = await evidenceSurfaces(
      deciderAfter(
        (s) => {
          s.score = 700;
          s.ssn = SECRET;
        },
        // eslint-disable-next-line no-restricted-syntax -- the `has` trap is what is under test
        (s) => 'ssn' in s,
      ),
      { keys: ['ssn'] },
    );
    expect(conditionsOf(surfaces)[0].thresholdRedacted).toBe(true);
  });
});

describe('a read through the `get` trap counts by its key', () => {
  it.each(crossed(VALUE_READS))('%s over a key selected by %s', async (_door, _route, door, policy, seed, pick) => {
    const surfaces = await evidenceSurfaces(deciderAfter(seed, door, pick), policy);
    const [condition] = conditionsOf(surfaces);
    expect(condition.threshold).toBe('[REDACTED]');
    expect(condition.thresholdRedacted).toBe(true);
    expect(condition.result).toBe(false);
    expect(surfacesHolding(surfaces, SECRET)).toEqual([]);
  });

  it.each(VALUE_READS.map(([name, door]) => [name, door] as const))(
    '%s hides a later threshold the stage made itself (conservative)',
    async (_name, door) => {
      const surfaces = await evidenceSurfaces(
        deciderAfter((s) => {
          s.score = 700;
          s.ssn = SECRET;
        }, door),
        { keys: ['ssn'] },
      );
      expect(conditionsOf(surfaces)[0].thresholdRedacted).toBe(true);
    },
  );

  // A state rule selects by PATH, so a rule that names something inside `a` does not select `a` written whole: the log
  // and `onRead` hold it as they always did, and `fields` is how to select it. Reading it through a spread is the same
  // read as `s.a.ssn`.
  it.each([
    ['a nested name', { keys: ['ssn'] }],
    ['a dotted key', { keys: ['a.ssn'] }],
    ['a pattern', { patterns: [/ssn/] }],
  ] as const)('%s inside a key the rule leaves clear: the same as a direct read', async (_name, policy) => {
    const seed = (s: any) => {
      s.score = 700;
      s.a = { ssn: SECRET };
    };
    const direct = await evidenceSurfaces(
      deciderAfter(
        seed,
        (s) => s.a.ssn,
        (got) => got,
      ),
      policy,
    );
    const spread = await evidenceSurfaces(
      deciderAfter(
        seed,
        (s) => ({ ...s }),
        (got) => got.a.ssn,
      ),
      policy,
    );
    expect(conditionsOf(spread)).toEqual(conditionsOf(direct));
    expect(direct.disk).toContain(SECRET);
  });

  it('`fields` selects inside such a key, and a spread counts', async () => {
    const surfaces = await evidenceSurfaces(
      deciderAfter(
        (s) => {
          s.score = 700;
          s.a = { ssn: SECRET };
        },
        (s) => ({ ...s }),
        (got) => got.a.ssn,
      ),
      { fields: { a: ['ssn'] } },
    );
    expect(conditionsOf(surfaces)[0].thresholdRedacted).toBe(true);
    expect(surfacesHolding(surfaces, SECRET)).toEqual([]);
  });
});

describe('a whole-state read counts when it holds a selected name', () => {
  it.each(crossed(WHOLE_READS))('%s holding a key selected by %s', async (_door, _route, door, policy, seed, pick) => {
    const surfaces = await evidenceSurfaces(deciderAfter(seed, door, pick), policy);
    const [condition] = conditionsOf(surfaces);
    expect(condition.threshold).toBe('[REDACTED]');
    expect(condition.thresholdRedacted).toBe(true);
    expect(surfacesHolding(surfaces, SECRET)).toEqual([]);
  });

  // The whole state is a record handed out whole, so the name counts at any depth, as for args and thresholds.
  it.each(
    WHOLE_READS.flatMap(([door, read]) => [
      [door, 'a nested name', read, { keys: ['ssn'] }] as const,
      [door, 'a dotted key', read, { keys: ['a.ssn'] }] as const,
      [door, 'a pattern on a nested name', read, { patterns: [/^ssn$/] }] as const,
      [door, 'a nested field', read, { fields: { a: ['ssn'] } }] as const,
    ]),
  )('%s holding %s below a clear key', async (_door, _route, door, policy) => {
    const surfaces = await evidenceSurfaces(
      deciderAfter((s) => {
        s.score = 700;
        s.a = { ssn: SECRET };
      }, door),
      policy,
    );
    expect(conditionsOf(surfaces)[0].thresholdRedacted).toBe(true);
  });

  it.each(WHOLE_READS.map(([name, door]) => [name, door] as const))(
    '%s holding a key whose declared field is absent counts nothing',
    async (_name, door) => {
      const surfaces = await evidenceSurfaces(
        deciderAfter((s) => {
          s.score = 700;
          s.a = { name: 'A' };
        }, door),
        { fields: { a: ['ssn'] } },
      );
      expect(conditionsOf(surfaces)).toEqual([VISIBLE]);
    },
  );

  // Named in the guide's list of what stays uncovered: these walks read own enumerable keys, as a boundary record's does.
  it('a selected name inside a Map in a whole-state read or in the args is not seen', async () => {
    const held = new Map([['ssn', SECRET]]);
    const inState = await evidenceSurfaces(
      deciderAfter(
        (s) => {
          s.score = 700;
          s.held = held;
        },
        (s) => s.$getValue(),
      ),
      { keys: ['ssn'] },
    );
    expect(conditionsOf(inState)).toEqual([VISIBLE]);
    const inArgs = await evidenceSurfaces(
      deciderAfter(seedScore, () => undefined),
      { keys: ['ssn'] },
      { held },
    );
    expect(conditionsOf(inArgs)).toEqual([VISIBLE]);
  });

  it('a read of one subtree with no key counts by that subtree', async () => {
    const read = (s: any) => s.$toRaw().getValueAt(['a']);
    const seed = (s: any) => {
      s.score = 700;
      s.a = { ssn: SECRET, name: 'A' };
    };
    const held = await evidenceSurfaces(deciderAfter(seed, read), { keys: ['a.ssn'] });
    expect(conditionsOf(held)[0].thresholdRedacted).toBe(true);
    const named = await evidenceSurfaces(deciderAfter(seed, read), { keys: ['a'] });
    expect(conditionsOf(named)[0].thresholdRedacted).toBe(true);
    const clear = await evidenceSurfaces(deciderAfter(seed, read), { keys: ['a.other'] });
    expect(conditionsOf(clear)).toEqual([VISIBLE]);
  });
});

describe('the same count everywhere it is asked', () => {
  const SELECTS_NOTHING = { keys: ['nothing-here'] };

  it('select() reads it too', async () => {
    const chart = flowChart<any>('Seed', seedScore, 'seed')
      .addSelectorFunction(
        'Pick',
        (s: any) => {
          JSON.stringify(s);
          return select(s, [{ when: { score: { gt: 600 } }, then: 'yes' }]);
        },
        'pick',
      )
      .addFunctionBranch('yes', 'Yes', () => undefined)
      .addFunctionBranch('no', 'No', () => undefined)
      .end()
      .build();
    const surfaces = await evidenceSurfaces(chart, SELECTS_NOTHING);
    expect(conditionsOf(surfaces)).toEqual([VISIBLE]);
  });

  it('a rule that lists the keys and throws keeps its text', async () => {
    const chart = flowChart<any>('Seed', seedScore, 'seed')
      .addDeciderFunction(
        'Route',
        (s: any) =>
          decide(
            s,
            [
              {
                when: (x: any) => {
                  JSON.stringify(x);
                  throw new Error('rule text');
                },
                then: 'yes',
              },
            ],
            'no',
          ),
        'route',
      )
      .addFunctionBranch('yes', 'Yes', () => undefined)
      .addFunctionBranch('no', 'No', () => undefined)
      .setDefault('no')
      .end()
      .build();
    const surfaces = await evidenceSurfaces(chart, SELECTS_NOTHING);
    expect(surfaces.evidence[0].rules[0].matchError).toBe('rule text');
  });

  it('a stage that lists the keys and breaks keeps its reason', async () => {
    const chart = flowChart<any>('Seed', seedScore, 'seed')
      .addFunction(
        'Stop',
        (s: any) => {
          JSON.stringify(s);
          s.$break('stop here');
        },
        'stop',
      )
      .build();
    const surfaces = await evidenceSurfaces(chart, SELECTS_NOTHING);
    expect(surfaces.reasons).toEqual(['stop here']);
  });

  /** A fan-out over what `items` returns, and the names the run marked secret by the end. */
  async function fanOut(policy: RedactionPolicy, items: (s: any) => unknown[]) {
    const branch = flowChart<any>(
      'Each',
      (s: any) => {
        s.seen = s.item;
      },
      'each',
    ).build();
    const chart = flowChart<any>(
      'Seed',
      (s: any) => {
        s.score = 700;
        s.ssn = SECRET;
        s.list = [1, 2];
      },
      'seed',
    )
      .addParallelForEach('Fan', 'fan', { items, branch: () => branch, maxBranches: 4, into: 'done' })
      .build();
    const executor = new FlowChartExecutor(chart);
    executor.setRedactionPolicy(policy);
    await executor.run();
    return executor.getRedactionReport().redactedKeys;
  }

  it('a fan-out over a listing marks neither `item` nor `into`, as on main', async () => {
    const marks = await fanOut({ keys: ['nothing-here'] }, (s) => Object.keys(s));
    expect(marks).not.toContain('item');
    expect(marks).not.toContain('done');
  });

  it('a fan-out over the listed names of a selected key hands no value on', async () => {
    const marks = await fanOut({ keys: ['ssn'] }, (s) => Object.keys(s));
    expect(marks).not.toContain('item');
    expect(marks).not.toContain('done');
  });

  it.each([
    ['a spread', (s: any) => Object.values({ ...s })],
    ['a whole-state read', (s: any) => Object.values(s.$getValue())],
  ] as const)('a fan-out over %s that reads the selected key marks both', async (_name, items) => {
    const marks = await fanOut({ keys: ['ssn'] }, items);
    expect(marks).toContain('item');
    expect(marks).toContain('done');
  });

  it('a silent read under a rule with nothing to say counts nothing', async () => {
    const marks = await fanOut({ emitPatterns: [/x/] }, (s) => s.list.map((n: number) => n + 1));
    expect(marks).toEqual([]);
  });

  it('a whole-state read in a fan-out under a policy that selects nothing marks neither', async () => {
    const marks = await fanOut({ keys: ['nothing-here'] }, (s) => Object.keys(s.$getValue()));
    expect(marks).not.toContain('item');
    expect(marks).not.toContain('done');
  });
});

describe('differential: a policy that selects nothing equals no policy, and no policy equals main', () => {
  /** The evidence main gives for this chart, for every door below, pinned byte for byte. */
  const MAIN = JSON.stringify({
    rules: [
      {
        type: 'filter',
        ruleIndex: 0,
        branch: 'yes',
        matched: true,
        conditions: [{ key: 'score', op: 'gt', threshold: 600, actualSummary: '700', result: true, redacted: false }],
      },
    ],
    chosen: 'yes',
    default: 'no',
  });

  /** A recorder row names its run and its recorder's own id: neither is the evidence. */
  const stable = (rows: string) => rows.replace(/control-deps-\d+/g, 'id').replace(/"runId":"[^"]*"/g, '"runId":""');

  const ALL_DOORS = [...LISTINGS, ...VALUE_READS, ...WHOLE_READS, ['no extra read', () => undefined] as Door];
  const POLICIES: ReadonlyArray<readonly [string, RedactionPolicy | undefined]> = [
    ['no policy', undefined],
    ['an empty policy', {}],
    ['an absent key', { keys: ['nothing-here'] }],
    ['a pattern that matches nothing', { patterns: [/^nothing/] }],
    ['a field of an absent key', { fields: { nothing: ['x'] } }],
    ['a dotted key under an absent one', { keys: ['nothing.here'] }],
    ['an emit-only policy', { emitPatterns: [/x/] }],
    ['a diagnostic selector elsewhere', { diagnostics: { keys: ['logs.absent'] } }],
  ];

  it.each(ALL_DOORS.flatMap(([door, read]) => POLICIES.map(([name, policy]) => [door, name, read, policy] as const)))(
    '%s under %s',
    async (_door, _name, door, policy) => {
      const chart = () => deciderAfter(seedScore, door);
      const served = await evidenceSurfaces(chart(), policy);
      const bare = await evidenceSurfaces(chart(), undefined);
      expect(JSON.stringify(served.evidence[0])).toBe(MAIN);
      expect(served.narrative).toBe(bare.narrative);
      expect(stable(served.recorders)).toBe(stable(bare.recorders));
      expect(served.disk).not.toContain('thresholdRedacted');
    },
  );
});
