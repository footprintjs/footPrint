/**
 * A threshold under an active rule is read ONCE. THE LAW (`RedactionRule · serveThreshold`): one detached copy is made,
 * from property descriptors; that copy is what the check looks at and what evidence keeps. So nothing can change it after
 * the check, and no author code (a getter, a `toJSON`) decides what a reader sees. What the copy cannot hold faithfully
 * is a hole.
 *
 * The threshold's own object is the author's: a stage can still edit it after `decide()` returns, or in a later stage.
 *
 * Test types: Security (each way in, both doors, every surface) · Boundary (what stays a value; a Proxy never throws) ·
 * Differential (an inert rule keeps the reference and reads nothing).
 */
import { describe, expect, it } from 'vitest';

import type { RedactionPolicy } from '../../../../src/index.js';
import { decide, flowChart, FlowChartExecutor, select } from '../../../../src/index.js';
import { conditionsOf, evidenceSurfaces, surfacesHolding } from '../helpers/evidenceSurfaces.js';

const SECRET = 'SEKRET-1138-LEAK';
const POLICY: RedactionPolicy = { keys: ['token'] };
const DOORS = ['decide', 'select'] as const;
type Door = (typeof DOORS)[number];

interface Stage {
  /** More state, past what every chart seeds. */
  readonly seed?: (s: any) => void;
  /** The key the filter tests. Default: `plain`. */
  readonly key?: string;
  /** The filter's ops, built inside the stage so a threshold can read the scope. */
  readonly ops: (s: any) => Record<string, unknown>;
  /** Runs after the helper returned, before the stage does. */
  readonly after?: (s: any) => void;
  /** A later stage, for a threshold held across stages. */
  readonly later?: (s: any) => void;
}

/** The chart, and the evidence `decide()` / `select()` returned to the stage. */
function chartOf(door: Door, stage: Stage) {
  const returned: any[] = [];
  const route = (s: any) => {
    const rules = [{ when: { [stage.key ?? 'plain']: stage.ops(s) }, then: 'yes' }];
    const result = door === 'decide' ? decide(s, rules, 'no') : select(s, rules);
    returned.push(result.evidence);
    stage.after?.(s);
    return result;
  };
  const start = flowChart<any>(
    'Seed',
    (s: any) => {
      s.plain = 'clear';
      s.token = SECRET;
      s.list = ['clear', 'other'];
      s.config = { name: 'A' };
      stage.seed?.(s);
    },
    'seed',
  );
  const branches = (cursor: any) =>
    cursor.addFunctionBranch('yes', 'Yes', () => undefined).addFunctionBranch('no', 'No', () => undefined);
  const decided =
    door === 'decide'
      ? branches(start.addDeciderFunction('Route', route, 'route')).setDefault('no').end()
      : branches(start.addSelectorFunction('Route', route, 'route')).end();
  const chart = (stage.later ? decided.addFunction('Later', stage.later, 'later') : decided).build();
  return { chart, returned };
}

/**
 * Runs the chart and proves the surfaces are not empty: a check that the secret is absent means nothing otherwise. The
 * saved note holds JSON values only, so `capture: 'not-written'` names a threshold it refuses (a `Date`, say): that run
 * still has every other surface.
 */
async function run(
  door: Door,
  stage: Stage,
  policy: RedactionPolicy | null = POLICY,
  capture: 'written' | 'not-written' = 'written',
) {
  const { chart, returned } = chartOf(door, stage);
  const surfaces = await evidenceSurfaces(chart, policy ?? undefined);
  expect(surfaces.evidence.length).toBe(1);
  expect(surfaces.deferred.length).toBe(1);
  if (capture === 'written') expect(surfaces.capture).not.toBe('');
  else expect(surfaces.capture).toBe('');
  return {
    surfaces,
    returned,
    condition: conditionsOf(surfaces)[0],
    clone: surfaces.deferred[0].rules[0].conditions[0],
  };
}

