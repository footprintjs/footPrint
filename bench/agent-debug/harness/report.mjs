/**
 * Reads `runs.jsonl` and writes `report.md`, to RULE.md version 1.4. Every
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
import { smokeChecklist } from './smoke-check.mjs';

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

/** The share of a group's finished runs that were solved (0 when it has none). */
const shareOf = (/** @type {{ solved: number, runs: number }} */ g) => (g.runs > 0 ? g.solved / g.runs : 0);
const pct = (/** @type {number} */ x) => `${Math.round(x * 100)}%`;
/** "x of y (z%)". */
const shareText = (/** @type {{ solved: number, runs: number }} */ g) => `${g.solved} of ${g.runs} (${pct(shareOf(g))})`;

/** RULE.md 1.4: the headline needs this much less, a left-out row this much. */
export const HEADLINE_MARGIN = 0.25;
export const ROW_MARGIN = 0.15;

/** Whether `a` uses at least `margin` fewer tokens per solved task than `b` (none solved is never cheaper). */
function cheaperBy(a, b, margin) {
  if (a.tokensPerSolved === null) return false;
  return b.tokensPerSolved === null || a.tokensPerSolved <= (1 - margin) * b.tokensPerSolved;
}

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
 * RULE.md 1.4's sensitivity rule: with any one data-flow fault left out, and
 * with each set-up's single most expensive data-flow run left out, set-up 3
 * must still solve at least as large a share of its finished runs as set-up 1
 * and use at least 15% fewer tokens per solved task. One row per case.
 * @param {any[]} runs finished runs only
 */
