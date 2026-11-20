/**
 * The comparisons of part 2 (RULE-2.md, "What decides"), read off the run
 * rows. No number here is typed; report2.mjs prints what this returns.
 *
 * - Claims: A = set-up 3 against set-up P, B = set-up 3 against set-up 1,
 *   C = set-up 1 against set-up P (reported, decides nothing by itself). In
 *   each, `a` is the set-up the claim favours.
 * - Task groups: the 30 questions, each kind of 10, the seven data-flow
 *   faults (and, deciding nothing, without the three pairs easier to see in
 *   the twin), the three controls.
 * - A claim HOLDS on a group when the favoured side is right at least as
 *   often as the other and uses at least HEADLINE_PERCENT % fewer tokens per
 *   correct answer; in every row with one task of the group left out it is
 *   still right at least as often (decided while building, the stricter
 *   reading) and at least ROW_PERCENT % cheaper; and it is still ROW_PERCENT %
 *   cheaper when the other set-up's most expensive finished run is counted
 *   as costing nothing (RULE-2.md, "The most-expensive-run row leaves out
 *   one run of B only"). No run of the favoured set-up is left out of that
 *   row, in either reading: the old row left out a run of each side and was
 *   not monotone (a worse set-up 3 could turn "Stop and look" into "Go on";
 *   three reviewers built such batches, test/monotone.test.mjs keeps them).
 * - With every transcript present, a worse favoured set-up or a better other
 *   one never helps a claim, in the headline or in any row, in either
 *   reading. A missing transcript is not such a change: a lost transcript of
 *   set-up 3 gives no decision (`withholding`), and in the first reading the
 *   favoured side counts that run at its cap (readings.mjs · worstTokensOf),
 *   so it never makes that side cheaper there. In the second reading it can:
 *   a near-cap run with possibly-paid retries is priced above the cap while
 *   its transcript exists, which is one reason RULE-2.md withholds the
 *   decision instead. A lost transcript of set-up P, 1 or 2 withholds
 *   nothing: claim A reads no token of set-up P's unfinished runs and does not
 *   read set-ups 1 and 2 (fifth fairness reading).
 * - "At least" includes equal, compared exactly: whole tokens, whole right
 *   answers, whole percents, in BigInt (`cheaperBy`, `rightAsOften`). A
 *   rounded division put some exact ties on the wrong side.
 * - How each side is read (RULE-2.md, "Changed after the fairness
 *   readings"; readings.mjs): unfinished runs are counted against the claim
 *   on BOTH sides. The favoured side is read at its worst (an unfinished run
 *   is not right, counted over its PLANNED runs; its recorded tokens count,
 *   a run with no transcript at the most a run can spend);
 *   the other side over its FINISHED runs only. A side with no finished run
 *   in a group cannot be compared, and the claim does not hold there.
 * - The second reading (`claim(…, { bound: true })`) is the worst case for
 *   the claim on both sides: the favoured side's unknowns priced at their
 *   caps (readings.mjs · boundTokensOf), and each of the other side's
 *   unfinished runs a right answer that cost nothing; in its most-expensive-
 *   run row the other side's dearest finished run costs nothing too.
 *   If claim A on the questions holds in the first reading and fails in the
 *   second, there is no decision (report2.mjs · rowsDecision); everywhere else
 *   the second reading is a row that decides nothing.
 * - With a plan, a side's planned runs of a group are the plan's items of
 *   the group's tasks; with none, every row is a planned run.
 * Example: `claim(rows, CLAIMS[0], GROUPS[0], plan).holds` → `false`.
 */
import { EASIER_IN_TWIN } from './plan2.mjs';
import { SETUP_IDS } from './programs.mjs';
import { UNFINISHED, readSide, recordedTokensOf } from './readings.mjs';
import { unfinishedRow } from './rows.mjs';

/** "At least 25% fewer tokens per correct answer" (the headline) and "at least 15% fewer" (every row), as whole percents. */
export const HEADLINE_PERCENT = 25;
export const ROW_PERCENT = 15;
/** More unfinished runs than this, and there is no decision (RULE-2.md). */
export const MAX_UNFINISHED = 20;
export { UNFINISHED };