/** A value the file record cannot hold (a `Map` in state, a cycle): the doors that do not go through JSON. */
async function liveOnly(door: Door, stage: Stage, policy: RedactionPolicy = POLICY) {
  const { chart, returned } = chartOf(door, stage);
  const executor = new FlowChartExecutor(chart);
  executor.setRedactionPolicy(policy);
  const live: any[] = [];
  const deferred: any[] = [];
  const take = (into: any[]) => (event: any) => {
    if (event.evidence) into.push(event.evidence);
  };
  executor.attachFlowRecorder({ id: 'live', onDecision: take(live), onSelected: take(live) });
  executor.attachFlowRecorder(
    { id: 'deferred', onDecision: take(deferred), onSelected: take(deferred) },
    { delivery: 'deferred' },
  );
  await executor.run();
  await executor.drainObservers();
  return { returned, condition: live[0].rules[0].conditions[0], clone: deferred[0].rules[0].conditions[0] };
}

function expectNoSecret(result: Awaited<ReturnType<typeof run>>): void {
  expect(surfacesHolding(result.surfaces, SECRET)).toEqual([]);
  expect(JSON.stringify(result.returned)).not.toContain(SECRET);
}

function expectHole(result: Awaited<ReturnType<typeof run>>): void {
  for (const condition of [result.condition, result.clone, result.returned[0].rules[0].conditions[0]]) {
    expect(condition.threshold).toBe('[REDACTED]');
    expect(condition.thresholdRedacted).toBe(true);
  }
  expect(result.surfaces.capture).toContain('"thresholdRedacted":true');
  expectNoSecret(result);
}

function expectValue(result: Awaited<ReturnType<typeof run>>, value: unknown): void {
  for (const condition of [result.condition, result.clone, result.returned[0].rules[0].conditions[0]]) {
    expect(condition.threshold).toEqual(value);
    expect(Object.hasOwn(condition, 'thresholdRedacted')).toBe(false);
  }
  expect(result.surfaces.capture).not.toContain('thresholdRedacted');
  expectNoSecret(result);
}

describe.each(DOORS)('%s(): nothing changes a threshold after the check', (door) => {
  it('a selected value set on the threshold after the helper returned', async () => {
    const threshold: Record<string, unknown> = { limit: 10 };
    const result = await run(door, {
      ops: () => ({ ne: threshold }),
      after: (s) => {
        threshold.token = s.token;
      },
    });
    expect(threshold.token).toBe(SECRET);
    expectValue(result, { limit: 10 });
  });

  it('the same, under a name nothing selects', async () => {
    const threshold: Record<string, unknown> = { limit: 10 };
    const result = await run(door, {
      ops: () => ({ ne: threshold }),
      after: (s) => {
        threshold.copied = s.token;
      },
    });
    expectValue(result, { limit: 10 });
  });

  it('an `in` list that grows after the helper returned', async () => {
    const list = ['clear'];
    const result = await run(door, {
      ops: () => ({ in: list }),
      after: (s) => {
        list.push(s.token);
      },
    });
    expectValue(result, ['clear']);
  });

  it('a value deep inside the threshold', async () => {
    const threshold = { deep: { rows: [{ row: 1 } as Record<string, unknown>] } };
    const result = await run(door, {
      ops: () => ({ ne: threshold }),
      after: (s) => {
        threshold.deep.rows[0].copied = s.token;
      },
    });
    expectValue(result, { deep: { rows: [{ row: 1 }] } });
  });

  it('a threshold held across stages and edited in a later one', async () => {
    const threshold: Record<string, unknown> = { limit: 10 };
    const result = await run(door, {
      ops: () => ({ ne: threshold }),
      later: (s) => {
        threshold.copied = s.token;
      },
    });
    expect(threshold.copied).toBe(SECRET);
    expectValue(result, { limit: 10 });
  });

  it('a Date moved after the helper returned', async () => {
    const when = new Date(0);
    const result = await run(
      door,
      {
        ops: () => ({ ne: when }),
        after: () => {
          when.setTime(1138);
        },
      },
      POLICY,
      'not-written',
    );
    expectValue(result, new Date(0));
    expect(result.condition.threshold).not.toBe(when);
  });

  it('evidence keeps a copy nothing can edit, not the original', async () => {
    const threshold = { limit: 10, deep: [{ row: 1 }] };
    const { condition } = await run(door, { ops: () => ({ ne: threshold }) });
    expect(condition.threshold).not.toBe(threshold);
    expect(condition.threshold.deep).not.toBe(threshold.deep);
    expect(Object.isFrozen(condition.threshold)).toBe(true);
    expect(Object.isFrozen(condition.threshold.deep)).toBe(true);
    expect(Object.isFrozen(condition.threshold.deep[0])).toBe(true);
  });
});

