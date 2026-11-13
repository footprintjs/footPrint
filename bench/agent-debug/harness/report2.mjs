/**
 * Reads a part 2 batch's `runs.jsonl` and writes its `report.md`, to
 * RULE-2.md. Every number comes from the run lines (compare2.mjs), the
 * constants and the plan; none is typed by hand, except the block "Known
 * before the run", copied from the fairness readings (twin-proof/known-before.json).
 *
 * Order: the first lines (what claim A compares; unfinished runs whose
 * tokens are not fully known; what was known before the run); the decision
 * as RULE-2.md words it; each claim on each task group with its rows; the
 * transcripts the reviewer must read; every task by itself; retried
 * attempts by reason; stop reasons; notes. A batch that is not a smoke batch
 * also names the other part 2 batches kept beside it (siblings.mjs). Beside every tokens-per-correct number stand the
 * new and the re-sent tokens per run, which decide nothing.
 * "Void" is a reviewer's finding from the transcripts; this script never
 * prints it.
 * Example: `node harness/report2.mjs <folder> [title]` → `<folder>/report.md`.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { readRuns } from './batch.mjs';
import { costOf } from './budget.mjs';
import { loadFaults } from '../faults/apply.mjs';
import { loadQuestions } from '../questions/index.mjs';
import { CLAIMS, FAVOURED, GROUPS, HEADLINE_PERCENT, ROW_PERCENT, UNFINISHED, claim, fewer, fillMissing, rightAsOften, transcriptsToRead, withholding } from './compare2.mjs';
import { MAYBE_PAID_REASONS, SCRIPTED_MODEL } from './model.mjs';
import { readSide } from './readings.mjs';
import { SETUP_IDS } from './programs.mjs';
import { BENCH_DIR } from './runtime.mjs';
import { otherBatches, startedAt } from './siblings.mjs';
import { smokeChecklist } from './smoke-check.mjs';

const n0 = (x) => (x === null ? '-' : Math.round(x).toLocaleString('en-US'));
const perRight = (s) => (s.perRight === null ? 'none right' : n0(s.perRight));
/**
 * Tokens per correct answer, and beside it what unfinished runs did to it,
 * by the side's reading (readings.mjs): "1,290 (5 unfinished: 100,000 tokens)"
 * for the favoured side; "1,071 (finished only: 4 unfinished left out)" for the other.
 */
const perRightCell = (s) => {
  if (s.reading === 'finished') return `${perRight(s)} (finished only${s.unfinishedLeftOut ? `: ${s.unfinishedLeftOut} unfinished left out` : ''})`;
  if (s.reading === 'best') return `${perRight(s)} (finished runs' tokens${s.countedRight ? `; ${s.countedRight} unfinished counted right at no cost` : ''})`;
  const unfinished = `${s.unfinished} unfinished${s.unfinished ? `: ${n0(s.unfinishedTokens)} tokens${s.unknown ? `, ${s.unknown} unknown` : ''}${s.partial ? `, ${s.partial} a lower bound` : ''}` : ''}`;
  return `${perRight(s)} (${unfinished}${s.reading === 'bound' ? `; ${s.capped} runs priced at their caps` : ''})`;
};
/**
 * Right answers in the side's reading, with planned and finished beside it:
 * "116 of 150 planned (146 finished)" for the favoured side (an unfinished run
 * is not right); "116 of 146 finished (150 planned)" for the other side.
 */