const dataFlow = (r) => r.taskType !== 'question' && r.faultClass === 'data-flow';

/**
 * The task groups. A group's label is built from the number of its tasks in
 * the batch (`labelFor(n)`), never typed: "the 30 questions" says 30 only
 * because 30 questions ran.
 */
export const GROUPS = Object.freeze([
  { id: 'questions', name: 'the questions', labelFor: (n) => `the ${n} questions`, pick: (r) => r.taskType === 'question' },
  { id: 'program', name: 'the questions about the program', labelFor: (n) => `the ${n} about the program`, pick: (r) => r.taskType === 'question' && r.kind === 'program' },
  { id: 'run', name: 'the questions about one run', labelFor: (n) => `the ${n} about what one run did`, pick: (r) => r.taskType === 'question' && r.kind === 'run' },
  { id: 'why', name: 'the questions about why a run ended', labelFor: (n) => `the ${n} about why one run ended as it did`, pick: (r) => r.taskType === 'question' && r.kind === 'why' },
  { id: 'data-flow', name: 'the data-flow faults', labelFor: (n) => `the ${n} data-flow faults`, pick: dataFlow },
  {
    id: 'data-flow-without-three',
    name: 'the data-flow faults without the three pairs',
    labelFor: (n) => `the ${n} data-flow faults without ${EASIER_IN_TWIN.faults.join(', ')} (decides nothing)`,
    pick: (r) => dataFlow(r) && !EASIER_IN_TWIN.faults.includes(r.task ?? r.fault),
    decidesNothing: 'The faults decide nothing, and this row leaves out the three pairs the fairness reader judged easier to see in the twin (harness/plan2.mjs · EASIER_IN_TWIN).',
  },
  { id: 'controls', name: 'the controls', labelFor: (n) => `the ${n} controls`, pick: (r) => r.taskType !== 'question' && r.faultClass === 'inside-step' },
]);

export const CLAIMS = Object.freeze([
  { id: 'A', a: 3, b: 'P', label: 'claim A (set-up 3 against set-up P)', decides: true },
  { id: 'B', a: 3, b: 1, label: 'claim B (set-up 3 against set-up 1)', decides: false },
  { id: 'C', a: 1, b: 'P', label: 'claim C (set-up 1 against set-up P), which decides nothing by itself', decides: false },
]);

const taskOf = (r) => r.task ?? r.fault;
const tokensOf = recordedTokensOf;

/**
 * Whether `a` uses at least `percent` % fewer tokens per correct answer than
 * `b`, equal included, compared exactly: a.tokens / a.right <= (100 - percent)
 * / 100 × b.tokens / b.right, multiplied out in BigInt. A side with no right
 * answer is never cheaper; against a side with none, a side with some is.
 * @param {{ tokens: number, right: number }} a @param {{ tokens: number, right: number }} b @param {number} percent a whole percent
 */
export function cheaperBy(a, b, percent) {
  if (a.right === 0) return false;
  if (b.right === 0) return true;
  return BigInt(a.tokens) * BigInt(b.right) * 100n <= BigInt(100 - percent) * BigInt(b.tokens) * BigInt(a.right);
}

/** `a`'s change against `b` in tokens per correct answer, as a fraction (0.3 = 30% fewer), or null. */
export function fewer(a, b) {
  return a.perRight === null || b.perRight === null ? null : 1 - a.perRight / b.perRight;
}

/** Whether the favoured side `a` was right at least as often as `b`, each in its own reading, compared exactly; false when either cannot be compared. */
export function rightAsOften(a, b) {
  return a.comparable && b.comparable && BigInt(a.rateNum) * BigInt(b.rateDen) >= BigInt(b.rateNum) * BigInt(a.rateDen);
}

/**
 * One claim on one group.
 * @param {any[]} allRows every row, unfinished ones included @param {typeof CLAIMS[number]} c @param {typeof GROUPS[number]} g
 * @param {{ setup: any, task?: string, fault?: string, repeat: number }[]} [plan] order.json's plan
 * @param {{ bound?: boolean }} [options] `bound`: the second reading (the favoured side's unknowns at their caps)
 */
