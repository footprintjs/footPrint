/**
 * Reads `runs.jsonl` and writes `report.md`, to RULE.md version 1.3. Every
 * number is computed here from the run lines; none is typed by hand
 * (RULE.md, rule 3).
 *
 * - Headline: tokens per solved task = all input and output tokens of all
 *   runs of a set-up, solved or not, divided by its solved runs; for the seven
 *   data-flow faults, the three decision faults and the other four apart, the
 *   three controls, and every fault by itself.
 * - Second number, which decides nothing: the mean context at the end of a
 *   run (the last request's input tokens plus its output tokens).
 * - Runs that ended as `error` or `interrupted` are left out of every number
 *   and listed by name; a decision prints only for a complete batch that is
 *   not a smoke batch, and "go" needs the sensitivity table to hold.
 * - The decision comes first, as RULE.md words it. "Void" is a reviewer's
 *   finding from transcripts, so the report never prints it; it lists the
 *   transcripts the rule says a reviewer must read.
 * Example: `node harness/report.mjs <folder> [title]` → `<folder>/report.md`.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { costOf } from './budget.mjs';
import { readRuns } from './batch.mjs';

/** @param {any[]} runs */
export function summarize(runs) {
  const tokens = runs.reduce((s, r) => s + r.inputTokens + r.outputTokens, 0);
  const solved = runs.filter((r) => r.solved).length;
  const mean = (/** @type {(r: any) => number} */ pick) => (runs.length ? runs.reduce((s, r) => s + pick(r), 0) / runs.length : null);
  return {
    runs: runs.length,
    solved,
    tokens,
    tokensPerSolved: solved > 0 ? tokens / solved : null,
    meanRequests: mean((r) => r.requests),
    meanFinalContext: mean((r) => r.finalContextTokens ?? 0),
    namedStep: runs.filter((r) => r.namedFaultyStep).length,
    editedFaultyFile: runs.filter((r) => r.editedFaultyFile).length,
  };
}

/** The four groups RULE.md reports, for one set-up's runs. @param {any[]} runs */
export function groups(runs) {
  const dataFlow = runs.filter((r) => r.faultClass === 'data-flow');
  return {
    dataFlow: summarize(dataFlow),
    decision: summarize(dataFlow.filter((r) => r.inDecision)),
    otherFour: summarize(dataFlow.filter((r) => !r.inDecision)),
    controls: summarize(runs.filter((r) => r.faultClass === 'inside-step')),
  };
}

const band = (d) => (d <= 1 ? '0 to 1' : d <= 4 ? '2 to 4' : '5 or more');
const fmt = (n) => (n === null ? 'none solved' : Math.round(n).toLocaleString('en-US'));
const fmtMean = (n) => (n === null ? '-' : Math.round(n).toLocaleString('en-US'));

/** Whether `a` is cheaper per solved task than `b` (none solved is never cheaper). */
function cheaperThan(a, b) {
  if (a.tokensPerSolved === null) return false;
  return b.tokensPerSolved === null || a.tokensPerSolved < b.tokensPerSolved;
}

/** Runs RULE.md 1.3 leaves out of every number: the harness could not finish them. */
export const UNFINISHED = new Set(['error', 'interrupted']);
/** More unfinished runs than this, and there is no decision (RULE.md 1.3). */
export const MAX_UNFINISHED = 3;

/**
 * RULE.md 1.3's sensitivity rule: with any one data-flow fault left out, and
 * with each set-up's single most expensive data-flow run left out, set-up 3
 * must still solve at least as many runs as set-up 1 and be cheaper per
 * solved task. One row per case.
 * @param {any[]} runs finished runs only
 */
export function sensitivity(runs) {
  const dataFlow = runs.filter((r) => r.faultClass === 'data-flow');
  const row = (/** @type {string} */ label, /** @type {any[]} */ kept) => {
    const one = summarize(kept.filter((r) => r.setup === 1));
    const three = summarize(kept.filter((r) => r.setup === 3));
    return { label, one, three, holds: three.solved >= one.solved && cheaperThan(three, one) };
  };
  const faults = [...new Set(dataFlow.map((r) => r.fault))].sort();
  const rows = faults.map((f) => row(`fault ${f} left out`, dataFlow.filter((r) => r.fault !== f)));
  const priciest = new Set(
    [1, 3].flatMap((setup) => {
      const mine = dataFlow.filter((r) => r.setup === setup);
      if (mine.length === 0) return [];
      return [mine.reduce((a, b) => (b.inputTokens + b.outputTokens > a.inputTokens + a.outputTokens ? b : a))];
    }),
  );
  rows.push(row('the most expensive run of each set-up left out', dataFlow.filter((r) => !priciest.has(r))));
  return rows;
}

