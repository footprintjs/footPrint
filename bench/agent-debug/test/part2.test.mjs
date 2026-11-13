/**
 * Part 2's harness (RULE-2.md), with the scripted model only:
 * - the program table: set-up P is refused by name until twin/src exists,
 *   and every plan that includes it fails at the start, writing nothing;
 * - a stand-in twin (a copy of the flowchart program given P's table entry)
 *   plugs in by data: working copy, run_order, run_tests, scoring, and the
 *   record tools refused; files outside its manifest never reach a copy;
 * - the question task: `answer` in place of `done`, one answer only, the
 *   reminder, the scoring, new and re-sent tokens;
 * - a batch of questions and faults, and the part 2 report's decision.
 */
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

import { editFor, loadFault } from '../faults/apply.mjs';
import { runAgent } from '../harness/agent.mjs';
import { readRuns, runBatch } from '../harness/batch.mjs';
import { MAX_UNFINISHED } from '../harness/compare2.mjs';
import { currentManifest, readManifest, verifyProgram } from '../harness/manifest.mjs';
import { scriptedModel } from '../harness/model.mjs';
import { PART2 } from '../harness/plan2.mjs';
import { PROGRAMS, TWIN_MISSING, programFor, programIdOf } from '../harness/programs.mjs';
import { QUESTION_REMINDER, SYSTEM_PROMPT_2 } from '../harness/prompt.mjs';
import { decision2, renderReport2 } from '../harness/report2.mjs';
import { BENCH_DIR } from '../harness/runtime.mjs';
import { scoreRun } from '../harness/score.mjs';
import { expectedAnswers, scoreQuestion } from '../harness/score-question.mjs';
import { answerer, talker, wrongAnswerer } from '../harness/scripts.mjs';
import { schemaOf } from '../harness/shapes.mjs';
import { newAndResent } from '../harness/tokens.mjs';
import { createWorkdir, listFiles, removeWorkdir } from '../harness/workdir.mjs';
import { loadQuestions } from '../questions/index.mjs';
import { SETUPS, callTool, toolsFor } from '../tools/index.mjs';

const QUESTIONS = loadQuestions();
const ANSWERS = expectedAnswers();
const q = (id) => /** @type {any} */ (QUESTIONS.find((x) => x.id === id));
const twinBuilt = existsSync(join(PROGRAMS.P.dir, 'src'));

test('one table says which program each set-up runs, and both use the paths the tool descriptions name', () => {
  assert.equal(programIdOf('P'), 'P');
  for (const s of [1, 2, 3]) assert.equal(programIdOf(s), 'F');
  assert.throws(() => programIdOf(4), /no set-up 4/);
  const runOrder = SETUPS[1].find((t) => t.definition.name === 'run_order');
  const runTests = SETUPS[1].find((t) => t.definition.name === 'run_tests');
  for (const program of Object.values(PROGRAMS)) {
    assert.ok(runOrder?.definition.description.includes(`node ${program.runScript} fixtures/<fixture>.json`), program.id);
    assert.ok(runTests?.definition.description.includes(program.testFile), program.id);
  }
  assert.equal(PROGRAMS.F.hasRecord, true);
  assert.equal(PROGRAMS.P.hasRecord, false);
});