export function claim(allRows, c, g, plan, options = {}) {
  const readingA = options.bound ? 'bound' : 'worst';
  const mine = allRows.filter(g.pick);
  const groupTasks = new Set(mine.map(taskOf));
  const groupPlan = plan?.filter((p) => groupTasks.has(taskOf(p)));
  /** The two sides on some of the group's rows, and the plan items that remain with them. */
  const sides = (kept, keptPlan) => ({
    a: readSide(kept.filter((r) => r.setup === c.a), readingA, keptPlan?.filter((p) => p.setup === c.a).length),
    b: readSide(kept.filter((r) => r.setup === c.b), options.bound ? 'best' : 'finished', keptPlan?.filter((p) => p.setup === c.b).length),
  });
  const { a, b } = sides(mine, groupPlan);
  const present = a.runs > 0 && b.runs > 0;
  const row = (label, kept, keptPlan) => {
    const { a: ra, b: rb } = sides(kept, keptPlan);
    return { label, kind: 'task left out', a: ra, b: rb, holds: rightAsOften(ra, rb) && cheaperBy(ra, rb, ROW_PERCENT) };
  };
  const tasks = [...groupTasks].sort();
  const rows = tasks.map((t) => row(`${t} left out`, mine.filter((r) => taskOf(r) !== t), groupPlan?.filter((p) => taskOf(p) !== t)));
  // The most-expensive-run row: the other set-up's dearest FINISHED run (by recorded tokens) costs nothing, its
  // answer still counting; the favoured side is read exactly as in the headline. It asks only the 15%.
  const bRows = mine.filter((r) => r.setup === c.b);
  const bFinished = bRows.filter((r) => !UNFINISHED.has(r.stopReason));
  const dearest = bFinished.length ? bFinished.reduce((x, y) => (recordedTokensOf(y) > recordedTokensOf(x) ? y : x)) : undefined;
  const bFree = readSide(bRows, options.bound ? 'best' : 'finished', groupPlan?.filter((p) => p.setup === c.b).length, { free: dearest });
  rows.push({
    label: `set-up ${c.b}'s most expensive finished run counted as costing nothing`, kind: 'most expensive run',
    a, b: bFree, holds: a.comparable && bFree.comparable && cheaperBy(a, bFree, ROW_PERCENT),
  });
  const head = rightAsOften(a, b) && cheaperBy(a, b, HEADLINE_PERCENT);
  return { claim: c, group: g, label: g.labelFor(groupTasks.size), bound: Boolean(options.bound), present, a, b, fewer: fewer(a, b), head, rows, holds: present && head && rows.every((r) => r.holds) };
}

/**
 * The set-up claim A favours, read from the one place the claims are defined
 * (the claim that decides): set-up 3. The lost-transcript guard applies to
 * its runs only.
 */
export const FAVOURED = /** @type {typeof CLAIMS[number]} */ (CLAIMS.find((c) => c.decides)).a;

/**
 * Why a batch carries no decision (RULE-2.md, "What decides"), and of which
 * kind, or undefined.
 * - `kind: 'smoke'` or `'no plan'`: nothing is printed beside the decision.
 * - `kind: 'not the plan'`: a planned run appears more than once, or a row
 *   is not in the plan (`unknownTasks` empty), or the plan names a task the
 *   harness does not know (`unknownTasks`: no row of it and no entry in
 *   `options.tasks`, the loaded questions and faults; seventh fairness
 *   reading: guessed, such a run could be filled into the wrong group), or
 *   is not in the plan. The rows cannot be read against the plan at all, so
 *   no line shows what they would give; the report says so.
 * - `kind: 'guard'`: one or more guards withhold the decision, and the report
 *   prints beside it what the rows give without them (report2.mjs ·
 *   withoutGuardsLine). The guards, in this order:
 *   planned runs that have no row (`missing` holds those plan items; a batch
 *   stopped before its end, by the spend stop or by hand, or a row deleted);
 *   a run of set-up 3 (`FAVOURED`) whose transcript is missing; more than 20
 *   unfinished (counted over all set-ups, the favoured one included; the
 *   sentence gives the count per set-up). The last two are counted on the
 *   rows present only: a run that was never made trips neither (sixth
 *   fairness reading). `reasons` holds every guard that trips, `reason` the
 *   first, which the decision line prints.
 * Why set-up 3 only for a lost transcript: what a set-up 3 run with no
 * transcript spent cannot be known at all (its retried attempts cannot be
 * priced), and claim A rests on set-up 3's spend. A lost transcript of
 * set-up P, 1 or 2 changes nothing claim A reads (set-up P's unfinished runs
 * are left out of its first reading and counted right at no cost in its
 * second; set-ups 1 and 2 are not read), so it withholds nothing; the report
 * lists the run with the other unfinished runs. Before the fifth fairness
 * reading any lost transcript withheld the decision: deleting one file of
 * set-up P turned a plain "Stop and look" into "No decision", which asks
 * for a new batch.
 * Example: one set-up 3 run rebuilt by rows.mjs · unfinishedRow(…, null) →
 * `{ kind: 'guard', guard: true, reason: 'the transcript of 1 run of set-up 3 is missing, …', reasons: [that], missing: [] }`.
 * @param {any[]} allRuns @param {{ plan?: any[], smoke?: boolean, tasks?: Map<string, any> }} options `tasks`: the loaded questions and faults by id
 * @returns {{ kind: 'smoke' | 'no plan' | 'not the plan' | 'guard', guard: boolean, reason: string, reasons: string[], missing: any[], unknownTasks: string[] } | undefined}
 */
