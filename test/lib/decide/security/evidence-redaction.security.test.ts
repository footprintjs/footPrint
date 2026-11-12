/**
 * A redaction policy covers a decision's evidence — what `decide()` / `select()` quote from the stage's own code: a
 * filter's threshold and a rule's thrown text. THE LAW: `RedactionRule · serveThreshold` and `retainStageText`.
 *
 * Each route below selects a value a different way. Each is checked on every surface evidence reaches: live events,
 * the narrative, the redacted recorder rows, and the record on disk through `fileSink`, `capture-history` included.
 * Fixed at the source, so one form reaches them all.
 *
 * Test types: Security (the routes) · Boundary (a hole against a real `[REDACTED]`, over-hiding) · Scenario
 * (subflow, fork, fan-out) · Unit-level byte identity (no policy, a policy that selects nothing).
 */
import { describe, expect, it } from 'vitest';

import type { RedactionPolicy } from '../../../../src/index.js';
import { decide, flowChart, FlowChartExecutor, select } from '../../../../src/index.js';
import { registerScopeRuntime } from '../../../../src/lib/scope/runtime.js';
import { registerTestScope } from '../../../helpers/registerScope.js';
import { conditionsOf, evidenceSurfaces, surfacesHolding } from '../helpers/evidenceSurfaces.js';

const SECRET = 'SEKRET-1138-LEAK';

type Rules = (s: any) => any[];

/** A decider whose first rule is built in the stage, after `seed` committed. */
function deciderChart(seed: (s: any) => void, rules: Rules) {
  return flowChart<any>('Seed', seed, 'seed')
    .addDeciderFunction('Route', (s: any) => decide(s, rules(s), 'no'), 'route')
    .addFunctionBranch('yes', 'Yes', () => undefined)
    .addFunctionBranch('no', 'No', () => undefined)
    .setDefault('no')
    .end()
    .build();
}

function selectorChart(seed: (s: any) => void, rules: Rules) {
  return flowChart<any>('Seed', seed, 'seed')
    .addSelectorFunction('Pick', (s: any) => select(s, rules(s)), 'pick')
    .addFunctionBranch('yes', 'Yes', () => undefined)
    .addFunctionBranch('no', 'No', () => undefined)
    .end()
    .build();
}

interface Route {
  readonly name: string;
  readonly policy?: RedactionPolicy;
  readonly input?: unknown;
  readonly seed: (s: any) => void;
  readonly rules: Rules;
}

const seedPlain = (s: any) => {
  s.plain = 'visible';
};