test('set-up P is refused by name while the twin is not built', { skip: twinBuilt && 'the twin is built' }, () => {
  assert.throws(() => programFor('P'), new RegExp(TWIN_MISSING.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')));
  assert.equal(programFor(1), PROGRAMS.F);
});

test('a plan that includes set-up P fails at the start and writes nothing', { skip: twinBuilt && 'the twin is built' }, async () => {
  const out = join(mkdtempSync(join(tmpdir(), 'agent-debug-p2-')), 'batch');
  try {
    await assert.rejects(
      runBatch({ out, setups: [1, 'P'], faults: [], questions: [q('run-tax-rate')], repeats: 1, modelFor: async () => assert.fail('no run starts') }),
      /the twin is not built yet/,
    );
    assert.equal(existsSync(out), false, 'the batch folder was never made');
  } finally {
    rmSync(dirname(out), { recursive: true, force: true });
  }
});

test('the record tools can never be handed to set-up P', () => {
  const names = (s) => toolsFor(s).map((t) => t.definition.name);
  assert.deepEqual(names('P'), names(1));
  for (const s of ['P', 1]) for (const name of ['map', 'step', 'why', 'story']) assert.ok(!names(s).includes(name), `${s} ${name}`);
  assert.ok(SETUPS[3].filter((t) => t.NEEDS_RECORD).length === 4);
});

/** A stand-in twin: the flowchart program's listed files under P's table entry, with files beside it that are not the program. */
function standInTwin() {
  const dir = mkdtempSync(join(tmpdir(), 'agent-debug-twin-'));
  for (const rel of Object.keys(readManifest())) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    cpSync(join(PROGRAMS.F.dir, rel), join(dir, rel));
  }
  writeFileSync(join(dir, 'MANIFEST.json'), JSON.stringify(currentManifest(dir, true)));
  writeFileSync(join(dir, 'SPEC.md'), 'the twin\'s specification: 445.48\n');
  mkdirSync(join(dir, 'test', 'unit'), { recursive: true });
  writeFileSync(join(dir, 'test', 'unit', 'rules.test.mjs'), '// pins every rule\n');
  writeFileSync(join(dir, 'expected-results.json'), '{}\n');
  return Object.freeze({ ...PROGRAMS.P, dir });
}

test('a twin plugs in by data: its manifest, its copy, run_order, run_tests and scoring, and no record tool', async () => {
  const twin = standInTwin();
  const fault = { ...loadFault('wrong-key-read') };
  fault.twin = editFor(fault, 'F'); // the stand-in twin is a copy, so its planted fault is the same edit
  try {
    assert.equal(verifyProgram(twin.dir, true).length, Object.keys(readManifest()).length, 'files beside the manifest are allowed for the twin');
    assert.throws(() => verifyProgram(twin.dir, false), /not in the manifest: SPEC\.md/, 'and never for the flowchart program');
    const work = await createWorkdir(fault, { program: twin });
    try {
      const files = listFiles(work.dir);
      for (const never of ['SPEC.md', 'test/unit/rules.test.mjs', 'expected-results.json']) assert.ok(!files.includes(never), never);
      const context = { workdir: work.dir, program: twin };
      assert.match((await callTool(toolsFor('P'), 'run_order', { fixture: 'small-pickup' }, context)).content, /"grandTotal": 6\.36/);
      assert.match((await callTool(toolsFor('P'), 'run_tests', {}, context)).content, /8 passed, 0 failed/);
      const why = await callTool(SETUPS[3], 'why', { fixture: 'small-pickup', key: 'status' }, context);
      assert.equal(why.is_error, true);
      assert.match(why.content, /the ordinary twin has no chart and no run record/);
      const unsolved = await scoreRun(work.dir, work.manifest, fault, twin);
      assert.equal(unsolved.solved, false);
      const file = join(work.dir, fault.twin.file);
      writeFileSync(file, readFileSync(file, 'utf8').replace(fault.twin.replace, fault.twin.find));
      const solved = await scoreRun(work.dir, work.manifest, fault, twin);
      assert.equal(solved.solved, true, JSON.stringify(solved));
      assert.equal(solved.editedFaultyFile, true);
    } finally {
      removeWorkdir(work.dir);
    }
  } finally {
    rmSync(twin.dir, { recursive: true, force: true });
  }
});

test('a manifest may list only what a working folder holds', () => {
  const twin = standInTwin();
  try {
    writeFileSync(join(twin.dir, 'MANIFEST.json'), JSON.stringify({ ...readManifest(twin.dir), 'SPEC.md': 'x' }));
    assert.throws(() => verifyProgram(twin.dir, true), /not a kind of file a working folder holds: SPEC\.md/);
  } finally {
    rmSync(twin.dir, { recursive: true, force: true });
  }
});

test('a fault with no edit in the twin cannot be planted there', () => {
  const fault = loadFault('wrong-rule');
  assert.equal(fault.twin, undefined);
  assert.throws(() => editFor(fault, 'P'), /has no edit planted in the twin/);
});

/** Runs one question with a model on an unfaulted copy of F. */
async function ask(question, model, setup = 1) {
  const work = await createWorkdir(null);
  const events = [];
  try {
    const counts = await runAgent({ model, setup, task: question, workdir: work.dir, system: SYSTEM_PROMPT_2, log: (e) => events.push(e) });
    return { counts, events };
  } finally {
    removeWorkdir(work.dir);
  }
}

test('a question: answer replaces done, its schema is the question\'s, and the run ends after it', async () => {
  const question = q('why-rejected-limits');
  const names = toolsFor(3, schemaOf(question.shape)).map((t) => t.definition.name);
  assert.deepEqual(names, toolsFor(3).map((t) => t.definition.name).map((n) => (n === 'done' ? 'answer' : n)));
  for (const setup of [1, 2, 3]) {
    const { counts, events } = await ask(question, scriptedModel(answerer(question, ANSWERS[question.id], setup)), setup);
    assert.equal(counts.stopReason, 'answered');
    assert.deepEqual(counts.answer, ANSWERS[question.id]);
    const start = events.find((e) => e.type === 'start');
    assert.equal(start.system, SYSTEM_PROMPT_2);
    assert.match(start.task, /^Order fixture `cafe-chairs` was rejected\./);
    assert.deepEqual(start.tools.find((t) => t.name === 'answer').input_schema.properties.answer, schemaOf(question.shape));
    assert.ok(!start.tools.some((t) => t.name === 'done'));
    assert.equal(scoreQuestion(question, counts.answer).solved, true);
  }
});

test('one answer, no second try: a second answer in the same message is refused and ignored', async () => {
  const question = q('run-tax-rate');
  const model = scriptedModel(() => ({ stop_reason: 'tool_use', content: [
    { type: 'tool_use', id: 'a', name: 'answer', input: { answer: 8 } },
    { type: 'tool_use', id: 'b', name: 'answer', input: { answer: 6 } },
  ] }));
  const { counts, events } = await ask(question, model);
  assert.equal(counts.stopReason, 'answered');
  assert.equal(counts.answer, 8);
  assert.equal(counts.requests, 1);
  assert.match(events.filter((e) => e.type === 'tool')[1].content, /already given/);
  assert.equal(scoreQuestion(question, counts.answer).solved, false);
});

test('a wrong answer, a malformed answer and no answer are all wrong', async () => {
  const question = q('program-outcome-order');
  const wrong = await ask(question, scriptedModel(wrongAnswerer(question, ANSWERS[question.id], 1)));
  assert.equal(scoreQuestion(question, wrong.counts.answer).solved, false);
  const malformed = await ask(question, scriptedModel(() => ({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'a', name: 'answer', input: { answer: 'on-hold, rejected, review, approved' } }] })));
  assert.deepEqual(scoreQuestion(question, malformed.counts.answer), { solved: false, expected: ANSWERS[question.id], answerProblem: 'not a list' });
  const silent = await ask(question, scriptedModel(talker()));
  assert.equal(silent.counts.stopReason, 'end_turn_without_answer');
  assert.equal(silent.counts.answered, false);
  assert.ok(silent.events.some((e) => e.type === 'reminder'));
  assert.equal(scoreQuestion(question, silent.counts.answer).answerProblem, 'no answer was given');
  assert.ok(!QUESTION_REMINDER.includes('why') && !QUESTION_REMINDER.includes('map'));
});

