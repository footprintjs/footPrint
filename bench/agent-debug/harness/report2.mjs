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
import { CLAIMS, GROUPS, UNFINISHED, claim, noDecisionReason, summarize, transcriptsToRead } from './compare2.mjs';
import { SETUP_IDS } from './programs.mjs';
import { smokeChecklist } from './smoke-check.mjs';

const n0 = (x) => (x === null ? '-' : Math.round(x).toLocaleString('en-US'));
const perRight = (s) => (s.perRight === null ? 'none right' : n0(s.perRight));
const share = (s) => `${s.right} of ${s.runs} (${s.runs ? Math.round(s.share * 100) : 0}%)`;
const pct = (f) => (f === null ? '-' : f >= 0 ? `${(f * 100).toFixed(1)}% fewer` : `${(-f * 100).toFixed(1)}% more`);
const setupName = (s) => (s === 'P' ? 'set-up P' : `set-up ${s}`);

/** The decision sentence, as RULE-2.md words it. */
export function decision2(runs, withheld) {
  if (withheld) return `No decision: ${withheld}`;
  const questions = GROUPS.find((g) => g.id === 'questions');
  const a = claim(runs, CLAIMS[0], /** @type {any} */ (questions));
  if (!a.present) return 'No decision: the batch does not hold both set-up 3 and set-up P, so claim A cannot be read.';
  const head = `on the 30 questions set-up 3 was right in ${share(a.a)} of its finished runs against set-up P's ${share(a.b)}, at ${perRight(a.a)} against ${perRight(a.b)} tokens per correct answer (${pct(a.fewer)})`;
  if (a.holds) {
    return `Go on (a larger program of our own, then a program we did not write, ported to the pattern): claim A holds on the questions: ${head}, and in every left-out row set-up 3 is still right at least as often and at least 15% cheaper.`;
  }
  const failing = a.rows.filter((r) => !r.holds).map((r) => r.label);
  const why = !a.head
    ? a.a.share < a.b.share ? 'set-up 3 was right less often' : 'set-up 3 is not at least 25% cheaper per correct answer'
    : `it hangs on one task or one run (${failing.slice(0, 5).join('; ')}${failing.length > 5 ? '; …' : ''})`;
  return `Stop and look: claim A does not hold on the questions: ${head}; ${why}. Read the transcripts and say why before anything else is built or run.`;
}

/** The lines of one claim on every group, then its left-out rows. */
function claimSection(runs, c) {
  const results = GROUPS.map((g) => claim(runs, c, g));
  const A = setupName(c.a);
  const B = setupName(c.b);
  const lines = [
    `### ${c.label[0].toUpperCase()}${c.label.slice(1)}`,
    '',
    `| Task group | ${A} right | ${A} tokens per correct answer | ${A} new / re-sent tokens per run | ${B} right | ${B} tokens per correct answer | ${B} new / re-sent tokens per run | ${A} against ${B} | Holds |`,
    '|---|---|---|---|---|---|---|---|---|',
    ...results.map((r) => r.present
      ? `| ${r.group.label} | ${share(r.a)} | ${perRight(r.a)} | ${n0(r.a.newPerRun)} / ${n0(r.a.resentPerRun)} | ${share(r.b)} | ${perRight(r.b)} | ${n0(r.b.newPerRun)} / ${n0(r.b.resentPerRun)} | ${pct(r.fewer)} | ${r.holds ? 'yes' : 'no'} |`
      : `| ${r.group.label} | not in this batch | | | | | | | - |`),
    '',
  ];
  for (const r of results.filter((x) => x.present)) {
    lines.push(
      `Left out, ${c.id} on ${r.group.label} (each row must still be right at least as often and at least 15% cheaper):`,
      '',
      `| Left out | ${A} right | ${A} tokens per correct answer | ${B} right | ${B} tokens per correct answer | ${A} against ${B} | Holds |`,
      '|---|---|---|---|---|---|---|',
      ...r.rows.map((row) => `| ${row.label} | ${share(row.a)} | ${perRight(row.a)} | ${share(row.b)} | ${perRight(row.b)} | ${pct(row.a.perRight === null || row.b.perRight === null ? null : 1 - row.a.perRight / row.b.perRight)} | ${row.holds ? 'yes' : 'no'} |`),
      '',
    );
  }
  return lines;
}

/**
 * @param {any[]} allRuns every row of runs.jsonl
 * @param {{ title?: string, plan?: any[], smoke?: boolean, code?: { commit: string | null, uncommittedChanges: boolean | null }, checklist?: string[] }} [options]
 */
