/**
 * A policy selects by NAME, so a threshold can be served only when a walk of its names answers for everything it holds.
 * THE LAW (`RedactionRule · servesThreshold`, SHAPE): a threshold that keeps content no key shows, at any depth, is a
 * hole under an active rule. A `Map` keeps its entries there, so without this they reach the live event, the deferred
 * clone and `getSnapshot().recorders` whole, and `JSON.stringify` prints `{}` over them: these tests read them with
 * `spelled`, which spells those contents out.
 *
 * A `Date` is the one kind served as written: it holds one number and its own keys, so it can hide no name, and it says
 * no more than a number threshold does.
 *
 * Test types: Security (each kind, each placement, each surface) · Boundary (`Date`, what the walk does accept) ·
 * Differential (no policy and an inert rule keep the value itself).
 */
import { describe, expect, it } from 'vitest';

import type { RedactionPolicy } from '../../../../src/index.js';
import { decide, flowChart, FlowChartExecutor, select } from '../../../../src/index.js';
import { controlDepRecorder } from '../../../../src/trace.js';
import { conditionsOf, evidenceSurfaces, surfacesHolding } from '../helpers/evidenceSurfaces.js';

const SECRET = 'SEKRET-1138-LEAK';

class Holder {
  readonly #secret = SECRET;
  get secret(): string {
    return this.#secret;
  }
}

/** `JSON.stringify` that spells out what it prints as `{}` or drops, so a check for the secret means something. */
function spelled(value: unknown): string {
  return JSON.stringify(value, (_key, part) => {
    if (part instanceof Map) return { map: [...part] };
    if (part instanceof Set) return { set: [...part] };
    if (part instanceof RegExp) return { regexp: part.source };
    if (part instanceof Error) return { error: part.message };
    if (part instanceof String) return { boxed: String(part) };
    if (part instanceof Holder) return { holder: part.secret };
    if (part instanceof ArrayBuffer) return { bytes: new TextDecoder().decode(part) };
    if (ArrayBuffer.isView(part)) return { bytes: new TextDecoder().decode(part) };
    return part;
  });
}

const encoded = () => new TextEncoder().encode(SECRET);

/** Each keeps content a walk of own enumerable keys does not show. */
const KINDS: ReadonlyArray<readonly [string, () => unknown]> = [
  ['a Map holding a selected key', () => new Map([['ssn', SECRET]])],
  ['a Map holding only other entries', () => new Map([['plain', SECRET]])],
  ['a Map keyed by an object', () => new Map([[{ ssn: SECRET }, 1]])],
  ['a Set', () => new Set([SECRET])],
  ['a RegExp', () => new RegExp(SECRET)],
  ['an Error', () => new Error(SECRET)],
  ['a boxed string', () => new String(SECRET)],
  ['a class instance', () => new Holder()],
  ['an object that inherits its keys', () => Object.create({ ssn: SECRET })],
  ['an ArrayBuffer', () => encoded().buffer],
  ['a typed array', () => encoded()],
  ['a DataView', () => new DataView(encoded().buffer)],
];

/** A kind nothing can clone or print: a deferred recorder could not carry it whole, so it is checked live only. */
const UNCLONEABLE: ReadonlyArray<readonly [string, () => unknown]> = [
  ['a function', () => () => SECRET],
  ['a WeakMap', () => new WeakMap()],
  ['a Promise', () => Promise.resolve(SECRET)],
  ['a fake Date', () => Object.create(Date.prototype)],
  ['a Date subclass', () => new (class Later extends Date {})(0)],
];

/** Where in a filter the value can sit. */
const PLACEMENTS: ReadonlyArray<readonly [string, (value: unknown) => Record<string, unknown>]> = [
  ['bare', (value) => ({ ne: value })],
  ['in an `in` list', (value) => ({ notIn: ['x', value] })],
  ['in a plain object', (value) => ({ ne: { deep: value } })],
  ['in a list in a plain object', (value) => ({ ne: { deep: [{ deeper: value }] } })],
];