test('new and re-sent tokens: from consecutive usages, and they add up to every token', async () => {
  assert.deepEqual(newAndResent([{ input_tokens: 100, output_tokens: 10 }, { input_tokens: 150, output_tokens: 20 }]), { newTokens: 170, resentTokens: 110 });
  assert.deepEqual(newAndResent([{ input_tokens: 100, output_tokens: 10 }, { input_tokens: 90, output_tokens: 5 }]), { newTokens: 115, resentTokens: 90 }, 'a smaller request re-sends at most itself');
  assert.deepEqual(newAndResent([]), { newTokens: 0, resentTokens: 0 });
  const question = q('run-weight');
  const { counts } = await ask(question, scriptedModel(answerer(question, ANSWERS[question.id], 3)), 3);
  assert.ok(counts.requests > 2);
  assert.equal(counts.newTokens + counts.resentTokens, counts.inputTokens + counts.outputTokens);
});

test('the system text is one text, true of both programs and both kinds of task, and names no tool and no library', () => {
  assert.ok(!/footprint|flowchart|\bchart|\bfault|\bfix\b|\bfixing\b|\bsteps?\b|\bquestion/i.test(SYSTEM_PROMPT_2), SYSTEM_PROMPT_2);
  for (const t of [...SETUPS[3], ...toolsFor(3, { type: 'number' })]) assert.ok(!SYSTEM_PROMPT_2.includes(t.definition.name), t.definition.name);
});

