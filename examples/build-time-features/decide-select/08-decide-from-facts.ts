/**
 * decideFromFacts() — decide()'s rule table, without a stage
 *
 * Some choices are made where there is no flowchart stage to hand a scope to:
 * an adapter picks a strategy, a configuration names one. They still deserve
 * decide()'s law (first match wins, the label IS the reason) and its evidence.
 *
 * `decideFromFacts(rules, facts, default)` evaluates the same rules over a plain
 * record of FLAT named facts and returns the same `DecisionEvidence` shape.
 * There is no run, so there is no redaction rule: the evidence always keeps
 * names and operators only, never a value. (Inside a stage, `decide()` records
 * the run's own evidence.)
 *
 * `decisionRecord(evidence)` projects that evidence to one small record,
 * `{ strategy, by, rule?, label?, reads }`, and `fixedRecord(strategy, label?,
 * voucher?)` records a choice no table made — a bare string in a config.
 *
 * Run: npx tsx examples/build-time-features/decide-select/08-decide-from-facts.ts
 */

import { decideFromFacts, decisionRecord, fixedRecord } from 'footprintjs';
import type { DecideRule, DecisionRecord } from 'footprintjs';

/** The facts the table reads: flat names, computed by the caller from its own data. */
interface DeliveryFacts {
  express: boolean;
  heavy: boolean;
  postcode: string;
}

const DELIVERY: DecideRule<DeliveryFacts>[] = [
  { when: { express: { eq: true } }, then: 'courier', label: 'Express delivery was asked for' },
  { when: { heavy: { eq: true } }, then: 'freight', label: 'Too heavy for a parcel' },
  { when: (facts) => facts.postcode.startsWith('ZZ'), then: 'freight', label: 'A remote postcode' },
];

const FALLBACK = { branch: 'post', label: 'No rule fired: standard post' };

/** A configured choice is a bare string; a table is a list of rules. */
function chooseDelivery(configured: string | undefined, facts: DeliveryFacts): DecisionRecord {
  if (configured !== undefined) return fixedRecord(configured, undefined, 'app');
  return decisionRecord(decideFromFacts(DELIVERY, facts, FALLBACK).evidence);
}

let failed = false;
function check(ok: boolean, message: string): void {
  if (!ok) {
    failed = true;
    console.log(`REGRESSION: ${message}`);
  }
}

// 1. A rule chose. The record names the rule, its reason and the fact it read.
const heavy = chooseDelivery(undefined, { express: false, heavy: true, postcode: 'AB1 2CD' });
console.log('1. a rule chose     :', JSON.stringify(heavy));
check(heavy.by === 'rule' && heavy.rule === 1 && heavy.reads.join() === 'heavy', 'rule 1 should choose freight');

// 2. No rule chose. The default's label is the reason; `reads` is everything the table looked at.
const plain = chooseDelivery(undefined, { express: false, heavy: false, postcode: 'AB1 2CD' });
console.log('2. the default      :', JSON.stringify(plain));
check(plain.by === 'default' && plain.reads.join() === 'express,heavy,postcode', 'the default should read all three');

// 3. The configuration named a carrier: no table decided, the app stated it.
const fixed = chooseDelivery('courier', { express: false, heavy: false, postcode: 'AB1 2CD' });
console.log('3. a configured one :', JSON.stringify(fixed));
check(fixed.by === 'fixed' && fixed.voucher === 'app' && fixed.reads.length === 0, 'a bare string is fixed');

// 4. The evidence keeps names and operators, never a value: the postcode is nowhere in it.
const remote = decideFromFacts(DELIVERY, { express: false, heavy: false, postcode: 'ZZ9 9ZZ' }, FALLBACK);
const evidence = JSON.stringify(remote.evidence);
console.log('4. evidence         :', remote.branch, '— holds the postcode?', evidence.includes('ZZ9'));
console.log('   the function row :', JSON.stringify(remote.evidence.rules[2]));
check(remote.branch === 'freight' && !evidence.includes('ZZ9'), 'the value decides but never reaches the evidence');

if (failed) process.exit(1);
console.log('\n✓ one law, one record: a rule, the default, or a fixed choice — names only');

/* Output:

1. a rule chose     : {"strategy":"freight","by":"rule","rule":1,"label":"Too heavy for a parcel","reads":["heavy"]}
2. the default      : {"strategy":"post","by":"default","label":"No rule fired: standard post","reads":["express","heavy","postcode"]}
3. a configured one : {"strategy":"courier","by":"fixed","reads":[],"voucher":"app"}
4. evidence         : freight — holds the postcode? false
   the function row : {"type":"function","ruleIndex":2,"branch":"freight","matched":true,"label":"A remote postcode","inputs":[{"key":"postcode","valueSummary":"[REDACTED]","redacted":true}]}

✓ one law, one record: a rule, the default, or a fixed choice — names only
*/
