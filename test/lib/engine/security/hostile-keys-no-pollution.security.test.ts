/**
 * Security — hostile KEYS in data never reach a prototype, through any door CodeQL
 * named (alerts js/prototype-polluting-assignment and js/prototype-pollution-utility
 * on `memory/pathOps.ts` and `memory/TransactionBuffer.ts`).
 *
 * Every write site those alerts flag sits behind the one segment refusal,
 * `pathOps · isDeniedSegment` (`__proto__`, `constructor`, `prototype`), or behind
 * `pathOps · ownChild` (that refusal plus an own-property check); the unit tests pin
 * each primitive (test/lib/memory/security/copy-on-write.security.test.ts). This
 * test drives the FLOWS the alerts traced, end to end: a stage writing a parsed
 * record whole, merging it, and using its keys as state keys; a subflow seeded
 * from it (`SubflowInputMapper · seedSubflowGlobalStore`, the `initialValues`
 * flow) and merging it back (`applyOutputMapping`, the `mappedOutput` flow) —
 * under both commit encodings, then every fold of the log and the redacted
 * mirror.
 */
import { describe, expect, it } from 'vitest';

import { flowChart, FlowChartExecutor } from '../../../../src/index.js';
import { stateAt } from '../../../../src/trace.js';

/** A record as `JSON.parse` makes it from untrusted text: the three hostile names are OWN keys. */
const hostile = (): Record<string, unknown> =>
  JSON.parse(
    '{"__proto__":{"polluted":"proto"},"constructor":{"prototype":{"polluted":"ctor"}},' +
      '"prototype":{"polluted":"prototype"},"ok":true}',
  );

const clean = () => {
  for (const probe of [{}, [], Object.create(null) as object, () => undefined]) {
    expect((probe as Record<string, unknown>).polluted).toBeUndefined();
  }
  expect((Object.prototype as Record<string, unknown>).polluted).toBeUndefined();
  expect((Array.prototype as unknown as Record<string, unknown>).polluted).toBeUndefined();
  expect((Function.prototype as unknown as Record<string, unknown>).polluted).toBeUndefined();
};

interface Inner {
  seeded?: Record<string, unknown>;
  made?: Record<string, unknown>;
}

function chart() {
  const inner = flowChart<Inner>(
    'Inside',
    (scope) => {
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
      outputMapper: (out: Inner) => ({ back: out.made, made: out.made, ...hostile() }), // the `mappedOutput` flow
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

describe('hostile keys in data reach no prototype', () => {
  it.each(['full', 'delta'] as const)(
    'stage writes, a subflow seed and its merge-back, every fold and the mirror (%s)',
    async (commitValues) => {
      const executor = new FlowChartExecutor(chart(), { commitValues });
      executor.setRedactionPolicy({ keys: ['unrelatedSecret'] });
      await executor.run();
      clean();

      const snapshot = executor.getSnapshot();
      const state = snapshot.sharedState as Record<string, any>;
      expect(state.after).toBe(true); // the benign sibling of every hostile key landed
      expect(state.whole.ok).toBe(true);
      expect(Object.getPrototypeOf(state)).toBe(Object.prototype);
      expect(Object.getPrototypeOf(state.whole)).toBe(Object.prototype);

      for (let idx = 0; idx < snapshot.commitLog.length; idx++) stateAt(snapshot, idx);
      executor.getSnapshot({ redact: true });
      clean();
    },
  );
});