/** Each route's first rule matches, so the narrative prints its conditions too. */
const THRESHOLD_ROUTES: readonly Route[] = [
  {
    name: 'a threshold on a key selected by `keys`',
    policy: { keys: ['ssn'] },
    seed: (s) => {
      s.ssn = SECRET;
    },
    rules: () => [{ when: { ssn: { eq: SECRET } }, then: 'yes' }],
  },
  {
    name: 'a threshold on a key selected by `patterns`',
    policy: { patterns: [/^ssn$/] },
    seed: (s) => {
      s.ssn = SECRET;
    },
    rules: () => [{ when: { ssn: { eq: SECRET } }, then: 'yes' }],
  },
  {
    name: 'a threshold on a key selected by a run-time mark',
    seed: (s) => {
      s.$setValue('ssn', SECRET, true);
    },
    rules: () => [{ when: { ssn: { eq: SECRET } }, then: 'yes' }],
  },
  {
    name: 'a threshold on a key selected by `keys` that the run never wrote',
    policy: { keys: ['ssn'] },
    seed: seedPlain,
    rules: () => [{ when: { ssn: { ne: SECRET } }, then: 'yes' }],
  },
  {
    name: 'an object threshold on a key selected by `fields`',
    policy: { fields: { patient: ['ssn'] } },
    seed: (s) => {
      s.patient = { name: 'A', ssn: 'other' };
    },
    rules: () => [{ when: { patient: { ne: { name: 'A', ssn: SECRET } } }, then: 'yes' }],
  },
  {
    name: 'a scalar threshold on a key selected by `fields`',
    policy: { fields: { patient: ['ssn'] } },
    seed: (s) => {
      s.patient = { name: 'A', ssn: 'other' };
    },
    rules: () => [{ when: { patient: { ne: SECRET } }, then: 'yes' }],
  },
  {
    name: 'a threshold copied from a selected value the stage read (taint)',
    policy: { keys: ['expected'] },
    seed: (s) => {
      s.plain = 'visible';
      s.expected = SECRET;
    },
    rules: (s) => [{ when: { plain: { ne: s.expected } }, then: 'yes' }],
  },
  {
    name: 'a threshold copied from a `fields`-selected value the stage read (taint)',
    policy: { fields: { patient: ['ssn'] } },
    seed: (s) => {
      s.plain = 'visible';
      s.patient = { name: 'A', ssn: SECRET };
    },
    rules: (s) => [{ when: { plain: { ne: s.patient.ssn } }, then: 'yes' }],
  },
  {
    name: 'a threshold copied from `$getValue(key)` (taint)',
    policy: { keys: ['expected'] },
    seed: (s) => {
      s.plain = 'visible';
      s.expected = SECRET;
    },
    rules: (s) => [{ when: { plain: { ne: s.$getValue('expected') } }, then: 'yes' }],
  },
  {
    name: 'a threshold copied from a whole-state read (taint)',
    policy: { keys: ['expected'] },
    seed: (s) => {
      s.plain = 'visible';
      s.expected = SECRET;
    },
    rules: (s) => [{ when: { plain: { ne: (s.$getValue() as any).expected } }, then: 'yes' }],
  },
  {
    name: 'a threshold copied from a silent read (taint)',
    policy: { keys: ['expected'] },
    seed: (s) => {
      s.plain = 'visible';
      s.expected = SECRET;
    },
    rules: (s) => [{ when: { plain: { ne: s.$toRaw().getValueSilent('expected') } }, then: 'yes' }],
  },
  {
    name: 'a threshold copied from args holding a selected key',
    policy: { keys: ['ssn'] },
    input: { ssn: SECRET },
    seed: seedPlain,
    rules: (s) => [{ when: { plain: { ne: s.$getArgs().ssn } }, then: 'yes' }],
  },
  {
    name: 'a threshold copied from args holding a selected key deep inside',
    policy: { keys: ['ssn'] },
    input: { applicant: { ids: [{ ssn: SECRET }] } },
    seed: seedPlain,
    rules: (s) => [{ when: { plain: { ne: s.$getArgs().applicant.ids[0].ssn } }, then: 'yes' }],
  },
  {
    name: 'a threshold copied from args holding a `fields`-selected field',
    policy: { fields: { applicant: ['ssn'] } },
    input: { applicant: { ssn: SECRET } },
    seed: seedPlain,
    rules: (s) => [{ when: { plain: { ne: s.$getArgs().applicant.ssn } }, then: 'yes' }],
  },
  {
    name: 'an `in` threshold on a selected key',
    policy: { keys: ['list'] },
    seed: (s) => {
      s.list = 'x';
    },
    rules: () => [{ when: { list: { in: ['x', SECRET] } }, then: 'yes' }],
  },
  {
    name: 'a `notIn` threshold copied from a selected value (taint)',
    policy: { keys: ['expected'] },
    seed: (s) => {
      s.plain = 'visible';
      s.expected = SECRET;
    },
    rules: (s) => [{ when: { plain: { notIn: ['y', s.expected] } }, then: 'yes' }],
  },
  {
    name: 'an object threshold that holds a selected name under a clear key',
    policy: { keys: ['ssn'] },
    seed: seedPlain,
    rules: () => [{ when: { plain: { ne: { nested: { ssn: SECRET } } } }, then: 'yes' }],
  },
  {
    name: 'an `in` threshold whose element holds a selected name under a clear key',
    policy: { keys: ['ssn'] },
    seed: seedPlain,
    rules: () => [{ when: { plain: { notIn: [{ ssn: SECRET }] } }, then: 'yes' }],
  },
  {
    name: 'an object threshold that holds a dotted selection under its own key',
    policy: { keys: ['patient.ssn'] },
    seed: seedPlain,
    rules: () => [{ when: { patient: { ne: { ssn: SECRET } } }, then: 'yes' }],
  },
  {
    name: 'a threshold under an unknown operator',
    policy: { keys: ['ssn'] },
    seed: (s) => {
      s.ssn = 'x';
    },
    rules: () => [
      { when: { ssn: { typo: SECRET } }, then: 'yes' },
      { when: { ssn: { ne: 'other' } }, then: 'yes' },
    ],
  },
];