/**
 * RULE.md 1.3, "What decides the next step", read off the numbers.
 * @param {Record<number, ReturnType<typeof groups>>} bySetup
 * @param {ReturnType<typeof sensitivity>} rows the sensitivity rows (required); a failing row withholds "go"
 */
export function decision(bySetup, rows) {
  if (!Array.isArray(rows) || rows.length === 0) return 'No decision: the sensitivity table (RULE.md 1.3) was not given.';
  const one = bySetup[1];
  const three = bySetup[3];
  if (!one || !three) return 'No decision: the batch does not hold both set-up 1 and set-up 3.';
  const solvesEnough = three.dataFlow.solved >= one.dataFlow.solved;
  const cheaper =
    three.dataFlow.tokensPerSolved !== null &&
    (one.dataFlow.tokensPerSolved === null || three.dataFlow.tokensPerSolved <= 0.75 * one.dataFlow.tokensPerSolved);
  let ratio = '';
  if (three.dataFlow.tokensPerSolved !== null && one.dataFlow.tokensPerSolved !== null) {
    const change = Math.round((1 - three.dataFlow.tokensPerSolved / one.dataFlow.tokensPerSolved) * 100);
    ratio = change >= 0 ? ` (${change}% fewer tokens per solved task)` : ` (${-change}% more tokens per solved task)`;
  }
  const head = `on the seven data-flow faults set-up 3 solved ${three.dataFlow.solved} runs against set-up 1's ${one.dataFlow.solved}${ratio}`;
  const failing = rows.filter((r) => !r.holds);
  if (solvesEnough && cheaper && failing.length > 0) {
    const named = failing
      .map((r) => `with ${r.label}, set-up 3 solves ${r.three.solved} against ${r.one.solved} at ${fmt(r.three.tokensPerSolved)} against ${fmt(r.one.tokensPerSolved)} tokens per solved task`)
      .join('; ');
    return `Stop and look: ${head}, but the result hangs on one fault or one run: ${named}. Read the transcripts and say why before building anything else.`;
  }
  if (solvesEnough && cheaper) {
    const lines = [`Go on to the full study: ${head}, and it holds with any one fault and each set-up's most expensive run left out.`];
    if (!cheaperThan(three.otherFour, one.otherFour)) {
      lines.push(
        `This holds only because of the three decision faults: on the other four, set-up 3 is not cheaper than set-up 1 (${fmt(three.otherFour.tokensPerSolved)} against ${fmt(one.otherFour.tokensPerSolved)} tokens per solved task), so the full study must use programs whose faults lie mostly outside decisions.`,
      );
    }
    return lines.join(' ');
  }
  return `Stop and look: ${head}; ${solvesEnough ? 'it is not at least 25% cheaper per solved task' : 'it solved fewer'}. Read the transcripts and say why before building anything else.`;
}

/** The transcripts RULE.md's void rule says a reviewer must read. @param {any[]} runs */
export function transcriptsToRead(runs) {
  return runs
    .filter((r) => r.setup === 3 && r.solved && (r.faultClass === 'inside-step' || r.inDecision))
    .map((r) => r.transcript)
    .sort();
}

/**
 * Whether the batch may carry a decision (RULE.md 1.3): every planned run
 * present, at most `MAX_UNFINISHED` of them unfinished, and not a smoke batch.
 * @param {any[]} allRuns every row, unfinished ones included
 * @param {{ plan?: { setup: number, fault: string, repeat: number }[], smoke?: boolean }} options
 * @returns {string | undefined} why there is no decision, or undefined
 */