/** Each one hides content, or runs code, where a walk of enumerable names does not look. */
const HIDDEN: ReadonlyArray<readonly [string, () => { value: unknown; ran: () => number }]> = [
  [
    'a non-enumerable toJSON',
    () => {
      let ran = 0;
      const value = Object.defineProperty({ limit: 10 }, 'toJSON', {
        value: () => {
          ran += 1;
          return { copied: SECRET };
        },
        enumerable: false,
      });
      return { value, ran: () => ran };
    },
  ],
  [
    'a non-enumerable toString',
    () => {
      let ran = 0;
      const value = Object.defineProperty({ limit: 10 }, 'toString', {
        value: () => {
          ran += 1;
          return SECRET;
        },
        enumerable: false,
      });
      return { value, ran: () => ran };
    },
  ],
  [
    'a non-enumerable data key',
    () => ({ value: Object.defineProperty({ limit: 10 }, 'copied', { value: SECRET }), ran: () => 0 }),
  ],
  ['a symbol key', () => ({ value: { limit: 10, [Symbol('copied')]: SECRET }, ran: () => 0 })],
  ['a symbol key that spells a selected name', () => ({ value: { [Symbol.for('token')]: SECRET }, ran: () => 0 })],
  ['a symbol value', () => ({ value: { limit: Symbol(SECRET) }, ran: () => 0 })],
  ['a bare symbol', () => ({ value: Symbol(SECRET), ran: () => 0 })],
  ['a list with a named key', () => ({ value: Object.assign(['a'], { copied: SECRET }), ran: () => 0 })],
  [
    'a list with a non-enumerable toJSON',
    () => ({
      value: Object.defineProperty(['a'], 'toJSON', { value: () => SECRET, enumerable: false }),
      ran: () => 0,
    }),
  ],
  [
    'an enumerable getter whose answer changes',
    () => {
      let ran = 0;
      return {
        value: {
          get limit() {
            ran += 1;
            return ran === 1 ? 10 : SECRET;
          },
        },
        ran: () => ran,
      };
    },
  ],
  [
    'a non-enumerable getter',
    () => {
      let ran = 0;
      const value = Object.defineProperty({ limit: 10 }, 'copied', {
        get() {
          ran += 1;
          return SECRET;
        },
        enumerable: false,
      });
      return { value, ran: () => ran };
    },
  ],
  [
    'a setter with no getter',
    () => {
      let ran = 0;
      // eslint-disable-next-line accessor-pairs -- the shape under test: a setter with no getter.
      const value = Object.defineProperty({ limit: 10 }, 'copied', {
        set() {
          ran += 1;
        },
        enumerable: true,
      });
      return { value, ran: () => ran };
    },
  ],
  [
    'a Date with a non-enumerable toJSON',
    () => ({
      value: Object.defineProperty(new Date(0), 'toJSON', { value: () => SECRET, enumerable: false }),
      ran: () => 0,
    }),
  ],
  ['a Date with a key of its own', () => ({ value: Object.assign(new Date(0), { copied: SECRET }), ran: () => 0 })],
];

const PLACEMENTS: ReadonlyArray<readonly [string, (value: unknown) => Record<string, unknown>]> = [
  ['bare', (value) => ({ ne: value })],
  ['in an `in` list', (value) => ({ notIn: ['x', value] })],
  ['in a plain object', (value) => ({ ne: { deep: value } })],
  ['deep in a list in an object', (value) => ({ ne: { deep: [{ deeper: value }] } })],
];

describe.each(DOORS)('%s(): what a walk of enumerable names cannot see is a hole', (door) => {
  it.each(HIDDEN.flatMap(([kind, make]) => PLACEMENTS.map(([where, place]) => [kind, where, make, place] as const)))(
    '%s, %s, and no author code ran',
    async (_kind, _where, make, place) => {
      const { value, ran } = make();
      const result = await run(door, { ops: () => place(value) });
      expectHole(result);
      expect(ran()).toBe(0);
    },
  );

  it('a hidden toJSON under a policy that names something else entirely', async () => {
    const hidden = 'HIDDEN-IN-A-HOOK';
    const threshold = Object.defineProperty({ limit: 10 }, 'toJSON', {
      value: () => ({ copied: hidden }),
      enumerable: false,
    });
    const { surfaces, condition } = await run(door, { ops: () => ({ ne: threshold }) }, { keys: ['ssn'] });
    expect(condition.thresholdRedacted).toBe(true);
    expect(surfacesHolding(surfaces, hidden)).toEqual([]);
  });
});

