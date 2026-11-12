/**
 * A batch: runs (set-up × fault × repeat) in a fixed, shuffled order that
 * is written to the output folder BEFORE the first run, one line per run
 * appended to `runs.jsonl` and one transcript file per run written as it
 * goes. A batch started again on the same folder skips the runs already in
 * `runs.jsonl`, so a stopped batch loses nothing and nothing is rerun.
 * The spend stop (budget.mjs) is checked before every run.
 * Example: `await runBatch({ out, setups: [1, 2, 3], faults, repeats: 3, modelFor })`.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { runAgent } from './agent.mjs';
import { spendOf, spendStopReached } from './budget.mjs';
import { scoreRun } from './score.mjs';
import { createWorkdir, removeWorkdir } from './workdir.mjs';

/** A small seeded generator (mulberry32), so the order is reproducible from its seed. */
export function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Every (set-up, fault, repeat), shuffled with `seed` (Fisher–Yates). */
export function runOrder(setups, faultIds, repeats, seed) {
  const plan = [];
  for (const setup of setups) for (const fault of faultIds) for (let repeat = 1; repeat <= repeats; repeat++) plan.push({ setup, fault, repeat });
  const random = seeded(seed);
  for (let i = plan.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [plan[i], plan[j]] = [plan[j], plan[i]];
  }
  return plan;
}

/** @param {string} file */
export function readRuns(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

/**
 * @param {{ out: string, setups: number[], faults: import('../faults/apply.mjs').Fault[], repeats: number, seed?: number,
 *   modelFor: (setup: number, fault: import('../faults/apply.mjs').Fault) => Promise<import('./model.mjs').ModelPort>,
 *   say?: (line: string) => void }} options
 */
export async function runBatch({ out, setups, faults, repeats, seed = 20261112, modelFor, say = () => {} }) {
  mkdirSync(join(out, 'transcripts'), { recursive: true });
  const orderFile = join(out, 'order.json');
  const plan = existsSync(orderFile)
    ? JSON.parse(readFileSync(orderFile, 'utf8')).plan
    : runOrder(setups, faults.map((f) => f.id), repeats, seed);
  if (!existsSync(orderFile)) writeFileSync(orderFile, `${JSON.stringify({ seed, setups, faults: faults.map((f) => f.id), repeats, plan }, null, 2)}\n`);
  const runsFile = join(out, 'runs.jsonl');
  const done = new Set(readRuns(runsFile).map((r) => `${r.setup}/${r.fault}/${r.repeat}`));
  for (const item of plan) {
    const key = `${item.setup}/${item.fault}/${item.repeat}`;
    if (done.has(key)) continue;
    const spent = spendOf(readRuns(runsFile));
    if (spendStopReached(spent)) {
      say(`spend stop: the estimate has reached ${spent.toFixed(2)} dollars; no further run starts`);
      return { stoppedBySpend: true };
    }
    const fault = faults.find((f) => f.id === item.fault);
    if (!fault) throw new Error(`the plan names fault ${item.fault}, which is not loaded`);
    const transcript = join(out, 'transcripts', `setup${item.setup}-${item.fault}-r${item.repeat}.jsonl`);
    writeFileSync(transcript, '');
    const log = (/** @type {object} */ event) => appendFileSync(transcript, `${JSON.stringify({ at: Date.now(), ...event })}\n`);
    const work = await createWorkdir(fault);
    try {
      const model = await modelFor(item.setup, fault);
      const counts = await runAgent({ model, setup: item.setup, fault, workdir: work.dir, log });
      const score = await scoreRun(work.dir, work.manifest, fault, counts.doneSummary ?? undefined);
      log({ type: 'score', ...score });
      const row = {
        setup: item.setup, fault: fault.id, faultClass: fault.class, distance: fault.distance, repeat: item.repeat,
        model: model.name, solved: score.solved, stopReason: counts.stopReason, error: counts.error,
        requests: counts.requests, inputTokens: counts.inputTokens, outputTokens: counts.outputTokens,
        largestRequestTokens: counts.largestRequestTokens, toolCalls: counts.toolCalls, toolErrors: counts.toolErrors,
        readFileChars: counts.readFileChars, runOrderCalls: counts.toolCalls.run_order ?? 0,
        runTestsCalls: counts.toolCalls.run_tests ?? 0, edits: counts.edits,
        namedFaultyStep: score.namedFaultyStep, editedFaultyFile: score.editedFaultyFile, editedFiles: score.editedFiles,
        changedOutsideSrc: score.changedOutsideSrc, wrongFixtures: score.wrongFixtures, scoringProblem: score.scoringProblem,
        doneSummary: counts.doneSummary, wallMs: counts.wallMs,
        transcript: `transcripts/setup${item.setup}-${fault.id}-r${item.repeat}.jsonl`,
      };
      appendFileSync(runsFile, `${JSON.stringify(row)}\n`);
      say(`set-up ${item.setup} ${fault.id} r${item.repeat}: ${row.solved ? 'solved' : 'unsolved'} (${row.stopReason}), ${row.requests} requests, ${row.inputTokens + row.outputTokens} tokens`);
    } finally {
      removeWorkdir(work.dir);
    }
  }
  return { stoppedBySpend: false };
}