export function noDecisionReason(allRuns, options) {
  if (options.smoke) return 'a smoke batch is not part of the result and decides nothing (RULE.md 1.2).';
  if (!options.plan) return 'there is no plan (order.json) to check the batch against.';
  const have = new Set(allRuns.map((r) => `${r.setup}/${r.fault}/${r.repeat}`));
  const missing = options.plan.filter((p) => !have.has(`${p.setup}/${p.fault}/${p.repeat}`));
  if (missing.length > 0) return `${missing.length} of the ${options.plan.length} planned runs are missing, so the batch is incomplete.`;
  const unfinished = allRuns.filter((r) => UNFINISHED.has(r.stopReason)).length;
  if (unfinished > MAX_UNFINISHED) return `${unfinished} runs ended as error or interrupted, more than ${MAX_UNFINISHED}; a new batch in a new folder runs them all again (RULE.md 1.3).`;
  return undefined;
}

/**
 * @param {any[]} allRuns every row of runs.jsonl
 * @param {{ title?: string, plan?: { setup: number, fault: string, repeat: number }[], smoke?: boolean }} [options]
 */
export function renderReport(allRuns, options = {}) {
  // Runs the harness could not finish say nothing about a set-up: kept, counted in the spend, left out of every number.
  const runs = allRuns.filter((r) => !UNFINISHED.has(r.stopReason));
  const unfinished = allRuns.filter((r) => UNFINISHED.has(r.stopReason));
  const setups = [...new Set(runs.map((r) => r.setup))].sort();
  /** @type {Record<number, ReturnType<typeof groups>>} */
  const bySetup = {};
  for (const s of setups) bySetup[s] = groups(runs.filter((r) => r.setup === s));
  const models = [...new Set(allRuns.map((r) => r.model).filter(Boolean))].join(', ');
  const spend = allRuns.reduce((s, r) => s + costOf({ input_tokens: r.inputTokens, output_tokens: r.outputTokens }), 0);
  const toRead = transcriptsToRead(runs);
  const rows = sensitivity(runs);
  const withheld = noDecisionReason(allRuns, options);
  const lines = [
    `# ${options.title ?? 'agent-debug report'}`,
    '',
    `Generated by \`harness/report.mjs\` from \`runs.jsonl\` (RULE.md version 1.3): ${allRuns.length} runs (${unfinished.length} unfinished, left out of every number below), model ${models}, spend estimate ${spend.toFixed(4)} dollars at RULE.md's prices, unfinished runs included. No number here is typed by hand.`,
    '',
    ...(models === 'scripted'
      ? ['The model here is a script that KNOWS each fault and counts tokens as characters / 4. These numbers test the harness, not the claim: the decision below is read off them mechanically and means nothing.', '']
      : []),
    '## The decision (RULE.md)',
    '',
    withheld ? `No decision: ${withheld}` : decision(bySetup, rows),
    '',
    unfinished.length
      ? `Runs the harness could not finish (kept, counted in the spend, left out of every number): ${unfinished.map((r) => `\`${r.transcript}\` (${r.stopReason})`).join(', ')}.`
      : 'Runs the harness could not finish: none.',
    '',
    '### Does the result hang on one fault or one run?',
    '',
    'RULE.md 1.3: on the data-flow faults, set-up 3 must still solve at least as many runs as set-up 1 and be cheaper per solved task in every row.',
    '',
    '| Left out | Set-up 1 solved | Set-up 1 tokens per solved task | Set-up 3 solved | Set-up 3 tokens per solved task | Holds |',
    '|---|---|---|---|---|---|',
    ...rows.map((r) => `| ${r.label} | ${r.one.solved} of ${r.one.runs} | ${fmt(r.one.tokensPerSolved)} | ${r.three.solved} of ${r.three.runs} | ${fmt(r.three.tokensPerSolved)} | ${r.holds ? 'yes' : 'no'} |`),
    '',
    'Whether the batch is void is a reviewer\'s finding, not this script\'s: RULE.md says a reviewer reads every solved set-up 3 transcript of the three controls and of the three decision faults, looking for a tool answer that hands over the answer.',
    '',
    toRead.length ? `Transcripts to read (${toRead.length}):` : 'Transcripts to read: none (no such run was solved).',
    ...toRead.map((t) => `- \`${t}\``),
    '',
    '## Tokens per solved task, and the context at the end of a run',
    '',
    'Tokens per solved task: all input and output tokens of all runs of a set-up, solved or not, divided by its solved runs. Context at the end: the last request\'s input tokens plus its output tokens, averaged over the runs; it decides nothing (RULE.md, "What is counted").',
    '',
    '| Set-up | Faults | Runs | Solved | Tokens | Tokens per solved task | Mean context at the end | Mean requests | Named the faulty step | Edited the faulty file |',
    '|---|---|---|---|---|---|---|---|---|---|',
  ];
  for (const s of setups) {
    for (const [label, sum] of [
      ['7 data-flow', bySetup[s].dataFlow],
      ['3 decision (of the 7)', bySetup[s].decision],
      ['4 other data-flow (of the 7)', bySetup[s].otherFour],
      ['3 controls', bySetup[s].controls],
    ]) {
      lines.push(`| ${s} | ${label} | ${sum.runs} | ${sum.solved} | ${fmt(sum.tokens)} | ${fmt(sum.tokensPerSolved)} | ${fmtMean(sum.meanFinalContext)} | ${sum.meanRequests === null ? '-' : sum.meanRequests.toFixed(1)} | ${sum.namedStep} | ${sum.editedFaultyFile} |`);
    }
  }
  lines.push('', '## Every fault by itself', '', '| Fault | Class | Set-up | Solved of runs | Tokens per solved task | Mean requests |', '|---|---|---|---|---|---|');
  const faults = [...new Map(runs.map((r) => [r.fault, r])).values()].sort(
    (a, b) => a.faultClass.localeCompare(b.faultClass) || Number(b.inDecision) - Number(a.inDecision) || a.fault.localeCompare(b.fault),
  );
  for (const f of faults) {
    const cls = f.faultClass === 'inside-step' ? 'control' : f.inDecision ? 'data-flow, decision' : 'data-flow';
    for (const s of setups) {
      const sum = summarize(runs.filter((r) => r.fault === f.fault && r.setup === s));
      lines.push(`| ${f.fault} | ${cls} | ${s} | ${sum.solved} of ${sum.runs} | ${fmt(sum.tokensPerSolved)} | ${sum.meanRequests === null ? '-' : sum.meanRequests.toFixed(1)} |`);
    }
  }
  lines.push('', '## By distance (data-flow faults)', '', '| Set-up | Distance | Runs | Solved | Tokens per solved task |', '|---|---|---|---|---|');
  for (const s of setups) {
    for (const b of ['0 to 1', '2 to 4', '5 or more']) {
      const sum = summarize(runs.filter((r) => r.setup === s && r.faultClass === 'data-flow' && band(r.distance) === b));
      lines.push(`| ${s} | ${b} | ${sum.runs} | ${sum.solved} | ${fmt(sum.tokensPerSolved)} |`);
    }
  }
  lines.push('', '## Stop reasons', '', '| Set-up | Stop reason | Runs |', '|---|---|---|');
  for (const s of setups) {
    const counts = {};
    for (const r of runs.filter((x) => x.setup === s)) counts[r.stopReason] = (counts[r.stopReason] ?? 0) + 1;
    for (const [reason, n] of Object.entries(counts).sort()) lines.push(`| ${s} | ${reason} | ${n} |`);
  }
  if (bySetup[2] && bySetup[1]) {
    const two = bySetup[2].dataFlow;
    const one = bySetup[1].dataFlow;
    lines.push('', '## Set-up 2 against set-up 1 (decides nothing)', '', `On the data-flow faults set-up 2 solved ${two.solved} runs at ${fmt(two.tokensPerSolved)} tokens per solved task, set-up 1 ${one.solved} at ${fmt(one.tokensPerSolved)}.`);
  }
  return `${lines.join('\n')}\n`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const folder = process.argv[2];
  if (!folder) {
    console.error('usage: node harness/report.mjs <folder holding runs.jsonl> [title]');
    process.exit(2);
  }
  const title = process.argv[3];
  const order = JSON.parse(readFileSync(join(folder, 'order.json'), 'utf8'));
  writeFileSync(
    join(folder, 'report.md'),
    renderReport(readRuns(join(folder, 'runs.jsonl')), { ...(title ? { title } : {}), plan: order.plan, smoke: order.label === 'smoke' }),
  );
  console.log(readFileSync(join(folder, 'report.md'), 'utf8'));
}