const share = (s) => {
  if (s.reading === 'finished') return `${s.right} of ${s.finished} finished (${s.planned} planned)`;
  if (s.reading === 'best') return `${s.right} of ${s.planned} planned (${s.finished} finished; ${s.countedRight} unfinished counted right)`;
  return `${s.right} of ${s.planned} planned (${s.finished} finished)`;
};
/** The sentence above a claim's tables: which reading each side got. */
const readingsSentence = (c) => `Readings (RULE-2.md, "Changed after the fairness readings"): ${setupName(c.a)}, the side the claim favours, is read at its worst (an unfinished run is not right, counted over its planned runs; its recorded tokens count, a run with no transcript at the most a run can spend); ${setupName(c.b)} is read over its finished runs only (its unfinished runs are left out of its share and its tokens). The second reading takes the worst case for the claim on both sides: ${setupName(c.a)}'s unknown and possibly-paid tokens priced at their caps, and each of ${setupName(c.b)}'s unfinished runs counted as a right answer that cost nothing (${setupName(c.b)}'s share over its planned runs, its finished runs' tokens over its right answers so counted). In the most-expensive-run row, ${setupName(c.b)}'s most expensive finished run is counted as costing nothing (its answer still counts) and ${setupName(c.a)} is read as in the headline, in both readings.`;

/**
 * How an unfinished run is counted, said per side (the same words in the
 * first line and in the list of runs the harness could not finish).
 */
export const UNFINISHED_PER_SIDE = 'kept and counted in the spend; on the side a claim favours never right, its recorded tokens counted in the first reading and what is not known priced at its cap in the second; on the other side left out of its share and its tokens in the first reading, counted as a right answer that cost nothing in the second';
const pct = (f) => (f === null ? '-' : f >= 0 ? `${(f * 100).toFixed(1)}% fewer` : `${(-f * 100).toFixed(1)}% more`);
const setupName = (s) => (s === 'P' ? 'set-up P' : `set-up ${s}`);

/**
 * The decision sentence, as RULE-2.md words it: "No decision" with the
 * reason when the batch is withheld (compare2.mjs · withholding), else what
 * the rows give (`rowsDecision`). Whatever reads the decision as data reads
 * this line, so a withheld batch never shows "Go on" or "Stop and look" here.
 * @param {any[]} allRows every row, unfinished ones included @param {string | undefined} withheld @param {any[]} [plan]
 */
export function decision2(allRows, withheld, plan) {
  return withheld ? `No decision: ${withheld}` : rowsDecision(allRows, plan);
}

/**
 * What the rows give, with no guard asked: the ONE function behind both the
 * decision of a batch that is not withheld and the line printed beside a
 * withheld one (`withoutGuardsLine`), so the two cannot drift. Its own "No
 * decision" (claim A holds in the first reading and fails in the second, or
 * a side is missing) is a reading of the rows, not a guard.
 * @param {any[]} allRows @param {any[]} [plan]
 */
export function rowsDecision(allRows, plan) {
  const questions = GROUPS.find((g) => g.id === 'questions');
  const a = claim(allRows, CLAIMS[0], /** @type {any} */ (questions), plan);
  if (!a.present) return 'No decision: the batch does not hold both set-up 3 and set-up P, so claim A cannot be read.';
  const headOf = (x) => `on ${x.label} set-up 3 was right in ${share(x.a)} against set-up P's ${share(x.b)}, at ${perRight(x.a)} against ${perRight(x.b)} tokens per correct answer (${pct(x.fewer)})`;
  const head = headOf(a);
  if (a.holds) {
    const bound = claim(allRows, CLAIMS[0], /** @type {any} */ (questions), plan, { bound: true });
    if (!bound.holds) {
      return `No decision: claim A on the questions holds in the first reading and fails in the second, where set-up 3's unknown and possibly-paid tokens are priced at their caps and each of set-up P's unfinished runs counts as a right answer that cost nothing (RULE-2.md, "Changed after the fairness readings"). First reading: ${head}. Second reading: ${headOf(bound)}${bound.head ? `, and a row fails (${bound.rows.filter((r) => !r.holds).map((r) => r.label).slice(0, 5).join('; ')})` : ''}.`;
    }
    return `Go on (a larger program of our own, then a program we did not write, ported to the pattern): claim A holds on the questions: ${head}, in every row with one task left out set-up 3 is still right at least as often and at least ${ROW_PERCENT}% cheaper, and with set-up P's most expensive finished run counted as costing nothing it is still at least ${ROW_PERCENT}% cheaper; it holds in the second reading too.`;
  }
  const failing = a.rows.filter((r) => !r.holds).map((r) => r.label);
  const why = !a.head
    ? !a.a.comparable || !a.b.comparable ? 'a side has no finished run, so it cannot be compared' : !rightAsOften(a.a, a.b) ? 'set-up 3 was right less often (set-up 3 over its planned runs, set-up P over its finished runs)' : `set-up 3 is not at least ${HEADLINE_PERCENT}% cheaper per correct answer`
    : `it hangs on one task or one run (${failing.slice(0, 5).join('; ')}${failing.length > 5 ? '; …' : ''})`;
  return `Stop and look: claim A does not hold on the questions: ${head}; ${why}. Read the transcripts and say why before anything else is built or run.`;
}

