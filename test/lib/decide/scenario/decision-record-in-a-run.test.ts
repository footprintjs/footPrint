/**
 * A strategy chosen inside a stage from computed facts, recorded where it takes effect — SCENARIO.
 *
 * A stage builds flat facts, evaluates a table with `decideFromFacts`, and writes `decisionRecord(evidence)` to state;
 * a configured bare string is written as `fixedRecord(…, 'app')` instead. The record lands in the commit log as names
 * only, survives the clone every committed value goes through, and the value that decided it is nowhere in the run's
 * record.
 *
 * Test type: Scenario.
 */
import { describe, expect, it } from 'vitest';

import type { DecideRule, DecisionRecord } from '../../../../src/index.js';
import { decideFromFacts, decisionRecord, fixedRecord, flowChart, FlowChartExecutor } from '../../../../src/index.js';

const SECRET_WEIGHT = 987_654;

interface State {
  order: { weightKg: number; express: boolean; carrier?: string };
  delivery?: DecisionRecord;
}

const TABLE: DecideRule<Record<string, unknown>>[] = [
  { when: { express: { eq: true } }, then: 'courier', label: 'Express delivery was asked for' },
  { when: { heavy: { eq: true } }, then: 'freight', label: 'Too heavy for a parcel' },
];

function chart(order: State['order']) {
  return flowChart<State>(
    'Take order',
    (scope) => {
      scope.order = order;
    },
    'take-order',
  )
    .addFunction(
      'Pick delivery',
      (scope) => {
        const { carrier, express, weightKg } = scope.order;
        if (carrier !== undefined) {
          scope.delivery = fixedRecord(carrier, undefined, 'app');
          return;
        }
        // The table reads flat facts the stage computes, never the order itself.
        const facts = { express, heavy: weightKg > 30, weightKg };
        scope.delivery = decisionRecord(
          decideFromFacts(TABLE, facts, { branch: 'post', label: 'No rule fired' }).evidence,
        );
      },
      'pick-delivery',
    )
    .build();
}

async function run(order: State['order']) {
  const executor = new FlowChartExecutor(chart(order));
  await executor.run();
  const snapshot = executor.getSnapshot();
  return { delivery: snapshot.sharedState.delivery as DecisionRecord, log: JSON.stringify(snapshot.commitLog) };
}

describe('a decision record written where the decision takes effect', () => {
  it('a rule chose: the record names the rule, its reason and the fact it read, and lands in the commit log', async () => {
    const { delivery, log } = await run({ weightKg: SECRET_WEIGHT, express: false });
    expect(delivery).toEqual({
      strategy: 'freight',
      by: 'rule',
      rule: 1,
      label: 'Too heavy for a parcel',
      reads: ['heavy'],
    });
    expect(log).toContain('Too heavy for a parcel');
  });

  it('no rule chose: the default and every name the table read', async () => {
    const { delivery } = await run({ weightKg: 2, express: false });
    expect(delivery).toEqual({ strategy: 'post', by: 'default', label: 'No rule fired', reads: ['express', 'heavy'] });
  });

  it('a configured carrier: fixed, vouched for by the app, no reads', async () => {
    const { delivery } = await run({ weightKg: SECRET_WEIGHT, express: true, carrier: 'courier' });
    expect(delivery).toEqual({ strategy: 'courier', by: 'fixed', reads: [], voucher: 'app' });
  });

  it('the record is names only: the value that decided it is not in it', async () => {
    const { delivery, log } = await run({ weightKg: SECRET_WEIGHT, express: false });
    expect(JSON.stringify(delivery)).not.toContain(String(SECRET_WEIGHT));
    // The weight is in the log once: the order the first stage wrote. A second copy would be the record's.
    expect(log.split(String(SECRET_WEIGHT)).length - 1).toBe(1);
    expect(structuredClone(delivery)).toEqual(delivery);
  });
});