export function sensitivity(runs) {
  const dataFlow = runs.filter((r) => r.faultClass === 'data-flow');
  const row = (/** @type {string} */ label, /** @type {any[]} */ kept) => {
    const one = summarize(kept.filter((r) => r.setup === 1));
    const three = summarize(kept.filter((r) => r.setup === 3));
    return { label, one, three, holds: shareOf(three) >= shareOf(one) && cheaperBy(three, one, ROW_MARGIN) };
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
  if (!Array.isArray(rows) || rows.length === 0) return 'No decision: the sensitivity table (RULE.md 1.4) was not given.';
  const one = bySetup[1];
  const three = bySetup[3];
  if (!one || !three) return 'No decision: the batch does not hold both set-up 1 and set-up 3.';
  // RULE.md 1.4: shares of finished runs, not counts (unfinished runs are left out).
  const solvesEnough = shareOf(three.dataFlow) >= shareOf(one.dataFlow);
  const cheaper = cheaperBy(three.dataFlow, one.dataFlow, HEADLINE_MARGIN);
  let ratio = '';
  if (three.dataFlow.tokensPerSolved !== null && one.dataFlow.tokensPerSolved !== null) {
    // One decimal: a margin stands next to its threshold (24.6% must not read as 25%).
    const change = (1 - three.dataFlow.tokensPerSolved / one.dataFlow.tokensPerSolved) * 100;
    ratio = change >= 0 ? ` (${change.toFixed(1)}% fewer tokens per solved task)` : ` (${(-change).toFixed(1)}% more tokens per solved task)`;
  }
  const head = `on the seven data-flow faults set-up 3 solved ${shareText(three.dataFlow)} of its finished runs against set-up 1's ${shareText(one.dataFlow)}${ratio}`;
  const failing = rows.filter((r) => !r.holds);
  if (solvesEnough && cheaper && failing.length > 0) {
    const named = failing
      .map((r) => `with ${r.label}, set-up 3 solves ${shareText(r.three)} against ${shareText(r.one)} at ${fmt(r.three.tokensPerSolved)} against ${fmt(r.one.tokensPerSolved)} tokens per solved task`)
      .join('; ');
    return `Stop and look: ${head}, but the result hangs on one fault or one run: ${named}. Read the transcripts and say why before building anything else.`;
  }
  if (solvesEnough && cheaper) {
    const lines = [`Go on to the full study: ${head}, and with any one fault and each set-up's most expensive run left out set-up 3 still solves as large a share and uses at least 15% fewer tokens per solved task.`];
    if (!cheaperThan(three.otherFour, one.otherFour)) {
      lines.push(
        `This holds only because of the three decision faults: on the other four, set-up 3 is not cheaper than set-up 1 (${fmt(three.otherFour.tokensPerSolved)} against ${fmt(one.otherFour.tokensPerSolved)} tokens per solved task), so the full study must use programs whose faults lie mostly outside decisions.`,
      );
    }
    return lines.join(' ');
  }
  return `Stop and look: ${head}; ${solvesEnough ? 'it is not at least 25% cheaper per solved task' : 'it solved a smaller share'}. Read the transcripts and say why before building anything else.`;
}

/** The transcripts RULE.md's void rule says a reviewer must read. @param {any[]} runs */
export function transcriptsToRead(runs) {
  return runs
    .filter((r) => r.setup === 3 && r.solved && (r.faultClass === 'inside-step' || r.inDecision))
    .map((r) => r.transcript)
    .sort();
}

/**
 * Whether the batch may carry a decision (RULE.md 1.4): the rows exactly the
 * planned runs (none missing, none twice, none unplanned), at most
 * `MAX_UNFINISHED` of them unfinished, and not a smoke batch.
 * @param {any[]} allRuns every row, unfinished ones included
 * @param {{ plan?: { setup: number, fault: string, repeat: number }[], smoke?: boolean }} options
 * @returns {string | undefined} why there is no decision, or undefined
 */
export function noDecisionReason(allRuns, options) {
  if (options.smoke) return 'a smoke batch is not part of the result and decides nothing (RULE.md 1.2).';
  if (!options.plan) return 'there is no plan (order.json) to check the batch against.';
  // RULE.md 1.4: the rows must be EXACTLY the plan: each planned run once, nothing else.
  const key = (/** @type {any} */ r) => `${r.setup}/${r.fault}/${r.repeat}`;
  const planned = new Set(options.plan.map(key));
  const seen = new Map();
  for (const r of allRuns) seen.set(key(r), (seen.get(key(r)) ?? 0) + 1);
  const missing = [...planned].filter((k) => !seen.has(k));
  const twice = [...seen].filter(([k, n]) => planned.has(k) && n > 1).map(([k]) => k);
  const unplanned = [...seen.keys()].filter((k) => !planned.has(k));
  if (missing.length > 0) return `${missing.length} of the ${options.plan.length} planned runs are missing, so the batch is incomplete.`;
  if (twice.length > 0) return `${twice.length} planned runs appear more than once (${twice.slice(0, 3).join(', ')}${twice.length > 3 ? ', …' : ''}), so the rows are not exactly the plan.`;
  if (unplanned.length > 0) return `${unplanned.length} rows are not in the plan (${unplanned.slice(0, 3).join(', ')}${unplanned.length > 3 ? ', …' : ''}), so the rows are not exactly the plan.`;
  const unfinished = allRuns.filter((r) => UNFINISHED.has(r.stopReason)).length;
  if (unfinished > MAX_UNFINISHED) return `${unfinished} runs ended as error or interrupted, more than ${MAX_UNFINISHED}; a new batch in a new folder runs them all again (RULE.md 1.4).`;
  return undefined;
}

/**
 * @param {any[]} allRuns every row of runs.jsonl
 * @param {{ title?: string, plan?: { setup: number, fault: string, repeat: number }[], smoke?: boolean, code?: { commit: string | null, uncommittedChanges: boolean | null }, checklist?: string[] }} [options]
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
    `Generated by \`harness/report.mjs\` from \`runs.jsonl\` (RULE.md version 1.4): ${allRuns.length} runs (${unfinished.length} unfinished, left out of every number below), model ${models}, spend estimate at least ${spend.toFixed(4)} dollars at RULE.md's prices, unfinished runs included (at least: a request in flight when the harness stopped is not counted). No number here is typed by hand.`,
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
    ...(options.smoke
      ? []
      : [
          '### Does the result hang on one fault or one run?',
          '',
          'RULE.md 1.4: on the data-flow faults, in every row set-up 3 must still solve at least as large a share of its finished runs as set-up 1 and use at least 15% fewer tokens per solved task.',
          '',
          '| Left out | Set-up 1 solved | Set-up 1 tokens per solved task | Set-up 3 solved | Set-up 3 tokens per solved task | Set-up 3 fewer tokens | Holds |',
          '|---|---|---|---|---|---|---|',
          ...rows.map((r) => {
            const fewer = r.one.tokensPerSolved !== null && r.three.tokensPerSolved !== null ? `${((1 - r.three.tokensPerSolved / r.one.tokensPerSolved) * 100).toFixed(1)}%` : '-';
            return `| ${r.label} | ${shareText(r.one)} | ${fmt(r.one.tokensPerSolved)} | ${shareText(r.three)} | ${fmt(r.three.tokensPerSolved)} | ${fewer} | ${r.holds ? 'yes' : 'no'} |`;
          }),
          '',
        ]),
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
  lines.push(
    '',
    '## Notes',
    '',
    '- The spend is a lower bound: a request in flight when the harness stopped has no logged usage and is not counted.',
    '- A request retried after a client timeout may have been paid twice: the server may have finished the first copy, whose usage was never received.',
    ...(options.code ? [`- Code: commit ${options.code.commit ?? 'unknown'}${options.code.uncommittedChanges ? ', with uncommitted changes in bench/agent-debug' : options.code.uncommittedChanges === false ? ', no uncommitted changes' : ''} (order.json).`] : []),
  );
  if (bySetup[2] && bySetup[1]) {
    const two = bySetup[2].dataFlow;
    const one = bySetup[1].dataFlow;
    lines.push('', '## Set-up 2 against set-up 1 (decides nothing)', '', `On the data-flow faults set-up 2 solved ${two.solved} runs at ${fmt(two.tokensPerSolved)} tokens per solved task, set-up 1 ${one.solved} at ${fmt(one.tokensPerSolved)}.`);
  }
  if (options.checklist) {
    lines.push(
      '',
      '## The smoke batch\'s pass (RULE.md 1.5)',
      '',
      'Answered from this folder\'s own files (harness/smoke-check.mjs). A "no" does not change the exit code; it is read before the 90 runs.',
      '',
      ...options.checklist,
    );
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
    renderReport(readRuns(join(folder, 'runs.jsonl')), {
      ...(title ? { title } : {}),
      plan: order.plan,
      smoke: order.label === 'smoke',
      code: order.code,
      ...(order.label === 'smoke' ? { checklist: smokeChecklist(folder) } : {}),
    }),
  );
  console.log(readFileSync(join(folder, 'report.md'), 'utf8'));
}