/** The questions and faults by id, loaded once: the task of a missing planned run that no row names (compare2.mjs · fillMissing). */
let tasksById;
const allTasks = () => (tasksById ??= new Map([...loadQuestions(), ...loadFaults()].map((t) => [t.id, t])));

/** Beside a decision whose rows cannot be read against the plan: why no line follows (RULE-2.md, "What decides"). */
export const NOT_THE_PLAN_SENTENCE = 'A planned run appears more than once, or a row is not in the plan: the rows cannot be read against the plan at all, so no line shows what they would give (RULE-2.md, "What decides").';

/**
 * The line beside a withheld decision (RULE-2.md, "What decides": so that
 * "No decision" can never hide a "Stop and look"), or undefined.
 * - A guard withholds it (planned runs that have no row; a lost set-up 3
 *   transcript; more than 20 unfinished): what the rows give without the
 *   guards, `rowsDecision` of the rows with each missing planned run filled
 *   in as an unfinished run whose transcript is lost (compare2.mjs ·
 *   fillMissing). When more than one guard trips, the others are named.
 * - The rows are not the plan in another way (a planned run twice, a row
 *   not in the plan): `NOT_THE_PLAN_SENTENCE`, no line.
 * - A smoke batch, no plan, nothing withheld: undefined.
 * Example: → "Without this guard, with each of the 400 planned runs that have no row counted as an unfinished run whose transcript is lost, the rows give: Stop and look: …".
 * @param {any[]} allRows @param {ReturnType<typeof withholding>} withheld @param {any[]} [plan]
 */
export function withoutGuardsLine(allRows, withheld, plan) {
  if (withheld?.kind === 'not the plan') return NOT_THE_PLAN_SENTENCE;
  if (!withheld?.guard) return undefined;
  const others = withheld.reasons.slice(1);
  const lead = others.length === 0
    ? 'Without this guard'
    : `The other ${others.length === 1 ? 'guard trips' : 'guards trip'} too: ${others.join(' ')} Without ${withheld.reasons.length === 2 ? 'both guards' : 'these guards'}`;
  const n = withheld.missing.length;
  const filled = n === 0 ? '' : n === 1
    ? ', with the 1 planned run that has no row counted as an unfinished run whose transcript is lost,'
    : `, with each of the ${n} planned runs that have no row counted as an unfinished run whose transcript is lost,`;
  const rows = n === 0 ? allRows : fillMissing(allRows, withheld.missing, allTasks());
  return `${lead}${filled} the rows give: ${rowsDecision(rows, plan)}`;
}