describe.each([
  ['decide()', deciderChart],
  ['select()', selectorChart],
] as const)('%s evidence holds no selected threshold', (_door, build) => {
  it.each(THRESHOLD_ROUTES.map((route) => [route.name, route] as const))('%s', async (_name, route) => {
    const surfaces = await evidenceSurfaces(build(route.seed, route.rules), route.policy, route.input);

    expect(surfacesHolding(surfaces, SECRET)).toEqual([]);
    expect(surfaces.capture, 'capture-history was written').toContain('"key"');
    expect(surfaces.storedStatus).toBe('acknowledged');
    const conditions = conditionsOf(surfaces);
    expect(conditions.length).toBeGreaterThan(0);
    for (const condition of conditions) {
      expect(condition.threshold).toBe('[REDACTED]');
      expect(condition.thresholdRedacted).toBe(true);
    }
    // The hole is named wherever the row travels.
    expect(surfaces.recorders).toContain('"thresholdRedacted":true');
    expect(surfaces.capture).toContain('"thresholdRedacted":true');
    // A matched rule's conditions are printed, so the narrative was not silent about it.
    expect(surfaces.narrative).toContain('[REDACTED]');
  });
});

describe('evidence: the actual value of a selected key', () => {
  it('a `fields`-selected key masks the actual like a function rule read does', async () => {
    const surfaces = await evidenceSurfaces(
      deciderChart(
        (s) => {
          s.patient = { name: 'A', ssn: SECRET };
        },
        () => [{ when: { patient: { ne: 1 } }, then: 'yes' }],
      ),
      { fields: { patient: ['ssn'] } },
    );
    const [condition] = conditionsOf(surfaces);
    expect(condition.redacted).toBe(true);
    expect(condition.actualSummary).toBe('[REDACTED]');
  });

  it('a key selected by `keys` that the run never wrote is masked too', async () => {
    const surfaces = await evidenceSurfaces(
      deciderChart(
        () => undefined,
        () => [{ when: { ssn: { ne: 'x' } }, then: 'yes' }],
      ),
      { keys: ['ssn'] },
    );
    const [condition] = conditionsOf(surfaces);
    expect(condition.redacted).toBe(true);
    expect(condition.actualSummary).toBe('[REDACTED]');
  });
});

