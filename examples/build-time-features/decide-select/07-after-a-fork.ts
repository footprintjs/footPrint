/**
 * decide() after a fork — reading what the children wrote
 *
 * A fork's children write under `runs/<child id>/`, by design: that is what
 * keeps two siblings from overwriting each other's keys. So after the fork,
 * the value one child wrote is at the PATH `runs.look-tag.tagExists`, not at
 * the top-level name `tagExists`.
 *
 * A filter rule's key is a top-level state NAME. A path is not followed. So
 *
 *     { when: { 'runs.look-tag.tagExists': { eq: true } }, then: 'released' }
 *
 * reads a key the state does not hold: the rule can never match and the
 * decision falls to the default. In dev mode (`enableDevMode()`) the library
 * now says so, once per key per run. This file shows that, then the two ways
 * that work:
 *
 *   1. a small stage after the fork LIFTS the value to a top-level name, and
 *      `decide()` reads it by name. The evidence keeps one row per condition.
 *   2. a FUNCTION rule reads the path with `$read`. It matches, and its
 *      evidence names what it read (the key `runs`, whose path it walked),
 *      but it records no operator or threshold.
 *
 * Run: npx tsx examples/build-time-features/decide-select/07-after-a-fork.ts
 */

import { decide, disableDevMode, enableDevMode, flowChart, FlowChartExecutor } from 'footprintjs';
import type { DecideRule, DecisionEvidence, FlowRecorder, TypedScope } from 'footprintjs';

/**
 * An UNTYPED state, as a tool built from data or a first draft has: any key is allowed. On a typed state
 * (`flowChart<MyState>`) TypeScript refuses a rule key that is not a field of it, which catches this
 * mistake at compile time; the warning is for the charts that do not have that net.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type State = Record<string, any>;
type Scope = TypedScope<State>;
type Rules = DecideRule<Scope>[];

/** The way a developer wishes it worked: the path as a rule key. */
const byPath: Rules = [
  { when: { 'runs.look-tag.tagExists': { eq: true } }, then: 'released', label: 'The tag exists' },
];

/** Way 1: the rule reads a top-level name; the chart lifts the value there first. */
const byLiftedName: Rules = [{ when: { tagFound: { eq: true } }, then: 'released', label: 'The tag exists' }];

/** Way 2: a function rule reads the path itself. */
const byFunction: Rules = [
  {
    when: (s) => s.$read('runs.look-tag.tagExists') === true,
    then: 'released',
    label: 'The tag exists',
  },
];

function buildChart(rules: Rules, lift: boolean) {
  const afterFork = flowChart<State>(
    'Request',
    (s) => {
      s.version = '1.0.0';
    },
    'request',
  ).addListOfFunction([
    // These write `tagExists` and `npmHasVersion`; the engine files them under runs/<id>/.
    {
      id: 'look-tag',
      name: 'Look for the tag',
      fn: (s) => {
        (s as unknown as { tagExists: boolean }).tagExists = true;
      },
    },
    {
      id: 'look-npm',
      name: 'Ask npm',
      fn: (s) => {
        (s as unknown as { npmHasVersion: boolean }).npmHasVersion = false;
      },
    },
  ]);

  // The lifting stage: a few lines, and the decision below reads by name.
  const beforeDecision = lift
    ? afterFork.addFunction(
        'Lift what the children found',
        (s) => {
          s.tagFound = s.$read('runs.look-tag.tagExists') === true;
        },
        'lift',
      )
    : afterFork;

  return beforeDecision
    .addDeciderFunction('Decide', (s) => decide(s, rules, { branch: 'held', label: 'No rule fired' }), 'decide')
    .addFunctionBranch('released', 'Released', (s) => {
      s.outcome = 'released';
    })
    .addFunctionBranch('held', 'Held', (s) => {
      s.outcome = 'held';
    })
    .setDefault('held')
    .end()
    .build();
}

interface Outcome {
  outcome: string;
  evidence: DecisionEvidence | undefined;
  warnings: string[];
}