/** The lines of one claim on every group, then its left-out rows. */
function claimSection(allRows, c, plan) {
  const results = GROUPS.map((g) => claim(allRows, c, g, plan));
  const bounds = GROUPS.map((g) => claim(allRows, c, g, plan, { bound: true }));
  const A = setupName(c.a);
  const B = setupName(c.b);
  const lines = [
    `### ${c.label[0].toUpperCase()}${c.label.slice(1)}`,
    '',
    readingsSentence(c),
    '',
    `| Task group | ${A} right | ${A} tokens per correct answer | ${A} new / re-sent tokens per run | ${B} right | ${B} tokens per correct answer | ${B} new / re-sent tokens per run | ${A} against ${B} | Holds |`,
    '|---|---|---|---|---|---|---|---|---|',
    ...results.flatMap((r, i) => {
      if (!r.present) return [`| ${r.group.name} | not in this batch | | | | | | | - |`];
      const withRowsHere = c.decides && r.group.id === 'questions';
      // The second reading's left-out rows are printed (and count) only where it can withhold the decision; elsewhere its row is its headline.
      const holdsCell = (x) => (x.bound && !withRowsHere ? `${x.head ? 'yes' : 'no'} (headline only)` : x.holds ? 'yes' : 'no');
      const line = (x, label) => `| ${label} | ${share(x.a)} | ${perRightCell(x.a)} | ${n0(x.a.newPerRun)} / ${n0(x.a.resentPerRun)} | ${share(x.b)} | ${perRightCell(x.b)} | ${n0(x.b.newPerRun)} / ${n0(x.b.resentPerRun)} | ${pct(x.fewer)} | ${holdsCell(x)} |`;
      const decides = withRowsHere ? 'withholds the decision if it fails where the first holds' : 'decides nothing';
      return [line(r, r.label), line(bounds[i], `${r.label}, second reading (a bound; ${decides})`)];
    }),
    '',
    ...results.filter((r) => r.present && r.group.decidesNothing).map((r) => `${r.label[0].toUpperCase()}${r.label.slice(1)}: ${r.group.decidesNothing}`),
    '',
  ];
  // The left-out rows of every group in the first reading, and of the second reading where it can withhold the decision (claim A on the questions).
  const withRows = [...results, ...bounds.filter((x) => c.decides && x.group.id === 'questions')];
  for (const r of withRows.filter((x) => x.present)) {
    lines.push(
      `Rows, ${c.id} on ${r.label}${r.bound ? ', second reading' : ''} (a row with one task left out must still be right at least as often, each side in its reading, and at least ${ROW_PERCENT}% cheaper; the most-expensive-run row asks only whether ${A} is still at least ${ROW_PERCENT}% cheaper):`,
      '',
      `| Row | ${A} right | ${A} tokens per correct answer | ${A} new / re-sent per run | ${B} right | ${B} tokens per correct answer | ${B} new / re-sent per run | ${A} against ${B} | Holds |`,
      '|---|---|---|---|---|---|---|---|---|',
      ...r.rows.map((row) => `| ${row.label} | ${share(row.a)} | ${perRightCell(row.a)} | ${n0(row.a.newPerRun)} / ${n0(row.a.resentPerRun)} | ${share(row.b)} | ${perRightCell(row.b)} | ${n0(row.b.newPerRun)} / ${n0(row.b.resentPerRun)} | ${pct(fewer(row.a, row.b))} | ${row.holds ? 'yes' : 'no'} |`),
      '',
    );
  }
  return lines;
}

/** What was known before the run (twin-proof/known-before.json), printed as read. */
export function knownBefore(file = join(BENCH_DIR, 'twin-proof', 'known-before.json')) {
  const k = JSON.parse(readFileSync(file, 'utf8'));
  const c = k.comments;
  const f2 = (/** @type {number} */ x) => x.toFixed(2);
  return [
    '### Known before the run',
    '',
    `- Comments: the flowchart program has ${f2(c.F.commentLinesPerCodeLine)} comment lines per code line and ${f2(c.F.commentWordsPerCodeToken)} comment words per code token; the twin ${f2(c.P.commentLinesPerCodeLine)} and ${f2(c.P.commentWordsPerCodeToken)}.`,
    ...k.notes.map((n) => `- ${n}`),
    '',
    `Source: ${k.source}`,
    '',
  ];
}

