/**
 * Reads a part 2 batch's `runs.jsonl` and writes its `report.md`, to
 * RULE-2.md. Every number comes from the run lines (compare2.mjs); none is
 * typed by hand.
 *
 * Order: the decision as RULE-2.md words it; each claim on each task group
 * with its left-out rows; the transcripts the reviewer must read; every task
 * by itself; stop reasons. Beside every tokens-per-correct number stand the
 * new and the re-sent tokens per run, which decide nothing.
 * "Void" is a reviewer's finding from the transcripts; this script never
 * prints it.
 * Example: `node harness/report2.mjs <folder> [title]` → `<folder>/report.md`.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { readRuns } from './batch.mjs';
import { costOf } from './budget.mjs';
import { CLAIMS, GROUPS, UNFINISHED, claim, fewer, noDecisionReason, rightAsOften, transcriptsToRead } from './compare2.mjs';
import { readSide } from './readings.mjs';
import { SETUP_IDS } from './programs.mjs';
import { BENCH_DIR } from './runtime.mjs';
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
  const unfinished = `${s.unfinished} unfinished${s.unfinished ? `: ${n0(s.unfinishedTokens)} tokens${s.unknown ? `, ${s.unknown} unknown` : ''}${s.partial ? `, ${s.partial} a lower bound` : ''}` : ''}`;
  return `${perRight(s)} (${unfinished}${s.reading === 'bound' ? `; ${s.capped} runs priced at their caps` : ''})`;
};
/**
 * Right answers in the side's reading, with planned and finished beside it:
 * "116 of 150 planned (146 finished)" for the favoured side (an unfinished run
 * is not right); "116 of 146 finished (150 planned)" for the other side.
 */
const share = (s) => (s.reading === 'finished' ? `${s.right} of ${s.finished} finished (${s.planned} planned)` : `${s.right} of ${s.planned} planned (${s.finished} finished)`);
/** The sentence above a claim's tables: which reading each side got. */
const readingsSentence = (c) => `Readings (RULE-2.md, "Changed after the fairness readings"): ${setupName(c.a)}, the side the claim favours, is read at its worst (an unfinished run is not right, counted over its planned runs; its recorded tokens count); ${setupName(c.b)} is read over its finished runs only (its unfinished runs are left out of its share and its tokens). The second reading prices ${setupName(c.a)}'s unknown and possibly-paid tokens at their caps.`;
const pct = (f) => (f === null ? '-' : f >= 0 ? `${(f * 100).toFixed(1)}% fewer` : `${(-f * 100).toFixed(1)}% more`);
const setupName = (s) => (s === 'P' ? 'set-up P' : `set-up ${s}`);

/**
 * The decision sentence, as RULE-2.md words it.
 * @param {any[]} allRows every row, unfinished ones included @param {string | undefined} withheld @param {any[]} [plan]
 */
