/**
 * Random `decide()` rule tables over a few flat fact names, and the two `decide()` partners the scope-free door is
 * compared with:
 *
 *   - `decideInRun`: `decide()` in a decider stage of a real run over state seeded with the facts, under a real
 *     redaction policy when one is given (`EVERY_KEY_POLICIES` select every fact name, in four ways).
 *   - `decideOverEveryKeyPort`: `decide()` over a scope port registered with `registerScopeRuntime` whose
 *     `getRedactedKeys()` holds every key and which has no `decisionEvidenceRule`, so it takes the same default path
 *     `evaluateFilter(read, () => true, filter)` takes — what mask-all is compared with.
 *
 * A rule is built from data (`RuleSpec`), so one seed gives the same table every time. A function rule's thrown text
 * holds a value it read, and a function rule may return a value instead of a boolean (a mask must hide both).
 */
import fc from 'fast-check';

import type {
  DecideRule,
  DecisionEvidence,
  DefaultBranch,
  RedactionPolicy,
  RuleEvidence,
} from '../../../../src/index.js';
import { decide, flowChart, FlowChartExecutor } from '../../../../src/index.js';
import { type ScopeRuntimeTarget, registerScopeRuntime } from '../../../../src/lib/scope/runtime.js';
import type { ReadEvent, ScopeRecorder } from '../../../../src/lib/scope/types.js';

export const FACT_NAMES = ['a', 'b', 'c', 'd'] as const;
export type Facts = Record<string, unknown>;

/** Real policies that each select every fact name: by name, by pattern, by declared fields, and a mix. */
export const EVERY_KEY_POLICIES: ReadonlyArray<RedactionPolicy> = [
  { keys: [...FACT_NAMES] },
  { patterns: [/^[a-d]$/] },
  { fields: Object.fromEntries(FACT_NAMES.map((name) => [name, ['inner']])) },
  { keys: ['a', 'b'], patterns: [/^[cd]$/] },
];

/** Every branch a generated rule or default can name: a decider stage needs one for each. */
export const BRANCHES = ['x', 'y', 'z', 'p', 'q'] as const;

const primitive = fc.oneof(
  fc.integer({ min: -3, max: 3 }),
  fc.constantFrom('m', 'n', 'o'),
  fc.boolean(),
  fc.constant(null),
);

/** Facts: some names hold a value, the rest are missing. */
export const factsArb: fc.Arbitrary<Facts> = fc.record(
  Object.fromEntries(FACT_NAMES.map((name) => [name, primitive])) as Record<string, fc.Arbitrary<unknown>>,
  { requiredKeys: [] },
);

/** One operator and its threshold, every operator `evaluateFilter` knows, plus a typo and an oversized list. */
const opArb: fc.Arbitrary<[string, unknown]> = fc.oneof(
  { weight: 4, arbitrary: fc.tuple(fc.constantFrom('eq', 'ne'), primitive) },
  {
    weight: 4,
    arbitrary: fc.tuple(
      fc.constantFrom('gt', 'gte', 'lt', 'lte'),
      fc.oneof(fc.integer({ min: -3, max: 3 }), fc.constantFrom('m', 'n')),
    ),
  },
  { weight: 3, arbitrary: fc.tuple(fc.constantFrom('in', 'notIn'), fc.array(primitive, { maxLength: 3 })) },
  { weight: 1, arbitrary: fc.constant<[string, unknown]>(['gle', 1]) },
  // Past MAX_IN_ARRAY_SIZE: the filter throws, and the row records the error and no conditions.
  { weight: 1, arbitrary: fc.constant<[string, unknown]>(['in', Array.from({ length: 1001 }, (_, i) => i)]) },
);

export type RuleSpec =
  | {
      readonly kind: 'filter';
      readonly when: Record<string, Record<string, unknown>>;
      readonly then: string;
      readonly label?: string;
    }
  | {
      readonly kind: 'function';
      readonly reads: readonly string[];
      readonly want: unknown;
      readonly throws: boolean;
      /** What the rule hands back: a boolean, the first value it read, or `first || second === want`. */
      readonly returns: 'boolean' | 'value' | 'or';
      readonly then: string;
      readonly label?: string;
    };

const thenArb = fc.constantFrom(...BRANCHES);
const labelArb = fc.option(fc.constantFrom('first reason', 'second reason'), { nil: undefined });
const nameArb = fc.constantFrom(...FACT_NAMES);

const filterSpec: fc.Arbitrary<RuleSpec> = fc.record({
  kind: fc.constant('filter' as const),
  when: fc.dictionary(nameArb, fc.array(opArb, { minLength: 1, maxLength: 2 }).map(Object.fromEntries), {
    minKeys: 1,
    maxKeys: 2,
  }),
  then: thenArb,
  label: labelArb,
});

const functionSpec: fc.Arbitrary<RuleSpec> = fc.record({
  kind: fc.constant('function' as const),
  reads: fc.array(nameArb, { minLength: 1, maxLength: 3 }),
  want: primitive,
  throws: fc.boolean(),
  returns: fc.constantFrom('boolean' as const, 'value' as const, 'or' as const),
  then: thenArb,
  label: labelArb,
});