/**
 * Retried attempts per set-up by reason (RULE-2.md, "Changed after the
 * fairness readings"), the ones that may have been paid apart (model.mjs ·
 * MAYBE_PAID_REASONS, on a model request). A retried token count is free.
 * @param {any[]} allRuns @param {any[]} setups
 */
export function retrySection(allRuns, setups) {
  const lines = ['## Retried attempts, by reason', '', `Each retried attempt got no answer and carries no usage. Those that may have been paid (${MAYBE_PAID_REASONS.join(', ')}, on a model request) are priced at their caps in the second reading, on the side a claim favours; a refused attempt (429, 529, or a 5xx other than 504) is taken as not billed, and a retried token count is free.`, '', '| Set-up | Reason | On | Attempts | May have been paid |', '|---|---|---|---|---|'];
  let any = false;
  for (const s of setups) {
    const counts = new Map();
    for (const r of allRuns.filter((x) => x.setup === s)) {
      for (const t of r.retried ?? []) {
        const k = JSON.stringify([t.reason, t.call, t.mayHaveBeenPaid]);
        counts.set(k, (counts.get(k) ?? 0) + 1);
      }
    }
    for (const [k, n] of [...counts].sort()) {
      const [reason, call, paid] = JSON.parse(k);
      lines.push(`| ${setupName(s)} | ${reason} | ${call === 'count' ? 'a token count' : 'a model request'} | ${n} | ${paid ? 'yes' : 'no'} |`);
      any = true;
    }
  }
  if (!any) lines.push('| every set-up | none | | 0 | |');
  return lines;
}

/**
 * The first lines' word on unfinished runs whose tokens are not fully
 * known: none at all (no transcript), a lower bound (a request never
 * answered), or with a retried attempt that may have been paid. Pinned by
 * test/report-words.test.mjs against readings.mjs.
 * @param {any[]} unfinished
 */
export function unknownTokensLine(unfinished) {
  const unknown = unfinished.filter((r) => r.tokensKnown === false).length;
  const partial = unfinished.filter((r) => r.tokensKnown !== false && (r.requestsWithoutUsage ?? 0) > 0).length;
  const paid = unfinished.filter((r) => r.tokensKnown !== false && (r.retried ?? []).some((x) => x.mayHaveBeenPaid)).length;
  return `Unfinished runs whose tokens cannot be known at all (no transcript): ${unknown}. Unfinished runs whose tokens are a lower bound (a request was sent and never answered, so its usage is unknown): ${partial}. Unfinished runs with a retried attempt that may have been paid: ${paid}. On the side a claim favours, the first reading counts what an unfinished run recorded (a request never answered and a possibly-paid retried attempt add nothing there; a run with no transcript counts the most a run can spend, and when it is a run of set-up ${FAVOURED} its batch is not decided) and the second prices what is not known at its cap; on the other side, an unfinished run is left out of the first reading and counted as a right answer that cost nothing in the second (RULE-2.md, "Changed after the fairness readings").`;
}

/** The report's first lines: what claim A compares, and what B and C are beside it for. */
export const WHAT_A_COMPARES = 'What claim A compares: set-up 3 against set-up P changes two things at once, the program (the flowchart program against its ordinary twin) and four more tools (`map`, `step`, `why` and `story`, which set-up P does not have). If claim A holds, it supports "this flowchart program with its tools against this twin"; it does not show that the record alone saves tokens. Claim B (set-up 3 against set-up 1: the tools, the program fixed) and claim C (set-up 1 against set-up P: the program, the tools fixed) are printed beside it to tell the two apart.';

/**
 * What a lost transcript does to the decision, said beside the run in the
 * list of unfinished runs (RULE-2.md, "What decides", fifth fairness reading).
 * @param {any} r a row with `tokensKnown: false`
 */
