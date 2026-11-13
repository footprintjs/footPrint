/**
 * How each side of a comparison is read (RULE-2.md, "Changed after the
 * fairness readings": unfinished runs are counted against the claim, on
 * both sides). In "A against B", A is the set-up the claim favours.
 *
 * | Reading | For | Right | Tokens per correct answer |
 * |---|---|---|---|
 * | `worst` | A, first reading | right runs over A's PLANNED runs (an unfinished run is not right) | every run's recorded tokens, unfinished ones included |
 * | `bound` | A, second reading | as `worst` | as `worst`, with what is not known priced at its cap (`boundTokensOf`) |
 * | `finished` | B | right runs over B's FINISHED runs | B's finished runs only |
 *
 * Why: an unfinished run says nothing sure about its set-up, so the
 * assumption taken is the one worse for the claim. The fairness reader
 * built both cases that break a one-sided reading: shares of finished runs
 * on both sides printed "Go on" for a set-up 3 with fewer right answers;
 * planned runs on both sides printed "Go on" when set-up P lost four runs to
 * API errors although P was right more often on the runs that finished.
 * A side with no finished run cannot be compared (`comparable: false`).
 * Every number comes from the rows and from the limits in budget.mjs.
 * Example: `readSide(rows, 'finished')` → `{ rate: 116 / 146, perRight: …, reading: 'finished', … }`.
 */
import { LIMITS, MAX_OUTPUT_TOKENS } from './budget.mjs';

export const UNFINISHED = new Set(['error', 'interrupted']);
export const recordedTokensOf = (/** @type {any} */ r) => r.inputTokens + r.outputTokens;
const isUnfinished = (/** @type {any} */ r) => UNFINISHED.has(r.stopReason);

/**
 * A run's tokens with what is not known priced at its cap (the second
 * reading, RULE-2.md): a run with no transcript counts as the per-run limit;
 * each request never answered counts the per-request input limit plus the
 * output limit; each retried attempt that may have been paid counts its
 * input (the answered attempt's, the same request sent again; the
 * per-request limit where none was answered) plus the output limit. A
 * refused attempt (429, 5xx, 529) adds nothing: taken as not billed.
 * @param {any} r a row
 */
export function boundTokensOf(r) {
  if (r.tokensKnown === false) return LIMITS.maxInputTokensPerRun;
  const unanswered = (r.requestsWithoutUsage ?? 0) * (LIMITS.maxInputTokensPerRequest + MAX_OUTPUT_TOKENS);
  const paid = (r.retried ?? [])
    .filter((x) => x.mayHaveBeenPaid)
    .reduce((t, x) => t + (x.answeredInput ?? LIMITS.maxInputTokensPerRequest) + MAX_OUTPUT_TOKENS, 0);
  return recordedTokensOf(r) + unanswered + paid;
}

/** Whether a row adds anything in the second reading. @param {any} r */
export const pricedAtCap = (r) => boundTokensOf(r) !== recordedTokensOf(r);

/**
 * One side's numbers on its rows of a group, in one reading.
 * @param {any[]} rows the side's rows, finished and unfinished
 * @param {'worst' | 'bound' | 'finished'} reading
 * @param {number} [planned] the plan's items for these rows (every row, without a plan)
 */
export function readSide(rows, reading, planned) {
  const finishedRows = rows.filter((r) => !isUnfinished(r));
  const unfinishedRows = rows.filter(isUnfinished);
  const counted = reading === 'finished' ? finishedRows : rows;
  const tokenOf = reading === 'bound' ? boundTokensOf : recordedTokensOf;
  const tokens = counted.reduce((t, r) => t + tokenOf(r), 0);
  const right = finishedRows.filter((r) => r.solved).length;
  const p = planned ?? rows.length;
  const over = reading === 'finished' ? finishedRows.length : p;
  const mean = (/** @type {(r: any) => number} */ pick) => (counted.length ? counted.reduce((t, r) => t + pick(r), 0) / counted.length : null);
  return {
    reading, runs: rows.length, planned: p, finished: finishedRows.length, right,
    rate: over > 0 ? right / over : 0,
    comparable: finishedRows.length > 0,
    tokens, perRight: right > 0 ? tokens / right : null,
    newPerRun: mean((r) => r.newTokens ?? 0), resentPerRun: mean((r) => r.resentTokens ?? 0),
    meanRequests: mean((r) => r.requests), edited: counted.filter((r) => (r.edits ?? 0) > 0).length,
    // What the unfinished runs put into this reading (none, for `finished`).
    unfinished: reading === 'finished' ? 0 : unfinishedRows.length,
    unfinishedTokens: reading === 'finished' ? 0 : unfinishedRows.reduce((t, r) => t + tokenOf(r), 0),
    unfinishedLeftOut: reading === 'finished' ? unfinishedRows.length : 0,
    unknown: unfinishedRows.filter((r) => r.tokensKnown === false).length,
    partial: unfinishedRows.filter((r) => r.tokensKnown !== false && (r.requestsWithoutUsage ?? 0) > 0).length,
    capped: reading === 'bound' ? counted.filter(pricedAtCap).length : 0,
  };
}