export const specsArb: fc.Arbitrary<RuleSpec[]> = fc.array(fc.oneof(filterSpec, functionSpec), { maxLength: 4 });

export const defaultArb: fc.Arbitrary<DefaultBranch> = fc.oneof(
  fc.constantFrom('p', 'q'),
  fc.record({ branch: fc.constantFrom('p', 'q'), label: fc.constantFrom('no rule fired', 'fallback') }),
  fc.record({ branch: fc.constantFrom('p', 'q') }),
);

/** The rule a spec describes. A throwing function rule names the first value it read in its error. */
export function ruleOf(spec: RuleSpec): DecideRule<Facts> {
  const label = spec.label === undefined ? {} : { label: spec.label };
  if (spec.kind === 'filter') return { when: spec.when, then: spec.then, ...label };
  return {
    when: (facts: Facts) => {
      const seen = spec.reads.map((name) => facts[name]);
      if (spec.throws) throw new Error(`rule saw ${String(seen[0])}`);
      // A rule typed over `any` facts can return a value: `(f) => f.token`, `(f) => f.override || f.score > 5`.
      if (spec.returns === 'value') return seen[0] as boolean;
      if (spec.returns === 'or') return (seen[0] || seen[1] === spec.want) as boolean;
      return seen.some((value) => value === spec.want);
    },
    then: spec.then,
    ...label,
  };
}

export const rulesOf = (specs: readonly RuleSpec[]): DecideRule<Facts>[] => specs.map(ruleOf);

/** `decide()` in a decider stage of a real run, over state seeded with `facts`, under `policy` when one is given. */
export async function decideInRun(
  rules: DecideRule<Facts>[],
  facts: Facts,
  defaultBranch: DefaultBranch,
  policy?: RedactionPolicy,
): Promise<{ branch: string; evidence: DecisionEvidence }> {
  let evidence: DecisionEvidence | undefined;
  let branch: string | undefined;
  let cursor = flowChart<Facts>(
    'Seed',
    (scope: Facts) => {
      for (const [name, value] of Object.entries(facts)) scope[name] = value;
    },
    'seed',
  ).addDeciderFunction(
    'Decide',
    (scope: Facts) => {
      const result = decide(scope as never, rules as never, defaultBranch);
      branch = result.branch;
      return result;
    },
    'decide',
  );
  for (const id of BRANCHES) cursor = cursor.addFunctionBranch(id, id, () => undefined);
  const executor = new FlowChartExecutor(cursor.end().build());
  if (policy) executor.setRedactionPolicy(policy);
  executor.attachFlowRecorder({ id: 'evidence', onDecision: (event) => (evidence = event.evidence) });
  await executor.run();
  if (branch === undefined || evidence === undefined) throw new Error('decideInRun: the decider stage did not run');
  return { branch, evidence };
}

/** A set that holds every key. */
class EveryKey extends Set<string> {
  override has(_key: string): boolean {
    return true;
  }
}

/**
 * `decide()` over a registered scope port whose redacted keys are every key. Its scope fires each read to the
 * recorders `decide()` attaches, as a facade does, marked redacted; the port has no `decisionEvidenceRule`.
 */
export function decideOverEveryKeyPort(
  rules: DecideRule<Facts>[],
  facts: Facts,
  defaultBranch: DefaultBranch,
): { branch: string; evidence: DecisionEvidence } {
  const recorders = new Map<string, ScopeRecorder>();
  const everyKey = new EveryKey();
  const read = (key: string): unknown => (Object.hasOwn(facts, key) ? facts[key] : undefined);
  const target: ScopeRuntimeTarget = {
    attachScopeRecorder: (recorder) => {
      recorders.set(recorder.id, recorder);
    },
    detachScopeRecorder: (id) => {
      recorders.delete(id);
    },
    getValue: (key) => (key === undefined ? undefined : read(key)),
    getRedactedKeys: () => everyKey,
  };
  const scope = new Proxy(
    {},
    {
      get(_target, key) {
        if (typeof key !== 'string') return undefined;
        const value = read(key);
        for (const recorder of recorders.values()) {
          recorder.onRead?.({ key, value, redacted: everyKey.has(key) } as unknown as ReadEvent);
        }
        return value;
      },
    },
  );
  const { branch, evidence } = decide(
    registerScopeRuntime(scope, { target, handlesAssignments: false }) as Facts,
    rules,
    defaultBranch,
  );
  return { branch, evidence };
}

/** `evidence` with every rule's `matchError` replaced by `word`: the one field mask-all serves differently. */
export function withMatchErrors(evidence: DecisionEvidence, word: string): DecisionEvidence {
  const rules = evidence.rules.map(
    (row): RuleEvidence => (row.matchError === undefined ? row : { ...row, matchError: word }),
  );
  return { ...evidence, rules };
}