describe('evidence: a rule that throws', () => {
  const thrown = (text: string) => {
    throw new Error(text);
  };

  const ERROR_ROUTES: readonly Route[] = [
    {
      name: 'text quoting a selected value the rule read',
      policy: { keys: ['pw'] },
      seed: (s) => {
        s.pw = SECRET;
      },
      rules: () => [{ when: (x: any) => thrown(`bad ${x.pw}`), then: 'yes' }],
    },
    {
      name: 'text quoting a selected value the stage read first',
      policy: { keys: ['pw'] },
      seed: (s) => {
        s.pw = SECRET;
      },
      rules: (s) => {
        const pw = s.pw;
        return [{ when: () => thrown(`bad ${pw}`), then: 'yes' }];
      },
    },
    {
      name: 'text quoting args that hold a selected key',
      policy: { keys: ['ssn'] },
      input: { ssn: SECRET },
      seed: seedPlain,
      rules: (s) => [{ when: () => thrown(`bad ${s.$getArgs().ssn}`), then: 'yes' }],
    },
    {
      name: 'a thrown string',
      policy: { keys: ['pw'] },
      seed: (s) => {
        s.pw = SECRET;
      },
      rules: () => [
        {
          when: (x: any) => {
            // eslint-disable-next-line no-throw-literal
            throw `bad ${x.pw}`;
          },
          then: 'yes',
        },
      ],
    },
    {
      name: 'a filter whose comparison throws, on a selected key',
      policy: { keys: ['pw'] },
      seed: (s) => {
        s.pw = SECRET;
      },
      rules: (s) => {
        const pw = s.pw;
        return [
          {
            when: {
              plain: {
                // The list the rule reads throws when it is asked: the one place a filter comparison runs
                // code the rule's author wrote (an ordered operator never coerces an object).
                in: new Proxy([] as unknown[], {
                  get(target, prop, receiver) {
                    if (prop === 'includes') throw new Error(`bad ${pw}`);
                    return Reflect.get(target, prop, receiver);
                  },
                }),
              },
            },
            then: 'yes',
          },
        ];
      },
    },
    {
      name: 'the entry selected by name through a diagnostic selector',
      policy: { diagnostics: { keys: ['errors.matchError'] } },
      seed: seedPlain,
      rules: () => [{ when: () => thrown(`bad ${SECRET}`), then: 'yes' }],
    },
    {
      name: 'the entry selected by name through a state rule',
      policy: { keys: ['matchError'] },
      seed: seedPlain,
      rules: () => [{ when: () => thrown(`bad ${SECRET}`), then: 'yes' }],
    },
  ];

  describe.each([
    ['decide()', deciderChart],
    ['select()', selectorChart],
  ] as const)('%s', (_door, build) => {
    it.each(ERROR_ROUTES.map((route) => [route.name, route] as const))('%s', async (_name, route) => {
      // A later rule matches, because `select()` with nothing selected fires its event with no evidence.
      const rules: Rules = (s) => [...route.rules(s), { when: () => true, then: 'yes' }];
      const surfaces = await evidenceSurfaces(build(route.seed, rules), route.policy, route.input);

      expect(surfacesHolding(surfaces, SECRET)).toEqual([]);
      const [rule] = surfaces.evidence[0].rules;
      expect(rule.matched).toBe(false);
      expect(rule.matchError).toBe('[REDACTED]');
    });
  });

  it('the dev-mode warning prints the served text, never the raw one', async () => {
    const { enableDevMode, disableDevMode } = await import('../../../../src/index.js');
    const warned: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => {
      warned.push(args.map(String).join(' '));
    };
    enableDevMode();
    try {
      await evidenceSurfaces(
        deciderChart(
          (s) => {
            s.pw = SECRET;
          },
          () => [{ when: (x: any) => thrown(`bad ${x.pw}`), then: 'yes' }],
        ),
        { keys: ['pw'] },
      );
    } finally {
      disableDevMode();
      console.warn = original;
    }
    expect(warned.some((line) => line.includes('threw during evaluation'))).toBe(true);
    expect(warned.filter((line) => line.includes(SECRET))).toEqual([]);
  });

  it('the text stays when nothing selected reached the rule', async () => {
    const surfaces = await evidenceSurfaces(
      deciderChart(
        (s) => {
          s.plain = 'visible';
          s.pw = SECRET;
        },
        () => [{ when: (x: any) => thrown(`bad ${x.plain}`), then: 'yes' }],
      ),
      { keys: ['pw'] },
    );
    expect(surfaces.evidence[0].rules[0].matchError).toBe('bad visible');
  });
});

