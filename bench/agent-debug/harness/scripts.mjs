/**
 * Scripted stand-ins for the model, used by the rehearsal and the tests.
 * They know the fault (a script cannot think), so they test the harness's
 * plumbing, never the tools' usefulness.
 *
 * - `solver(fault, setup)`: looks around with the set-up's tools, reads the
 *   faulty file, makes the reverse edit, runs the tests, calls `done`.
 * - `wrongFile(fault)`: edits a different file and calls `done`.
 * - `idler()`: lists files forever (runs out of requests).
 * Example: `scriptedModel(solver(fault, 3))`.
 */

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

/** @param {import('../faults/apply.mjs').Fault} fault @param {number} setup */
export function solver(fault, setup) {
  const { fixture, key } = fault.symptom;
  const look = [[use('list_files', {}), use('run_order', { fixture })]];
  if (setup >= 2) look.push([use('map', {})]);
  if (setup >= 3) look.push([use('why', { fixture, key }), use('step', { address: fault.stepAddress, fixture })], [use('story', { fixture })]);
  return fromTurns([
    ...look,
    [use('read_file', { path: fault.file })],
    [use('edit_file', { path: fault.file, find: fault.replace, replace: fault.find })],
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