export function decision2(allRows, withheld, plan) {
  if (withheld) return `No decision: ${withheld}`;
  const questions = GROUPS.find((g) => g.id === 'questions');
  const a = claim(allRows, CLAIMS[0], /** @type {any} */ (questions), plan);
  if (!a.present) return 'No decision: the batch does not hold both set-up 3 and set-up P, so claim A cannot be read.';
  const headOf = (x) => `on the 30 questions set-up 3 was right in ${share(x.a)} against set-up P's ${share(x.b)}, at ${perRight(x.a)} against ${perRight(x.b)} tokens per correct answer (${pct(x.fewer)})`;
  const head = headOf(a);
  if (a.holds) {
    const bound = claim(allRows, CLAIMS[0], /** @type {any} */ (questions), plan, { bound: true });
    if (!bound.holds) {
      return `No decision: claim A on the questions holds in the first reading and fails in the second, where set-up 3's unknown and possibly-paid tokens are priced at their caps (RULE-2.md, "Changed after the fairness readings"). First reading: ${head}. Second reading: ${headOf(bound)}${bound.head ? ', and a left-out row fails' : ''}.`;
    }
    return `Go on (a larger program of our own, then a program we did not write, ported to the pattern): claim A holds on the questions: ${head}, and in every left-out row set-up 3 is still right at least as often and at least 15% cheaper; it holds in the second reading too.`;
  }
  const failing = a.rows.filter((r) => !r.holds).map((r) => r.label);
  const why = !a.head
    ? !a.a.comparable || !a.b.comparable ? 'a side has no finished run, so it cannot be compared' : !rightAsOften(a.a, a.b) ? 'set-up 3 was right less often (set-up 3 over its planned runs, set-up P over its finished runs)' : 'set-up 3 is not at least 25% cheaper per correct answer'
    : `it hangs on one task or one run (${failing.slice(0, 5).join('; ')}${failing.length > 5 ? '; …' : ''})`;
  return `Stop and look: claim A does not hold on the questions: ${head}; ${why}. Read the transcripts and say why before anything else is built or run.`;
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
      if (!r.present) return [`| ${r.group.label} | not in this batch | | | | | | | - |`];
      const line = (x, label) => `| ${label} | ${share(x.a)} | ${perRightCell(x.a)} | ${n0(x.a.newPerRun)} / ${n0(x.a.resentPerRun)} | ${share(x.b)} | ${perRightCell(x.b)} | ${n0(x.b.newPerRun)} / ${n0(x.b.resentPerRun)} | ${pct(x.fewer)} | ${x.holds ? 'yes' : 'no'} |`;
      const decides = c.decides && r.group.id === 'questions' ? 'withholds the decision if it fails where the first holds' : 'decides nothing';
      return [line(r, r.group.label), line(bounds[i], `${r.group.label}, second reading (a bound; ${decides})`)];
    }),
    '',
    ...results.filter((r) => r.present && r.group.decidesNothing).map((r) => `${r.group.label[0].toUpperCase()}${r.group.label.slice(1)}: ${r.group.decidesNothing}`),
    '',
  ];
  // The left-out rows of every group in the first reading, and of the second reading where it can withhold the decision (claim A on the questions).
  const withRows = [...results, ...bounds.filter((x) => c.decides && x.group.id === 'questions')];
  for (const r of withRows.filter((x) => x.present)) {
    lines.push(
      `Left out, ${c.id} on ${r.group.label}${r.bound ? ', second reading' : ''} (each row must still be right at least as often, each side in its reading, and at least 15% cheaper):`,
      '',
      `| Left out | ${A} right | ${A} tokens per correct answer | ${A} new / re-sent per run | ${B} right | ${B} tokens per correct answer | ${B} new / re-sent per run | ${A} against ${B} | Holds |`,
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
 * fairness readings"), the ones that may have been paid apart: a client
 * timeout, a dropped connection or a 408 on a model request (model.mjs ·
 * MAYBE_PAID_REASONS). A retried token count is free.
 * @param {any[]} allRuns @param {any[]} setups
 */
export function retrySection(allRuns, setups) {
  const lines = ['## Retried attempts, by reason', '', 'Each retried attempt got no answer and carries no usage. Those that may have been paid are priced at their caps in the second reading, on the side a claim favours; a refused attempt (429, 5xx, 529) is taken as not billed.', '', '| Set-up | Reason | On | Attempts | May have been paid |', '|---|---|---|---|---|'];
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
 * The first lines' word on unfinished runs whose tokens are not fully known:
 * none at all (no transcript), or a lower bound (a request never answered).
 * @param {any[]} unfinished
 */
export function unknownTokensLine(unfinished) {
  const unknown = unfinished.filter((r) => r.tokensKnown === false).length;
  const partial = unfinished.filter((r) => r.tokensKnown !== false && (r.requestsWithoutUsage ?? 0) > 0).length;
  return `Unfinished runs whose tokens cannot be known at all (no transcript): ${unknown}. Unfinished runs whose tokens are a lower bound (a request was sent and never answered, so its usage is unknown): ${partial}. Every other token of an unfinished run is counted (RULE-2.md, "Changed after the fairness reading").`;
}

/** The report's first lines: what claim A compares, and what B and C are beside it for. */
export const WHAT_A_COMPARES = 'What claim A compares: set-up 3 against set-up P changes two things at once, the program (the flowchart program against its ordinary twin) and four more tools (`map`, `step`, `why` and `story`, which set-up P does not have). If claim A holds, it supports "this flowchart program with its tools against this twin"; it does not show that the record alone saves tokens. Claim B (set-up 3 against set-up 1: the tools, the program fixed) and claim C (set-up 1 against set-up P: the program, the tools fixed) are printed beside it to tell the two apart.';

/**
 * @param {any[]} allRuns every row of runs.jsonl
 * @param {{ title?: string, plan?: any[], smoke?: boolean, code?: { commit: string | null, uncommittedChanges: boolean | null }, checklist?: string[] }} [options]
 */
export function renderReport2(allRuns, options = {}) {
  const unfinished = allRuns.filter((r) => UNFINISHED.has(r.stopReason));
  const setups = SETUP_IDS.filter((s) => allRuns.some((r) => r.setup === s));
  const models = [...new Set(allRuns.map((r) => r.model).filter(Boolean))].join(', ');
  const spend = allRuns.reduce((s, r) => s + costOf({ input_tokens: r.inputTokens, output_tokens: r.outputTokens }), 0);
  const withheld = noDecisionReason(allRuns, options);
  const lines = [
    `# ${options.title ?? 'agent-debug part 2 report'}`,
    '',
    `Generated by \`harness/report2.mjs\` from \`runs.jsonl\`, to RULE-2.md${options.code?.commit ? ` as committed at ${options.code.commit}${options.code.uncommittedChanges ? ' (with uncommitted changes in bench/agent-debug)' : ''}` : ''}: ${allRuns.length} runs (${unfinished.length} unfinished: never right, their recorded tokens counted), model ${models || 'none'}, spend estimate at least ${spend.toFixed(4)} dollars at RULE.md's prices, unfinished runs included. No number here is typed by hand.`,
    '',
    WHAT_A_COMPARES,
    '',
    unknownTokensLine(unfinished),
    '',
    ...knownBefore(),
    ...(models === 'scripted'
      ? ['The model here is a script that is TOLD each answer and each fault, and counts tokens as characters / 4. These numbers test the harness, not the claims: the decision below is read off them mechanically and means nothing.', '']
      : []),
    '## The decision (RULE-2.md, "What decides")',
    '',
    decision2(allRuns, withheld, options.plan),
    '',
    unfinished.length
      ? `Runs the harness could not finish (kept, counted in the spend and in every token number, never right): ${unfinished.map((r) => `\`${r.transcript}\` (${r.stopReason}, ${n0(r.inputTokens + r.outputTokens)} tokens recorded${r.tokensKnown === false ? ', tokens unknown' : (r.requestsWithoutUsage ?? 0) > 0 ? ', a lower bound' : ''})`).join(', ')}.`
      : 'Runs the harness could not finish: none.',
    '',
    'The faults are reported and do not block. Whether the batch is void is a reviewer\'s finding, not this script\'s.',
    '',
    '## The claims, on every task group',
    '',
    'Right and tokens per correct answer are read differently on the two sides of a claim (RULE-2.md, "Changed after the fairness readings"; harness/readings.mjs). The side the claim favours is read at its worst: right answers over its PLANNED runs (a run that ended in an error or was interrupted is not right), and tokens per correct answer over all its runs, an unfinished run counting what the harness recorded of it (every answered request; a request never answered has no usage). The other side is read over its FINISHED runs only. A side with no finished run cannot be compared, and the claim does not hold there. Beside each tokens number: what unfinished runs put into it, or how many were left out. The second reading (a bound) prices the favoured side\'s unknown and possibly-paid tokens at their caps: a run with no transcript at the most a run can spend under the limits, each request never answered and each possibly-paid retried attempt at its input (the answered attempt\'s, or the per-request limit) plus the output limit. The most-expensive-run-out row leaves out the favoured side\'s most expensive run and the other side\'s most expensive finished run. A fault is right when the edit gives the expected result for every hidden order; a question when the answer equals the expected one. New / re-sent tokens per run, over the same runs: decide nothing (harness/tokens.mjs).',
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
    '- The spend is a lower bound: a request in flight when the harness stopped has no logged usage and is not counted.',
    '- "Named the faulty step" is not reported in part 2 (harness/score.mjs says why); "edited the faulty file" is in every fault row.',
  );
  if (options.checklist) {
    lines.push('', '## The smoke batch\'s pass (RULE.md 1.5, asked again by RULE-2.md)', '', 'Answered from this folder\'s own files (harness/smoke-check.mjs). A "no" does not change the exit code.', '', ...options.checklist);
  }
  return `${lines.join('\n')}\n`;
}

/** Writes `report.md` of a part 2 batch folder from its own files. */
export function writeReport2(folder, title) {
  const order = JSON.parse(readFileSync(join(folder, 'order.json'), 'utf8'));
  const text = renderReport2(readRuns(join(folder, 'runs.jsonl')), {
    ...(title ? { title } : {}),
    plan: order.plan,
    smoke: order.label === 'smoke',
    code: order.code,
    ...(order.label === 'smoke' ? { checklist: smokeChecklist(folder) } : {}),
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