describe('evidence: nested placements serve one form', () => {
  const policy = { keys: ['ssn'] };

  it('a decider in a subflow, its threshold copied from the mapped args', async () => {
    const inner = flowChart<any>('Start', () => undefined, 'start')
      .addDeciderFunction(
        'Route',
        (s: any) => decide(s, [{ when: { plain: { ne: s.$getArgs().ssn } }, then: 'yes' }], 'no'),
        'route',
      )
      .addFunctionBranch('yes', 'Yes', () => undefined)
      .addFunctionBranch('no', 'No', () => undefined)
      .setDefault('no')
      .end()
      .build();
    const chart = flowChart<any>(
      'Seed',
      (s: any) => {
        s.ssn = SECRET;
      },
      'seed',
    )
      .addSubFlowChartNext('sf', inner, 'Sub', { inputMapper: (p: any) => ({ ssn: p.ssn }) })
      .build();

    const surfaces = await evidenceSurfaces(chart, policy);

    expect(surfaces.evidence.length).toBe(1);
    expect(surfacesHolding(surfaces, SECRET)).toEqual([]);
    expect(conditionsOf(surfaces)[0].thresholdRedacted).toBe(true);
  });

  it('a decider in a fork child, its rule throwing with a selected value', async () => {
    const chart = flowChart<any>(
      'Seed',
      (s: any) => {
        s.ssn = SECRET;
      },
      'seed',
    )
      .addListOfFunction([
        {
          id: 'child',
          name: 'Child',
          fn: (s: any) => {
            const ssn = s.ssn;
            const result = decide(
              s,
              [
                {
                  when: () => {
                    throw new Error(`bad ${ssn}`);
                  },
                  then: 'yes',
                },
              ],
              'no',
            );
            s.childEvidence = JSON.stringify(result.evidence);
          },
        },
      ])
      .addFunction('Join', () => undefined, 'join')
      .build();

    const surfaces = await evidenceSurfaces(chart, policy);

    expect(surfacesHolding(surfaces, SECRET)).toEqual([]);
    expect(surfaces.disk).toContain('childEvidence');
  });

  it('a fan-out branch, its threshold copied from the selected item', async () => {
    const branch = flowChart<any>(
      'Each',
      (s: any) => {
        const result = decide(s, [{ when: { index: { ne: s.item } }, then: 'yes' }], 'no');
        s.branchEvidence = JSON.stringify(result.evidence);
      },
      'each',
    ).build();
    const chart = flowChart<any>(
      'Seed',
      (s: any) => {
        s.ssn = SECRET;
      },
      'seed',
    )
      .addParallelForEach('Fan', 'fan', {
        items: (s: any) => [s.ssn],
        branch: () => branch,
        maxBranches: 2,
        into: 'done',
      })
      .build();

    const surfaces = await evidenceSurfaces(chart, policy);

    expect(surfacesHolding(surfaces, SECRET)).toEqual([]);
    expect(surfaces.disk).toContain('branchEvidence');
  });
});

describe('evidence: one form at every door', () => {
  const policy = { keys: ['ssn'] };
  const chart = () =>
    deciderChart(
      (s) => {
        s.ssn = SECRET;
      },
      () => [{ when: { ssn: { eq: SECRET } }, then: 'yes' }],
    );

  it('a deferred recorder gets the served form', async () => {
    const seen: unknown[] = [];
    const executor = new FlowChartExecutor(chart());
    executor.setRedactionPolicy(policy);
    executor.attachFlowRecorder(
      {
        id: 'deferred-evidence',
        onDecision: (event: any) => {
          seen.push(event.evidence);
        },
      },
      { delivery: 'deferred' },
    );
    await executor.run();
    await executor.drainObservers();
    expect(seen.length).toBe(1);
    expect(JSON.stringify(seen)).not.toContain(SECRET);
  });

  it('the result a stage gets back is the served form, and routing used the real values', async () => {
    let returned: any;
    const flow = flowChart<any>(
      'Seed',
      (s: any) => {
        s.ssn = SECRET;
      },
      'seed',
    )
      .addDeciderFunction(
        'Route',
        (s: any) => {
          returned = decide(s, [{ when: { ssn: { eq: SECRET } }, then: 'yes' }], 'no');
          return returned;
        },
        'route',
      )
      .addFunctionBranch('yes', 'Yes', () => undefined)
      .addFunctionBranch('no', 'No', () => undefined)
      .setDefault('no')
      .end()
      .build();
    await evidenceSurfaces(flow, policy);
    expect(returned.branch).toBe('yes');
    expect(JSON.stringify(returned.evidence)).not.toContain(SECRET);
  });

  it('a scope registered by hand over the facade gets the same rule', async () => {
    const flow = flowChart<any>(
      'Seed',
      (s: any) => {
        s.ssn = SECRET;
      },
      'seed',
    )
      .addDeciderFunction(
        'Route',
        (s: any) => {
          const custom = registerScopeRuntime({}, { target: s.$toRaw(), handlesAssignments: false });
          return decide(custom, [{ when: { ssn: { eq: SECRET } }, then: 'yes' }], 'no');
        },
        'route',
      )
      .addFunctionBranch('yes', 'Yes', () => undefined)
      .addFunctionBranch('no', 'No', () => undefined)
      .setDefault('no')
      .end()
      .build();
    const surfaces = await evidenceSurfaces(flow, policy);
    expect(surfacesHolding(surfaces, SECRET)).toEqual([]);
    expect(conditionsOf(surfaces)[0].thresholdRedacted).toBe(true);
  });

  it('a port with no rule still masks what it names, and quotes what it cannot judge', () => {
    const scope = registerTestScope({
      getValue: () => 'real',
      getRedactedKeys: () => new Set(['ssn']),
    });
    const { evidence } = decide(
      scope,
      [
        { when: { ssn: { ne: 'real' } }, then: 'a' },
        { when: { other: { eq: 'kept' } }, then: 'a' },
      ],
      'no',
    );
    const [masked, kept] = evidence.rules.map((rule: any) => rule.conditions[0]);
    expect(masked.thresholdRedacted).toBe(true);
    expect(kept.threshold).toBe('kept');
  });
});

