/**
 * A batch: runs (set-up × task × repeat) in a fixed, shuffled order that
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
 * A task is a fault (part 1) or a question (part 2, RULE-2.md). Everything a
 * plan needs is checked BEFORE the folder is touched (`checkReady`): every
 * set-up's program exists (set-up P is refused by name until the twin is
 * built), matches its manifest, every fault has its edit in every program the
 * plan runs, and every question has its expected answer. A plan that cannot
 * finish fails at the start, never half-way.
 * Example: `await runBatch({ out, setups: [1, 2, 3], faults, repeats: 3, modelFor })`.
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { editFor } from '../faults/apply.mjs';
import { runAgent } from './agent.mjs';
import { spendOf, spendStopReached } from './budget.mjs';
import { verifyProgram } from './manifest.mjs';
import { programFor } from './programs.mjs';
import { Refusal } from './refusal.mjs';
import { faultRow, questionRow, unfinishedRow } from './rows.mjs';
import { BENCH_DIR } from './runtime.mjs';
import { scoreRun, changedFiles } from './score.mjs';
import { expectedAnswers, scoreQuestion } from './score-question.mjs';
import { alive, sweepStale } from './temp.mjs';
import { createWorkdir, manifestOf, removeWorkdir } from './workdir.mjs';

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

/**
 * The versions of the two libraries actually installed (read from their own
 * package.json in node_modules, not from the range in this package's
 * manifest), recorded in order.json (RULE.md 1.5).
 */