const ACTIVE: ReadonlyArray<readonly [string, RedactionPolicy]> = [
  ['a rule that names a key in it', { keys: ['ssn'] }],
  ['a rule that names nothing in it', { keys: ['nothing-here'] }],
  ['a pattern', { patterns: [/^nothing/] }],
  ['a field of an absent key', { fields: { nothing: ['x'] } }],
];

function chartOf(ops: (s: any) => Record<string, unknown>, door: 'decide' | 'select' = 'decide') {
  const rules = (s: any) => [
    { when: { plain: ops(s) }, then: 'yes' },
    { when: () => true, then: 'no' },
  ];
  const start = flowChart<any>(
    'Seed',
    (s: any) => {
      s.plain = 'clear';
      s.ssn = 'held back';
      s.list = ['a'];
      s.config = { name: 'A' };
      s.holdsMap = { inner: new Map([['ssn', SECRET]]) };
    },
    'seed',
  );
  const branches = (cursor: any) =>
    cursor.addFunctionBranch('yes', 'Yes', () => undefined).addFunctionBranch('no', 'No', () => undefined);
  if (door === 'decide') {
    return branches(start.addDeciderFunction('Route', (s: any) => decide(s, rules(s), 'no'), 'route'))
      .setDefault('no')
      .end()
      .build();
  }
  return branches(start.addSelectorFunction('Pick', (s: any) => select(s, rules(s)), 'pick'))
    .end()
    .build();
}

/** What each door a threshold reaches is handed: live, deferred, the recorder rows both ways. */
async function served(chart: any, policy: RedactionPolicy | undefined) {
  const live: any[] = [];
  const deferred: any[] = [];
  const executor = new FlowChartExecutor(chart);
  if (policy) executor.setRedactionPolicy(policy);
  executor.attachFlowRecorder(controlDepRecorder());
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
  return {
    live,
    deferred,
    recorders: executor.getSnapshot().recorders,
    redactedRecorders: executor.getSnapshot({ redact: true }).recorders,
  };
}

const firstCondition = (evidence: readonly any[]) => evidence[0].rules[0].conditions[0];

