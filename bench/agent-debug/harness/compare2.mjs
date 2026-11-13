/**
 * The comparisons of part 2 (RULE-2.md, "What decides"), read off the run
 * rows. No number here is typed; report2.mjs prints what this returns.
 *
 * - Claims: A = set-up 3 against set-up P, B = set-up 3 against set-up 1,
 *   C = set-up 1 against set-up P (reported, decides nothing by itself).
 * - Task groups: the 30 questions, each kind of 10, the seven data-flow
 *   faults, the three controls.
 * - A claim HOLDS on a group when the first set-up is right in at least as
 *   large a share of its finished runs as the second, uses at least 25% fewer
 *   tokens per correct answer, and in every left-out row (each task of the
 *   group left out in turn; each set-up's most expensive run of the group
 *   left out) is still right at least as often and at least 15% cheaper.
 *   The rule's words for the rows name only the 15%; "right at least as
 *   often" is applied there too, as part 1's rule did, because it is the
 *   stricter reading (the reader looks for the claim being helped).
 * - Tokens per correct answer: all input and output tokens of the group's
 *   finished runs of a set-up, right or wrong, divided by its right ones.
 *   Beside it (decides nothing): new and re-sent tokens per run (tokens.mjs).
 * Example: `claim(rows, CLAIMS[0], GROUPS[0]).holds` → `false`.
 */

export const HEADLINE_MARGIN = 0.25;
export const ROW_MARGIN = 0.15;
/** More unfinished runs than this, and there is no decision (RULE-2.md). */
export const MAX_UNFINISHED = 20;
export const UNFINISHED = new Set(['error', 'interrupted']);

export const GROUPS = Object.freeze([
  { id: 'questions', label: 'the 30 questions', pick: (r) => r.taskType === 'question' },
  { id: 'program', label: 'the 10 about the program', pick: (r) => r.taskType === 'question' && r.kind === 'program' },
  { id: 'run', label: 'the 10 about what one run did', pick: (r) => r.taskType === 'question' && r.kind === 'run' },
  { id: 'why', label: 'the 10 about why one run ended as it did', pick: (r) => r.taskType === 'question' && r.kind === 'why' },
  { id: 'data-flow', label: 'the seven data-flow faults', pick: (r) => r.taskType !== 'question' && r.faultClass === 'data-flow' },
  { id: 'controls', label: 'the three controls', pick: (r) => r.taskType !== 'question' && r.faultClass === 'inside-step' },
]);

export const CLAIMS = Object.freeze([
  { id: 'A', a: 3, b: 'P', label: 'claim A (set-up 3 against set-up P)', decides: true },
  { id: 'B', a: 3, b: 1, label: 'claim B (set-up 3 against set-up 1)', decides: false },
  { id: 'C', a: 1, b: 'P', label: 'claim C (set-up 1 against set-up P), which decides nothing by itself', decides: false },
]);

const taskOf = (r) => r.task ?? r.fault;
const tokensOf = (r) => r.inputTokens + r.outputTokens;

/** One set-up's numbers on a list of finished runs. @param {any[]} runs */
export function summarize(runs) {
  const tokens = runs.reduce((s, r) => s + tokensOf(r), 0);
  const right = runs.filter((r) => r.solved).length;
  const mean = (pick) => (runs.length ? runs.reduce((s, r) => s + pick(r), 0) / runs.length : null);
  return {
    runs: runs.length, right, share: runs.length ? right / runs.length : 0, tokens,
    perRight: right > 0 ? tokens / right : null,
    newPerRun: mean((r) => r.newTokens ?? 0), resentPerRun: mean((r) => r.resentTokens ?? 0),
    meanRequests: mean((r) => r.requests), edited: runs.filter((r) => (r.edits ?? 0) > 0).length,
  };
}

/** Whether `a` uses at least `margin` fewer tokens per correct answer than `b` (none right is never cheaper). */
export function cheaperBy(a, b, margin) {
  if (a.perRight === null) return false;
  return b.perRight === null || a.perRight <= (1 - margin) * b.perRight;
}

/** `a`'s change against `b` in tokens per correct answer, as a fraction (0.3 = 30% fewer), or null. */
export function fewer(a, b) {
  return a.perRight === null || b.perRight === null ? null : 1 - a.perRight / b.perRight;
}

