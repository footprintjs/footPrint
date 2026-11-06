/**
 * Redaction — Decision Evidence
 *
 * A filter rule records the threshold it compared against, and a threshold is whatever the stage's code passed. A
 * policy covers it: a selected threshold becomes a named hole, on every surface, and the rule still decides on the real
 * value. A threshold nothing selects stays visible, because that is what explains the decision.
 *
 * The order of the conditions matters. `amount` is tested BEFORE the selected `ssn`, so its threshold stays. Once a
 * stage has read a selected value, the later thresholds in it are hidden: the library cannot tell what they were made
 * from.
 *
 * Pipeline: Intake → Route(decide) → [known: Known] / [other: Other]
 *
 * Run: npx tsx examples/runtime-features/redaction/05-decision-evidence.ts
 */

import { decide, flowChart, FlowChartExecutor } from 'footprintjs';

interface State {
  amount: number;
  ssn: string;
}

const SECRET = '999-88-7777';

const chart = flowChart<State>(
  'Intake',
  (scope) => {
    scope.amount = 1200;
    scope.ssn = SECRET;
  },
  'intake',
)
  .addDeciderFunction(
    'Route',
    (scope) =>
      decide(
        scope,
        [
          {
            when: { amount: { gt: 500 }, ssn: { eq: SECRET } },
            then: 'known',
            label: 'Known applicant, large amount',
          },
        ],
        'other',
      ),
    'route',
  )
  .addFunctionBranch('known', 'Known', () => undefined)
  .addFunctionBranch('other', 'Other', () => undefined)
  .setDefault('other')
  .end()
  .build();

function check(condition: boolean, message: string): void {
  if (!condition) throw new Error(`example invariant failed: ${message}`);
}

async function main(): Promise<void> {
  const executor = new FlowChartExecutor(chart);
  executor.setRedactionPolicy({ keys: ['ssn'] });
  executor.enableNarrative();

  interface Condition {
    key: string;
    threshold: unknown;
    thresholdRedacted?: true;
    result: boolean;
  }
  const conditions: Condition[] = [];
  let chosen: string | undefined;
  executor.attachFlowRecorder({
    id: 'evidence',
    onDecision: (event) => {
      chosen = event.evidence?.chosen;
      for (const rule of event.evidence?.rules ?? []) {
        if (rule.type === 'filter') conditions.push(...rule.conditions);
      }
    },
  });
  await executor.run();

  for (const c of conditions) {
    console.log(`${c.key}: threshold ${String(c.threshold)}, thresholdRedacted ${c.thresholdRedacted === true}`);
  }
  const narrative = executor.getNarrativeEntries().map((entry) => entry.text);
  console.log(narrative.find((line) => line.startsWith('[Condition]')));

  const [amount, ssn] = conditions;
  check(chosen === 'known', 'the rule decides on the real value');
  check(amount.threshold === 500 && amount.thresholdRedacted === undefined, 'a clear threshold stays a value');
  check(ssn.threshold === '[REDACTED]' && ssn.thresholdRedacted === true, 'a selected threshold is a named hole');
  check(ssn.result === true, 'the result is kept');
  const surfaces = JSON.stringify({ conditions, narrative, recorders: executor.getSnapshot({ redact: true }).recorders });
  check(!surfaces.includes(SECRET), 'the secret is on no surface');

  console.log('✓ the secret is on no surface; the clear threshold still explains the decision');
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