describe('a threshold that keeps content no key shows is a hole under an active rule', () => {
  it.each(KINDS.flatMap(([kind, make]) => PLACEMENTS.map(([where, place]) => [kind, where, make, place] as const)))(
    '%s, %s, on the live event, the deferred clone and the recorder rows',
    async (_kind, _where, make, place) => {
      const doors = await served(
        chartOf(() => place(make())),
        { keys: ['ssn'] },
      );
      for (const evidence of [doors.live, doors.deferred]) {
        const condition = firstCondition(evidence);
        expect(condition.threshold).toBe('[REDACTED]');
        expect(condition.thresholdRedacted).toBe(true);
      }
      expect(doors.deferred.length).toBe(1);
      expect(spelled(doors.recorders)).toContain('thresholdRedacted');
      for (const door of [doors.live, doors.deferred, doors.recorders, doors.redactedRecorders]) {
        expect(spelled(door)).not.toContain(SECRET);
      }
    },
  );

  it.each(ACTIVE.flatMap(([rule, policy]) => KINDS.map(([kind, make]) => [kind, rule, make, policy] as const)))(
    '%s under %s',
    async (_kind, _rule, make, policy) => {
      const [condition] = conditionsOf(
        await evidenceSurfaces(
          chartOf(() => ({ ne: make() })),
          policy,
        ),
      );
      expect(condition.threshold).toBe('[REDACTED]');
      expect(condition.thresholdRedacted).toBe(true);
    },
  );

  it.each(UNCLONEABLE.map(([kind, make]) => [kind, make] as const))('%s', async (_kind, make) => {
    const [condition] = conditionsOf(
      await evidenceSurfaces(
        chartOf(() => ({ ne: make() })),
        { keys: ['nothing-here'] },
      ),
    );
    expect(condition.threshold).toBe('[REDACTED]');
    expect(condition.thresholdRedacted).toBe(true);
  });

  it('under a run-time mark alone', async () => {
    const chart = flowChart<any>(
      'Seed',
      (s: any) => {
        s.plain = 'clear';
        s.$setValue('marked', 'x', true);
      },
      'seed',
    )
      .addDeciderFunction(
        'Route',
        (s: any) => decide(s, [{ when: { plain: { ne: new Map([['a', SECRET]]) } }, then: 'yes' }], 'no'),
        'route',
      )
      .addFunctionBranch('yes', 'Yes', () => undefined)
      .addFunctionBranch('no', 'No', () => undefined)
      .setDefault('no')
      .end()
      .build();
    const doors = await served(chart, undefined);
    expect(firstCondition(doors.live).thresholdRedacted).toBe(true);
    expect(spelled(doors.live)).not.toContain(SECRET);
  });

  it('select() serves the same hole', async () => {
    const doors = await served(
      chartOf(() => ({ ne: new Set([SECRET]) }), 'select'),
      { keys: ['ssn'] },
    );
    expect(firstCondition(doors.live).thresholdRedacted).toBe(true);
    expect(spelled(doors.live)).not.toContain(SECRET);
    expect(spelled(doors.recorders)).not.toContain(SECRET);
  });

  it('a state value handed over as the threshold, the Map behind a scope handle', async () => {
    const doors = await served(
      chartOf((s) => ({ ne: s.holdsMap })),
      { keys: ['nothing-here'] },
    );
    expect(firstCondition(doors.live).thresholdRedacted).toBe(true);
    expect(spelled(firstCondition(doors.live))).not.toContain(SECRET);
    expect(spelled(firstCondition(doors.deferred))).not.toContain(SECRET);
  });

  it('the rule still decides on the real value: `eq` a Map is compared, then served as a hole', async () => {
    const shared = new Map([['a', 1]]);
    const chart = flowChart<any>(
      'Seed',
      (s: any) => {
        s.plain = 'clear';
      },
      'seed',
    )
      .addDeciderFunction(
        'Route',
        (s: any) => decide(s, [{ when: { plain: { ne: shared } }, then: 'yes' }], 'no'),
        'route',
      )
      .addFunctionBranch('yes', 'Yes', () => undefined)
      .addFunctionBranch('no', 'No', () => undefined)
      .setDefault('no')
      .end()
      .build();
    const doors = await served(chart, { keys: ['nothing-here'] });
    expect(firstCondition(doors.live).result).toBe(true);
    expect(doors.live[0].chosen).toBe('yes');
    expect(shared.size).toBe(1);
  });
});

describe('a Date holds one number and its own keys, so it is served as written', () => {
  const when = new Date(0);

  it.each(PLACEMENTS.map(([where, place]) => [where, place] as const))('%s', async (_where, place) => {
    const doors = await served(
      chartOf(() => place(when)),
      { keys: ['ssn'] },
    );
    const condition = firstCondition(doors.live);
    expect(condition.threshold).toEqual(place(when)[Object.keys(place(when))[0]]);
    expect(Object.hasOwn(condition, 'thresholdRedacted')).toBe(false);
    const clone = firstCondition(doors.deferred);
    expect(Object.hasOwn(clone, 'thresholdRedacted')).toBe(false);
    expect(spelled(clone.threshold)).toContain(when.toISOString());
  });

  it('the Date itself reaches the live event, as a number does', async () => {
    const doors = await served(
      chartOf(() => ({ ne: when })),
      { keys: ['ssn'] },
    );
    expect(firstCondition(doors.live).threshold).toBe(when);
  });

  it('an invalid Date is still a Date', async () => {
    const invalid = new Date(Number.NaN);
    const doors = await served(
      chartOf(() => ({ ne: invalid })),
      { keys: ['ssn'] },
    );
    expect(firstCondition(doors.live).threshold).toBe(invalid);
  });

  it('it follows the rest of the law: its key selected, or a selected read before it', async () => {
    const onSelectedKey = await served(
      chartOf(() => ({ ne: when })),
      { keys: ['plain'] },
    );
    expect(firstCondition(onSelectedKey.live).thresholdRedacted).toBe(true);
    const afterRead = await served(
      chartOf((s) => ({ ne: s.ssn === 'never' ? 0 : when })),
      { keys: ['ssn'] },
    );
    expect(firstCondition(afterRead.live).thresholdRedacted).toBe(true);
  });

  it('a selected name on the Date itself is a hole, by the name walk', async () => {
    const stamped = Object.assign(new Date(0), { ssn: SECRET });
    const doors = await served(
      chartOf(() => ({ ne: stamped })),
      { keys: ['ssn'] },
    );
    expect(firstCondition(doors.live).thresholdRedacted).toBe(true);
    expect(spelled(firstCondition(doors.live))).not.toContain(SECRET);
  });

  it('a Map on the Date itself is a hole: its own keys are walked', async () => {
    const stamped = Object.assign(new Date(0), { note: new Map([['a', SECRET]]) });
    const doors = await served(
      chartOf(() => ({ ne: stamped })),
      { keys: ['nothing-here'] },
    );
    expect(firstCondition(doors.live).thresholdRedacted).toBe(true);
  });
});

