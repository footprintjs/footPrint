/**
 * New tokens and re-sent tokens of one run, from the usage of its
 * consecutive requests (RULE-2.md, "What is counted": what any caching price
 * would weigh; it decides nothing).
 *
 * The rule (the same as part 1's second reader, batches/2026-11-12-batch-1/
 * review/numbers.py): the first request's input is new. Each later request
 * re-sends at most what the previous request held (its input plus its
 * output): re-sent = min(previous input + previous output, this input), and
 * the rest of its input is new. Every output token is new.
 * So new + re-sent = all input + all output, always.
 * Example: usages [{in 100, out 10}, {in 150, out 20}] → new 100 + 10 + 40 + 20 = 170, re-sent 110.
 */

/**
 * @param {{ input_tokens?: number, output_tokens?: number }[]} usages in request order
 * @returns {{ newTokens: number, resentTokens: number }}
 */
export function newAndResent(usages) {
  let newTokens = 0;
  let resentTokens = 0;
  let previous = null;
  for (const u of usages) {
    const input = u?.input_tokens ?? 0;
    const output = u?.output_tokens ?? 0;
    const resent = previous === null ? 0 : Math.min(previous, input);
    resentTokens += resent;
    newTokens += input - resent + output;
    previous = input + output;
  }
  return { newTokens, resentTokens };
}