/** A Proxy: every reflective question reaches its traps, so what comes out may never be built from their answers. */
const PROXIES: ReadonlyArray<readonly [string, (s: any) => unknown]> = [
  ['a transparent object', () => new Proxy({ limit: 10 }, {})],
  ['a transparent list', () => new Proxy(['a'], {})],
  ['a Date', () => new Proxy(new Date(0), {})],
  [
    'a revoked one',
    () => {
      const { proxy, revoke } = Proxy.revocable({}, {});
      revoke();
      return proxy;
    },
  ],
  [
    'one whose getPrototypeOf throws',
    () =>
      new Proxy(
        {},
        {
          getPrototypeOf: () => {
            throw new Error(SECRET);
          },
        },
      ),
  ],
  [
    'one whose ownKeys throws',
    () =>
      new Proxy(
        {},
        {
          ownKeys: () => {
            throw new Error(SECRET);
          },
        },
      ),
  ],
  [
    'one whose getOwnPropertyDescriptor throws',
    () =>
      new Proxy(
        { limit: 10 },
        {
          getOwnPropertyDescriptor: () => {
            throw new Error(SECRET);
          },
        },
      ),
  ],
  [
    'one whose get throws',
    () =>
      new Proxy(
        { limit: 10 },
        {
          get: () => {
            throw new Error(SECRET);
          },
        },
      ),
  ],
  [
    'one that answers with a value of its own',
    () =>
      new Proxy(
        {},
        {
          ownKeys: () => ['copied'],
          getOwnPropertyDescriptor: () => ({ value: SECRET, enumerable: true, configurable: true }),
        },
      ),
  ],
  [
    'one whose trap reads the selected value',
    (s) =>
      new Proxy(
        {},
        {
          ownKeys: () => ['copied'],
          getOwnPropertyDescriptor: () => ({ value: s.token, enumerable: true, configurable: true }),
        },
      ),
  ],
  [
    'one that takes itself out of the threshold while it answers',
    () => {
      const parent: Record<string, unknown> = {};
      parent.part = new Proxy(
        {},
        {
          ownKeys: () => {
            delete parent.part;
            return ['copied'];
          },
          getOwnPropertyDescriptor: () => ({ value: SECRET, enumerable: true, configurable: true }),
        },
      );
      return parent;
    },
  ],
];

describe.each(DOORS)('%s(): a Proxy is a hole and never throws out of the helper', (door) => {
  it.each(PROXIES.flatMap(([kind, make]) => PLACEMENTS.map(([where, place]) => [kind, where, make, place] as const)))(
    '%s, %s',
    async (_kind, _where, make, place) => {
      const result = await run(door, { ops: (s) => place(make(s)) });
      expectHole(result);
      expect(result.surfaces.evidence[0].rules[0].matchError).toBeUndefined();
      expect(result.condition.result).toBe(true);
    },
  );

  it('the rule still evaluates on the real Proxy', async () => {
    let includes = 0;
    const list = new Proxy(['clear'], {
      get(target, prop, receiver) {
        if (prop === 'includes') includes += 1;
        return Reflect.get(target, prop, receiver);
      },
    });
    const result = await run(door, { ops: () => ({ in: list }) });
    expect(includes).toBe(1);
    expect(result.condition.result).toBe(true);
    expectHole(result);
  });
});

