/**
 * The run limits and the spend stop of RULE.md, in one place.
 *
 * RULE.md, "The model and the budget":
 * > One run ends when the agent calls `done`, after 30 model requests, when a
 * > request would send more than 90,000 input tokens, or when the run has used
 * > 400,000 input tokens in total.
 * > Prices used for the spend estimate (read 12 Nov 2026): 0.10 dollars per
 * > million input tokens and 0.50 per million output tokens [...]. The harness
 * > adds up `usage.input_tokens` and `usage.output_tokens` from every response
 * > and stops before a run when the estimate has reached 15 dollars.
 *
 * "Would send more than 90,000": the size of a request is known only after it
 * is sent, so before each request the loop ESTIMATES it (the last request's
 * input and output tokens plus the new tool results at 2 characters per
 * token, which over-counts on purpose); only when the estimate passes
 * `EXACT_COUNT_FROM` does it ask the model port for an exact count, and the
 * exact count decides. Example: `costOf({ input_tokens: 1e6, output_tokens: 0 })` → `0.1`.
 */

export const LIMITS = Object.freeze({
  maxRequests: 30,
  maxInputTokensPerRequest: 90_000,
  maxInputTokensPerRun: 400_000,
});

export const PRICES = Object.freeze({ inputDollarsPerMillion: 0.1, outputDollarsPerMillion: 0.5 });

export const SPEND_STOP_DOLLARS = 15;

/** Below this estimate no exact count is asked for. */
export const EXACT_COUNT_FROM = 60_000;

/** Characters per token used for the estimate: low, so the estimate is high. */
export const ESTIMATE_CHARS_PER_TOKEN = 2;

/** @param {{ input_tokens?: number, output_tokens?: number }} usage */
export function costOf(usage) {
  return ((usage.input_tokens ?? 0) * PRICES.inputDollarsPerMillion + (usage.output_tokens ?? 0) * PRICES.outputDollarsPerMillion) / 1e6;
}

/** The batch's spend so far, from the runs already written. @param {{ inputTokens: number, outputTokens: number }[]} runs */
export function spendOf(runs) {
  return runs.reduce((sum, r) => sum + costOf({ input_tokens: r.inputTokens, output_tokens: r.outputTokens }), 0);
}

/** Whether the batch must stop before starting another run. @param {number} dollars */
export function spendStopReached(dollars) {
  return dollars >= SPEND_STOP_DOLLARS;
}