export function renderReport2(allRuns, options = {}) {
  const runs = allRuns.filter((r) => !UNFINISHED.has(r.stopReason));
  const unfinished = allRuns.filter((r) => UNFINISHED.has(r.stopReason));
  const setups = SETUP_IDS.filter((s) => runs.some((r) => r.setup === s));
  const models = [...new Set(allRuns.map((r) => r.model).filter(Boolean))].join(', ');
  const spend = allRuns.reduce((s, r) => s + costOf({ input_tokens: r.inputTokens, output_tokens: r.outputTokens }), 0);
  const withheld = noDecisionReason(allRuns, options);
  const lines = [
    `# ${options.title ?? 'agent-debug part 2 report'}`,
    '',
    `Generated by \`harness/report2.mjs\` from \`runs.jsonl\`, to RULE-2.md${options.code?.commit ? ` as committed at ${options.code.commit}${options.code.uncommittedChanges ? ' (with uncommitted changes in bench/agent-debug)' : ''}` : ''}: ${allRuns.length} runs (${unfinished.length} unfinished, left out of every number below), model ${models || 'none'}, spend estimate at least ${spend.toFixed(4)} dollars at RULE.md's prices, unfinished runs included. No number here is typed by hand.`,
    '',
    ...(models === 'scripted'
      ? ['The model here is a script that is TOLD each answer and each fault, and counts tokens as characters / 4. These numbers test the harness, not the claims: the decision below is read off them mechanically and means nothing.', '']
      : []),
    '## The decision (RULE-2.md, "What decides")',
    '',
    decision2(runs, withheld),
    '',
    unfinished.length
      ? `Runs the harness could not finish (kept, counted in the spend, left out of every number): ${unfinished.map((r) => `\`${r.transcript}\` (${r.stopReason})`).join(', ')}.`
      : 'Runs the harness could not finish: none.',
    '',
    'The faults are reported and do not block. Whether the batch is void is a reviewer\'s finding, not this script\'s.',
    '',
    '## The claims, on every task group',
    '',
    'Right: the share of a set-up\'s finished runs of the group that were right (a fault: the edit gives the expected result for every hidden order; a question: the answer equals the expected one). Tokens per correct answer: all tokens of those runs, right or wrong, divided by the right ones. New / re-sent tokens per run: decide nothing (harness/tokens.mjs).',
    '',
    ...CLAIMS.flatMap((c) => claimSection(runs, c)),
    '## Transcripts the reviewer reads (RULE-2.md, "Void")',
    '',
    'For each kind of question: the three cheapest correct runs of set-up 3 and the three most expensive runs of set-up P.',
    '',
    ...transcriptsToRead(runs).flatMap((t) => [
      `- ${t.kind}: set-up 3 cheapest correct: ${t.cheapest.length ? t.cheapest.map((x) => `\`${x}\``).join(', ') : 'none'}; set-up P most expensive: ${t.priciest.length ? t.priciest.map((x) => `\`${x}\``).join(', ') : 'none'}.`,
    ]),
    '',
    '## Every task by itself',
    '',
    `| Task | Group | ${setups.map((s) => `${setupName(s)} right · tokens per correct · runs that edited`).join(' | ')} |`,
    `|---|---|${setups.map(() => '---').join('|')}|`,
  ];
  const tasks = [...new Map(runs.map((r) => [r.task ?? r.fault, r])).values()].sort((x, y) => String(x.taskType).localeCompare(String(y.taskType)) || String(x.task ?? x.fault).localeCompare(String(y.task ?? y.fault)));
  for (const t of tasks) {
    const id = t.task ?? t.fault;
    const group = t.taskType === 'question' ? `question, ${t.kind}` : t.faultClass === 'inside-step' ? 'fault, control' : 'fault, data-flow';
    const cells = setups.map((s) => {
      const sum = summarize(runs.filter((r) => (r.task ?? r.fault) === id && r.setup === s));
      return `${sum.right} of ${sum.runs} · ${perRight(sum)} · ${sum.edited}`;
    });
    lines.push(`| ${id} | ${group} | ${cells.join(' | ')} |`);
  }
  lines.push('', '## Stop reasons', '', '| Set-up | Stop reason | Runs |', '|---|---|---|');
  for (const s of setups) {
    const counts = {};
    for (const r of runs.filter((x) => x.setup === s)) counts[r.stopReason] = (counts[r.stopReason] ?? 0) + 1;
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
