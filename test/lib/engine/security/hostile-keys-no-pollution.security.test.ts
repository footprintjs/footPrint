/**
 * Security — hostile KEYS in data reach no prototype and fail no run.
 *
 * CodeQL flagged eight writes in `memory/pathOps.ts` and
 * `memory/TransactionBuffer.ts` (js/prototype-polluting-assignment,
 * js/prototype-pollution-utility). Each sits behind the path-segment denylist
 * on the same segment — the `DENIED` set, `pathOps · isDeniedSegment` its
 * predicate: `__proto__`, `constructor`, `prototype` — or is reached only
 * through `pathOps · ownChild` (that denylist plus an own-property check).
 *
 *   1. primitives — each refusal, including a path that ENDS at a denied name
 *      (the older pins in test/lib/memory/security/copy-on-write.security.test.ts
 *      all end in `polluted`, so they never reach a last-segment refusal);
 *   2. end to end — the flows the alerts traced: a stage writing a JSON-parsed
 *      record whole, merging it and using its keys as state keys; a subflow
 *      seeded from it (`SubflowInputMapper · seedSubflowGlobalStore`, the
 *      `initialValues` flow) and merging it back (`applyOutputMapping`, the
 *      `mappedOutput` flow) — under both commit encodings, with a `keys` and
 *      with a `fields` policy. Every object reachable from live state, from
 *      every fold of the log and from the redacted mirror keeps a standard
 *      prototype; a hostile name stays as data inside a value written whole
 *      or merged, and is dropped where it would be a path segment;
 *   3. a `fields` policy reads only its OWN keys
 *      (`memory/redaction.ts · declaredFields`): a state key, an input key or
 *      a record key named like an `Object.prototype` member used to fail the
 *      run with a TypeError ("fields is not iterable").
 */
import { stateAt } from 'foottrace';
import { afterEach, describe, expect, it } from 'vitest';

import { flowChart, FlowChartExecutor } from '../../../../src/index.js';
import type { RedactionPolicy } from '../../../../src/lib/memory/redaction.js';
import { RedactionRule } from '../../../../src/lib/memory/redaction.js';

const DENIED_NAMES = ['__proto__', 'constructor', 'prototype'] as const;

/** A record as `JSON.parse` makes it from untrusted text: the three denied names are OWN keys. */
const hostile = (): Record<string, unknown> =>
  JSON.parse(
    '{"__proto__":{"polluted":"proto"},"constructor":{"prototype":{"polluted":"ctor"}},' +
      '"prototype":{"polluted":"prototype"},"ok":true}',
  );

const SHARED_PROTOTYPES: object[] = [Object.prototype, Array.prototype, Function.prototype];

/** A failure in one case must not leave the next one (or the next file) polluted. */
afterEach(() => {
  for (const proto of SHARED_PROTOTYPES) delete (proto as Record<string, unknown>).polluted;
});

const clean = () => {
  for (const probe of [{}, [], Object.create(null) as object, () => undefined]) {
    expect((probe as Record<string, unknown>).polluted).toBeUndefined();
  }
  for (const proto of SHARED_PROTOTYPES) expect((proto as Record<string, unknown>).polluted).toBeUndefined();
};

/** Every object reachable from `root` by own enumerable keys has a standard prototype. */
function expectStandardPrototypes(root: unknown, where: string): void {
  const seen = new Set<object>();
  const stack: Array<[unknown, string]> = [[root, where]];
  for (let next = stack.pop(); next !== undefined; next = stack.pop()) {
    const [value, path] = next;
    if (value === null || typeof value !== 'object' || seen.has(value)) continue;
    seen.add(value);
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== Array.prototype && proto !== null) {
      throw new Error(`${path} has a non-standard prototype`);
    }
    for (const key of Object.keys(value)) stack.push([(value as Record<string, unknown>)[key], `${path}.${key}`]);
  }
}

/** The denied names `value` holds as own keys, in order. */
const deniedOwnKeys = (value: unknown): string[] =>
  DENIED_NAMES.filter((name) => Object.prototype.hasOwnProperty.call(value, name));

// ── 1. primitives ─────────────────────────────────────────────────────────────

interface Inner {
  seeded?: Record<string, unknown>;
  made?: Record<string, unknown>;
  seenSeed?: string[];
}

function chart() {
  const inner = flowChart<Inner>(
    'Inside',
    (scope) => {
      scope.seenSeed = Object.keys((scope.$getValue('seeded') as object | undefined) ?? {});
      scope.made = hostile();
    },
    'inside',
  ).build();

  return flowChart<any>(
    'Write',
    (scope) => {
      scope.whole = hostile(); // a record written whole (set)
      scope.$update('merged', hostile()); // a record merged (merge verb)
      scope.$update('merged', { cfg: hostile() });
      for (const [key, value] of Object.entries(hostile())) scope.$setValue(key, value); // its keys as state keys
      scope.nested = { cfg: hostile() };
    },
    'write',
  )
    .addSubFlowChartNext('sf', inner, 'Sub', {
      inputMapper: () => ({ seeded: hostile(), ...hostile() }), // the `initialValues` flow
      outputMapper: (out: Inner) => ({ back: out.made, seenSeed: out.seenSeed, ...hostile() }), // the `mappedOutput` flow
    })
    .addFunction(
      'Read',
      (scope) => {
        scope.after = scope.whole?.ok === true && scope.back?.ok === true;
      },
      'read',
    )
    .build();
}