export function installedVersions() {
  const read = (/** @type {string} */ name) => {
    try {
      return JSON.parse(readFileSync(join(BENCH_DIR, 'node_modules', name, 'package.json'), 'utf8')).version;
    } catch {
      return null;
    }
  };
  return { footprintjs: read('footprintjs'), foottrace: read('foottrace') };
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

/**
 * Every (set-up, task, repeat), shuffled with `seed` (Fisher–Yates). Part 1's
 * plans name the task `fault`; part 2's, which mix questions and faults,
 * name it `task` (`field`). The shuffle is the same either way.
 */
export function runOrder(setups, taskIds, repeats, seed, field = 'fault') {
  const plan = [];
  for (const setup of setups) for (const id of taskIds) for (let repeat = 1; repeat <= repeats; repeat++) plan.push({ setup, [field]: id, repeat });
  const random = seeded(seed);
  for (let i = plan.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [plan[i], plan[j]] = [plan[j], plan[i]];
  }
  return plan;
}

/** The key of a plan item or a row: set-up, task, repeat. */
export const keyOf = (/** @type {any} */ r) => `${r.setup}/${r.task ?? r.fault}/${r.repeat}`;

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
 * Creates a run's transcript file and returns its name, relative to the
 * batch folder. The file is created with the `wx` flag, so an existing
 * transcript is never opened for writing by a second run: on EEXIST the next
 * name is tried.
 */
function createTranscript(out, item) {
  const base = `transcripts/setup${item.setup}-${item.task ?? item.fault}-r${item.repeat}`;
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
 * @param {string} out @param {any} started a line of started.jsonl @param {any} task the fault or question, when loaded
 */
export function interruptedRow(out, started, task) {
  const file = join(out, started.transcript);
  const events = existsSync(file)
    ? readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap((line) => {
        try {
          return [JSON.parse(line)];
        } catch {
          return []; // a line cut by the stop
        }
      })
    : null; // no transcript: the run's tokens cannot be known at all
  return unfinishedRow(started, task, events);
}

/**
 * Everything a plan needs, checked before anything is written (see the
 * file's head). Returns the program of each set-up.
 * @param {('P'|1|2|3)[]} setups @param {any[]} faults @param {any[]} questions
 * @returns {Map<'P'|1|2|3, import('./programs.mjs').Program>}
 */
export function checkReady(setups, faults, questions) {
  const programs = new Map(setups.map((setup) => [setup, programFor(setup)]));
  for (const program of new Set(programs.values())) {
    verifyProgram(program.dir, program.unlistedAllowed);
    for (const fault of faults) {
      try {
        editFor(fault, program.id);
      } catch (error) {
        throw new Refusal(`${error instanceof Error ? error.message : error}, so ${program.name} cannot run it.`);
      }
    }
  }
  if (questions.length > 0) {
    const answers = expectedAnswers();
    const missing = questions.filter((q) => !Object.hasOwn(answers, q.id)).map((q) => q.id);
    if (missing.length) throw new Refusal(`hidden/answers.json has no answer for ${missing.join(', ')}; run node questions/generate.mjs.`);
  }
  return programs;
}

/** The flags a batch folder is bound to; `questions` is absent from part 1's order.json and reads as none. */
const FLAG_DEFAULTS = Object.freeze({ questions: [] });

/**
 * @param {{ out: string, setups: ('P'|1|2|3)[], faults?: any[], questions?: any[], repeats: number, seed?: number,
 *   modelFor: (setup: 'P'|1|2|3, task: any) => Promise<import('./model.mjs').ModelPort>,
 *   label?: 'batch' | 'smoke', system?: string, say?: (line: string) => void }} options
 *   `system`: the system text of every run (part 2: prompt.mjs · SYSTEM_PROMPT_2; default part 1's).
 */
export async function runBatch({ out, setups, faults = [], questions = [], repeats, seed = 20261112, label = 'batch', modelFor, system, say = () => {} }) {
  // Nothing is written, swept or locked until the whole plan is known to be runnable.
  const programs = checkReady(setups, faults, questions);
  // Folders left by a harness that was killed (SIGKILL cannot be caught) go first.
  for (const dir of sweepStale()) say(`removed the folder of a stopped harness: ${dir}`);
  mkdirSync(join(out, 'transcripts'), { recursive: true });
  const release = lockBatch(out, say);
  try {
    return await runLocked({ out, setups, faults, questions, programs, repeats, seed, label, modelFor, system, say });
  } finally {
    release();
  }
}

/** The batch itself, run while this process holds the folder's lock. */
async function runLocked({ out, setups, faults, questions, programs, repeats, seed, label, modelFor, system, say }) {
  const orderFile = join(out, 'order.json');
  const flags = { label, seed, setups, faults: faults.map((f) => f.id), ...(questions.length ? { questions: questions.map((q) => q.id) } : {}), repeats };
  const tasks = new Map([...questions, ...faults].map((t) => [t.id, t]));
  let plan;
  if (existsSync(orderFile)) {
    const order = JSON.parse(readFileSync(orderFile, 'utf8'));
    // A folder belongs to one batch: other flags are refused, never silently ignored.
    const names = ['label', 'seed', 'setups', 'faults', 'questions', 'repeats'];
    const value = (/** @type {any} */ from, /** @type {string} */ k) => JSON.stringify(from[k] ?? FLAG_DEFAULTS[k]);
    const differ = names.filter((k) => value(order, k) !== value(flags, k));
    if (differ.length > 0) {
      throw new Refusal(`the folder ${out} holds a batch started with other flags (${differ.map((k) => `${k}: ${JSON.stringify(order[k])}`).join(', ')}); start it again with the same flags, or use a new folder.`);
    }
    plan = order.plan;
  } else {
    plan = questions.length ? runOrder(setups, [...tasks.keys()], repeats, seed, 'task') : runOrder(setups, flags.faults, repeats, seed);
    writeFileSync(orderFile, `${JSON.stringify({ ...flags, code: codeState(), versions: installedVersions(), plan }, null, 2)}\n`);
  }
  const runsFile = join(out, 'runs.jsonl');
  const startedFile = join(out, 'started.jsonl');
  // A run that started and never finished is recorded as interrupted, once, and never run again.
  const finished = new Set(readRuns(runsFile).map(keyOf));
  for (const started of readRuns(startedFile)) {
    if (finished.has(keyOf(started))) continue;
    const row = interruptedRow(out, started, tasks.get(started.task ?? started.fault));
    appendFileSync(runsFile, `${JSON.stringify(row)}\n`);
    finished.add(keyOf(started));
    say(`set-up ${row.setup} ${started.task ?? started.fault} r${row.repeat}: interrupted earlier, kept with ${row.inputTokens + row.outputTokens} tokens, not run again`);
  }
  let answers;
  for (const item of plan) {
    if (finished.has(keyOf(item))) continue;
    const spent = spendOf(readRuns(runsFile));
    if (spendStopReached(spent)) {
      say(`spend stop: the estimate has reached ${spent.toFixed(2)} dollars; no further run starts`);
      return { stoppedBySpend: true };
    }
    const id = item.task ?? item.fault;
    const task = tasks.get(id);
    if (!task) throw new Error(`the plan names task ${id}, which is not loaded`);
    const question = task.type === 'question';
    const program = /** @type {import('./programs.mjs').Program} */ (programs.get(item.setup));
    const work = await createWorkdir(question ? null : task, { program });
    try {
      const model = await modelFor(item.setup, task);
      const transcript = createTranscript(out, item);
      // The started line comes before the first request: a stop after it leaves a run the next start finds.
      const startedLine = { setup: item.setup, ...(item.task !== undefined ? { task: id } : { fault: id }), taskType: question ? 'question' : 'fault', repeat: item.repeat, model: model.name, transcript, at: Date.now() };
      appendFileSync(startedFile, `${JSON.stringify(startedLine)}\n`);
      const log = (/** @type {object} */ event) => appendFileSync(join(out, transcript), `${JSON.stringify({ at: Date.now(), ...event })}\n`);
      const counts = await runAgent({ model, setup: item.setup, task, workdir: work.dir, program, ...(system ? { system } : {}), log });
      let row;
      if (question) {
        answers ??= expectedAnswers();
        const score = scoreQuestion(task, counts.answer, answers);
        const editedFiles = changedFiles(work.manifest, manifestOf(work.dir));
        log({ type: 'score', ...score, answered: counts.answered, answer: counts.answer ?? null, editedFiles });
        row = questionRow({ item, task, program, model, counts, score, editedFiles, transcript });
      } else {
        const score = await scoreRun(work.dir, work.manifest, task, program);
        log({ type: 'score', ...score });
        row = faultRow({ item, task, program, model, counts, score, transcript });
      }
      appendFileSync(runsFile, `${JSON.stringify(row)}\n`);
      finished.add(keyOf(item));
      say(`set-up ${item.setup} ${id} r${item.repeat}: ${row.solved ? (question ? 'right' : 'solved') : question ? 'wrong' : 'unsolved'} (${row.stopReason}), ${row.requests} requests, ${row.inputTokens + row.outputTokens} tokens`);
    } finally {
      removeWorkdir(work.dir);
    }
  }
  return { stoppedBySpend: false };
}