export function lostTranscriptWords(r) {
  return r.setup === FAVOURED
    ? `its transcript is lost, and a lost transcript of set-up ${FAVOURED} withholds the decision`
    : `its transcript is lost, which does not withhold the decision: nothing claim A uses depends on a transcript of ${setupName(r.setup)}`;
}

/**
 * Beside an interrupted run whose transcript holds the run's own `end` line
 * (rows.mjs · unfinishedRow, `finishedInTranscript`): the agent finished, and
 * the row was never written or was deleted. It still counts as unfinished
 * everywhere; a person judges (sixth fairness reading).
 */
export const ROW_LOST_WORDS = 'its transcript shows the run finished (it holds the run\'s end line) and its row was lost; it still counts as unfinished';

/**
 * The other part 2 batches beside this one (siblings.mjs), each with when it
 * started and its decision line, read again from its own files by this code.
 * @param {{ started?: string, batches: { name: string, started?: string, decision?: { line: string, without?: string }, unreadable?: string }[] }} others
 */
export function othersSection(others) {
  const head = [
    '## Other batches of part 2 beside this one (RULE-2.md, "What decides")',
    '',
    `Every batch of part 2 is kept, and a later batch names each earlier one with its decision line. Listed: every folder beside this one (in the same parent folder) that holds a part 2 batch which is neither a smoke batch nor a rehearsal, with when its first run started (from its started.jsonl) and its decision line, read again from its own order.json and runs.jsonl by the code that wrote this report. A folder moved out of the parent folder, or deleted, cannot be listed. This batch's first run started ${others.started ?? 'at a time not known (no run started)'}.`,
    '',
  ];
  if (!others.batches.length) return [...head, 'No earlier batch was found beside this one.', ''];
  return [
    ...head,
    ...others.batches.map((b) => {
      const when = b.started ? `started ${b.started}` : 'start not known (no run started)';
      if (b.unreadable) return `- \`${b.name}\`, ${when}: ${b.unreadable}`;
      const d = /** @type {{ line: string, without?: string }} */ (b.decision);
      return `- \`${b.name}\`, ${when}: ${d.line}${d.without ? ` (${d.without})` : ''}`;
    }),
    '',
  ];
}

/**
 * @param {any[]} allRuns every row of runs.jsonl
 * @param {{ title?: string, plan?: any[], smoke?: boolean, code?: { commit: string | null, uncommittedChanges: boolean | null }, checklist?: string[], others?: Parameters<typeof othersSection>[0] }} [options]
 *   `others`: the batches beside this one (writeReport2 reads them; absent, the section is not printed)
 */