describe('what a walk of names can answer for stays a value', () => {
  it.each<readonly [string, () => unknown]>([
    ['a string', () => 'visible'],
    ['a number', () => 1],
    ['a boolean', () => false],
    ['null', () => null],
    ['a list', () => ['a', 1, null]],
    ['a plain object', () => ({ name: 'A', deep: { list: [1] } })],
    ['a null-prototype object', () => Object.assign(Object.create(null), { name: 'A' })],
    ['a frozen object', () => Object.freeze({ name: 'A' })],
    [
      'a cycle',
      () =>
        (() => {
          const loop: Record<string, unknown> = { name: 'A' };
          loop.self = loop;
          return loop;
        })(),
    ],
  ])('%s', async (_kind, make) => {
    const value = make();
    const doors = await served(
      chartOf(() => ({ ne: value })),
      { keys: ['ssn'] },
    );
    const condition = firstCondition(doors.live);
    expect(condition.threshold).toBe(value);
    expect(Object.hasOwn(condition, 'thresholdRedacted')).toBe(false);
  });

  it('a list and an object behind a scope handle', async () => {
    for (const ops of [(s: any) => ({ notIn: s.list }), (s: any) => ({ ne: s.config })]) {
      const doors = await served(chartOf(ops), { keys: ['nothing-here'] });
      expect(Object.hasOwn(firstCondition(doors.live), 'thresholdRedacted')).toBe(false);
    }
  });
});

describe('differential: no policy and an inert rule keep the value itself', () => {
  const INERT: ReadonlyArray<readonly [string, RedactionPolicy | undefined]> = [
    ['no policy', undefined],
    ['an empty policy', {}],
    ['an emit-only policy', { emitPatterns: [/x/] }],
    ['a diagnostic selector elsewhere', { diagnostics: { keys: ['logs.absent'] } }],
  ];

  it.each(INERT.flatMap(([name, policy]) => KINDS.map(([kind, make]) => [kind, name, make, policy] as const)))(
    '%s under %s',
    async (_kind, _name, make, policy) => {
      const value = make();
      const doors = await served(
        chartOf(() => ({ ne: value })),
        policy,
      );
      const condition = firstCondition(doors.live);
      expect(condition.threshold).toBe(value);
      expect(Object.hasOwn(condition, 'thresholdRedacted')).toBe(false);
      expect(spelled(doors.live)).not.toContain('thresholdRedacted');
    },
  );

  it('a Map under no policy reaches the deferred clone with its entries, as on main', async () => {
    const doors = await served(
      chartOf(() => ({ ne: new Map([['a', 1]]) })),
      undefined,
    );
    expect(firstCondition(doors.deferred).threshold).toEqual(new Map([['a', 1]]));
  });

  it('a plain threshold under a policy that selects nothing is byte-identical to no policy', async () => {
    const ops = () => ({ ne: { name: 'A', list: [1, new Date(0)] } });
    const bare = await evidenceSurfaces(chartOf(ops), undefined);
    const held = await evidenceSurfaces(chartOf(ops), { keys: ['nothing-here'] });
    expect(JSON.stringify(held.evidence)).toBe(JSON.stringify(bare.evidence));
    expect(held.narrative).toBe(bare.narrative);
    expect(surfacesHolding(held, 'thresholdRedacted')).toEqual([]);
  });
});