describe.each(DOORS)('%s(): plain data under a key nothing selects stays visible', (door) => {
  const loop: Record<string, unknown> = { name: 'A' };
  loop.self = loop;
  const shared = { name: 'A' };

  it.each<readonly [string, unknown]>([
    ['a string', 'visible'],
    ['a number', 1],
    ['a boolean', false],
    ['null', null],
    ['a string that reads like the placeholder', '[REDACTED]'],
    ['a list', ['a', 1, null]],
    ['an object', { name: 'A', deep: { list: [1] } }],
    ['a frozen object', Object.freeze({ name: 'A' })],
    ['a value shared twice', [shared, shared]],
  ])('%s', async (_kind, value) => {
    expectValue(await run(door, { ops: () => ({ ne: value }) }), value);
  });

  it.each<readonly [string, unknown]>([
    ['a Date', new Date(0)],
    ['an invalid Date', new Date(Number.NaN)],
    ['a Date in a list', [new Date(0)]],
    ['a Date deep in an object', { at: { when: new Date(0) } }],
  ])('%s', async (_kind, value) => {
    expectValue(await run(door, { ops: () => ({ ne: value }) }, POLICY, 'not-written'), value);
  });

  it('a null-prototype object keeps its shape', async () => {
    const value = Object.assign(Object.create(null), { name: 'A' });
    const { condition } = await liveOnly(door, { ops: () => ({ ne: value }) });
    expect(Object.getPrototypeOf(condition.threshold)).toBeNull();
    expect(condition.threshold.name).toBe('A');
    expect(Object.hasOwn(condition, 'thresholdRedacted')).toBe(false);
  });

  it('an own `__proto__` key stays a key and sets no prototype', async () => {
    const value = JSON.parse('{"__proto__":{"name":"A"}}');
    const { condition } = await run(door, { ops: () => ({ ne: value }) });
    expect(Object.getPrototypeOf(condition.threshold)).toBe(Object.prototype);
    expect(Object.hasOwn(condition.threshold, '__proto__')).toBe(true);
  });

  it('a cycle is copied as a cycle, live', async () => {
    const { threshold } = (await liveOnly(door, { ops: () => ({ ne: loop }) })).condition;
    expect(threshold).not.toBe(loop);
    expect(threshold.self).toBe(threshold);
    expect(threshold.name).toBe('A');
  });

  it('a list behind a scope handle is copied from the value behind it, and the rule matches', async () => {
    const result = await run(door, { ops: (s) => ({ in: s.list }) });
    expectValue(result, ['clear', 'other']);
    expect(result.condition.result).toBe(true);
  });

  it('an object behind a scope handle', async () => {
    expectValue(await run(door, { ops: (s) => ({ ne: s.config }) }), { name: 'A' });
  });

  it('a handle inside an object the stage built is a Proxy like any other: a hole', async () => {
    expectHole(await run(door, { ops: (s) => ({ ne: { deep: [s.config] } }) }));
  });

  it('a Map behind a scope handle is still a hole', async () => {
    const { condition, clone, returned } = await liveOnly(door, {
      seed: (s) => {
        s.holdsMap = { inner: new Map([['a', SECRET]]) };
      },
      ops: (s) => ({ ne: s.holdsMap }),
    });
    for (const row of [condition, clone, returned[0].rules[0].conditions[0]]) {
      expect(row.threshold).toBe('[REDACTED]');
      expect(row.thresholdRedacted).toBe(true);
    }
  });

  it('a selected name added on the copy route: the check reads the copy', async () => {
    expectHole(await run(door, { ops: () => ({ ne: { token: 'made here' } }) }));
  });
});

describe('the rule evaluates on the real value, unchanged', () => {
  it.each(DOORS)('%s(): `eq` compares the original object, by identity, and the copy is served', async (door) => {
    const held: { raw?: unknown } = {};
    const result = await run(door, {
      key: 'config',
      ops: (s) => {
        held.raw = s.$getValue('config');
        return { eq: held.raw };
      },
    });
    expect(result.condition.result).toBe(true);
    expect(result.condition.threshold).not.toBe(held.raw);
    expectValue(result, { name: 'A' });
  });

  it.each(DOORS)('%s(): a hole does not change the result', async (door) => {
    const list = Object.defineProperty(['clear'], 'toJSON', { value: () => SECRET, enumerable: false });
    const result = await run(door, { ops: () => ({ in: list }) });
    expect(result.condition.result).toBe(true);
    expect(result.surfaces.evidence[0].rules[0].matched).toBe(true);
    expectHole(result);
  });
});

describe('differential: an inert rule keeps the reference and reads nothing', () => {
  const INERT: ReadonlyArray<readonly [string, RedactionPolicy | null]> = [
    ['no policy', null],
    ['an empty policy', {}],
    ['an emit-only policy', { emitPatterns: [/x/] }],
    ['a diagnostic selector elsewhere', { diagnostics: { keys: ['logs.absent'] } }],
  ];

  it.each(DOORS.flatMap((door) => INERT.map(([name, policy]) => [door, name, policy] as const)))(
    '%s() under %s: the original object, as main keeps it',
    async (door, _name, policy) => {
      const threshold: Record<string, unknown> = { limit: 10 };
      const { condition } = await run(
        door,
        {
          ops: () => ({ ne: threshold }),
          after: () => {
            threshold.later = 1;
          },
        },
        policy,
      );
      expect(condition.threshold).toBe(threshold);
      expect(condition.threshold.later).toBe(1);
      expect(Object.isFrozen(threshold)).toBe(false);
      expect(Object.hasOwn(condition, 'thresholdRedacted')).toBe(false);
    },
  );
});

