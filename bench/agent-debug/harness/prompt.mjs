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
