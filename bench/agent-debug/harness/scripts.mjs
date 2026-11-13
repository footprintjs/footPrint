/**
 * Scripted stand-ins for the model, used by the rehearsal and the tests.
 * They know the fault (a script cannot think), so they test the harness's
 * plumbing, never the tools' usefulness.
 *
 * - `solver(fault, setup)`: looks around with the set-up's tools, reads the
 *   faulty file, makes the reverse edit, runs the tests, calls `done`.
 * - `wrongFile(fault)`: edits a different file and calls `done`.
 * - `idler()`: lists files forever (runs out of requests).
 * For a question (part 2), the scripts are told the expected answer (they
 * run in the harness, never in a child):
 * - `answerer(question, answer, setup)`: looks around, then answers right;
 * - `wrongAnswerer(question, answer, setup)`: the same, then a well-formed
 *   WRONG answer (harness/shapes.mjs · wrongOf);
 * - `talker()`: never answers (one reminder, then the run ends).
 * Example: `scriptedModel(solver(fault, 3))`.
 */
import { editFor } from '../faults/apply.mjs';
import { wrongOf } from './shapes.mjs';

let ids = 0;
const use = (name, input) => ({ type: 'tool_use', id: `toolu_scripted_${++ids}`, name, input });
const say = (text) => ({ type: 'text', text });

/** Turns a list of turns (each a list of tool calls) into a script. */
function fromTurns(turns) {
  return ({ turn }) => {
    const calls = turns[Math.min(turn, turns.length - 1)];
    return { content: [say('Working on it.'), ...calls], stop_reason: 'tool_use' };
  };
}

/** @param {import('../faults/apply.mjs').Fault} fault @param {'P'|1|2|3} setup */
export function solver(fault, setup) {
  const { fixture, key } = fault.symptom;
  const edit = editFor(fault, setup === 'P' ? 'P' : 'F');
  const look = [[use('list_files', {}), use('run_order', { fixture })]];
  if (setup !== 'P' && setup >= 2) look.push([use('map', {})]);
  if (setup !== 'P' && setup >= 3) look.push([use('why', { fixture, key }), use('step', { address: fault.stepAddress, fixture })], [use('story', { fixture })]);
  return fromTurns([
    ...look,
    [use('read_file', { path: edit.file })],
    [use('edit_file', { path: edit.file, find: edit.replace, replace: edit.find })],
    [use('run_tests', {})],
    [use('done', { summary: `I fixed the step ${fault.stepAddress}.` })],
  ]);
}

/** @param {import('../faults/apply.mjs').Fault} fault */
export function wrongFile(fault) {
  const other = fault.file === 'src/steps/net-amount/index.mjs' ? 'src/steps/apply-coupon/index.mjs' : 'src/steps/net-amount/index.mjs';
  return fromTurns([
    [use('read_file', { path: other })],
    [use('edit_file', { path: other, find: 'export const purpose', replace: '// looked here\nexport const purpose' })],
    [use('done', { summary: 'I changed a step that was not the faulty one.' })],
  ]);
}

export function idler() {
  return fromTurns([[use('list_files', {})]]);
}

/** Ends its turn with text twice: the run must end unsolved after one reminder. */
export function talker() {
  return () => ({ content: [say('I think it is fine.')], stop_reason: 'end_turn' });
}

/** What a scripted agent looks at before it answers a question, by set-up. */
function lookAround(question, setup) {
  const look = [[use('list_files', {}), use('read_file', { path: 'README.md' })]];
  if (question.fixture) look.push([use('run_order', { fixture: question.fixture })]);
  if (setup !== 'P' && setup >= 2) look.push([use('map', {})]);
  if (setup !== 'P' && setup >= 3 && question.fixture) look.push([use('story', { fixture: question.fixture }), use('why', { fixture: question.fixture, key: 'status' })]);
  return look;
}

/** Answers `answer` after looking around. @param {any} question @param {unknown} answer @param {'P'|1|2|3} setup */
export function answerer(question, answer, setup) {
  return fromTurns([...lookAround(question, setup), [use('answer', { answer })]]);
}

/** Answers a well-formed wrong answer after looking around. @param {any} question @param {unknown} answer @param {'P'|1|2|3} setup */
export function wrongAnswerer(question, answer, setup) {
  return fromTurns([...lookAround(question, setup), [use('answer', { answer: wrongOf(question.shape, answer) })]]);
}
