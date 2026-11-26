/**
 * decide/record -- the decision record: which strategy was picked, by what, for what reason, from which facts.
 *
 * A projection, not a second structure: `decisionRecord(evidence)` derives the record from a `DecisionEvidence`
 * (`decide()`'s or `decideFromFacts`'s), so nothing is stored twice. `fixedRecord` makes the one record no evidence
 * can give: a choice no table made, because someone stated it.
 */

import type { DecisionEvidence, RuleEvidence } from './types.js';

/**
 * Who stated a fixed choice: the application (its configuration), or a provider (an adapter's own setting).
 *
 * @category Decision Branching
 */
export type DecisionVoucher = 'app' | 'provider';

/**
 * One "which strategy, and why". A user may add its own fields beside these five; it does not rename or drop them.
 *
 * @category Decision Branching
 */
export interface DecisionRecord {
  /** The branch chosen. */
  readonly strategy: string;
  /**
   * What chose it: `'rule'`, a rule of the table; `'default'`, the table's default, because no rule matched;
   * `'fixed'`, no table — someone stated the choice ({@link fixedRecord}).
   */
  readonly by: 'rule' | 'default' | 'fixed';
  /** The winning rule's index in its table (`ruleIndex`, counted from 0). Present only when `by` is `'rule'`. */
  readonly rule?: number;
  /** The reason, in the table author's words: the winning rule's `label`, or the default's. Absent when none was given. */
  readonly label?: string;
  /** The names of the facts that decided it, de-duplicated in first-read order. Names only, never values. */
  readonly reads: readonly string[];
  /** Who stated a fixed choice, when the caller says. Only on `by: 'fixed'`. */
  readonly voucher?: DecisionVoucher;
}

/**
 * The decision record of `evidence`, derived from the evidence alone.
 *
 * - **The winner.** The winning rule is the last entry of `evidence.rules` when its `matched` is true (first match
 *   wins, so evaluation stopped there): `by: 'rule'`, `rule` its `ruleIndex`, `label` its label. `by` is never
 *   inferred from `chosen === default`: a rule whose `then` equals the default branch is still `by: 'rule'`.
 * - **The default.** Otherwise `by: 'default'` and `label` is `evidence.defaultLabel`.
 * - **`reads`.** For a rule, the names its row read: a filter's condition keys, a function's input keys. For the
 *   default, the de-duplicated union, in first-read order, of every row's condition and input keys: what was looked
 *   at, since no rule won.
 *
 * Two cases lose a name, and the record says nothing more about them:
 * - a filter rule that THREW (for example an `in` list over 1000 entries) records no conditions, so it contributes no
 *   names;
 * - a key the filter refuses (the prototype denylist: `__proto__`, `constructor`, `toString`, …) records no condition.
 *
 * A function rule that threw keeps the names it read before the throw.
 *
 * @category Decision Branching
 */
export function decisionRecord(evidence: DecisionEvidence): DecisionRecord {
  const rows = evidence.rules;
  const last = rows[rows.length - 1];
  if (last !== undefined && last.matched) {
    return {
      strategy: evidence.chosen,
      by: 'rule',
      rule: last.ruleIndex,
      ...labelled(last.label),
      reads: namesRead([last]),
    };
  }
  return { strategy: evidence.chosen, by: 'default', ...labelled(evidence.defaultLabel), reads: namesRead(rows) };
}

const VOUCHERS: ReadonlySet<unknown> = new Set<DecisionVoucher>(['app', 'provider']);

/**
 * The record of a choice no table made: `by: 'fixed'`, no rule, no reads. A bare string in a configuration
 * (`delivery: 'courier'`) is `fixedRecord('courier', undefined, 'app')`. It is not a rule: an empty filter never
 * matches, so no table can express "always".
 *
 * @param strategy - the branch someone stated.
 * @param label - the reason, when there is one.
 * @param voucher - who stated it, `'app'` or `'provider'`, when the caller knows.
 * @throws TypeError when `strategy` is not a string, `label` is given and not a string, or `voucher` is given and is
 *   not one of the two.
 *
 * @category Decision Branching
 */
export function fixedRecord(strategy: string, label?: string, voucher?: DecisionVoucher): DecisionRecord {
  if (typeof strategy !== 'string') throw new TypeError('fixedRecord: strategy must be a string');
  if (label !== undefined && typeof label !== 'string') throw new TypeError('fixedRecord: label must be a string');
  if (voucher !== undefined && !VOUCHERS.has(voucher)) {
    throw new TypeError("fixedRecord: voucher must be 'app' or 'provider'");
  }
  return { strategy, by: 'fixed', ...labelled(label), reads: [], ...(voucher !== undefined && { voucher }) };
}

function labelled(label: string | undefined): { label: string } | undefined {
  return label === undefined ? undefined : { label };
}

/** The keys `rows` read, de-duplicated in first-read order. */
function namesRead(rows: readonly RuleEvidence[]): string[] {
  const names = new Set<string>();
  for (const row of rows) {
    for (const { key } of row.type === 'filter' ? row.conditions : row.inputs) names.add(key);
  }
  return [...names];
}