test('the plan of part 2: 40 tasks, four set-ups, five repeats; the smoke batch one question of each kind and one fault', () => {
  assert.deepEqual([...PART2.setups], ['P', 1, 2, 3]);
  assert.equal(PART2.repeats, 5);
  assert.equal(PART2.setups.length * (QUESTIONS.length + 10) * PART2.repeats, 800);
  const kinds = PART2.smoke.questions.map((id) => q(id).kind).sort();
  assert.deepEqual(kinds, ['program', 'run', 'why']);
  assert.equal(PART2.smoke.setups.length * (PART2.smoke.questions.length + PART2.smoke.faults.length), 16);
  assert.equal(MAX_UNFINISHED, 20);
});

test('a batch of questions and a fault: the plan names tasks, one row each, and a folder refuses other questions', async () => {
  const out = mkdtempSync(join(tmpdir(), 'agent-debug-p2-'));
  try {
    const questions = [q('run-tax-rate'), q('program-free-shipping')];
    const fault = loadFault('wrong-key-read');
    const { solver } = await import('../harness/scripts.mjs');
    const modelFor = async (setup, task) => scriptedModel(task.type === 'question' ? answerer(task, ANSWERS[task.id], setup) : solver(task, setup));
    await runBatch({ out, setups: [1, 3], faults: [fault], questions, repeats: 1, seed: 7, system: SYSTEM_PROMPT_2, modelFor });
    const order = JSON.parse(readFileSync(join(out, 'order.json'), 'utf8'));
    assert.deepEqual(order.questions, ['run-tax-rate', 'program-free-shipping']);
    assert.ok(order.plan.every((p) => typeof p.task === 'string' && p.fault === undefined));
    const runs = readRuns(join(out, 'runs.jsonl'));
    assert.equal(runs.length, 6);
    assert.ok(runs.every((r) => r.solved && r.program === 'F' && r.newTokens + r.resentTokens === r.inputTokens + r.outputTokens));
    const qrow = runs.find((r) => r.task === 'run-tax-rate');
    assert.equal(qrow.taskType, 'question');
    assert.equal(qrow.answer, ANSWERS['run-tax-rate']);
    assert.equal(qrow.kind, 'run');
    const frow = runs.find((r) => r.taskType === 'fault');
    assert.equal(frow.fault, 'wrong-key-read');
    assert.ok(!('namedFaultyStep' in frow));
    await assert.rejects(
      runBatch({ out, setups: [1, 3], faults: [fault], questions: [q('run-tax-rate')], repeats: 1, seed: 7, modelFor: async () => assert.fail('no run') }),
      /holds a batch started with other flags \(questions/,
    );
    assert.match(renderReport2(runs, { plan: order.plan }), /No decision: the batch does not hold both set-up 3 and set-up P/);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

/** Synthetic rows: every question once in set-ups P and 3, at fixed token counts. */
function rows(tokensP, tokens3, extra = {}) {
  return QUESTIONS.flatMap((x) => [
    { setup: 'P', task: x.id, taskType: 'question', kind: x.kind, repeat: 1, solved: true, stopReason: 'answered', inputTokens: tokensP(x), outputTokens: 0, newTokens: tokensP(x), resentTokens: 0, requests: 3, model: 'm', transcript: `transcripts/setupP-${x.id}-r1.jsonl`, ...extra },
    { setup: 3, task: x.id, taskType: 'question', kind: x.kind, repeat: 1, solved: true, stopReason: 'answered', inputTokens: tokens3(x), outputTokens: 0, newTokens: tokens3(x), resentTokens: 0, requests: 3, model: 'm', transcript: `transcripts/setup3-${x.id}-r1.jsonl`, ...extra },
  ]);
}
const planOf = (rs) => rs.map((r) => ({ setup: r.setup, task: r.task, repeat: r.repeat }));

test('the decision, as RULE-2.md words it: go on, stop and look, no decision', () => {
  const go = rows(() => 1000, () => 600);
  assert.match(decision2(go, undefined), /^Go on \(a larger program of our own, then a program we did not write, ported to the pattern\): claim A holds on the questions/);
  const notCheaper = rows(() => 1000, () => 800);
  assert.match(decision2(notCheaper, undefined), /^Stop and look: claim A does not hold on the questions: .*not at least 25% cheaper.*Read the transcripts and say why before anything else is built or run\.$/);
  // One task carries the whole saving: the left-out row fails.
  const oneTask = rows((x) => (x.id === 'run-weight' ? 60000 : 1000), (x) => (x.id === 'run-weight' ? 1000 : 950));
  assert.match(decision2(oneTask, undefined), /^Stop and look: .*hangs on one task or one run \(.*run-weight left out/);
  const lessRight = rows(() => 1000, () => 100).map((r) => (r.setup === 3 && r.task === 'run-weight' ? { ...r, solved: false } : r));
  assert.match(decision2(lessRight, undefined), /set-up 3 was right less often/);
  const report = renderReport2(go, { plan: planOf(go) });
  assert.match(report, /## The decision \(RULE-2\.md, "What decides"\)\n\nGo on/);
  assert.match(report, /\| the 30 questions \| 30 of 30 \(100%\) \| 600 \| 600 \/ 0 \| 30 of 30 \(100%\) \| 1,000 \| 1,000 \/ 0 \| 40\.0% fewer \| yes \|/);
  assert.match(report, /- program: set-up 3 cheapest correct: `transcripts\/setup3-program-/);
  const missing = go.slice(1);
  assert.match(renderReport2(missing, { plan: planOf(go) }), /No decision: the rows are not exactly the planned runs: 1 of the 60 planned runs are missing/);
  const broken = go.map((r, i) => (i < MAX_UNFINISHED + 1 ? { ...r, stopReason: 'error' } : r));
  assert.match(renderReport2(broken, { plan: planOf(go) }), /No decision: more than 20 of the 60 runs ended as error or interrupted \(21\)/);
  assert.match(renderReport2(go, { plan: planOf(go), smoke: true }), /No decision: a smoke batch is not part of the result/);
});

test('part 1\'s report reads its version from RULE.md and no longer counts a "named" step', async () => {
  const { ruleVersion, renderReport } = await import('../harness/report.mjs');
  const version = /^Version (\d+\.\d+)/m.exec(readFileSync(join(BENCH_DIR, 'RULE.md'), 'utf8'))?.[1];
  assert.equal(ruleVersion(), version);
  const text = renderReport([], {});
  assert.match(text, new RegExp(`RULE\\.md version ${version.replace('.', '\\.')}\\)`));
  assert.ok(!/Named the faulty step \|/.test(text));
});
