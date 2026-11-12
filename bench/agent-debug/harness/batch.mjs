/**
 * A batch: runs (set-up × fault × repeat) in a fixed, shuffled order that
 * is written to the output folder BEFORE the first run, one line per run
 * appended to `runs.jsonl` and one transcript per run, appended to as it
 * goes and never truncated or overwritten.
 *
 * A stopped run (RULE.md 1.3, "The model and the budget"): before a run's
 * first request a line is appended to `started.jsonl`. A batch started again
 * on the same folder records every run that started and never finished as
 * `interrupted`, with the tokens its transcript holds, and never runs it
 * again; runs already in `runs.jsonl` are skipped. So a stopped batch loses
 * nothing, counts every token in the spend, and reruns nothing.
 * The spend stop (budget.mjs) is checked before every run.
 * Example: `await runBatch({ out, setups: [1, 2, 3], faults, repeats: 3, modelFor })`.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { runAgent } from './agent.mjs';
import { spendOf, spendStopReached } from './budget.mjs';
import { scoreRun } from './score.mjs';
import { sweepStale } from './temp.mjs';
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
  // A line cut by a stop in the middle of a write is skipped: for runs.jsonl
  // its run then counts as interrupted (it has a started line).
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
}

/**
 * @param {{ out: string, setups: number[], faults: import('../faults/apply.mjs').Fault[], repeats: number, seed?: number,
 *   modelFor: (setup: number, fault: import('../faults/apply.mjs').Fault) => Promise<import('./model.mjs').ModelPort>,
 *   say?: (line: string) => void }} options
 */
/** Where a run's transcript lives, relative to the batch folder; never the name of an existing file. */
function transcriptName(out, item) {
  const base = `transcripts/setup${item.setup}-${item.fault}-r${item.repeat}`;
  let name = `${base}.jsonl`;
  for (let n = 2; existsSync(join(out, name)); n++) name = `${base}-file${n}.jsonl`;
  return name;
}

/**
 * The row of a run that started and never finished: its tokens are what its
 * transcript holds (every logged response's usage).
 * @param {string} out @param {any} started a line of started.jsonl @param {import('../faults/apply.mjs').Fault | undefined} fault
 */
export function interruptedRow(out, started, fault) {
  const file = join(out, started.transcript);
  const events = existsSync(file)
    ? readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap((line) => {
        try {
          return [JSON.parse(line)];
        } catch {
          return []; // a line cut by the stop
        }
      })
    : [];
  const responses = events.filter((e) => e.type === 'response');
  const last = responses.at(-1)?.usage ?? {};
  return {
    setup: started.setup, fault: started.fault, faultClass: fault?.class ?? null, inDecision: fault?.inDecision ?? null,
    distance: fault?.distance ?? null, repeat: started.repeat, model: started.model ?? null, solved: false,
    stopReason: 'interrupted', error: 'the harness stopped before the run finished',
    requests: responses.length,
    inputTokens: responses.reduce((sum, e) => sum + (e.usage?.input_tokens ?? 0), 0),
    outputTokens: responses.reduce((sum, e) => sum + (e.usage?.output_tokens ?? 0), 0),
    finalContextTokens: (last.input_tokens ?? 0) + (last.output_tokens ?? 0),
    transcript: started.transcript,
  };
}

/**
 * @param {{ out: string, setups: number[], faults: import('../faults/apply.mjs').Fault[], repeats: number, seed?: number,
 *   modelFor: (setup: number, fault: import('../faults/apply.mjs').Fault) => Promise<import('./model.mjs').ModelPort>,
 *   say?: (line: string) => void }} options
 */