export function withholding(allRuns, options) {
  const not = (/** @type {'smoke' | 'no plan' | 'not the plan'} */ kind, /** @type {string} */ reason, unknownTasks = /** @type {string[]} */ ([])) => ({ kind, guard: false, reason, reasons: [reason], missing: [], unknownTasks });
  if (options.smoke) return not('smoke', 'a smoke batch is not part of the result and decides nothing (RULE-2.md).');
  if (!options.plan) return not('no plan', 'there is no plan (order.json) to check the batch against.');
  const key = (r) => `${r.setup}/${taskOf(r)}/${r.repeat}`;
  const planned = new Set(options.plan.map(key));
  const seen = new Map();
  for (const r of allRuns) seen.set(key(r), (seen.get(key(r)) ?? 0) + 1);
  const missing = options.plan.filter((p) => !seen.has(key(p)));
  const twice = [...seen].filter(([k, n]) => planned.has(k) && n > 1).map(([k]) => k);
  const unplanned = [...seen.keys()].filter((k) => !planned.has(k));
  const missingReason = `the rows are not exactly the planned runs: ${missing.length} of the ${options.plan.length} planned runs are missing.`;
  if (twice.length || unplanned.length) {
    // The first reason as before (missing, then twice, then unplanned); no line beside it either way.
    if (missing.length) return not('not the plan', missingReason);
    if (twice.length) return not('not the plan', `the rows are not exactly the planned runs: ${twice.length} planned runs appear more than once.`);
    return not('not the plan', `the rows are not exactly the planned runs: ${unplanned.length} rows are not in the plan.`);
  }
  const unknownTasks = [...new Set(missing.map(taskOf))].filter((id) => !taskFor(allRuns, id, options.tasks)).sort();
  if (unknownTasks.length) {
    return not('not the plan', `the plan names ${unknownTasks.length === 1 ? 'a task' : `${unknownTasks.length} tasks`} the harness does not know (no row of ${unknownTasks.length === 1 ? 'it' : 'them'}, and no question or fault of that id): ${unknownTasks.join(', ')}.`, unknownTasks);
  }
  const reasons = missing.length ? [missingReason] : [];
  const lost = allRuns.filter((r) => r.setup === FAVOURED && r.tokensKnown === false).length;
  if (lost) {
    reasons.push(lost === 1
      ? `the transcript of 1 run of set-up ${FAVOURED} is missing, so what it spent cannot be known, and claim A rests on set-up ${FAVOURED}'s spend (RULE-2.md).`
      : `the transcripts of ${lost} runs of set-up ${FAVOURED} are missing, so what they spent cannot be known, and claim A rests on set-up ${FAVOURED}'s spend (RULE-2.md).`);
  }
  const unfinished = allRuns.filter((r) => UNFINISHED.has(r.stopReason));
  if (unfinished.length > MAX_UNFINISHED) {
    const perSetup = SETUP_IDS.filter((s) => allRuns.some((r) => r.setup === s)).map((s) => `set-up ${s} ${unfinished.filter((r) => r.setup === s).length}`);
    reasons.push(`more than ${MAX_UNFINISHED} of the ${allRuns.length} runs ended as error or interrupted (${unfinished.length}), counted over all set-ups: ${perSetup.join(', ')}.`);
  }
  return reasons.length ? { kind: 'guard', guard: true, reason: reasons[0], reasons, missing, unknownTasks: [] } : undefined;
}