export function renderReport2(allRuns, options = {}) {
  const unfinished = allRuns.filter((r) => UNFINISHED.has(r.stopReason));
  const setups = SETUP_IDS.filter((s) => allRuns.some((r) => r.setup === s));
  const models = [...new Set(allRuns.map((r) => r.model).filter(Boolean))].join(', ');
  const spend = allRuns.reduce((s, r) => s + costOf({ input_tokens: r.inputTokens, output_tokens: r.outputTokens }), 0);
  const withheld = withholding(allRuns, options);
  const without = withoutGuardsLine(allRuns, withheld, options.plan);
  const lines = [
    `# ${options.title ?? 'agent-debug part 2 report'}`,
    '',
    `Generated by \`harness/report2.mjs\` from \`runs.jsonl\`, to RULE-2.md${options.code?.commit ? ` as committed at ${options.code.commit}${options.code.uncommittedChanges ? ' (with uncommitted changes in bench/agent-debug)' : ''}` : ''}: ${allRuns.length} runs (${unfinished.length} unfinished: ${UNFINISHED_PER_SIDE}), model ${models || 'none'}, spend estimate at least ${spend.toFixed(4)} dollars at RULE.md's prices (a lower bound, see the notes). No number here is typed by hand, except the block "Known before the run", which is copied from the fairness readings (twin-proof/known-before.json).`,
    '',
    WHAT_A_COMPARES,
    '',
    unknownTokensLine(unfinished),
    '',
    ...knownBefore(),
    ...(models === SCRIPTED_MODEL
      ? ['The model here is a script that is TOLD each answer and each fault, and counts tokens as characters / 4. These numbers test the harness, not the claims: the decision below is read off them mechanically and means nothing.', '']
      : []),
    '## The decision (RULE-2.md, "What decides")',
    '',
    decision2(allRuns, withheld?.reason, options.plan),
    '',
    ...(without ? [without, ''] : []),
    unfinished.length
      ? `Runs the harness could not finish (${UNFINISHED_PER_SIDE}): ${unfinished.map((r) => `\`${r.transcript}\` (${r.stopReason}, ${n0(r.inputTokens + r.outputTokens)} tokens recorded${r.tokensKnown === false ? `, tokens unknown: ${lostTranscriptWords(r)}` : (r.requestsWithoutUsage ?? 0) > 0 ? ', a lower bound' : ''}${r.finishedInTranscript ? `, ${ROW_LOST_WORDS}` : ''})`).join(', ')}.`
      : 'Runs the harness could not finish: none.',
    '',
    ...(options.others ? othersSection(options.others) : []),
    'The faults are reported and do not block. Whether the batch is void is a reviewer\'s finding, not this script\'s.',
    '',
    '## The claims, on every task group',
    '',
    `Right and tokens per correct answer are read differently on the two sides of a claim (RULE-2.md, "Changed after the fairness readings"; harness/readings.mjs). The side the claim favours is read at its worst: right answers over its PLANNED runs (a run that ended in an error or was interrupted is not right), and tokens per correct answer over all its runs, an unfinished run counting what the harness recorded of it (every answered request; a request never answered has no usage) and a run with no transcript the most a run can spend under the limits, as in the second reading. The other side is read over its FINISHED runs only. A side with no finished run cannot be compared, and the claim does not hold there. Beside each tokens number: what unfinished runs put into it, or how many were left out. The second reading (a bound) is the worst case for the claim on both sides: the favoured side\'s unknown and possibly-paid tokens priced at their caps (a run with no transcript at the most a run can spend under the limits, each request never answered and each possibly-paid retried attempt at its input, the answered attempt\'s or the per-request limit, plus the output limit), and each of the other side\'s unfinished runs counted as a right answer that cost nothing. The most-expensive-run row counts the other side\'s most expensive finished run as costing nothing (its answer still counts), reads the favoured side as in the headline, and asks only whether the favoured side is still at least ${ROW_PERCENT}% cheaper. Margins: at least ${HEADLINE_PERCENT}% fewer tokens per correct answer in the headline, at least ${ROW_PERCENT}% in every row, equal included. A fault is right when the edit gives the expected result for every hidden order; a question when the answer equals the expected one. New / re-sent tokens per run, over the same runs: decide nothing (harness/tokens.mjs).`,
    '',
    ...CLAIMS.flatMap((c) => claimSection(allRuns, c, options.plan)),
    '## Transcripts the reviewer reads (RULE-2.md, "Void")',
    '',
    'For each kind of question: the three cheapest correct runs of set-up 3 and the three most expensive runs of set-up P.',
    '',
    ...transcriptsToRead(allRuns).flatMap((t) => [
      `- ${t.kind}: set-up 3 cheapest correct: ${t.cheapest.length ? t.cheapest.map((x) => `\`${x}\``).join(', ') : 'none'}; set-up P most expensive: ${t.priciest.length ? t.priciest.map((x) => `\`${x}\``).join(', ') : 'none'}.`,
    ]),
    '',
    '## Every task by itself',
    '',
    `| Task | Group | ${setups.map((s) => `${setupName(s)}: right · tokens per correct (new / re-sent per run) · runs that edited the program`).join(' | ')} |`,
    `|---|---|${setups.map(() => '---').join('|')}|`,
  ];
  const tasks = [...new Map(allRuns.map((r) => [r.task ?? r.fault, r])).values()].sort((x, y) => String(x.taskType).localeCompare(String(y.taskType)) || String(x.task ?? x.fault).localeCompare(String(y.task ?? y.fault)));
  for (const t of tasks) {
    const id = t.task ?? t.fault;
    const group = t.taskType === 'question' ? `question, ${t.kind}` : t.faultClass === 'inside-step' ? 'fault, control' : 'fault, data-flow';
    const cells = setups.map((s) => {
      const sum = readSide(allRuns.filter((r) => (r.task ?? r.fault) === id && r.setup === s), 'worst');
      return `${sum.right} of ${sum.runs} · ${perRightCell(sum)} (${n0(sum.newPerRun)} / ${n0(sum.resentPerRun)}) · ${sum.edited}`;
    });
    lines.push(`| ${id} | ${group} | ${cells.join(' | ')} |`);
  }
  lines.push('', ...retrySection(allRuns, setups));
  lines.push('', '## Stop reasons', '', '| Set-up | Stop reason | Runs |', '|---|---|---|');
  for (const s of setups) {
    const counts = {};
    for (const r of allRuns.filter((x) => x.setup === s)) counts[r.stopReason] = (counts[r.stopReason] ?? 0) + 1;
    for (const [reason, n] of Object.entries(counts).sort()) lines.push(`| ${setupName(s)} | ${reason} | ${n} |`);
  }
  lines.push(
    '',
    '## Notes',
    '',
    '- The spend is a lower bound: it adds up the usage of answered requests only. A request never answered (the last model request of a run that ended in an error on it, a request in flight when the harness stopped), a retried attempt that may have been paid, and a run with no transcript add nothing to it.',
    '- Requests, input and output tokens apart, tool calls by name and the context at the end are kept in every row of runs.jsonl and are not printed here; they decide nothing.',
    '- "Named the faulty step" is not reported in part 2 (harness/score.mjs says why); "edited the faulty file" is in every fault row.',
  );
  if (options.checklist) {
    lines.push('', '## The smoke batch\'s pass (RULE.md 1.5, asked again by RULE-2.md)', '', 'Answered from this folder\'s own files (harness/smoke-check.mjs). A "no" does not change the exit code.', '', ...options.checklist);
  }
  return `${lines.join('\n')}\n`;
}

/** A part 2 batch folder's rows and the options its report is read with, from its own files. @param {string} folder */
function readBatchFolder(folder) {
  const order = JSON.parse(readFileSync(join(folder, 'order.json'), 'utf8'));
  return { order, runs: readRuns(join(folder, 'runs.jsonl')), options: { plan: order.plan, smoke: order.label === 'smoke' } };
}

/**
 * A folder's decision line, and beside it what its rows give when a guard
 * withholds the decision: the same functions as the report's own decision.
 * @param {string} folder
 */
export function decisionOf(folder) {
  const { runs, options } = readBatchFolder(folder);
  const withheld = withholding(runs, options);
  return { line: decision2(runs, withheld?.reason, options.plan), without: withoutGuardsLine(runs, withheld, options.plan) };
}

/** Writes `report.md` of a part 2 batch folder from its own files. */
export function writeReport2(folder, title) {
  const { order, runs, options } = readBatchFolder(folder);
  const text = renderReport2(runs, {
    ...(title ? { title } : {}),
    ...options,
    code: order.code,
    ...(options.smoke ? { checklist: smokeChecklist(folder) } : { others: { started: startedAt(folder), batches: otherBatches(folder, decisionOf) } }),
  });
  writeFileSync(join(folder, 'report.md'), text);
  return text;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const folder = process.argv[2];
  if (!folder) {
    console.error('usage: node harness/report2.mjs <folder holding runs.jsonl> [title]');
    process.exit(2);
  }
  console.log(writeReport2(folder, process.argv[3]));
}