/**
 * One claim on one group of finished runs.
 * @param {any[]} runs finished runs @param {typeof CLAIMS[number]} c @param {typeof GROUPS[number]} g
 */
export function claim(runs, c, g) {
  const mine = runs.filter(g.pick);
  const side = (setup, kept) => summarize(kept.filter((r) => r.setup === setup));
  const a = side(c.a, mine);
  const b = side(c.b, mine);
  const present = a.runs > 0 && b.runs > 0;
  const row = (label, kept) => {
    const ra = side(c.a, kept);
    const rb = side(c.b, kept);
    return { label, a: ra, b: rb, holds: ra.share >= rb.share && cheaperBy(ra, rb, ROW_MARGIN) };
  };
  const tasks = [...new Set(mine.map(taskOf))].sort();
  const rows = tasks.map((t) => row(`${t} left out`, mine.filter((r) => taskOf(r) !== t)));
  const priciest = new Set([c.a, c.b].flatMap((setup) => {
    const own = mine.filter((r) => r.setup === setup);
    return own.length ? [own.reduce((x, y) => (tokensOf(y) > tokensOf(x) ? y : x))] : [];
  }));
  rows.push(row("each set-up's most expensive run left out", mine.filter((r) => !priciest.has(r))));
  const head = a.share >= b.share && cheaperBy(a, b, HEADLINE_MARGIN);
  return { claim: c, group: g, present, a, b, fewer: fewer(a, b), head, rows, holds: present && head && rows.every((r) => r.holds) };
}

/**
 * Why a batch carries no decision (RULE-2.md), or undefined: a smoke batch,
 * no plan, rows that are not exactly the plan, or more than 20 unfinished.
 * @param {any[]} allRuns @param {{ plan?: any[], smoke?: boolean }} options
 */
export function noDecisionReason(allRuns, options) {
  if (options.smoke) return 'a smoke batch is not part of the result and decides nothing (RULE-2.md).';
  if (!options.plan) return 'there is no plan (order.json) to check the batch against.';
  const key = (r) => `${r.setup}/${taskOf(r)}/${r.repeat}`;
  const planned = new Set(options.plan.map(key));
  const seen = new Map();
  for (const r of allRuns) seen.set(key(r), (seen.get(key(r)) ?? 0) + 1);
  const missing = [...planned].filter((k) => !seen.has(k));
  const twice = [...seen].filter(([k, n]) => planned.has(k) && n > 1).map(([k]) => k);
  const unplanned = [...seen.keys()].filter((k) => !planned.has(k));
  if (missing.length) return `the rows are not exactly the planned runs: ${missing.length} of the ${options.plan.length} planned runs are missing.`;
  if (twice.length) return `the rows are not exactly the planned runs: ${twice.length} planned runs appear more than once.`;
  if (unplanned.length) return `the rows are not exactly the planned runs: ${unplanned.length} rows are not in the plan.`;
  const unfinished = allRuns.filter((r) => UNFINISHED.has(r.stopReason)).length;
  if (unfinished > MAX_UNFINISHED) return `more than ${MAX_UNFINISHED} of the ${allRuns.length} runs ended as error or interrupted (${unfinished}).`;
  return undefined;
}

/**
 * The transcripts the rule tells the reviewer to read: for each kind of
 * question, the three cheapest RIGHT runs of set-up 3 and the three most
 * expensive runs of set-up P (right or not).
 * @param {any[]} runs finished runs
 */
export function transcriptsToRead(runs) {
  return ['program', 'run', 'why'].map((kind) => {
    const of = runs.filter((r) => r.taskType === 'question' && r.kind === kind);
    const cheapest = of.filter((r) => r.setup === 3 && r.solved).sort((x, y) => tokensOf(x) - tokensOf(y)).slice(0, 3);
    const priciest = of.filter((r) => r.setup === 'P').sort((x, y) => tokensOf(y) - tokensOf(x)).slice(0, 3);
    return { kind, cheapest: cheapest.map((r) => r.transcript), priciest: priciest.map((r) => r.transcript) };
  });
}
