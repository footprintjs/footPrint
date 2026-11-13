/**
 * `answer` (a question task only, in place of `done`): the agent gives its
 * one answer to the question; the run ends after this call (RULE-2.md, "The
 * tasks": a wrong answer is wrong, there is no second try).
 *
 * Why the schema is the question's: the answer's shape (a number, one member
 * of a printed list, a set, an ordered list, yes or no, or a small object of
 * those) is the `answer` field's JSON schema, built by harness/shapes.mjs ·
 * schemaOf. It lists every member of a list in the order the question prints
 * them (sorted, so the order says nothing about which is right).
 * The tool accepts ANY input and only records it: a malformed answer is
 * scored wrong by the harness (harness/score-question.mjs), never refused
 * here, because a refusal would be a second try.
 * Example: `answerTool({ type: 'number' })` → a tool whose input is `{ answer: 6 }`.
 */
import { tool } from './lib/answer.mjs';

export const LIMIT = 200;

/**
 * @param {object} schema the JSON schema of the answer (harness/shapes.mjs · schemaOf)
 * @returns {import('./index.mjs').Tool}
 */
export function answerTool(schema) {
  return {
    LIMIT,
    definition: {
      name: 'answer',
      description: `Call this once with your answer to the question. The run ends after this call; there is no second try. Answers are cut at ${LIMIT} characters.`,
      input_schema: {
        type: 'object',
        properties: { answer: schema },
        required: ['answer'],
        additionalProperties: false,
      },
    },
    run: tool(LIMIT, () => 'Recorded. The run ends here.'),
  };
}
