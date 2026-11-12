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
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { runAgent } from './agent.mjs';
import { spendOf, spendStopReached } from './budget.mjs';
import { scoreRun } from './score.mjs';
import { verifyProgram } from './manifest.mjs';
import { Refusal } from './refusal.mjs';
import { BENCH_DIR } from './runtime.mjs';
import { alive, sweepStale } from './temp.mjs';
import { createWorkdir, removeWorkdir } from './workdir.mjs';

/**
 * The code a batch runs on, recorded in order.json so that a number can be
 * traced to it: the commit and whether this folder had uncommitted changes
 * (`git status --porcelain -- .`). `null` fields when git cannot answer.
 */
export function codeState() {
  const git = (/** @type {string[]} */ args) => spawnSync('git', args, { cwd: BENCH_DIR, encoding: 'utf8' });
  const head = git(['rev-parse', 'HEAD']);
  const status = git(['status', '--porcelain', '--', '.']);
  return {
    commit: head.status === 0 ? head.stdout.trim() : null,
    uncommittedChanges: status.status === 0 ? status.stdout.trim().length > 0 : null,
  };
}

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
/**
 * Creates a run's transcript file and returns its name, relative to the
 * batch folder. The file is created with the `wx` flag, so an existing
 * transcript is never opened for writing by a second run: on EEXIST the next
 * name is tried.
 */
function createTranscript(out, item) {
  const base = `transcripts/setup${item.setup}-${item.fault}-r${item.repeat}`;
  for (let n = 1; ; n++) {
    const name = n === 1 ? `${base}.jsonl` : `${base}-file${n}.jsonl`;
    try {
      writeFileSync(join(out, name), '', { flag: 'wx' });
      return name;
    } catch (error) {
      if (/** @type {any} */ (error).code !== 'EEXIST') throw error;
    }
  }
}

/**
 * Takes the batch folder's lock, `lock.json` (created with `wx`). A lock held
 * by a live process refuses the start and names that process; a lock whose
 * owner is dead is taken over, and the takeover is logged in `lock.jsonl`.
 * @returns {() => void} releases the lock
 */
export function lockBatch(out, say = () => {}) {
  const file = join(out, 'lock.json');
  const mine = JSON.stringify({ pid: process.pid, started: new Date().toISOString() });
  for (let tries = 0; tries < 3; tries++) {
    try {
      writeFileSync(file, `${mine}\n`, { flag: 'wx' });
      const release = () => {
        try {
          if (JSON.parse(readFileSync(file, 'utf8')).pid === process.pid) unlinkSync(file);
        } catch {
          // already gone
        }
      };
      process.once('exit', release);
      return release;
    } catch (error) {
      if (/** @type {any} */ (error).code !== 'EEXIST') throw error;
    }
    let owner;
    try {
      owner = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      owner = {};
    }
    if (Number.isInteger(owner.pid) && alive(owner.pid)) {
      throw new Refusal(`the batch folder ${out} is locked by process ${owner.pid}, which is still running; two batches never share a folder.`);
    }
    appendFileSync(join(out, 'lock.jsonl'), `${JSON.stringify({ at: new Date().toISOString(), event: 'took over a lock of a dead process', from: owner, by: process.pid })}\n`);
    say(`took over the lock of process ${owner.pid ?? '(unknown)'}, which is no longer running`);
    unlinkSync(file);
  }
  throw new Error(`could not take the lock of ${out}`);
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
 *   label?: 'batch' | 'smoke', say?: (line: string) => void }} options
 */
export async function runBatch({ out, setups, faults, repeats, seed = 20261112, label = 'batch', modelFor, say = () => {} }) {
  // The program must be exactly its committed list before anything runs.
  verifyProgram();
  // Folders left by a harness that was killed (SIGKILL cannot be caught) go first.
  for (const dir of sweepStale()) say(`removed the folder of a stopped harness: ${dir}`);
  mkdirSync(join(out, 'transcripts'), { recursive: true });
  const release = lockBatch(out, say);
  try {
    return await runLocked({ out, setups, faults, repeats, seed, label, modelFor, say });
  } finally {
    release();
  }
}

/** The batch itself, run while this process holds the folder's lock. */
async function runLocked({ out, setups, faults, repeats, seed, label, modelFor, say }) {
  const orderFile = join(out, 'order.json');
  const flags = { label, seed, setups, faults: faults.map((f) => f.id), repeats };
  let plan;
  if (existsSync(orderFile)) {
    const order = JSON.parse(readFileSync(orderFile, 'utf8'));
    // A folder belongs to one batch: other flags are refused, never silently ignored.
    const differ = Object.keys(flags).filter((k) => JSON.stringify(order[k]) !== JSON.stringify(flags[/** @type {keyof typeof flags} */ (k)]));
    if (differ.length > 0) {
      throw new Refusal(`the folder ${out} holds a batch started with other flags (${differ.map((k) => `${k}: ${JSON.stringify(order[k])}`).join(', ')}); start it again with the same flags, or use a new folder.`);
    }
    plan = order.plan;
  } else {
    plan = runOrder(setups, flags.faults, repeats, seed);
    writeFileSync(orderFile, `${JSON.stringify({ ...flags, code: codeState(), plan }, null, 2)}\n`);
  }
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
      const transcript = createTranscript(out, item);
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
