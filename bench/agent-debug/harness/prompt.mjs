/**
 * The system prompt and the task text: the same words in every set-up
 * (RULE.md, "The task the agent gets"; version 1.2 dropped the tool list).
 *
 * Why no strategy: the prompt says what each tool does and never which to
 * use first, so the result measures the tools, not advice about them.
 * Example: `taskText(fault)` → "Order fixture `school-paper` gives `grandTotal = 52.7`. …".
 */

/**
 * The system prompt, the same in every set-up. It does not list the tools:
 * the tool definitions sent with every request already carry their
 * descriptions (RULE.md 1.2, change 5), and a list here would make the
 * larger tool sets pay for them twice on every request.
 */
export const SYSTEM_PROMPT = [
  'You are fixing a fault in a small Node.js program: an order desk, written as a flowchart with the footprintjs library.',
  "Your working folder holds the program's src/ folder, its fixtures and its visible tests. You can act only through the tools you are given; you cannot run other commands.",
].join('\n');

/**
 * RULE.md's task, word for word, with the fault's symptom filled in.
 * @param {import('../faults/apply.mjs').Fault} fault
 */
export function taskText(fault) {
  const { fixture, key, actual, expected } = fault.symptom;
  return `Order fixture \`${fixture}\` gives \`${key} = ${JSON.stringify(actual)}\`. It should be \`${JSON.stringify(expected)}\`. Find the cause and fix it. You may edit files under \`src/\` only. When you are done, call \`done\` with one sentence naming the step you changed.`;
}

/** Sent once when the model ends its turn without calling `done`. */
export const REMINDER = 'You ended your turn without calling done. If you have finished, call done with one sentence naming the step you changed; otherwise continue.';

/**
 * Part 2's system text (RULE-2.md): ONE text for all four set-ups and both
 * kinds of task. Part 1's first sentence ("fixing a fault … written as a
 * flowchart with the footprintjs library") is false for a question and for
 * the twin, so it became the one sentence true of every run: what the
 * program is, nothing about how it is built or what the task is. The task
 * text says what to do. The second sentence is part 1's, word for word
 * (both working folders hold src/, fixtures and the visible tests).
 * What this changes for a fault task in part 2, read beside part 1: the
 * agent is no longer told the program is a footprintjs flowchart; it finds
 * that out from the code (set-ups 1-3) or never (set-up P). Choosing against
 * the claim: the record tools' set-ups lose a hint, the twin is not misdescribed.
 */
export const SYSTEM_PROMPT_2 = [
  'You are working on a small Node.js program: an order desk.',
  "Your working folder holds the program's src/ folder, its fixtures and its visible tests. You can act only through the tools you are given; you cannot run other commands.",
].join('\n');

/**
 * A question's task text: the question, word for word, and one closing
 * sentence the same for every question and every set-up.
 * @param {{ text: string }} question
 */
export function questionText(question) {
  return `${question.text} When you have the answer, call \`answer\` with it; you can answer only once.`;
}

/** Sent once when the model ends its turn without calling `answer`. */
export const QUESTION_REMINDER = 'You ended your turn without calling answer. If you have the answer, call answer with it; otherwise continue.';

/** The task text of any task: a fault (part 1's words) or a question. @param {any} task */
export function textFor(task) {
  return task.type === 'question' ? questionText(task) : taskText(task);
}

/** The reminder of any task. @param {any} task */
export function reminderFor(task) {
  return task.type === 'question' ? QUESTION_REMINDER : REMINDER;
}