export async function runBatch({ out, setups, faults, repeats, seed = 20261112, modelFor, say = () => {} }) {
  // Folders left by a harness that was killed (SIGKILL cannot be caught) go first.
  for (const dir of sweepStale()) say(`removed the folder of a stopped harness: ${dir}`);
  mkdirSync(join(out, 'transcripts'), { recursive: true });
  const orderFile = join(out, 'order.json');
  const plan = existsSync(orderFile)
    ? JSON.parse(readFileSync(orderFile, 'utf8')).plan
    : runOrder(setups, faults.map((f) => f.id), repeats, seed);
  if (!existsSync(orderFile)) writeFileSync(orderFile, `${JSON.stringify({ seed, setups, faults: faults.map((f) => f.id), repeats, plan }, null, 2)}\n`);
  const runsFile = join(out, 'runs.jsonl');
  const startedFile = join(out, 'started.jsonl');
  const keyOf = (/** @type {any} */ r) => `${r.setup}/${r.fault}/${r.repeat}`;
  // A run that started and never finished is recorded as interrupted, once, and never run again.
  const finished = new Set(readRuns(runsFile).map(keyOf));
  for (const started of readRuns(startedFile)) {
    if (finished.has(keyOf(started))) continue;
    const row = interruptedRow(out, started, faults.find((f) => f.id === started.fault));
    appendFileSync(runsFile, `${JSON.stringify(row)}\n`);
    finished.add(keyOf(started));
    say(`set-up ${row.setup} ${row.fault} r${row.repeat}: interrupted earlier, kept with ${row.inputTokens + row.outputTokens} tokens, not run again`);
  }
  for (const item of plan) {
    if (finished.has(keyOf(item))) continue;
    const spent = spendOf(readRuns(runsFile));
    if (spendStopReached(spent)) {
      say(`spend stop: the estimate has reached ${spent.toFixed(2)} dollars; no further run starts`);
      return { stoppedBySpend: true };
    }
    const fault = faults.find((f) => f.id === item.fault);
    if (!fault) throw new Error(`the plan names fault ${item.fault}, which is not loaded`);
    const work = await createWorkdir(fault);
    try {
      const model = await modelFor(item.setup, fault);
      const transcript = transcriptName(out, item);
      // The started line comes before the first request: a stop after it leaves a run the next start finds.
      appendFileSync(startedFile, `${JSON.stringify({ setup: item.setup, fault: fault.id, repeat: item.repeat, model: model.name, transcript, at: Date.now() })}\n`);
      const log = (/** @type {object} */ event) => appendFileSync(join(out, transcript), `${JSON.stringify({ at: Date.now(), ...event })}\n`);
      const counts = await runAgent({ model, setup: item.setup, fault, workdir: work.dir, log });
      const score = await scoreRun(work.dir, work.manifest, fault, counts.doneSummary ?? undefined);
      log({ type: 'score', ...score });
      const row = {
        setup: item.setup, fault: fault.id, faultClass: fault.class, inDecision: fault.inDecision, distance: fault.distance, repeat: item.repeat,
        model: model.name, solved: counts.stopReason === 'error' ? false : score.solved, stopReason: counts.stopReason, error: counts.error,
        requests: counts.requests, inputTokens: counts.inputTokens, outputTokens: counts.outputTokens, thinkingTokens: counts.thinkingTokens,
        largestRequestTokens: counts.largestRequestTokens, finalContextTokens: counts.finalContextTokens, toolCalls: counts.toolCalls, toolErrors: counts.toolErrors,
        readFileChars: counts.readFileChars, runOrderCalls: counts.toolCalls.run_order ?? 0,
        runTestsCalls: counts.toolCalls.run_tests ?? 0, edits: counts.edits,
        namedFaultyStep: score.namedFaultyStep, editedFaultyFile: score.editedFaultyFile, editedFiles: score.editedFiles,
        changedOutsideSrc: score.changedOutsideSrc, wrongFixtures: score.wrongFixtures, scoringProblem: score.scoringProblem,
        doneSummary: counts.doneSummary, wallMs: counts.wallMs, transcript,
      };
      appendFileSync(runsFile, `${JSON.stringify(row)}\n`);
      finished.add(keyOf(item));
      say(`set-up ${item.setup} ${fault.id} r${item.repeat}: ${row.solved ? 'solved' : 'unsolved'} (${row.stopReason}), ${row.requests} requests, ${row.inputTokens + row.outputTokens} tokens`);
    } finally {
      removeWorkdir(work.dir);
    }
  }
  return { stoppedBySpend: false };
}