describe('a named limit: with no policy, a mark made after the check does not reach back', () => {
  it.each(DOORS)('%s() keeps the reference it was given when the rule was still inert', async (door) => {
    const threshold: Record<string, unknown> = { limit: 10 };
    const { condition } = await run(
      door,
      {
        ops: () => ({ ne: threshold }),
        after: (s) => {
          s.$setValue('marked', 'made after the check', true);
        },
      },
      null,
    );
    expect(condition.threshold).toBe(threshold);
    expect(Object.isFrozen(threshold)).toBe(false);
  });
});

describe.each(DOORS)('%s(): the text a rule threw is one string, made once', (door) => {
  const chartThrowing = (thrown: (s: any) => unknown, after?: (s: any) => void) => {
    const route = (s: any) => {
      const rules = [
        {
          when: () => {
            throw thrown(s);
          },
          then: 'yes',
        },
        // A selector that selects nothing fires with no evidence.
        { when: () => true, then: 'no' },
      ];
      const result = door === 'decide' ? decide(s, rules, 'no') : select(s, rules);
      after?.(s);
      return result;
    };
    const start = flowChart<any>(
      'Seed',
      (s: any) => {
        s.plain = 'clear';
        s.token = SECRET;
      },
      'seed',
    );
    const branches = (cursor: any) =>
      cursor.addFunctionBranch('yes', 'Yes', () => undefined).addFunctionBranch('no', 'No', () => undefined);
    return door === 'decide'
      ? branches(start.addDeciderFunction('Route', route, 'route')).setDefault('no').end().build()
      : branches(start.addSelectorFunction('Route', route, 'route')).end().build();
  };

  it('an Error edited after the helper returned changes nothing', async () => {
    const error = new Error('plain text');
    const surfaces = await evidenceSurfaces(
      chartThrowing(
        () => error,
        (s) => {
          error.message = s.token;
        },
      ),
      POLICY,
    );
    expect(surfaces.evidence[0].rules[0].matchError).toBe('plain text');
    expect(surfacesHolding(surfaces, SECRET)).toEqual([]);
  });

  it('a message that is an object whose toString reads the selected value', async () => {
    const surfaces = await evidenceSurfaces(
      chartThrowing((s) => Object.assign(new Error('x'), { message: { toString: () => s.token } })),
      POLICY,
    );
    expect(surfaces.evidence[0].rules[0].matchError).toBe('[REDACTED]');
    expect(surfacesHolding(surfaces, SECRET)).toEqual([]);
  });
});

describe('a break reason is one string, made once', () => {
  const chartBreaking = (reason: (s: any) => unknown) =>
    flowChart<any>(
      'Seed',
      (s: any) => {
        s.token = SECRET;
      },
      'seed',
    )
      .addFunction(
        'Stop',
        (s: any) => {
          s.$break(reason(s));
        },
        'stop',
      )
      .build();

  it('a plain string stays', async () => {
    const surfaces = await evidenceSurfaces(
      chartBreaking(() => 'stopped'),
      POLICY,
    );
    expect(surfaces.reasons).toEqual(['stopped']);
  });

  it('an object whose toString reads the selected value is a hole', async () => {
    let ran = 0;
    const surfaces = await evidenceSurfaces(
      chartBreaking((s) => ({
        toString: () => {
          ran += 1;
          return s.token;
        },
      })),
      POLICY,
    );
    expect(surfaces.reasons).toEqual(['[REDACTED]']);
    expect(ran).toBe(0);
    expect(surfacesHolding(surfaces, SECRET)).toEqual([]);
  });

  it('a number is its text', async () => {
    const surfaces = await evidenceSurfaces(
      chartBreaking(() => 7),
      POLICY,
    );
    expect(surfaces.reasons).toEqual(['7']);
  });

  it('with no policy it is the value as main keeps it', async () => {
    const reason = { why: 'stopped' };
    const surfaces = await evidenceSurfaces(
      chartBreaking(() => reason),
      undefined,
    );
    expect(surfaces.reasons[0]).toBe(reason);
  });
});