/** Runs one chart in dev mode, catching the library's console warnings so the example can print them. */
async function run(rules: Rules, lift: boolean): Promise<Outcome> {
  let evidence: DecisionEvidence | undefined;
  const probe: FlowRecorder = {
    id: 'evidence-probe',
    onDecision(event) {
      evidence = event.evidence;
    },
  };
  const warnings: string[] = [];
  const realWarn = console.warn;
  console.warn = (text: unknown) => void warnings.push(String(text));
  enableDevMode();
  try {
    const executor = new FlowChartExecutor(buildChart(rules, lift));
    executor.attachFlowRecorder(probe);
    await executor.run();
    return { outcome: String(executor.getSnapshot().sharedState.outcome), evidence, warnings };
  } finally {
    disableDevMode();
    console.warn = realWarn;
  }
}

function describeRows(evidence: DecisionEvidence | undefined): string {
  const rule = evidence?.rules[0];
  if (rule?.type === 'filter') {
    return `filter rule, conditions: ${rule.conditions.map((c) => `${c.key} ${c.op} ${JSON.stringify(c.threshold)} -> ${c.result}`).join('; ')}`;
  }
  if (rule?.type === 'function') {
    return `function rule, read: ${rule.inputs.map((i) => i.key).join(', ')} (no operator, no threshold)`;
  }
  return 'no rule';
}

let failed = false;

function regression(message: string): void {
  console.error(`REGRESSION: ${message}`);
  failed = true;
}

(async () => {
  console.log('1. The path as a rule key (the mistake):');
  const mistake = await run(byPath, false);
  console.log(`   outcome: ${mistake.outcome}   (the default; the rule never had a chance)`);
  console.log(`   ${describeRows(mistake.evidence)}`);
  console.log(`   dev-mode warning: ${mistake.warnings[0] ?? '(none)'}`);
  if (mistake.outcome !== 'held') regression('a rule keyed by a path matched; paths are not followed.');
  if (mistake.warnings.length !== 1 || !mistake.warnings[0]?.includes('"runs.look-tag.tagExists"')) {
    regression(`expected one dev-mode warning naming the path key, got ${JSON.stringify(mistake.warnings)}.`);
  }

  console.log('\n2. A stage after the fork lifts the value; the rule reads it by name:');
  const lifted = await run(byLiftedName, true);
  console.log(`   outcome: ${lifted.outcome}`);
  console.log(`   ${describeRows(lifted.evidence)}`);
  if (lifted.outcome !== 'released' || lifted.warnings.length !== 0) regression('the lifted name did not decide, or warned.');
  if (lifted.evidence?.rules[0]?.type !== 'filter') regression('the lifted rule lost its per-condition evidence.');

  console.log('\n3. A function rule reads the path:');
  const byFn = await run(byFunction, false);
  console.log(`   outcome: ${byFn.outcome}`);
  console.log(`   ${describeRows(byFn.evidence)}`);
  if (byFn.outcome !== 'released' || byFn.warnings.length !== 0) regression('the function rule did not decide, or warned.');
  if (byFn.evidence?.rules[0]?.type !== 'function') regression('expected function-rule evidence.');
  if (failed) process.exit(1);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});

/* Output:

1. The path as a rule key (the mistake):
   outcome: held   (the default; the rule never had a chance)
   filter rule, conditions: runs.look-tag.tagExists eq true -> false
   dev-mode warning: [footprint] decide()/select() filter: the key "runs.look-tag.tagExists" (rule 0, 'The tag exists') looks like a path, but rule keys are top-level state names and a path is not followed, and the state holds no key of that name, so this condition can never match. Lift the value to a top-level key in a stage before the decision (a small stage after the fork: scope.name = ...), or use a function rule that reads the path (when: (s) => s.$read('runs.look-tag.tagExists') === true).

2. A stage after the fork lifts the value; the rule reads it by name:
   outcome: released
   filter rule, conditions: tagFound eq true -> true

3. A function rule reads the path:
   outcome: released
   function rule, read: runs (no operator, no threshold)
*/