describe('evidence: a hole can be told from a value', () => {
  const policy = { keys: ['ssn'] };

  it('a real threshold that reads `[REDACTED]` stays a value, with no marker', async () => {
    const surfaces = await evidenceSurfaces(
      deciderChart(seedPlain, () => [{ when: { plain: { ne: '[REDACTED]' } }, then: 'yes' }]),
      policy,
    );
    const [condition] = conditionsOf(surfaces);
    expect(condition.threshold).toBe('[REDACTED]');
    expect(Object.hasOwn(condition, 'thresholdRedacted')).toBe(false);
    // The narrative quotes a value, and leaves a hole bare.
    expect(surfaces.narrative).toContain(String.raw`\"[REDACTED]\"`);
  });

  it('a masked threshold is bare in the narrative', async () => {
    const surfaces = await evidenceSurfaces(
      deciderChart(
        (s) => {
          s.ssn = SECRET;
        },
        () => [{ when: { ssn: { eq: SECRET } }, then: 'yes' }],
      ),
      policy,
    );
    expect(surfaces.narrative).toContain('ssn [REDACTED] eq [REDACTED]');
  });

  it('`redacted` still speaks only for the actual value', async () => {
    const surfaces = await evidenceSurfaces(
      deciderChart(
        (s) => {
          s.plain = 'visible';
          s.expected = SECRET;
        },
        (s) => [{ when: { plain: { ne: s.expected } }, then: 'yes' }],
      ),
      { keys: ['expected'] },
    );
    const [condition] = conditionsOf(surfaces);
    expect(condition.redacted).toBe(false);
    expect(condition.actualSummary).toBe('"visible"');
    expect(condition.thresholdRedacted).toBe(true);
  });

  it('the condition result is kept, so the decision still reads', async () => {
    const surfaces = await evidenceSurfaces(
      deciderChart(
        (s) => {
          s.ssn = SECRET;
        },
        () => [{ when: { ssn: { eq: SECRET } }, then: 'yes' }],
      ),
      policy,
    );
    expect(surfaces.evidence[0].chosen).toBe('yes');
    expect(conditionsOf(surfaces)[0].result).toBe(true);
  });
});

