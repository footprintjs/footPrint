/**
 * The retried attempts of one run, read from its events (the transcript's
 * `request`, `retry` and `response` lines): ONE owner for the agent loop
 * (agent.mjs, from the events it logs) and for an interrupted run rebuilt
 * from its transcript (rows.mjs · unfinishedRow).
 *
 * Each retried attempt: its `reason` (model.mjs · withRetries), its `call`
 * (`message`, a model request, or `count`, a token count, which is free),
 * the `request` it belongs to (1-based), `mayHaveBeenPaid` (a reason in
 * model.mjs · MAYBE_PAID_REASONS, on a model request: the server may have
 * done the work; that list is the one owner, so this comment does not copy
 * it; model.mjs · retryMayHaveBeenPaid) and `answeredInput`:
 * the input tokens of the answer that request finally got, the same request
 * sent again, so the retried attempt's input is exactly that; null when the
 * request was never answered.
 * Why: part 2's second reading prices a possibly-paid attempt at its input
 * plus the output limit (readings.mjs · boundTokensOf), and the report
 * prints retried attempts by reason (RULE-2.md, "Changed after the
 * fairness readings").
 * Example: events request 1, retry (client timeout), response {input 1200}
 * → `[{ reason: 'client timeout', call: 'message', request: 1, mayHaveBeenPaid: true, answeredInput: 1200 }]`.
 */
import { retryMayHaveBeenPaid } from './model.mjs';

/**
 * @param {any[]} events in the order logged
 * @returns {{ reason: string, call: 'message' | 'count', request: number, mayHaveBeenPaid: boolean, answeredInput: number | null }[]}
 */
export function retriedFrom(events) {
  const answered = new Map();
  let seen = 0;
  /** @type {any[]} */
  const out = [];
  for (const e of events) {
    if (e.type === 'request') seen = e.n ?? seen + 1;
    else if (e.type === 'response') answered.set(seen, e.usage?.input_tokens ?? null);
    else if (e.type === 'retry') {
      // A token count runs before its request is logged; a model request's retries come after its `request` line.
      const call = e.call === 'count' ? 'count' : 'message';
      out.push({ reason: String(e.reason), call, request: call === 'count' ? seen + 1 : seen, mayHaveBeenPaid: call === 'message' && retryMayHaveBeenPaid(String(e.reason)) });
    }
  }
  return out.map((r) => ({ ...r, answeredInput: r.call === 'message' ? (answered.get(r.request) ?? null) : null }));
}