/**
 * The rows with one row per planned run that has none: the ONE filling
 * (RULE-2.md, "What decides": for the line beside a withheld decision, a
 * planned run that has no row is counted as an unfinished run whose
 * transcript is lost). Each filled row is made by the real row maker,
 * rows.mjs · unfinishedRow(…, null): interrupted, not right, `tokensKnown:
 * false`, so a run of set-up 3 counts at the most a run can spend
 * (readings.mjs · worstTokensOf) and a run of another set-up as any
 * unfinished run of its side. Why not left out: a run that was never made
 * must never count for the claim; left out, a stopped batch's set-up 3 would
 * be read over fewer planned runs and look better.
 * The task of a missing run (question or fault, its kind) is read from a row
 * of the same task, else from `tasks` (the loaded questions and faults):
 * `taskFor`. A task neither names is an error here, never a guess:
 * `withholding` refuses such a plan first (`kind: 'not the plan'`).
 * Example: `fillMissing(rows, [{ setup: 3, task: 'run-tax-rate', repeat: 2 }])` → rows plus one interrupted set-up 3 row.
 * @param {any[]} allRuns @param {any[]} missing plan items @param {Map<string, any>} [tasks] task by id
 */
export function fillMissing(allRuns, missing, tasks = new Map()) {
  return [
    ...allRuns,
    ...missing.map((p) => {
      const id = taskOf(p);
      const task = taskFor(allRuns, id, tasks);
      if (!task) throw new Error(`fillMissing: the plan names task ${id}, which no row and no loaded question or fault names (withholding refuses such a plan first).`);
      const started = { setup: p.setup, ...(p.task !== undefined ? { task: id } : { fault: id }), taskType: task.type === 'question' ? 'question' : 'fault', repeat: p.repeat, model: null, transcript: null };
      return unfinishedRow(started, task, null);
    }),
  ];
}

/**
 * The task a plan item names, as the row maker reads it: from a row of the
 * same task, else from `tasks` (the loaded questions and faults), else
 * undefined. The ONE rule both `withholding` and `fillMissing` ask.
 * @param {any[]} allRuns @param {string} id @param {Map<string, any>} [tasks]
 */
export function taskFor(allRuns, id, tasks) {
  const r = allRuns.find((x) => taskOf(x) === id);
  if (r) {
    return r.taskType === 'question'
      ? { type: 'question', kind: r.kind, fixture: r.fixture }
      : { type: 'fault', class: r.faultClass, inDecision: r.inDecision, distance: r.distance };
  }
  return tasks?.get(id);
}

/** The sentence of `withholding`, or undefined. @param {any[]} allRuns @param {{ plan?: any[], smoke?: boolean }} options */
export const noDecisionReason = (allRuns, options) => withholding(allRuns, options)?.reason;

/**
 * The transcripts the rule tells the reviewer to read: for each kind of
 * question, the three cheapest RIGHT runs of set-up 3 and the three most
 * expensive runs of set-up P (right, wrong or unfinished, by recorded tokens).
 * @param {any[]} runs every row
 */
export function transcriptsToRead(runs) {
  return ['program', 'run', 'why'].map((kind) => {
    const of = runs.filter((r) => r.taskType === 'question' && r.kind === kind);
    const cheapest = of.filter((r) => r.setup === 3 && r.solved).sort((x, y) => tokensOf(x) - tokensOf(y)).slice(0, 3);
    const priciest = of.filter((r) => r.setup === 'P').sort((x, y) => tokensOf(y) - tokensOf(x)).slice(0, 3);
    return { kind, cheapest: cheapest.map((r) => r.transcript), priciest: priciest.map((r) => r.transcript) };
  });
}