const POLICIES: Array<[string, RedactionPolicy]> = [
  ['keys', { keys: ['unrelatedSecret'] }],
  ['fields', { fields: { profile: ['ssn'] } }],
];

describe('2 — end to end: hostile keys in data reach no prototype', () => {
  for (const commitValues of ['full', 'delta'] as const) {
    it.each(POLICIES)(
      `stage writes, a subflow seed and its merge-back, every fold and the mirror (${commitValues}, a %s policy)`,
      async (_name, policy) => {
        const executor = new FlowChartExecutor(chart(), { commitValues });
        executor.setRedactionPolicy(policy);
        await executor.run();
        clean();

        const snapshot = executor.getSnapshot();
        const state = snapshot.sharedState as Record<string, any>;
        expect(state.after).toBe(true); // the benign sibling of every hostile key landed

        // Inside a value written whole or merged, a hostile name stays as data.
        for (const kept of [state.whole, state.merged, state.merged.cfg, state.nested.cfg]) {
          expect(deniedOwnKeys(kept)).toEqual([...DENIED_NAMES]);
        }
        // Where it would be a path segment, it is dropped: a state key, a key of the subflow
        // seed and of the merge-back (each written as its own path).
        expect(deniedOwnKeys(state)).toEqual([]);
        expect(state.seenSeed).toEqual(['ok']);
        expect(Object.keys(state.back)).toEqual(['ok']);

        expectStandardPrototypes(state, 'live');
        for (let idx = 0; idx < snapshot.commitLog.length; idx++) {
          expectStandardPrototypes(stateAt(snapshot, idx).state, `stateAt(${idx})`);
        }
        expectStandardPrototypes(executor.getSnapshot({ redact: true }).sharedState, 'mirror');
        clean();
      },
    );
  }
});

// ── 3. a `fields` policy reads only its own keys ──────────────────────────────

/** Every name `Object.prototype` answers for — a plain-object lookup by one of them hits the chain. */
const INHERITED = Object.getOwnPropertyNames(Object.prototype);

describe('3 — a `fields` policy reads only its own keys', () => {
  const rule = () => new RedactionRule({ fields: { profile: ['ssn'] } });

  it.each(INHERITED)('a key named %s is clear, at the top and below', (name) => {
    expect(rule().verdict([name])).toEqual({ kind: 'clear' });
    expect(rule().verdict([name, 'x'])).toEqual({ kind: 'clear' });
    expect(rule().verdictAt([], name)).toEqual({ kind: 'clear' });
  });

  it.each(INHERITED)('a record holding %s at every depth is served with only its declared field masked', (name) => {
    const record = JSON.parse(`{"${name}":1,"a":{"${name}":{"${name}":2}},"profile":{"ssn":"123","${name}":3}}`);
    const served = rule().retainBoundary(record) as Record<string, any>;
    expect(served.profile.ssn).toBe('[REDACTED]');
    expect(Object.getOwnPropertyDescriptor(served.profile, name)?.value).toBe(3);
    expect(served.a).toEqual(record.a);
  });

  it('a policy that DECLARES such a name as its own key still scrubs under it', () => {
    const declared = new RedactionRule({ fields: { toString: ['secret'] } });
    const served = declared.retainBoundary({ toString: { secret: 's', ok: 1 } }) as Record<string, any>;
    expect(Object.getOwnPropertyDescriptor(served, 'toString')?.value).toEqual({ secret: '[REDACTED]', ok: 1 });
  });

  it('the report keeps a name a mapper wrote as an own key, whatever it is called', () => {
    const report = rule();
    report.inheritFields('toString', ['ssn']);
    report.inheritFields('__proto__', ['ssn']);
    const { fieldRedactions } = report.report();
    expect(Object.getPrototypeOf(fieldRedactions)).toBe(Object.prototype);
    expect(Object.keys(fieldRedactions)).toEqual(['profile', 'toString', '__proto__']);
    expect(Object.getOwnPropertyDescriptor(fieldRedactions, 'toString')?.value).toEqual(['ssn']);
    expect(Object.getOwnPropertyDescriptor(fieldRedactions, '__proto__')?.value).toEqual(['ssn']);
  });

  it('a run under a `fields` policy completes on input, state keys and records holding such names', async () => {
    const names = INHERITED.filter((name) => !(DENIED_NAMES as readonly string[]).includes(name));
    const input = JSON.parse('{"user":{"constructor":1,"toString":2,"hasOwnProperty":3},"profile":{"ssn":"123"}}');
    const run = flowChart<any>(
      'Write',
      (scope) => {
        for (const name of names) scope.$setValue(name, 1);
        scope.payload = JSON.parse('{"constructor":{"x":1},"hasOwnProperty":1,"valueOf":{"toString":2}}');
      },
      'write',
    ).build();
    const executor = new FlowChartExecutor(run);
    executor.setRedactionPolicy({ fields: { profile: ['ssn'] } });
    await executor.run({ input });
    const state = executor.getSnapshot().sharedState as Record<string, unknown>;
    for (const name of names) expect(Object.getOwnPropertyDescriptor(state, name)?.value).toBe(1);
    clean();
  });
});