describe('evidence: a threshold nothing selected stays visible', () => {
  const clearRule = () => [{ when: { plain: { ne: 'other' } }, then: 'yes', label: 'Plain rule' }];

  it('a policy is active, and this stage read nothing it selects', async () => {
    const surfaces = await evidenceSurfaces(
      deciderChart((s) => {
        s.plain = 'visible';
        s.ssn = SECRET;
      }, clearRule),
      { keys: ['ssn'] },
    );
    const [condition] = conditionsOf(surfaces);
    expect(condition).toEqual({
      key: 'plain',
      op: 'ne',
      threshold: 'other',
      actualSummary: '"visible"',
      result: true,
      redacted: false,
    });
  });

  it('a stage that only WROTE a selected key has no selected read', async () => {
    const chart = flowChart<any>('Seed', seedPlain, 'seed')
      .addDeciderFunction(
        'Route',
        (s: any) => {
          s.ssn = SECRET;
          return decide(s, clearRule(), 'no');
        },
        'route',
      )
      .addFunctionBranch('yes', 'Yes', () => undefined)
      .addFunctionBranch('no', 'No', () => undefined)
      .setDefault('no')
      .end()
      .build();
    const surfaces = await evidenceSurfaces(chart, { keys: ['ssn'] });
    expect(conditionsOf(surfaces)[0].threshold).toBe('other');
  });

  it('a condition before the selected read keeps its threshold; the one after is hidden (conservative)', async () => {
    const surfaces = await evidenceSurfaces(
      deciderChart(
        (s) => {
          s.plain = 'visible';
          s.ssn = SECRET;
          s.amount = 5;
        },
        () => [{ when: { plain: { ne: 'other' }, ssn: { eq: SECRET }, amount: { gt: 1 } }, then: 'yes' }],
      ),
      { keys: ['ssn'] },
    );
    const [plain, ssn, amount] = conditionsOf(surfaces);
    expect(plain.threshold).toBe('other');
    expect(ssn.thresholdRedacted).toBe(true);
    expect(amount.thresholdRedacted).toBe(true);
    expect(amount.actualSummary).toBe('5');
  });

  it('args that hold no selected key hide nothing', async () => {
    const surfaces = await evidenceSurfaces(deciderChart(seedPlain, clearRule), { keys: ['ssn'] }, { region: 'west' });
    expect(conditionsOf(surfaces)[0].threshold).toBe('other');
  });

  it('a read of a selected key that holds nothing is not a selected read', async () => {
    const surfaces = await evidenceSurfaces(
      deciderChart(seedPlain, (s) => {
        expect(s.ssn).toBeUndefined();
        return clearRule();
      }),
      { keys: ['ssn'] },
    );
    expect(conditionsOf(surfaces)[0].threshold).toBe('other');
  });

  it('a label is author text: served as written, even beside a masked threshold', async () => {
    const surfaces = await evidenceSurfaces(
      deciderChart(
        (s) => {
          s.ssn = SECRET;
        },
        () => [{ when: { ssn: { eq: SECRET } }, then: 'yes', label: 'Known applicant' }],
      ),
      { keys: ['ssn'] },
    );
    expect(surfaces.evidence[0].rules[0].label).toBe('Known applicant');
    expect(surfaces.narrative).toContain('Known applicant');
  });
});

describe('byte identity: no policy, or a policy that selects nothing', () => {
  const rules = () => [
    { when: { plain: { eq: 'other' }, count: { in: [1, 2] } }, then: 'yes', label: 'Filter' },
    {
      when: () => {
        throw new Error('rule text');
      },
      then: 'yes',
      label: 'Thrower',
    },
    { when: (x: any) => x.plain === 'nope', then: 'yes', label: 'Function' },
  ];
  const seed = (s: any) => {
    s.plain = 'visible';
    s.count = 2;
  };
  const pinned = JSON.stringify({
    rules: [
      {
        type: 'filter',
        ruleIndex: 0,
        branch: 'yes',
        matched: false,
        label: 'Filter',
        conditions: [
          { key: 'plain', op: 'eq', threshold: 'other', actualSummary: '"visible"', result: false, redacted: false },
          { key: 'count', op: 'in', threshold: [1, 2], actualSummary: '2', result: true, redacted: false },
        ],
      },
      {
        type: 'function',
        ruleIndex: 1,
        branch: 'yes',
        matched: false,
        label: 'Thrower',
        inputs: [],
        matchError: 'rule text',
      },
      {
        type: 'function',
        ruleIndex: 2,
        branch: 'yes',
        matched: false,
        label: 'Function',
        inputs: [{ key: 'plain', valueSummary: '"visible"', redacted: false }],
      },
    ],
    chosen: 'no',
    default: 'no',
  });

  it.each([
    ['no policy', undefined],
    ['an empty policy', {}],
    ['a policy that selects names this run never touches', { keys: ['absent'], fields: { none: ['x'] } }],
    ['a pattern that matches nothing', { patterns: [/^absent$/] }],
    ['an emit-only policy', { emitPatterns: [/x/] }],
    ['a diagnostic selector elsewhere', { diagnostics: { keys: ['logs.absent'] } }],
  ] as const)('%s', async (_name, policy) => {
    const surfaces = await evidenceSurfaces(deciderChart(seed, rules), policy as RedactionPolicy | undefined, {
      region: 'west',
    });
    expect(JSON.stringify(surfaces.evidence[0])).toBe(pinned);
    expect(surfaces.disk).not.toContain('thresholdRedacted');
    expect(surfaces.recorders).not.toContain('thresholdRedacted');
  });
});
